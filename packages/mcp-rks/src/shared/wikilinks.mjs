// Dendron wikilink parsing and rewriting. Pure: no filesystem access.
// backlog.feat.dendron-rename-note-wikilinks
//
// Covered forms: [[target]], [[label|target]], [[target#anchor]], [[label|target#anchor]]
// and embeds ![[target]] (embeds take the same label/anchor parts). Matching is on the
// EXACT target: [[docs.a.bc]] and [[docs.a.b.c]] are different notes from [[docs.a.b]], so
// a rename map naming only docs.a.b leaves them alone. Text inside fenced code blocks
// (``` or ~~~) is never rewritten.

// [[target]], [[label|target]], [[target#anchor]], ![[target]]
export const WIKILINK_RE = /(!?)\[\[([^\]|#]+\|)?([^\]#|]+)(#[^\]]*)?\]\]/g;

// A Dendron note name: dot-separated hierarchy segments, no path separators, no `..`,
// no empty segment, no `.md` suffix.
export const NOTE_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export function isValidNoteName(name) {
  return typeof name === "string" && NOTE_NAME_RE.test(name);
}

export function parseWikilinks(text) {
  const links = [];
  for (const m of String(text).matchAll(WIKILINK_RE)) {
    links.push({ raw: m[0], embed: m[1] === "!", label: m[2] ? m[2].slice(0, -1) : null, target: m[3].trim(), anchor: m[4] || null, index: m.index });
  }
  return links;
}

// An opening fence: up to three spaces of indent, then 3+ backticks or tildes (CommonMark).
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

function rewriteSegment(segment, renameMap) {
  let count = 0;
  const out = segment.replace(WIKILINK_RE, (raw, bang, labelPart, targetPart, anchor) => {
    const target = targetPart.trim();
    if (!renameMap.has(target)) return raw;
    count++;
    // Keep any whitespace that surrounded the target inside the brackets.
    const lead = targetPart.slice(0, targetPart.indexOf(target));
    const trail = targetPart.slice(lead.length + target.length);
    return `${bang}[[${labelPart || ""}${lead}${renameMap.get(target)}${trail}${anchor || ""}]]`;
  });
  return { text: out, count };
}

/**
 * Rewrite every wikilink whose target is a key of renameMap to the mapped value.
 *
 * @param {string} text
 * @param {Map<string, string>} renameMap - old note name -> new note name
 * @returns {{ text: string, count: number }} count is the number of links actually rewritten.
 *   When nothing matched, the input string itself is returned.
 */
export function rewriteWikilinks(text, renameMap) {
  // renameMap: Map<oldId, newId>. Exact-target match only; fenced code blocks are skipped.
  const src = String(text);
  if (!renameMap || renameMap.size === 0 || !src.includes("[[")) return { text: src, count: 0 };
  const lines = src.split("\n");
  let fence = null; // { ch, len } while inside a fenced block
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);
    if (fence) {
      // A closing fence uses the same character, at least as long, with nothing after it.
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && line.slice(fm[0].length).trim() === "") fence = null;
      continue;
    }
    if (fm) {
      fence = { ch: fm[1][0], len: fm[1].length };
      continue;
    }
    if (!line.includes("[[")) continue;
    const r = rewriteSegment(line, renameMap);
    if (r.count > 0) {
      lines[i] = r.text;
      count += r.count;
    }
  }
  if (count === 0) return { text: src, count: 0 };
  return { text: lines.join("\n"), count };
}
