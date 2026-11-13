import fs from "fs";
import path from "path";

/**
 * Files below this line count are read in full (no line-range targeting needed).
 */
const SMALL_FILE_THRESHOLD = 300;

/**
 * Buffer of lines added above/below a detected range to provide context.
 */
const LINE_RANGE_BUFFER = 15;

/**
 * Parse line range from a RAG snippet context comment, e.g.:
 *   // Context: function body for "xxx" (lines 234–317 of 1332)
 * Returns { startLine, endLine } (1-indexed, inclusive) or null.
 */
export function parseLineRangeFromSnippet(snippet) {
  if (!snippet || typeof snippet !== "string") return null;
  // Handle both en-dash (–) and hyphen (-) separators
  const match = snippet.match(/\/\/ Context:.*?\(lines (\d+)[–\-](\d+) of \d+\)/);
  if (match) {
    return { startLine: parseInt(match[1], 10), endLine: parseInt(match[2], 10) };
  }
  return null;
}

/**
 * Read a contiguous line range from a file.
 * Lines are 1-indexed, inclusive.
 * Returns the verbatim slice and the actual line coordinates used.
 */
function readLineRange(absPath, startLine, endLine) {
  const raw = fs.readFileSync(absPath, "utf8");
  const lines = raw.split("\n");
  const totalLines = lines.length;
  const s = Math.max(0, startLine - 1);       // convert to 0-indexed
  const e = Math.min(totalLines, endLine);     // slice end (exclusive) = endLine (1-indexed)
  return {
    content: lines.slice(s, e).join("\n"),
    startLine: s + 1,
    endLine: e,
    totalLines,
  };
}

/**
 * readLiveTargetContent(projectRoot, filePath, ragSnippets?)
 *
 * Returns verbatim current file content with line provenance, or null if the
 * file does not exist on disk.
 *
 * Strategy:
 * - If the file does not exist: return null (new-file creation path unaffected)
 * - If the file is small (≤ SMALL_FILE_THRESHOLD lines) or ragSnippets is empty:
 *     return the full file content
 * - Otherwise: scan ragSnippets for "// Context: ... (lines N–M of T)" comments,
 *     union the detected ranges with a buffer, and return that slice verbatim
 *
 * @param {string} projectRoot - absolute path to project root
 * @param {string} filePath    - relative file path from project root
 * @param {string[]} [ragSnippets=[]] - RAG snippets (used to extract line hints)
 * @returns {{ content: string, startLine: number, endLine: number, totalLines: number, source: 'line-range'|'full-file' } | null}
 */
export function readLiveTargetContent(projectRoot, filePath, ragSnippets = []) {
  const absPath = path.join(projectRoot, filePath);
  if (!fs.existsSync(absPath)) return null;

  const raw = fs.readFileSync(absPath, "utf8");
  const totalLines = raw.split("\n").length;

  // Small file — just return everything
  if (totalLines <= SMALL_FILE_THRESHOLD || !ragSnippets?.length) {
    return { content: raw, startLine: 1, endLine: totalLines, totalLines, source: "full-file" };
  }

  // Extract line range hints from all snippets
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const snippet of ragSnippets) {
    const range = parseLineRangeFromSnippet(snippet);
    if (range) {
      if (range.startLine < minStart) minStart = range.startLine;
      if (range.endLine > maxEnd) maxEnd = range.endLine;
    }
  }

  if (minStart === Infinity) {
    // No line hints found — fall back to full file
    return { content: raw, startLine: 1, endLine: totalLines, totalLines, source: "full-file" };
  }

  // Expand with buffer and clamp to file bounds
  const startLine = Math.max(1, minStart - LINE_RANGE_BUFFER);
  const endLine = Math.min(totalLines, maxEnd + LINE_RANGE_BUFFER);
  const result = readLineRange(absPath, startLine, endLine);
  return { ...result, source: "line-range" };
}
