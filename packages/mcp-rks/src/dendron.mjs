import fs from "node:fs";
import path from "node:path";
import { normalizeTargetFiles } from "./shared/normalize-target-files.mjs";


import { VALID_PHASES } from "./workflow/phases.mjs";
export { VALID_PHASES } from "./workflow/phases.mjs";

// Fields that must always be stored as YAML arrays
export const ARRAY_FIELDS = new Set(["targetFiles", "dependsOn", "testFiles", "testRequirements"]);

export function resolveProjectRoot(explicitRoot) {
  if (explicitRoot && typeof explicitRoot === "string") {
    return path.resolve(explicitRoot);
  }
  // Guard env-derived roots with an existence check (mirrors envProjectRoot in
  // project-context.mjs). An unexpanded/stale value — e.g. a literal "${workspaceFolder}"
  // the editor never expanded — must NOT resolve to <cwd>/${workspaceFolder}; fall back to cwd.
  for (const envVar of ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT"]) {
    const raw = process.env[envVar] && String(process.env[envVar]).trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (fs.existsSync(resolved)) return resolved;
    console.error(`[mcp] ${envVar} points to non-existent path: ${resolved} — ignoring, falling back to cwd`);
  }
  return process.cwd();
}

export function resolveNotesDir(projectRoot) {
  if (process.env.DENDRON_VAULT_PATH) {
    const raw = String(process.env.DENDRON_VAULT_PATH || "").trim();
    if (raw) return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
  }
  if (process.env.ROUTEKIT_NOTES_DIR) {
    return path.resolve(projectRoot, process.env.ROUTEKIT_NOTES_DIR);
  }
  return path.join(projectRoot, "notes");
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readNoteRaw(notePath) {
  return fs.readFileSync(notePath, "utf8");
}

/**
 * Read and parse a note by its ID within a notes directory.
 * Returns { title, desc, content, ...frontmatter }.
 */
export function readNote(notesDir, noteId) {
  const notePath = path.join(notesDir, `${noteId}.md`);
  const raw = fs.readFileSync(notePath, "utf8");
  const parsed = parseFrontmatter(raw);
  return { ...parsed.data, content: parsed.content };
}

export function writeNoteRaw(notePath, content, options = {}) {
  ensureDir(path.dirname(notePath));
  // Atomic write: write to temp file then rename. Same-filesystem rename is
  // POSIX-atomic — the target file is never observed in a partial state, even
  // if the calling process is interrupted (max_turns timeout, crash, signal).
  // Prevents the data-loss class fixed in backlog.fix.dendron-write-atomicity.
  const tmpPath = notePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, notePath);
  // Trigger background RAG embed to keep index fresh. Do not block main flow.
  // Skipped when the caller drives the embed itself after a commit (e.g.
  // commitAndEmbedNote — preserves "nothing embedded that's not committed"
  // by sequencing write → commit → embed).
  if (options.skipEmbed) return;
  try {
    import("node:child_process").then(({ spawn }) => {
      const proc = spawn(process.execPath, ["scripts/rag/embed.mjs"], {
        cwd: process.cwd(),
        stdio: "ignore",
        detached: true,
      });
      proc.unref();
    }).catch(() => { });
  } catch (e) {
    // ignore embed errors
  }
}

// Import from shared module for local use AND re-export for backwards compatibility
import { hasFrontmatter, parseFrontmatter, formatWithFrontmatter } from "./shared/frontmatter.mjs";
export { hasFrontmatter, parseFrontmatter, formatWithFrontmatter };

export function frontmatterDefaults({ id, title, desc } = {}) {
  const now = Date.now();
  return {
    id: id || "untitled",
    title: title || id || "Untitled",
    desc: desc || "",
    created: now,
    updated: now,
  };
}


export function validateNoteFrontmatter(content) {
  const result = {
    ok: true,
    issues: [],
    data: null,
  };
  if (!hasFrontmatter(content)) {
    result.ok = false;
    result.issues.push({ code: "missing_frontmatter", message: "Missing YAML frontmatter" });
    return result;
  }
  try {
    const parsed = parseFrontmatter(content);
    result.data = parsed.data || {};
    const required = ["id", "title", "created", "updated"];
    for (const field of required) {
      if (result.data[field] === undefined || result.data[field] === null || result.data[field] === "") {
        result.ok = false;
        result.issues.push({ code: "missing_field", field, message: `Missing field: ${field}` });
      }
    }
    return result;
  } catch (error) {
    result.ok = false;
    result.issues.push({ code: "frontmatter_parse_error", message: error.message || String(error) });
    return result;
  }
}

