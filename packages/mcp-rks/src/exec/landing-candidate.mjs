// Landing candidate preparation (backlog.feat.landing-gate-combined-tree-test).
// The tree the landing gate tests must be the tree that lands: bring the target tip
// into the candidate before the gate, and refuse delivery if the target, or the tested
// HEAD, moves after. Every returned field is read back from git on the executed path.
import { spawnSync } from "child_process";
import { resolveFullSuiteGateConfig } from "./full-suite-gate.mjs";
import { provenanceMergeMessageArgs } from "../shared/commit-provenance.mjs";

const GIT_TIMEOUT_MS = 60_000;

function defaultGit(projectRoot, args) {
  return spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
}

function revParse(run, ref) {
  const r = run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.status === 0 ? (r.stdout || "").trim() || null : null;
}

/** Landing preparation is part of the opt-in gate: no valid enabled fullSuiteGate, no landing step. */
export function landingGateEnabled(projectRoot) {
  return resolveFullSuiteGateConfig(projectRoot).enabled === true;
}

/** HEAD read back from git. Call sites read it AFTER the gate run: that observation is testedSha. */
export function readHeadSha(projectRoot, { git = defaultGit } = {}) {
  return revParse((args) => git(projectRoot, args), "HEAD");
}

export const PR_ARM_FOLLOW_UP = "backlog.feat.landing-gate-pr-merged-tree";

/**
 * Volunteered skip (rule R9): the gate is on, but this arm merges on the remote, so no landing
 * candidate is prepared or verified. Null when the gate is off or the arm lands locally.
 */
export function landingSkipRecord({ projectRoot, landsLocally }) {
  if (landsLocally || !landingGateEnabled(projectRoot)) return null;
  return { step: "landing_candidate", skipped: true, reason: "pr_arm_merges_on_remote", followUp: PR_ARM_FOLLOW_UP };
}

export function prepareLandingCandidate({ projectRoot, target, tool = "rks_landing", git = defaultGit }) {
  const run = (args) => git(projectRoot, args);
  const candidateSha = revParse(run, "HEAD");
  const targetSha = revParse(run, target);
  if (!candidateSha || !targetSha) {
    return { ok: false, reason: "unresolvable_ref", target, candidateSha, targetSha };
  }
  if (run(["merge-base", "--is-ancestor", targetSha, candidateSha]).status === 0) {
    return { ok: true, target, candidateSha, targetSha, preparedSha: candidateSha, mergedTarget: false };
  }
  const statusBefore = run(["status", "--porcelain"]).stdout || "";
  const merge = run(["merge", "--no-ff", targetSha, ...provenanceMergeMessageArgs(`Merge ${target} into landing candidate`, { defaultTool: tool })]);
  if (merge.status !== 0) {
    const stderr = (merge.stderr || merge.error?.message || "").trim();
    const mergeHeadSeen = revParse(run, "MERGE_HEAD") !== null;
    const conflictFiles = (run(["diff", "--name-only", "--diff-filter=U"]).stdout || "")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const abort = mergeHeadSeen ? run(["merge", "--abort"]) : null;
    // Read back what the abort left; never assume it restored the candidate.
    const headSha = revParse(run, "HEAD");
    const mergeHeadPresent = revParse(run, "MERGE_HEAD") !== null;
    const statusAfter = run(["status", "--porcelain"]).stdout || "";
    if (headSha !== candidateSha || mergeHeadPresent || statusAfter !== statusBefore) {
      return {
        ok: false, reason: "landing_abort_failed", target, candidateSha, targetSha, headSha, mergeHeadPresent,
        abortStatus: abort ? abort.status : null, abortStderr: (abort?.stderr || "").trim(), stderr,
      };
    }
    if (mergeHeadSeen || conflictFiles.length > 0) {
      return { ok: false, reason: "landing_conflict", target, candidateSha, targetSha, conflictFiles, stderr };
    }
    return { ok: false, reason: "landing_merge_failed", target, candidateSha, targetSha, stderr };
  }
  const preparedSha = revParse(run, "HEAD");
  if (!preparedSha || run(["merge-base", "--is-ancestor", targetSha, preparedSha]).status !== 0) {
    return { ok: false, reason: "landing_merge_unverified", target, candidateSha, targetSha, preparedSha };
  }
  return { ok: true, target, candidateSha, targetSha, preparedSha, mergedTarget: preparedSha !== candidateSha };
}

export function verifyTargetUnmoved({ projectRoot, target, expectedTargetSha, preparedSha, localBranch, git = defaultGit }) {
  const run = (args) => git(projectRoot, args);
  const actualTargetSha = revParse(run, target);
  if (actualTargetSha !== expectedTargetSha) {
    return { ok: false, reason: "target_moved_after_test", target, expectedTargetSha, actualTargetSha };
  }
  if (preparedSha !== undefined) {
    const actualHeadSha = revParse(run, "HEAD");
    if (actualHeadSha !== preparedSha) {
      return { ok: false, reason: "tested_tree_changed", preparedSha, actualHeadSha };
    }
  }
  if (localBranch) {
    const localTargetSha = revParse(run, `refs/heads/${localBranch}`);
    if (localTargetSha && run(["merge-base", "--is-ancestor", localTargetSha, expectedTargetSha]).status !== 0) {
      return { ok: false, reason: "local_target_not_tested", localBranch, localTargetSha, expectedTargetSha };
    }
  }
  return { ok: true, target, targetSha: actualTargetSha };
}
