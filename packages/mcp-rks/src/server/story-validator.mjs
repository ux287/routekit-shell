import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runGit } from "../utils/git.mjs";

/**
 * Ensure a backlog story file exists on the remote base branch (origin/<base>).
 * Throws an McpError(ErrorCode.InvalidParams) with user-friendly guidance if the story is not found.
 * Options:
 *   - local: boolean - when true, skip this check (for development/testing)
 * @param {string} projectRoot
 * @param {string} storyId - e.g. "backlog.dendron.mark-implemented-tool"
 * @param {string} [base="staging"]
 * @param {{local?: boolean}} [options={}] 
 */
export function ensureStoryOnRemote(projectRoot, storyId, base = "staging", options = {}) {
  if (options && options.local) {
    return { ok: true, skipped: true };
  }

  if (!storyId || typeof storyId !== "string") {
    return { ok: true, skipped: false };
  }

  const notePath = `notes/${storyId}.md`;
  const remoteSpecifier = `origin/${base}:${notePath}`;

  try {
    runGit(projectRoot, ["show", remoteSpecifier]);
    return { ok: true };
  } catch (err) {
    const message = `⛔ Story not found on remote base branch (origin/${base})\n\n   Story: ${storyId}\n\n   The story exists locally but hasn't been pushed.\n\n   Fix: Push your story to ${base} first:\n     git add notes/${storyId}.md\n     git commit -m "docs: add ${storyId} story"\n     git push origin ${base}\n\n   Then run rks.exec again.`;
    throw new McpError(ErrorCode.InvalidParams, message);
  }
}
