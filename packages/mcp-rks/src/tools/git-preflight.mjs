import fs from "fs";
import { runGit, getCurrentBranch, isWorkingTreeClean, getUncommittedFiles } from "../utils/git.mjs";

/**
 * MCP tool: rks_git_preflight
 *
 * Git preflight check — dirty tree detection, orphaned worktree cleanup,
 * and branch state verification. Called as a precondition before build/ship.
 *
 * Named rks_git_preflight (distinct from the project-preflight tool rks_preflight
 * in server/preflight.mjs) — the two previously collided on the name
 * "rks_preflight", which made this git tool a shadowed, unreachable duplicate.
 */

export const TOOL_NAME = "rks_git_preflight";

export const TOOL_DESCRIPTION = "Run git preflight checks: dirty tree, worktree cleanup, branch verification";

export const INPUT_SCHEMA = {
  type: "object",
  properties: {
    projectId: {
      type: "string",
      description: "Project identifier from registry",
    },
    expectedBranch: {
      type: "string",
      description: "Expected branch name (optional — verifies current branch matches)",
    },
    autoStash: {
      type: "boolean",
      description: "Auto-stash dirty tree instead of just reporting (default: false)",
    },
    cleanWorktrees: {
      type: "boolean",
      description: "Auto-remove orphaned worktrees (default: true)",
    },
    _governorToken: {
      type: "string",
      description: "Governor session token for authorization",
    },
  },
  required: ["projectId"],
};

/**
 * Check for dirty working tree.
 * @param {string} projectRoot
 * @returns {{ dirty: boolean, files: string[], suggestion: string|null }}
 */
function checkDirtyTree(projectRoot) {
  const clean = isWorkingTreeClean(projectRoot, { throwOnError: false });
  if (clean) {
    return { dirty: false, files: [], suggestion: null };
  }
  const files = getUncommittedFiles(projectRoot, { filterRks: false });
  return {
    dirty: true,
    files,
    suggestion: "Stash or commit uncommitted changes before proceeding",
  };
}

/**
 * Detect and optionally remove orphaned worktrees.
 * @param {string} projectRoot
 * @param {boolean} autoClean
 * @returns {{ orphaned: string[], cleaned: string[], errors: string[] }}
 */
function checkWorktrees(projectRoot, autoClean = true) {
  const orphaned = [];
  const cleaned = [];
  const errors = [];

  try {
    const output = runGit(projectRoot, ["worktree", "list", "--porcelain"]);
    const entries = output.split("\n\n").filter(Boolean);

    for (const entry of entries) {
      const lines = entry.split("\n");
      const worktreeLine = lines.find(l => l.startsWith("worktree "));
      const branchLine = lines.find(l => l.startsWith("branch "));
      const bareLine = lines.find(l => l === "bare");

      if (bareLine || !worktreeLine) continue; // Skip bare repo entry

      const worktreePath = worktreeLine.replace("worktree ", "");

      // Skip the main worktree
      if (worktreePath === projectRoot) continue;

      // Check if worktree path still exists
      if (!fs.existsSync(worktreePath)) {
        orphaned.push(worktreePath);
        if (autoClean) {
          try {
            runGit(projectRoot, ["worktree", "remove", "--force", worktreePath]);
            cleaned.push(worktreePath);
          } catch (e) {
            errors.push(`Failed to remove worktree ${worktreePath}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    errors.push(`Failed to list worktrees: ${e.message}`);
  }

  return { orphaned, cleaned, errors };
}

/**
 * Verify branch state.
 * @param {string} projectRoot
 * @param {string} [expectedBranch]
 * @returns {{ currentBranch: string, matches: boolean, tracking: string|null, ahead: number, behind: number }}
 */
function checkBranch(projectRoot, expectedBranch) {
  const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false }) || "unknown";
  const matches = expectedBranch ? currentBranch === expectedBranch : true;

  let tracking = null;
  let ahead = 0;
  let behind = 0;

  try {
    const status = runGit(projectRoot, ["status", "--porcelain=v2", "--branch"]);
    const upstreamLine = status.split("\n").find(l => l.startsWith("# branch.upstream "));
    if (upstreamLine) {
      tracking = upstreamLine.replace("# branch.upstream ", "");
    }
    const abLine = status.split("\n").find(l => l.startsWith("# branch.ab "));
    if (abLine) {
      const match = abLine.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    }
  } catch { /* best-effort */ }

  return { currentBranch, matches, expectedBranch: expectedBranch || null, tracking, ahead, behind };
}

/**
 * Run all preflight checks.
 * @param {string} projectRoot
 * @param {{ expectedBranch?: string, autoStash?: boolean, cleanWorktrees?: boolean }} opts
 * @returns {{ ok: boolean, dirtyTree: object, worktrees: object, branch: object, stashed?: boolean }}
 */
export function runGitPreflight(projectRoot, { expectedBranch, autoStash = false, cleanWorktrees = true } = {}) {
  const dirtyTree = checkDirtyTree(projectRoot);
  const worktrees = checkWorktrees(projectRoot, cleanWorktrees);
  const branch = checkBranch(projectRoot, expectedBranch);

  let stashed = false;
  if (dirtyTree.dirty && autoStash) {
    try {
      runGit(projectRoot, ["stash", "push", "-m", "rks-preflight-auto-stash"]);
      stashed = true;
      dirtyTree.dirty = false;
      dirtyTree.files = [];
      dirtyTree.suggestion = null;
    } catch { /* stash failed, leave dirty */ }
  }

  const ok = !dirtyTree.dirty && branch.matches && worktrees.errors.length === 0;

  return {
    ok,
    dirtyTree,
    worktrees,
    branch,
    ...(stashed ? { stashed } : {}),
  };
}
