import { runGit, getCurrentBranch } from "../utils/git.mjs";
import { assertNotProtectedBranch } from "../server/branch-protection.mjs";

/**
 * MCP tool: rks_git_push
 *
 * Push a branch to origin. Accepts projectId and optional branch
 * (defaults to current branch). Used by the Ship Governor after
 * commit to push the feature branch before creating a PR.
 */

export const TOOL_NAME = "rks_git_push";

export const TOOL_DESCRIPTION = "Push a branch to origin remote";

export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: {
      type: "string",
      description: "Project identifier from registry",
    },
    branch: {
      type: "string",
      description: "Branch to push (defaults to current branch if omitted)",
    },
    _governorToken: {
      type: "string",
      description: "Governor session token for authorization",
    },
  },
  required: ["projectId"],
};

/**
 * Push a branch to origin.
 * @param {string} projectRoot - Project root directory
 * @param {{ branch?: string }} opts - Options
 * @returns {{ ok: boolean, branch: string, remote: string, error?: string }}
 */
export function runGitPush(projectRoot, { branch } = {}) {
  const resolvedBranch = branch || getCurrentBranch(projectRoot);

  // Safety: don't push protected branches directly
  assertNotProtectedBranch(projectRoot, resolvedBranch);

  try {
    runGit(projectRoot, ["push", "origin", resolvedBranch]);
    return { ok: true, branch: resolvedBranch, remote: "origin" };
  } catch (e) {
    return { ok: false, branch: resolvedBranch, remote: "origin", error: e.message };
  }
}