export function canonicalIdFromFilename(filename) {
  const base = path.basename(filename);
  return base.replace(/\.md$/i, "");
}

export function findMatchingSchema(notesDir, filename) {
  try {
    const candidates = (fs.readdirSync(notesDir) || []).filter((f) => f.endsWith(".schema.yml"));
    for (const f of candidates) {
      const p = path.join(notesDir, f);
      const raw = String(fs.readFileSync(p, "utf8") || "");
      const idMatch = raw.match(/^[\s-]*id:\s*([\w.\-]+)/mi);
      const nsMatch = raw.match(/^[\s-]*namespace:\s*(true|false)/mi);
      const templateMatch = raw.match(/^[\s-]*template:\s*([\w.\-]+)/mi) || raw.match(/^[\s-]*template:\s*\n[\s\S]*?^[\s-]*id:\s*([\w.\-]+)/mi);
      const id = idMatch ? String(idMatch[1]).trim() : null;
      const namespace = nsMatch ? String(nsMatch[1]).trim() === "true" : false;
      const template = templateMatch ? String(templateMatch[1]).trim() : null;
      if (!id) continue;
      if (namespace) {
        if (String(filename) === id || String(filename).startsWith(`${id}.`)) {
          // Check for child schema match before returning parent
          const childTemplate = matchChildSchema(raw, id, String(filename));
          if (childTemplate) {
            return { id, template: childTemplate, raw, path: p };
          }
          return { id, template, raw, path: p };
        }
      }
      if (!namespace && template) {
        if (String(filename) === id || String(filename).startsWith(`${id}.`)) {
          return { id, template, raw, path: p };
        }
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse child schema entries from schema YAML and match against filename.
 * Children are defined as:
 *   children:
 *     - pattern: feat
 *       template: templates.backlog
 *     - pattern: fix
 *       template: templates.backlog-fix
 *
 * A filename like "backlog.fix.some-bug" matches child pattern "fix"
 * when the segment after the schema id matches the pattern.
 *
 * Returns the child template string if matched, null otherwise.
 */
function matchChildSchema(schemaRaw, schemaId, filename) {
  const suffix = filename.slice(schemaId.length + 1); // e.g. "fix.some-bug" from "backlog.fix.some-bug"
  if (!suffix) return null;
  const segment = suffix.split(".")[0]; // e.g. "fix"
  if (!segment) return null;

  // Extract children block from YAML using regex
  const childrenMatch = schemaRaw.match(/children:\s*\n((?:[\t ]+- .*\n?(?:[\t ]+\w.*\n?)*)*)/m);
  if (!childrenMatch) return null;

  const childrenBlock = childrenMatch[1];
  // Parse each child entry: "- pattern: X\n  template: Y"
  const childEntries = childrenBlock.matchAll(/- pattern:\s*([\w.\-]+)\s*\n\s*template:\s*([\w.\-]+)/g);
  for (const entry of childEntries) {
    const pattern = entry[1].trim();
    const childTemplate = entry[2].trim();
    if (segment === pattern) {
      return childTemplate;
    }
  }
  return null;
}

export function loadSchemaTemplate(notesDir, templateRef) {
  try {
    if (!templateRef) return null;
    const templateId = typeof templateRef === "string" ? templateRef : (templateRef && templateRef.id) || null;
    if (!templateId) return null;
    const templateFilename = `${templateId}.md`;
    const templatePath = path.join(notesDir, templateFilename);
    if (!fs.existsSync(templatePath)) return null;
    const raw = fs.readFileSync(templatePath, "utf8");
    const parsed = parseFrontmatter(raw);
    return { templatePath, parsed };
  } catch (err) {
    return null;
  }
}

export function mergeTemplateWithGenerated({ generated, templateParsed, content = "", id }) {
  const tmplFm = (templateParsed && templateParsed.data) || {};
  const tmplBody = (templateParsed && templateParsed.content) || "";
  const base = frontmatterDefaults({ id, title: generated.title || tmplFm.title || null, desc: generated.desc || tmplFm.desc || null });
  const merged = Object.assign({}, base, tmplFm || {}, generated || {});
  merged.id = id;
  merged.created = merged.created || base.created;
  merged.updated = Date.now();
  // Use provided content exclusively; template body is only a fallback
  const hasContent = content && String(content || "").trim();
  const body = hasContent
    ? String(content).trim()
    : (tmplBody && String(tmplBody || "").trim()) || "";
  return { merged, body };
}

export function parsePossibleArray(value) {
  // If it's not a string, return as-is (numbers/booleans/arrays already fine)
  if (typeof value !== "string") return value;
  let s = String(value || "").trim();
  if (!s) return value;

  // Handle double-encoded JSON from MCP transport
  // When MCP passes a JSON array string, transport may encode it as: "[\"a\"]"
  // We need to detect and unwrap this double-encoding
  if ((s.startsWith('"[') && s.endsWith(']"')) || (s.startsWith("'[") && s.endsWith("]'"))) {
    try {
      const unwrapped = JSON.parse(s);
      if (typeof unwrapped === "string" && unwrapped.startsWith("[")) {
        s = unwrapped; // Use the inner JSON array string
      }
    } catch (err) {
      // fall through to other parsing attempts
    }
  }

  // JSON array like: ["a","b"]
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      // Try single-quoted variant: ['a','b'] → ["a","b"]
      try {
        const normalized = s.replace(/'/g, '"');
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to other parsing attempts
      }
    }
  }

  // YAML-style list: lines starting with '- '
  const lines = s.split(/\r?\n/).map((l) => l.trim());
  const listLines = lines.filter((l) => l.startsWith("- "));
  if (listLines.length) {
    return listLines.map((l) => {
      let v = l.replace(/^\-\s*/, "").trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
        v = v.slice(1, -1);
      }
      return v;
    });
  }

  // Not an array representation, return original
  return value;
}

/**
 * Update a frontmatter field with a pre-parsed value (no string parsing needed).
 * Used when the caller already has structured data (e.g., targetFiles as array of objects).
 */
export function updateFieldDirect(notesDir, filename, field, value, options = {}) {
  const safe = String(filename || "").trim();
  if (!safe) throw new Error("Invalid filename");
  const notePath = path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!fs.existsSync(notePath)) throw new Error(`Note not found: ${notePath}`);

  const raw = readNoteRaw(notePath);
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("Failed to parse note frontmatter");

  const id = (parsed.data && parsed.data.id) || canonicalIdFromFilename(filename);
  let body = parsed.content || "";
  let fm = Object.assign({}, parsed.data || {});

  const bodyTrimmed = body.trim();
  if (bodyTrimmed.startsWith("---")) {
    const secondParsed = parseFrontmatter(bodyTrimmed);
    if (secondParsed && secondParsed.data && Object.keys(secondParsed.data).length > 0) {
      fm = Object.assign({}, secondParsed.data, fm);
      body = secondParsed.content || "";
    }
  }

  // Normalize targetFiles to consistent { path, op, desc } shape on write
  if (field === "targetFiles" && Array.isArray(value)) {
    value = normalizeTargetFiles(value).map(t => {
      const obj = { path: t.path, op: t.action?.toLowerCase() || "edit" };
      if (t.desc) obj.desc = t.desc;
      if (t.reason) obj.reason = t.reason;
      return obj;
    });
  }
  fm[field] = value;
  fm.id = id;
  fm.updated = Date.now();

  const out = formatWithFrontmatter(fm, body);
  writeNoteRaw(notePath, out, options);

  return { ok: true, path: path.relative(notesDir, notePath), id };
}

export function updateField(notesDir, filename, field, value, options = {}) {
  const safe = String(filename || "").trim();
  if (!safe) throw new Error("Invalid filename");
  const notePath = path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!fs.existsSync(notePath)) throw new Error(`Note not found: ${notePath}`);

  // Validate phase field values
  if (field === "phase") {
    // VALID_PHASES is defined at top of file
    if (!VALID_PHASES.includes(value)) {
      throw new Error(`Invalid phase '${value}'. Valid phases: ${VALID_PHASES.join(", ")}`);
    }
  }

  const raw = readNoteRaw(notePath);
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("Failed to parse note frontmatter");

  const id = (parsed.data && parsed.data.id) || canonicalIdFromFilename(filename);
  let body = parsed.content || "";
  let fm = Object.assign({}, parsed.data || {});

  // Fix corrupted notes with duplicate frontmatter blocks
  const bodyTrimmed = body.trim();
  if (bodyTrimmed.startsWith("---")) {
    const secondParsed = parseFrontmatter(bodyTrimmed);
    if (secondParsed && secondParsed.data && Object.keys(secondParsed.data).length > 0) {
      fm = Object.assign({}, secondParsed.data, fm);
      body = secondParsed.content || "";
    }
  }

  if (String(field || "").startsWith("body.")) {
    const bodyField = String(field).slice(5);
    const pattern = new RegExp(`(\\*\\*${bodyField}\\*\\*:\\s*)([^\\n]+)`, "i");
    if (pattern.test(body)) {
      body = body.replace(pattern, `$1${value}`);
    } else {
      throw new Error(`Body field '${bodyField}' not found`);
    }
  } else {
    try {
      let parsed = parsePossibleArray(value);
      // For known array fields, ensure the value is always an array
      if (ARRAY_FIELDS.has(field) && !Array.isArray(parsed)) {
        const str = String(parsed || "").trim();
        if (str.includes(",")) {
          parsed = str.split(",").map(s => s.trim()).filter(Boolean);
        } else if (str) {
          parsed = [str];
        } else {
          parsed = [];
        }
      }
      // Normalize targetFiles to consistent { path, op, desc } shape on write
      if (field === "targetFiles" && Array.isArray(parsed)) {
        parsed = normalizeTargetFiles(parsed).map(t => {
          const obj = { path: t.path, op: t.action?.toLowerCase() || "edit" };
          if (t.desc) obj.desc = t.desc;
          if (t.reason) obj.reason = t.reason;
          return obj;
        });
      }
      fm[field] = parsed;
    } catch (err) {
      fm[field] = value;
    }
  }

  fm.id = id;
  fm.updated = Date.now();

  const out = formatWithFrontmatter(fm, body);
  writeNoteRaw(notePath, out, options);

  return { ok: true, path: path.relative(notesDir, notePath), id };
}

