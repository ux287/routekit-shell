import fs from "node:fs";
import path from "node:path";
import { normalizeTargetFiles, inspectTargetFiles } from "./shared/normalize-target-files.mjs";


import { VALID_PHASES } from "./workflow/phases.mjs";
export { VALID_PHASES } from "./workflow/phases.mjs";

// Fields that must always be stored as YAML arrays
export const ARRAY_FIELDS = new Set(["targetFiles", "dependsOn", "testFiles", "testRequirements"]);

/**
 * Frontmatter fields owned exclusively by the `rks_arch_verdict` tool.
 *
 * backlog.fix.arch-reserved-fields-write-contract: guarding `arch_verdict` alone
 * guarded nothing. The verdict is a PURE FUNCTION of `arch_round` and the frozen
 * `arch_ledger`, so anything able to write those two could choose the verdict
 * without ever naming it — and the array-valued router path reached
 * `updateFieldDirect`, which carried no guard at all, so even `arch_verdict`
 * itself was writable as `["approved"]`.
 *
 * Reserved at the two write chokepoints rather than at their callers: there are
 * three call sites passing a caller-supplied field name (`server.mjs`,
 * `agents/dendron.mjs`, `agents/research.mjs`), and guarding inside the write
 * functions covers all three plus any future caller.
 *
 * `phase` is deliberately NOT reserved. Four production sites legitimately reset a
 * story to `arch-approved` (exec-start-durability, exec ×2, plan-ready), so
 * reserving it would not be a lockout but a re-assignment of phase-write
 * authority — a separate decision this contract does not settle.
 *
 * The `rks_arch_verdict` handler is unaffected: it reaches the note through
 * `writeNoteRaw` + `formatWithFrontmatter`, so the table never sees it.
 */
export const ARCH_RESERVED_FIELDS = new Set([
  "arch_verdict",
  "arch_round",
  "arch_ledger",
  "arch_deferred",
  "arch_findings_count",
  // backlog.fix.arch-ledger-subject-rebinding: the digest the ledger is bound to.
  // Reserved because the guard is exact-membership, not an arch_ prefix rule — an
  // unreserved arch_subject could be written with junk to force a rebase, or with
  // the current digest to SUPPRESS a legitimate one after amending a story, which
  // would make "reset is derived, never requested" false in both directions.
  "arch_subject",
  // backlog.fix.arch-no-cumulative-round-bound-across-rebases: advisory cumulative cost.
  // Reserved for the same reason as arch_subject — the guard is exact membership, not an
  // arch_ prefix rule, so an unlisted arch_* field is forgeable by any direct field write.
  // Advisory does not mean unprotected: a forged trajectory would misreport review cost.
  "arch_total_rounds",
  "arch_round_findings",
]);

/**
 * Identity of one array entry, for delta reporting.
 *
 * Key order must not decide identity: `targetFiles` entries are objects built by two
 * different normalizers, and a bare `JSON.stringify` would report an entry as removed
 * and re-added purely because `op` sorted before `path` on one side.
 */
function arrayEntryKey(entry) {
  if (entry === null || entry === undefined) return String(entry);
  if (Array.isArray(entry)) return `[${entry.map(arrayEntryKey).join(",")}]`;
  if (typeof entry !== "object") return String(entry);
  return JSON.stringify(
    Object.keys(entry)
      .sort()
      .map((k) => [k, arrayEntryKey(entry[k])]),
  );
}

/**
 * What a write is about to do to an `ARRAY_FIELDS` array.
 *
 * MULTISET, not set: removing one of two identical entries is a removal. A set
 * difference would report `["a"]` over `["a","a"]` as removing nothing, which is
 * exactly the silent loss this exists to surface.
 *
 * Exported so the comparison can be unit-tested directly, without driving a write —
 * the catch-fallback assignment inside `updateField` is otherwise awkward to reach.
 *
 * @returns {{beforeCount: number, afterCount: number, removed: unknown[]}}
 */
export function arrayFieldDelta(prior, next) {
  const before = Array.isArray(prior) ? prior : [];
  const after = Array.isArray(next) ? next : [];
  const remaining = new Map();
  for (const entry of after) {
    const key = arrayEntryKey(entry);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const removed = [];
  for (const entry of before) {
    const key = arrayEntryKey(entry);
    const count = remaining.get(key) || 0;
    if (count > 0) remaining.set(key, count - 1);
    else removed.push(entry);
  }
  return { beforeCount: before.length, afterCount: after.length, removed };
}

/**
 * Coerce a value destined for an `ARRAY_FIELDS` member into the array the file will
 * actually hold, so the reported count and the serialized value cannot disagree.
 *
 * `updateField` already did this for the string door at its own call site; the direct
 * door did not, which is how a scalar could land in a field the schema calls a list.
 */
function coerceArrayFieldValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  const str = String(value).trim();
  return str ? [str] : [];
}

