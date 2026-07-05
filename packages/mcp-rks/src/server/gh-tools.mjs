/**
 * GitHub CLI (`gh`) utility functions.
 *
 * Shared module for GitHub operations via the `gh` CLI.
 * Used by Git Agent tools and Ship Agent for atomic GitHub operations.
 *
 * All functions:
 * - Take `projectRoot` for cwd
 * - Return `{ ok: boolean, error?: string, ...data }`
 * - Use `spawnSync('gh', ...)` with `--json` for structured output
 * - Enforce branch protection rails where applicable
 */

import { spawnSync } from "child_process";
import { isProductionBranch, getProtectedBranches } from "./branch-protection.mjs";

/**
 * List pull requests with optional filters.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {string} [params.state="open"] - PR state filter: "open", "closed", "merged", "all"
 * @param {string} [params.base] - Filter by base branch
 * @param {string} [params.author] - Filter by author
 * @param {number} [params.limit=10] - Max results (capped at 50)
 * @returns {{ ok: boolean, prs?: Array, error?: string }}
 */
export function ghPrList({ projectRoot, state = "open", base, author, limit = 10 }) {
  const args = [
    "pr", "list",
    "--state", state,
    "--limit", String(Math.min(limit, 50)),
    "--json", "number,title,url,state,baseRefName,headRefName,author",
  ];
  if (base) { args.push("--base", base); }
  if (author) { args.push("--author", author); }

  const result = spawnSync("gh", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: `gh pr list failed: ${result.stderr?.trim() || "unknown error"}` };
  }

  try {
    const raw = JSON.parse(result.stdout);
    const prs = raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      base: pr.baseRefName,
      head: pr.headRefName,
      author: pr.author?.login || pr.author?.name || "unknown",
    }));
    return { ok: true, prs };
  } catch (e) {
    return { ok: false, error: `Failed to parse gh output: ${e.message}` };
  }
}

/**
 * View a single pull request with details.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {number} [params.prNumber] - PR number (auto-detects from current branch if omitted)
 * @returns {{ ok: boolean, pr?: object, error?: string }}
 */
export function ghPrView({ projectRoot, prNumber }) {
  const args = [
    "pr", "view",
    "--json", "number,title,url,state,baseRefName,headRefName,mergeable,reviewDecision,statusCheckRollup,body,author",
  ];
  if (prNumber) { args.splice(2, 0, String(prNumber)); }

  const result = spawnSync("gh", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: `gh pr view failed: ${result.stderr?.trim() || "no PR found for current branch"}` };
  }

  try {
    const raw = JSON.parse(result.stdout);
    const checks = (raw.statusCheckRollup || []).map((c) => ({
      name: c.name || c.context,
      status: c.status || c.state,
      conclusion: c.conclusion,
    }));
    return {
      ok: true,
      pr: {
        number: raw.number,
        title: raw.title,
        url: raw.url,
        state: raw.state,
        base: raw.baseRefName,
        head: raw.headRefName,
        mergeable: raw.mergeable,
        reviewDecision: raw.reviewDecision,
        checks,
        allChecksPassed: checks.length === 0 || checks.every((c) => c.conclusion === "SUCCESS" || c.status === "COMPLETED"),
        body: raw.body,
        author: raw.author?.login || raw.author?.name || "unknown",
      },
    };
  } catch (e) {
    return { ok: false, error: `Failed to parse gh output: ${e.message}` };
  }
}

/**
 * Create a pull request with base branch enforcement.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {string} params.targetBranch - Base branch for the PR
 * @param {string} params.title - PR title
 * @param {string} [params.body] - PR body/description
 * @returns {{ ok: boolean, url?: string, number?: number, error?: string }}
 */
export function ghPrCreate({ projectRoot, targetBranch, title, body }) {
  // Guard: reject PRs targeting production branch
  if (isProductionBranch(projectRoot, targetBranch)) {
    return {
      ok: false,
      error: `PRs must not target "${targetBranch}" (production branch). Use rks_release to promote to production.`,
      hint: "This rail prevents workflow violations. Only rks_release can advance the production branch.",
    };
  }

  const args = [
    "pr", "create",
    "--base", targetBranch,
    "--title", title,
  ];
  if (body) { args.push("--body", body); }

  const result = spawnSync("gh", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: `gh pr create failed: ${result.stderr?.trim() || "unknown error"}` };
  }

  const url = result.stdout.trim();

  // Parse PR number from URL
  const match = url.match(/\/pull\/(\d+)/);
  const number = match ? parseInt(match[1], 10) : undefined;

  return { ok: true, url, number };
}

/**
 * Merge a pull request.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {number} [params.prNumber] - PR number (auto-detects from current branch if omitted)
 * @param {string} [params.method="squash"] - Merge method: "squash", "merge", "rebase"
 * @param {boolean} [params.deleteBranch=true] - Delete branch after merge
 * @returns {{ ok: boolean, merged?: boolean, error?: string }}
 */
export function ghPrMerge({ projectRoot, prNumber, method = "squash", deleteBranch = true }) {
  const methodFlag = `--${method}`;
  const args = ["pr", "merge"];

  if (prNumber) { args.push(String(prNumber)); }
  args.push(methodFlag);
  if (deleteBranch) { args.push("--delete-branch"); }

  const result = spawnSync("gh", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: `gh pr merge failed: ${result.stderr?.trim() || "unknown error"}` };
  }

  return { ok: true, merged: true };
}