export function editNote(notesDir, filename, newBody, options = {}) {
  const safe = String(filename || "").trim();
  if (!safe) throw new Error("Invalid filename");
  const notePath = path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!fs.existsSync(notePath)) throw new Error(`Note not found: ${notePath}`);

  const raw = readNoteRaw(notePath);
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("Failed to parse note frontmatter");

  const id = (parsed.data && parsed.data.id) || canonicalIdFromFilename(filename);
  let fm = Object.assign({}, parsed.data || {});
  fm.id = id;
  fm.updated = Date.now();

  const out = formatWithFrontmatter(fm, newBody);
  writeNoteRaw(notePath, out, options);

  return { ok: true, path: path.relative(notesDir, notePath), id };
}

/**
 * Mark a backlog story as implemented and move to z_implemented namespace.
 * Updates the id field to match the new filename hierarchy.
 */
export function markImplemented(notesDir, filename, commitId, options = {}) {
  const safe = String(filename || "").trim();
  if (!safe) throw new Error("Invalid filename");
  const notePath = path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!fs.existsSync(notePath)) throw new Error(`Note not found: ${notePath}`);

  const raw = readNoteRaw(notePath);
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("Failed to parse note frontmatter");

  const originalId = (parsed.data && parsed.data.id) || canonicalIdFromFilename(filename);

  // Compute new filename with z_implemented prefix
  const baseFilename = safe.endsWith(".md") ? safe.slice(0, -3) : safe;
  const newFilename = baseFilename.includes("z_implemented")
    ? baseFilename
    : baseFilename.replace(/^backlog\./, "backlog.z_implemented.");

  // Update the id field to match the new filename hierarchy
  const newId = originalId.includes("z_implemented")
    ? originalId
    : originalId.replace(/^backlog\./, "backlog.z_implemented.");

  let fm = Object.assign({}, parsed.data || {});
  fm.id = newId;
  fm.updated = Date.now();
  if (commitId) {
    fm.implementedCommit = commitId;
  }

  const out = formatWithFrontmatter(fm, parsed.content);
  const newPath = path.join(notesDir, `${newFilename}.md`);

  // Write to new location
  writeNoteRaw(newPath, out, options);

  // Remove old file if different
  if (notePath !== newPath) {
    fs.unlinkSync(notePath);
  }

  return { ok: true, path: path.relative(notesDir, newPath), id: newId, oldPath: path.relative(notesDir, notePath) };
}