/**
 * The refusal returned — never thrown — when a write would shrink an array field.
 *
 * RETURNED rather than thrown on purpose. `commitDendronWriteResult` short-circuits on
 * `innerResult.ok === false` and yields `writeOk: false` / `commitOk: false`; a throw
 * would bypass that and lose the structured payload a caller needs to recover.
 *
 * `afterCount` here is PROSPECTIVE — the count the rejected write would have produced.
 * Nothing was serialized, and the file still holds `beforeCount`. Reporting the file's
 * count instead would make the `afterCount < beforeCount` trigger unfireable.
 */
/**
 * Apply the array-shrink guard to the value FINALLY assigned to `fm[field]`.
 *
 * Deliberately sited after every assignment rather than at each of them. `updateField`
 * assigns in three places — the normal path, the array-coercion path, and a catch
 * fallback — and at the normal one the identifier holding the parsed value SHADOWS the
 * outer parse of the note, so a guard written there would compare the incoming value
 * with itself and never fire. Guarding the serialized value closes all three at once
 * and cannot be outflanked by a fourth.
 *
 * Keyed on `ARRAY_FIELDS` membership, NOT on `Array.isArray(value)`: the latter would
 * extend the guard to every array-valued field, including the reserved ARCH ones whose
 * ledger shrinks by design.
 *
 * Mutates `fm[field]` into its array form as a side effect, so the count reported is
 * the count the file will hold.
 *
 * @returns {null | {ok: false, delta: object} | {delta: object}}
 */
function guardArrayFieldWrite({ fm, field, priorArray, options }) {
  if (!ARRAY_FIELDS.has(field)) return null;
  fm[field] = coerceArrayFieldValue(fm[field]);
  const delta = arrayFieldDelta(priorArray, fm[field]);
  if (delta.afterCount < delta.beforeCount && (!options || options.acknowledgeRemoval !== true)) {
    return { ok: false, delta };
  }
  return { delta };
}

function arrayRemovalRefusal({ field, delta, notesDir, notePath, id }) {
  return {
    ok: false,
    error: "array_entries_removed",
    field,
    beforeCount: delta.beforeCount,
    afterCount: delta.afterCount,
    removed: delta.removed,
    path: path.relative(notesDir, notePath),
    id,
    detail:
      `Refusing to write '${field}': the incoming value holds ${delta.afterCount} entries where the note holds ${delta.beforeCount}, ` +
      `so ${delta.removed.length} would be lost. Nothing was written and nothing was committed. ` +
      `Re-read the field from the note, merge your change into the entries it actually holds, and write the whole array back — ` +
      `or pass acknowledgeRemoval true if the removal is intended.`,
  };
}

/**
 * Refuse a reserved-field write before the note is read or touched, so a refused
 * call leaves the file byte-identical.
 */
function assertNotReservedArchField(field, options) {
  if (!ARCH_RESERVED_FIELDS.has(field)) return;
  if (options && options.internalWriter === true) return;
  throw new Error(
    `Direct writes to '${field}' are refused. Use rks_arch_verdict, which computes the ARCH verdict from the frozen finding ledger and writes these fields itself.`,
  );
}

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

// Background-embed lifecycle state. Module-level so a burst of note writes
// collapses to ONE embedder instead of one per write.
//
// Exposed as `embedSettled()` because the spawn is deferred into an
// `import(...).then()` microtask — it happens AFTER writeNoteRaw returns, so a
// test asserting "no subprocess was spawned" immediately after the call passes
// against the BROKEN code too. There is no other handle to await.
let embedInFlight = null;

/** Resolves once any in-flight background embed has been dispatched. */
export function embedSettled() {
  return embedInFlight ?? Promise.resolve();
}

// Bound the child's lifetime. Incremental embeds are seconds; anything running
// far longer is wedged and must not linger at ~200MB.
const EMBED_TIMEOUT_MS = 120_000;

/**
 * Evaluated at CALL time, never captured in a module-scope const — `vi.mock`
 * hoisting would freeze a const before a test could vary it, silently making
 * the positive control unfalsifiable.
 */