/**
 * Delete git branches (remote and/or local) with protection.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {string[]} params.branches - Branch names to delete
 * @param {boolean} [params.remote=true] - Delete remote branches
 * @param {boolean} [params.local=true] - Delete local branches
 * @returns {{ ok: boolean, deleted: string[], failed: string[], refused: string[] }}
 */
/**
 * Find and delete stale remote branches whose PRs are already merged.
 * Skips protected branches. Use dryRun to preview without deleting.
 *
 * @param {object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {boolean} [params.dryRun=false] - Preview what would be deleted without actually deleting
 * @returns {{ ok: boolean, deleted: string[], skipped: string[], protected: string[], dryRun: boolean }}
 */
export function ghBranchesPrune({ projectRoot, dryRun = false }) {
  const protectedBranches = getProtectedBranches(projectRoot);

  // Step 1: Get branch names from merged PRs
  const prResult = spawnSync("gh", [
    "pr", "list", "--state", "merged", "--limit", "50",
    "--json", "headRefName",
  ], { cwd: projectRoot, encoding: "utf8" });

  if (prResult.status !== 0) {
    return { ok: false, error: `gh pr list failed: ${prResult.stderr?.trim() || "unknown error"}` };
  }

  let mergedBranches;
  try {
    mergedBranches = JSON.parse(prResult.stdout).map((pr) => pr.headRefName);
  } catch (e) {
    return { ok: false, error: `Failed to parse merged PRs: ${e.message}` };
  }

  // Step 2: Get all remote branches
  const remotesResult = spawnSync("git", ["branch", "-r", "--format", "%(refname:short)"], {
    cwd: projectRoot, encoding: "utf8",
  });

  if (remotesResult.status !== 0) {
    return { ok: false, error: `git branch -r failed: ${remotesResult.stderr?.trim() || "unknown error"}` };
  }

  const remoteBranches = remotesResult.stdout.trim().split("\n")
    .filter(Boolean)
    .map((b) => b.replace(/^origin\//, ""))
    .filter((b) => b !== "HEAD");

  // Step 3: Cross-reference — remote branches that match merged PR head branches
  const staleBranches = remoteBranches.filter((b) => mergedBranches.includes(b));

  // Step 4: Filter out protected branches
  const protectedFound = [];
  const candidates = [];
  for (const branch of staleBranches) {
    if (protectedBranches.includes(branch)) {
      protectedFound.push(branch);
    } else {
      candidates.push(branch);
    }
  }

  if (dryRun) {
    return { ok: true, deleted: [], skipped: candidates, protected: protectedFound, dryRun: true };
  }

  // Step 5: Delete stale branches (remote + local)
  const deleted = [];
  const failed = [];
  for (const branch of candidates) {
    const remoteResult = spawnSync("git", ["push", "origin", "--delete", branch], {
      cwd: projectRoot, encoding: "utf8",
    });
    if (remoteResult.status === 0) {
      deleted.push(branch);
    } else {
      const stderr = remoteResult.stderr?.trim() || "";
      if (!stderr.includes("remote ref does not exist")) {
        failed.push(`${branch}: ${stderr}`);
      } else {
        deleted.push(branch); // Already gone from remote
      }
    }
    // Best-effort local cleanup
    spawnSync("git", ["branch", "-d", branch], { cwd: projectRoot, encoding: "utf8" });
  }

  return {
    ok: failed.length === 0,
    deleted,
    failed: failed.length > 0 ? failed : undefined,
    protected: protectedFound.length > 0 ? protectedFound : undefined,
    dryRun: false,
  };
}

export function ghBranchDelete({ projectRoot, branches, remote = true, local = true }) {
  const protectedBranches = getProtectedBranches(projectRoot);
  const deleted = [];
  const failed = [];
  const refused = [];

  for (const branch of branches) {
    if (protectedBranches.includes(branch)) {
      refused.push(branch);
      continue;
    }

    let branchDeleted = false;

    if (remote) {
      const result = spawnSync("git", ["push", "origin", "--delete", branch], {
        cwd: projectRoot, encoding: "utf8",
      });
      if (result.status === 0) {
        branchDeleted = true;
      } else {
        const stderr = result.stderr?.trim() || "";
        // Not an error if remote branch doesn't exist
        if (!stderr.includes("remote ref does not exist")) {
          failed.push(`${branch} (remote): ${stderr}`);
        }
      }
    }

    if (local) {
      const result = spawnSync("git", ["branch", "-d", branch], {
        cwd: projectRoot, encoding: "utf8",
      });
      if (result.status === 0) {
        branchDeleted = true;
      } else {
        const stderr = result.stderr?.trim() || "";
        // Not an error if local branch doesn't exist
        if (!stderr.includes("not found")) {
          failed.push(`${branch} (local): ${stderr}`);
        }
      }
    }

    if (branchDeleted) { deleted.push(branch); }
  }

  return {
    ok: refused.length === 0 && failed.length === 0,
    deleted,
    failed,
    refused: refused.length > 0 ? refused : undefined,
  };
}
