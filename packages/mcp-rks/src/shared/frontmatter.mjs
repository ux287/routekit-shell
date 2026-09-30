import matter from "gray-matter";

/**
 * Check if content has YAML frontmatter
 */
export function hasFrontmatter(content) {
  return /^---\n[\s\S]*?\n---/.test(content);
}

export function parseFrontmatter(content) {
  return matter(String(content || ""));
}

// Characters that require quoting to prevent YAML misinterpretation
const YAML_UNSAFE = /[{}\[\]:#&*!|>@`]|: /;

function yamlQuoteString(s) {
  if (YAML_UNSAFE.test(s) || s.trim() !== s) return JSON.stringify(s);
  return s;
}

/**
 * Byte-stable note split/join pair.
 *
 * NOT `formatWithFrontmatter` above — that one strips authored leading whitespace
 * (`replace(/^\s+/, "")`) and REGENERATES YAML from a parsed object, so it does not round-trip.
 * Routing a note through it trades one silent corruption for another. This pair preserves raw
 * text on both sides and satisfies `join(...split(x)) === x` for any well-formed note.
 *
 * The convention is taken from the site that already had it right —
 * `server/git/git-utils.mjs:262` writes `---\n${frontmatter}\n---${body}`, with NO newline after
 * the closing fence, because `body` (sliced from the end of the match) already begins with one.
 * refine.mjs emitted its own instead, adding a byte per apply while reporting
 * "story note unchanged". See backlog.fix.refine-apply-note-newline-growth-false-unchanged.
 */
export function splitNoteFrontmatter(raw) {
  const s = String(raw ?? "");
  const m = s.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { frontmatter: null, body: s };
  return { frontmatter: m[1], body: s.slice(m[0].length) };
}

export function joinNoteFrontmatter(frontmatter, body) {
  if (frontmatter === null || frontmatter === undefined) return String(body ?? "");
  return "---\n" + String(frontmatter) + "\n---" + String(body ?? "");
}

/**
 * Splice written keys into a raw frontmatter block, leaving every other line byte-identical.
 * backlog.fix.dendron-update-field-rewrites-untouched-frontmatter
 *
 * Rebuilding the whole block (parse → object → serializeFrontmatterYaml) re-emits fields the
 * writer never touched: gray-matter resolves `retrieved: 2026-09-29` to a Date, which then
 * prints via Date.toString() in local time (a day earlier west of UTC), and every string is
 * re-quoted. Here an untouched value is never parsed and re-emitted.
 *
 * A key's block is its column-0 `key:` line plus continuation lines (leading whitespace, or a
 * column-0 `- ` block-sequence item). Each written key is rendered with serializeFrontmatterYaml
 * on a single-key object, so it keeps exactly the form a full rebuild would give it. A missing
 * key is appended; a null/undefined value removes the block.
 *
 * @param {string} frontmatter raw YAML between the fences (no fences)
 * @param {object} updates     { key: value } to write
 * @returns {string} the new raw frontmatter text
 */
export function spliceFrontmatterText(frontmatter, updates) {
  let lines = String(frontmatter).split("\n");
  for (const [key, value] of Object.entries(updates)) {
    const rendered = serializeFrontmatterYaml({ [key]: value });
    const renderedLines = rendered ? rendered.split("\n") : [];
    const keyLine = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\s|$)`);
    const start = lines.findIndex((l) => keyLine.test(l));
    if (start === -1) {
      lines = lines.concat(renderedLines);
      continue;
    }
    let end = start + 1;
    while (end < lines.length && (/^[ \t]/.test(lines[end]) || /^-( |$)/.test(lines[end]))) end += 1;
    lines = [...lines.slice(0, start), ...renderedLines, ...lines.slice(end)];
  }
  return lines.join("\n");
}

/**
 * Splice `updates` into a raw note's frontmatter; the bytes after the closing fence are carried
 * through untouched. Returns null when the note has no frontmatter block (callers fall back to
 * formatWithFrontmatter, which has nothing to preserve).
 */
export function spliceNoteFrontmatter(raw, updates) {
  const split = splitNoteFrontmatter(raw);
  if (split.frontmatter === null) return null;
  return joinNoteFrontmatter(spliceFrontmatterText(split.frontmatter, updates), split.body);
}

/**
 * Splice `updates` into a raw note's frontmatter and REPLACE its body, emitting the body in
 * formatWithFrontmatter's form (closing fence, one blank line, body with leading whitespace
 * stripped) so a body-replacing writer's output format is unchanged. Returns null when the note
 * has no frontmatter block.
 */
export function spliceNoteFrontmatterWithBody(raw, updates, body) {
  const split = splitNoteFrontmatter(raw);
  if (split.frontmatter === null) return null;
  const cleanBody = String(body || "").replace(/^\s+/, "");
  return joinNoteFrontmatter(spliceFrontmatterText(split.frontmatter, updates), "\n\n" + cleanBody);
}

/**
 * Serialize a frontmatter object to YAML text WITHOUT the `---` fences.
 *
 * Extracted verbatim from `formatWithFrontmatter` so a caller that must preserve the
 * body's raw bytes can pair this serializer with `joinNoteFrontmatter` instead of
 * accepting `formatWithFrontmatter`'s leading-whitespace strip. `formatWithFrontmatter`
 * now delegates here, so the two cannot drift and its output is byte-identical to what
 * it emitted before the extraction.
 */
export function serializeFrontmatterYaml(data) {
  return Object.entries(data)
    .map(([k, v]) => {
      if (v === undefined || v === null) return null;
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`;
        return `${k}:\n${v.map((x) => {
          if (typeof x === 'object' && x !== null) {
            // Serialize structured objects as nested YAML (e.g. targetFiles: [{ path, op, desc }])
            const entries = Object.entries(x).filter(([, val]) => val !== undefined && val !== null);
            return entries.map(([ek, ev], i) => {
              const prefix = i === 0 ? '  - ' : '    ';
              const val = typeof ev === 'string' ? JSON.stringify(ev) : ev;
              return `${prefix}${ek}: ${val}`;
            }).join('\n');
          }
          return `  - ${yamlQuoteString(String(x))}`;
        }).join("\n")}`;
      }
      return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function formatWithFrontmatter(data, body) {
  const cleanBody = String(body || "").replace(/^\s+/, "");
  const fm = `---\n${serializeFrontmatterYaml(data)}\n---\n`;
  return `${fm}\n${cleanBody}`;
}

/**
 * Extract a field value from YAML frontmatter
 * Handles both quoted and unquoted values
 */
export function extractFrontmatterField(content, field) {
  const regex = new RegExp(`^${field}:\\s*["']?([\\w-]+)["']?`, 'm');
  const match = content.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract frontmatter block as string
 */
export function extractFrontmatterBlock(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}