function backgroundEmbedDisabled() {
  return Boolean(process.env.VITEST || process.env.RKS_SKIP_BACKGROUND_EMBED);
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
  // Never spawn a real embedder from a test run. Six bare writeNoteRaw calls in
  // the unit tier were each launching a full-corpus embed inside CI.
  if (backgroundEmbedDisabled()) return;
  // Single-flight: a Governor run performs many note writes, and each one used
  // to start its own embedder.
  if (embedInFlight) return;

  try {
    embedInFlight = import("node:child_process").then(({ spawn }) => {
      // `--files=` is REQUIRED, not cosmetic. embed.mjs filters argv with
      // `.startsWith('--files=')` and falls back to incrementalFiles: null —
      // i.e. a FULL-CORPUS re-index (lancedb + transformers, ~200MB, minutes) —
      // for anything else, including bare positional paths.
      const proc = spawn(
        process.execPath,
        ["packages/rag/src/embed.mjs", `--files=${notePath}`],
        {
          cwd: process.cwd(),
          stdio: "ignore",
          // Deliberately NOT detached. Detaching placed the child in its OWN
          // process group, so a signal to the parent's group never reached it —
          // which is how dozens of these survived as PID-1 orphans at ~200MB
          // for 20+ minutes, and why CI's SIGTERM left them running. Staying in
          // the parent's group means the child dies with the run. unref() alone
          // still keeps it off the event loop, so nothing blocks.
        },
      );
      proc.unref();

      const killTimer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      }, EMBED_TIMEOUT_MS);
      killTimer.unref?.();

      const clear = () => {
        clearTimeout(killTimer);
        embedInFlight = null;
      };
      proc.on("exit", clear);
      proc.on("error", clear);
    }).catch(() => {
      embedInFlight = null;
    });
  } catch (e) {
    embedInFlight = null;
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
  let _targetFilesReport = null;
  assertNotReservedArchField(field, options);
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

  // Sourced from the note's own frontmatter, BEFORE any assignment below. The caller's
  // input is not evidence of what the field held.
  const _priorArray = ARRAY_FIELDS.has(field) ? coerceArrayFieldValue(fm[field]) : null;

  // Normalize targetFiles to consistent { path, op, desc } shape on write
  if (field === "targetFiles" && Array.isArray(value)) {
    // Report what normalization discards. The keys are still dropped — the write contract
    // is unchanged — but a caller no longer learns of the loss only by reading the note
    // back and diffing. See backlog.fix.dendron-update-field-drops-unknown-targetfile-keys.
    const inspected = inspectTargetFiles(value);
    _targetFilesReport = inspected;
    value = inspected.normalized.map(t => {
      const obj = { path: t.path, op: t.action?.toLowerCase() || "edit" };
      if (t.desc) obj.desc = t.desc;
      if (t.reason) obj.reason = t.reason;
      return obj;
    });
  }
  fm[field] = value;
  fm.id = id;
  fm.updated = Date.now();

  const _arrayDelta = guardArrayFieldWrite({ fm, field, priorArray: _priorArray, options });
  if (_arrayDelta && _arrayDelta.ok === false) {
    return arrayRemovalRefusal({ field, delta: _arrayDelta.delta, notesDir, notePath, id });
  }

  const out = formatWithFrontmatter(fm, body);
  writeNoteRaw(notePath, out, options);

  const _result = { ok: true, path: path.relative(notesDir, notePath), id };
  if (_arrayDelta) {
    _result.field = field;
    _result.beforeCount = _arrayDelta.delta.beforeCount;
    _result.afterCount = _arrayDelta.delta.afterCount;
    _result.removed = _arrayDelta.delta.removed;
  }
  // Attached ONLY when something was actually discarded. An always-present empty array
  // would change the result shape for every write and break existing toEqual assertions,
  // and would also report "nothing dropped" as a positive claim on writes that never
  // normalized a targetFiles array at all.
  if (_targetFilesReport) {
    if (_targetFilesReport.droppedKeys.length > 0) _result.droppedKeys = _targetFilesReport.droppedKeys;
    if (_targetFilesReport.droppedEntries.length > 0) _result.droppedEntries = _targetFilesReport.droppedEntries;
  }
  return _result;
}

export function updateField(notesDir, filename, field, value, options = {}) {
  let _targetFilesReport = null;
  assertNotReservedArchField(field, options);
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

  // Captured BEFORE the assignment block below, because `parsed` is rebound inside it to
  // hold the INCOMING value — a guard reading that identifier at the assignment site
  // would compare the incoming array with itself.
  const _priorArray = ARRAY_FIELDS.has(field) ? coerceArrayFieldValue(fm[field]) : null;

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
        // Same report on the JSON-string route. A fix confined to the shared normalizer
        // would be invisible here, which is why both call sites are touched.
        const inspected = inspectTargetFiles(parsed);
        _targetFilesReport = inspected;
        parsed = inspected.normalized.map(t => {
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

  const _arrayDelta = guardArrayFieldWrite({ fm, field, priorArray: _priorArray, options });
  if (_arrayDelta && _arrayDelta.ok === false) {
    return arrayRemovalRefusal({ field, delta: _arrayDelta.delta, notesDir, notePath, id });
  }

  const out = formatWithFrontmatter(fm, body);
  writeNoteRaw(notePath, out, options);

  const _result = { ok: true, path: path.relative(notesDir, notePath), id };
  if (_arrayDelta) {
    _result.field = field;
    _result.beforeCount = _arrayDelta.delta.beforeCount;
    _result.afterCount = _arrayDelta.delta.afterCount;
    _result.removed = _arrayDelta.delta.removed;
  }
  // Attached ONLY when something was actually discarded. An always-present empty array
  // would change the result shape for every write and break existing toEqual assertions,
  // and would also report "nothing dropped" as a positive claim on writes that never
  // normalized a targetFiles array at all. DISTINCT from `removed` above: normalization
  // discarding an unknown per-entry key is not an entry disappearing.
  if (_targetFilesReport) {
    if (_targetFilesReport.droppedKeys.length > 0) _result.droppedKeys = _targetFilesReport.droppedKeys;
    if (_targetFilesReport.droppedEntries.length > 0) _result.droppedEntries = _targetFilesReport.droppedEntries;
  }
  return _result;
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

