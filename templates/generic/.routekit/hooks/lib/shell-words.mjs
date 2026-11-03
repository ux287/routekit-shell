/**
 * Quote-aware shell word scanner for the Bash allowlist hooks. Pure, no I/O, never throws.
 * Fail-closed: anything it cannot prove to be a plain list of words returns { ok: false }.
 * @see backlog.fix.bash-metachar-check-quote-aware
 */
const UNQUOTED_META = new Set([";", "&", "|", "`", "$", "(", ")", "{", "}", "<", ">", "\\", "\n", "\r"]);
// Inside double quotes a backslash before one of these changes quoting or expansion: fail closed.
const DQ_SPECIAL_AFTER_BACKSLASH = new Set(["$", "`", "\"", "\\", "\n", "\r"]);

const hasMeta = (text) => [...text].some((ch) => UNQUOTED_META.has(ch));

export function scanShellWords(command) {
  try {
    const s = typeof command === "string" ? command : String(command ?? "");
    const words = [];
    let cur = "";
    let inWord = false;
    let quotedMeta = false;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) return { ok: false, reason: "unbalanced-quote" };
        const body = s.slice(i + 1, end);
        if (body.includes("\n") || body.includes("\r")) return { ok: false, reason: "newline" };
        if (hasMeta(body)) quotedMeta = true;
        cur += body; inWord = true; i = end + 1;
        continue;
      }
      if (c === "\"") {
        let j = i + 1;
        let body = "";
        for (;;) {
          if (j >= s.length) return { ok: false, reason: "unbalanced-quote" };
          const d = s[j];
          if (d === "\"") break;
          if (d === "\n" || d === "\r") return { ok: false, reason: "newline" };
          if (d === "$" || d === "`") return { ok: false, reason: "expansion-in-double-quotes" };
          if (d === "\\") {
            const next = s[j + 1];
            if (next === undefined || DQ_SPECIAL_AFTER_BACKSLASH.has(next)) {
              return { ok: false, reason: "escape-in-double-quotes" };
            }
          }
          body += d; j++;
        }
        if (hasMeta(body)) quotedMeta = true;
        cur += body; inWord = true; i = j + 1;
        continue;
      }
      if (c === " " || c === "\t") {
        if (inWord) { words.push(cur); cur = ""; inWord = false; }
        i++;
        continue;
      }
      if (UNQUOTED_META.has(c)) return { ok: false, reason: "unquoted-metacharacter", char: c };
      cur += c; inWord = true; i++;
    }
    if (inWord) words.push(cur);
    return { ok: true, words, quotedMeta };
  } catch {
    return { ok: false, reason: "scan-error" };
  }
}
