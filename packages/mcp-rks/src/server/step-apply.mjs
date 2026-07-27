import fs from "fs";
import path from "path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Apply search/replace edits to a file.
 * @param {string} absPath - Absolute path to the file
 * @param {Array<{search: string, replace: string}>} edits - Array of search/replace pairs
 * @returns {{applied: number}} - Number of edits applied
 * @throws {McpError} - If file not found, search string not found, or ambiguous match
 */
export function applySearchReplace(absPath, edits) {
  if (!fs.existsSync(absPath)) {
    throw new McpError(ErrorCode.InvalidParams, `Cannot search_replace: file not found: ${absPath}`);
  }

  let content = fs.readFileSync(absPath, "utf8");
  const applied = [];
  const failed = [];

  for (const edit of edits) {
    const { search, replace } = edit;
    if (!search || typeof search !== "string") {
      failed.push({ search: String(search).slice(0, 50), reason: "invalid search string" });
      continue;
    }

    const index = content.indexOf(search);
    if (index === -1) {
      failed.push({ search: search.slice(0, 50) + (search.length > 50 ? "..." : ""), reason: "not found" });
      continue;
    }

    // Check for multiple matches (ambiguous)
    const secondIndex = content.indexOf(search, index + 1);
    if (secondIndex !== -1) {
      failed.push({ search: search.slice(0, 50) + (search.length > 50 ? "..." : ""), reason: "ambiguous: multiple matches" });
      continue;
    }

    content = content.slice(0, index) + replace + content.slice(index + search.length);
    applied.push({ search: search.slice(0, 50) + (search.length > 50 ? "..." : "") });
  }

  if (failed.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `search_replace failed: ${failed.map((f) => `"${f.search}": ${f.reason}`).join("; ")}`
    );
  }

  fs.writeFileSync(absPath, content, "utf8");
  return { applied: applied.length };
}

/**
 * Apply a create_file step — write content to disk, creating intermediate directories.
 * @param {string} absPath - Absolute path for the new file
 * @param {string} content - File content to write
 * @throws {McpError} If content is missing or empty
 */
export function applyCreateFile(absPath, content) {
  if (!content || !String(content).trim()) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `create_file step has empty content — plan LLM did not generate file body: ${absPath}. Run rks_refine to inject test exemplar, then retry rks_plan.`
    );
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}
