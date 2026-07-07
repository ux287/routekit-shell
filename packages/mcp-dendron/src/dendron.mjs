import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

export function resolveProjectRoot(explicitRoot) {
  if (explicitRoot && typeof explicitRoot === "string") {
    return path.resolve(explicitRoot);
  }
  if (process.env.ROUTEKIT_PROJECT_ROOT) return path.resolve(process.env.ROUTEKIT_PROJECT_ROOT);
  if (process.env.RKS_PROJECT_ROOT) return path.resolve(process.env.RKS_PROJECT_ROOT);
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

export function writeNoteRaw(notePath, content) {
  ensureDir(path.dirname(notePath));
  fs.writeFileSync(notePath, content, "utf8");
}

export function hasFrontmatter(content) {
  return String(content || "").trimStart().startsWith("---");
}

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

export function parseFrontmatter(content) {
  return matter(String(content || ""));
}

export function formatWithFrontmatter(data, body) {
  const cleanBody = String(body || "").replace(/^\s+/, "");
  const fm = `---\n${Object.entries(data)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null;
      if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
    })
    .filter(Boolean)
    .join("\n")}\n---\n`;
  return `${fm}\n${cleanBody}`;
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
  // Naive but fast schema discovery: look for *.schema.yml files in vault root
  try {
    const candidates = (fs.readdirSync(notesDir) || []).filter((f) => f.endsWith(".schema.yml"));
    for (const f of candidates) {
      const p = path.join(notesDir, f);
      const raw = String(fs.readFileSync(p, "utf8") || "");
      // Try to extract the first schema id and namespace flag and template reference
      // Matches either a list item "- id: NAME" or plain "id: NAME" near start
      const idMatch = raw.match(/^[\s-]*id:\s*([\w.\-]+)/mi);
      const nsMatch = raw.match(/^[\s-]*namespace:\s*(true|false)/mi);
      const templateMatch = raw.match(/^[\s-]*template:\s*([\w.\-]+)/mi) || raw.match(/^[\s-]*template:\s*\n[\s\S]*?^[\s-]*id:\s*([\w.\-]+)/mi);
      const id = idMatch ? String(idMatch[1]).trim() : null;
      const namespace = nsMatch ? String(nsMatch[1]).trim() === "true" : false;
      const template = templateMatch ? String(templateMatch[1]).trim() : null;
      if (!id) continue;
      if (namespace) {
        // namespace true matches id.* pattern
        if (String(filename) === id || String(filename).startsWith(`${id}.`)) {
          return { id, template, raw, path: p };
        }
      }
      // If not namespace, attempt simple prefix match using pattern or id
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

export function loadSchemaTemplate(notesDir, templateRef) {
  // templateRef can be a shorthand string like "templates.backlog" or null
  try {
    if (!templateRef) return null;
    const templateId = typeof templateRef === "string" ? templateRef : (templateRef && templateRef.id) || null;
    if (!templateId) return null;
    // templates are stored in vault as notes; templateId like "templates.backlog" -> templates.backlog.md
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
  // templateParsed: { data, content }
  const tmplFm = (templateParsed && templateParsed.data) || {};
  const tmplBody = (templateParsed && templateParsed.content) || "";
  // Start with defaults, overlay template frontmatter, then overlay generated (so generated id/title/desc/dates win unless template provides extras)
  const base = frontmatterDefaults({ id, title: generated.title || tmplFm.title || null, desc: generated.desc || tmplFm.desc || null });
  const merged = Object.assign({}, base, tmplFm || {}, generated || {});
  // Ensure id and timestamps are set correctly
  merged.id = id;
  merged.created = merged.created || base.created;
  merged.updated = Date.now();
  // Compose body: use provided content if given, otherwise fall back to template body
  const body = (content && String(content || "").trim()) || (tmplBody && String(tmplBody || "").trim()) || "";
  return { merged, body };
}

export function updateField(notesDir, filename, field, value) {
  // Perform an atomic update to either a frontmatter field or an in-body bold-field like **Status**: X
  const safe = String(filename || "").trim();
  if (!safe) throw new Error("Invalid filename");
  const notePath = path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
  if (!fs.existsSync(notePath)) throw new Error(`Note not found: ${notePath}`);

  const raw = readNoteRaw(notePath);
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("Failed to parse note frontmatter");

  const id = (parsed.data && parsed.data.id) || canonicalIdFromFilename(filename);
  let body = parsed.content || "";
  const fm = Object.assign({}, parsed.data || {});

  if (String(field || "").startsWith("body.")) {
    const bodyField = String(field).slice(5);
    // Match a bolded in-body pattern like **Status**: value (case-insensitive)
    const pattern = new RegExp(`(\\*\\*${bodyField}\\*\\*:\\s*)([^\\n]+)`, "i");
    if (pattern.test(body)) {
      body = body.replace(pattern, `$1${value}`);
    } else {
      throw new Error(`Body field '${bodyField}' not found`);
    }
  } else {
    // Update or create frontmatter field
    fm[field] = value;
  }

  // Ensure id and updated timestamp are set
  fm.id = id;
  fm.updated = Date.now();

  const out = formatWithFrontmatter(fm, body);
  writeNoteRaw(notePath, out);

  return { ok: true, path: path.relative(notesDir, notePath), id };
}
