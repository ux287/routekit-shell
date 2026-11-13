// Ship & cycle-complete orchestration — combines multiple git operations.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { loadContext, getBranchConfig, getWorkflowConfig } from "../project.mjs";
import {
  runGit,
  getCurrentBranch,
  slugify,
} from "./git-utils.mjs";
import { isThreeBranchTopology } from "./branch-delivery.mjs";
import { runGitBranch, runGitCommit, runGitPR } from "./git-workflow.mjs";
import { runStagingMerge, isGitHubRemoteUrl } from "./git-release.mjs";
import { runFullSuiteGate, fullSuiteGateApplies, fullSuiteGateStep } from "../../exec/full-suite-gate.mjs";
import { provenanceMergeMessageArgs } from "../../shared/commit-provenance.mjs";
import { landingGateEnabled, landingSkipRecord, prepareLandingCandidate, readHeadSha, verifyTargetUnmoved } from "../../exec/landing-candidate.mjs";
import { loadStoryTestFiles } from "../../shared/story-test-files.mjs";

/**
 * Load test results from the latest run.json in .rks/runs/.
 * Returns structured test data or null if unavailable. Counts are passed through as observed: a
 * null count stays null (with its countsUnavailableReason), never coerced to 0.
 */
export function loadTestResultsFromRun(projectRoot) {
  try {
    const runsDir = path.join(projectRoot, '.rks', 'runs');
    if (!fs.existsSync(runsDir)) return null;

    const runs = fs.readdirSync(runsDir).filter(d => {
      return fs.statSync(path.join(runsDir, d)).isDirectory();
    }).sort().reverse();
    if (runs.length === 0) return null;

    const runJsonPath = path.join(runsDir, runs[0], 'run.json');
    if (!fs.existsSync(runJsonPath)) return null;

    const runData = JSON.parse(fs.readFileSync(runJsonPath, 'utf8'));

    if (runData.testVerification) {
      return {
        passCount: runData.testVerification.passCount ?? null,
        failCount: runData.testVerification.failCount ?? null,
        countsUnavailableReason: runData.testVerification.countsUnavailableReason ?? null,
        duration: runData.testVerification.duration ? `${(runData.testVerification.duration / 1000).toFixed(1)}s` : undefined,
        runner: runData.testVerification.runner || undefined,
        attempts: runData.attempts || 1,
        // Sourced from the record it describes, never a literal.
        testsSkipped: runData.testsSkipped === true,
      };
    } else if (runData.testsSkipped) {
      return {
        testsSkipped: true,
        skipReason: runData.skipReason || "paired test story will cover test execution",
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Sync the working branch to origin after a merge, cleaning up merged branches.
 *
 * backlog.fix.cycle-complete-ungated-hard-reset: this function performs
 * `git reset --hard origin/<working>`, which DESTROYS unpushed local commits. It used to do so
 * unconditionally — it computed how many commits it was about to discard, formatted a warning
 * saying so, and then reset anyway, returning the warning as an informational field on an
 * `ok: true` payload that nothing consumed as a blocker. On 2026-08-21 that destroyed ~30
 * unpushed commits in this repository.
 *
 * The reset itself is legitimate; being ungated was the defect. `discardLocalCommits` is the
 * opt-in, modelled on `runBranchRepair`'s `confirm` flag in git-release.mjs — same operation,
 * same posture: destructive actions require explicit consent, and absent consent we refuse
 * rather than proceed.
 *
 * @param {boolean} [discardLocalCommits=false] - Explicit opt-in to discard unpushed local
 *   commits on the working branch. Absent or false, a diverged branch causes a refusal
 *   (`ok: false`) and NO reset. Irrelevant when the branch is not ahead: the reset is a no-op
 *   there and runs unchanged.
 *
 * backlog.fix.cycle-complete-discards-uncommitted-changes: the reset was also destroying
 * UNCOMMITTED tracked changes it did not own — e.g. the `unstagedOutOfScope` paths that
 * `rks_guardrails_on` deliberately leaves in the worktree. The sync is now non-destructive
 * whenever a reset is not genuinely required: equal to origin → skip; behind → `merge --ff-only`
 * (git itself refuses if a local change would be overwritten). Only the ahead +
 * `discardLocalCommits` path still resets, and over a dirty tracked tree it refuses unless
 * `discardUncommitted` is also strictly true.
 *
 * @param {boolean} [discardUncommitted=false] - FUNCTION-LEVEL ONLY. Explicit opt-in to discard
 *   uncommitted changes to tracked files when a hard reset is required. Deliberately NOT exposed
 *   on any MCP schema: from the MCP surface the user commits or stashes instead.
 * @param {boolean} [requireWorkingBranch=false] - Refuse with reason `not_on_working_branch`
 *   (ok: false, nothing touched) when the current branch is not the working branch. Set only by
 *   the rks_cycle_complete handler for a ship session at `committed`.
 * @returns Result carrying `preservedPaths` (ok) — tracked paths dirty before the sync step AND
 *   still dirty after it, from observed `git status` — or `dirtyPaths` (refusal) — tracked paths
 *   from the observed pre-sync status. Both are always arrays, `[]` on a clean tree.
 */
export async function runCycleComplete({ projectRoot, projectId, discardLocalCommits = false, discardUncommitted = false, requireWorkingBranch = false }) {
  const timestamp = new Date().toISOString();
  const currentBranch = runGit(projectRoot, ['branch', '--show-current']).trim();
  const previousHead = runGit(projectRoot, ['rev-parse', 'HEAD']).slice(0, 7);

  let branchConfig = { working: "staging", integration: "staging", production: "main" };
  let workflowConfig = { autoMergeIntegration: true, workingBranchLocal: false };

  if (projectId) {
    try {
      const context = await loadContext(projectId);
      branchConfig = getBranchConfig(context.record, context.projectJson);
      workflowConfig = getWorkflowConfig(context.record, context.projectJson);
    } catch (e) {
      console.warn(`[rks_cycle_complete] Failed to load context for ${projectId}, using defaults`);
    }
  }

  const { working, integration, production } = branchConfig;
  // backlog.fix.ship-flow-deterministic-no-llm (AC9 option A, the WHETHER half of the guard):
  // the rks_cycle_complete handler sets requireWorkingBranch for a ship session at `committed`
  // (no merge observed). Off the working branch the checkout and `branch -D` below would delete
  // an unmerged feature branch, so refuse before any fetch, checkout or delete.
  if (requireWorkingBranch === true && currentBranch !== working) {
    const error = `Refusing cycle_complete: current branch '${currentBranch}' is not the working branch '${working}' and no merge was observed`;
    console.warn(`[rks_cycle_complete] ${error}`);
    return { ok: false, action: 'cycle_complete', reason: 'not_on_working_branch', currentBranch, working, error };
  }
  // NOTE: only the parenthesised topology comparison moves to the shared predicate.
  // The `workflowConfig.workingBranchLocal ||` disjunct and the promotion to `true`
  // below are NOT topology reads and must survive unchanged.
  let workingBranchLocal = workflowConfig.workingBranchLocal || isThreeBranchTopology(branchConfig);
  if (!workingBranchLocal) {
    const remoteCheck = spawnSync("git", ["ls-remote", "--heads", "origin", working], { cwd: projectRoot, encoding: "utf8" });
    if (remoteCheck.status !== 0 || !remoteCheck.stdout.trim()) {
      workingBranchLocal = true;
    }
  }
  const collector = ensureTelemetryStorage(projectRoot);
  let dirtyBefore = null;

  try {
    if (!workingBranchLocal) {
      runGit(projectRoot, ['fetch', 'origin']);
    }

    if (currentBranch !== working) {
      runGit(projectRoot, ['checkout', working]);
    }

    // Observed BEFORE the sync step (and after the checkout, so it describes the working branch's
    // tree). Tracked entries only — untracked files are never touched by reset/ff and never gate.
    dirtyBefore = trackedDirtyPaths(projectRoot);

    let divergenceWarning = null;
    let localCommitsDiscarded = 0;
    // null = unknown (rev-list failed). Only a measured 0/0 or 0/N takes the non-destructive path.
    let aheadCount = null;
    let behindCount = null;
    if (!workingBranchLocal) {
      try {
        const aheadBehind = runGit(projectRoot, ['rev-list', '--left-right', '--count', `${working}...origin/${working}`]).trim();
        const [ahead, behind] = aheadBehind.split(/\s+/).map(Number);
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          aheadCount = ahead;
          behindCount = behind;
        }
        if (ahead > 0) {
          localCommitsDiscarded = ahead;
          divergenceWarning = `Warning: ${ahead} local commit(s) on ${working} will be lost by hard reset to origin/${working}`;
        }
      } catch (e) {
        // If rev-list fails, continue anyway
      }
    }

    // ── backlog.fix.cycle-complete-ungated-hard-reset: THE GATE ──
    //
    // Everything needed to make this decision was already computed above — the divergence count
    // and the warning string. The defect was that nothing acted on them. Refuse here, BEFORE the
    // reset below and before the branch-cleanup blocks that follow it.
    //
    // Returning early deliberately skips the feature-branch deletion and the stale `rks/*` sweep.
    // That is correct: those are cleanup steps for a completed cycle, and this cycle did not
    // complete. A merged stale branch surviving a refusal is the pinned, intended behaviour —
    // deleting branches on the way out of a refusal would be a second destructive act performed
    // without consent.
    // Strict `=== true`: only a real boolean true authorises destroying commits. A truthy string
    // or number arriving from a loosely-typed caller must NOT be able to consent on the user's
    // behalf.
    if (localCommitsDiscarded > 0 && discardLocalCommits !== true) {
      return {
        ok: false,
        action: 'cycle_complete',
        error: `Refusing to hard-reset ${working}: ${localCommitsDiscarded} local commit(s) would be lost`,
        branch: working,
        previousBranch: currentBranch,
        localCommitsDiscarded,
        divergenceWarning,
        hint: `Push ${working} to origin first, or re-run with discardLocalCommits: true to discard the ${localCommitsDiscarded} local commit(s) deliberately.`,
        dirtyPaths: dirtyBefore,
        branchConfig,
        metadata: { timestamp },
      };
    }

    // ── backlog.fix.cycle-complete-discards-uncommitted-changes: sync without destroying ──
    //
    // A hard reset is only NEEDED when the branch is ahead (or its position is unknown). Equal to
    // origin → nothing to do. Behind → fast-forward only; git refuses on its own if a local change
    // would be overwritten, and that refusal is reported verbatim — never synthesized.
    if (!workingBranchLocal && aheadCount === 0) {
      if (behindCount > 0) {
        try {
          runGit(projectRoot, ['merge', '--ff-only', `origin/${working}`]);
        } catch (e) {
          return {
            ok: false,
            action: 'cycle_complete',
            // git's own error text. Not attributed to dirty paths: dirtyPaths is the observed
            // status alone, and is [] when the tracked tree was clean.
            error: e.message || String(e),
            branch: working,
            previousBranch: currentBranch,
            dirtyPaths: dirtyBefore,
            ...(dirtyBefore.length > 0 ? { hint: commitOrStashHint(dirtyBefore) } : {}),
            branchConfig,
            metadata: { timestamp },
          };
        }
      }
    } else if (!workingBranchLocal) {
      // The reset below discards uncommitted tracked changes as well as commits. That needs its
      // own consent — `discardLocalCommits` speaks only for commits. Strict `=== true`, as above.
      // Returning here skips branch cleanup, mirroring the unpushed-commit gate.
      if (dirtyBefore.length > 0 && discardUncommitted !== true) {
        return {
          ok: false,
          action: 'cycle_complete',
          error: `Refusing to hard-reset ${working}: uncommitted changes to ${dirtyBefore.length} tracked file(s) would be lost: ${dirtyBefore.join(', ')}`,
          branch: working,
          previousBranch: currentBranch,
          localCommitsDiscarded,
          divergenceWarning,
          dirtyPaths: dirtyBefore,
          hint: commitOrStashHint(dirtyBefore),
          branchConfig,
          metadata: { timestamp },
        };
      }
      runGit(projectRoot, ['reset', '--hard', `origin/${working}`]);
    }

    // Observed AFTER the sync step: a path is "preserved" only if it was dirty before AND is
    // still dirty now. Never derived from the before-status or from intent alone.
    const dirtyAfter = new Set(trackedDirtyPaths(projectRoot));
    const preservedPaths = dirtyBefore.filter((p) => dirtyAfter.has(p));

    let deletedBranch = null;
    if (currentBranch !== working && currentBranch !== production) {
      try {
        runGit(projectRoot, ['branch', '-D', currentBranch]);
        deletedBranch = currentBranch;
      } catch (e) {
        // Branch might already be deleted
      }
    }

    const staleBranches = [];
    try {
      const allBranches = runGit(projectRoot, ['branch', '--list', 'rks/*']).split('\n')
        .map(b => b.trim().replace(/^\*\s*/, ''))
        .filter(Boolean);

      for (const branch of allBranches) {
        if (branch === currentBranch) continue;

        let merged = false;
        try {
          const mergedBranches = runGit(projectRoot, ['branch', '--merged', working]);
          merged = mergedBranches.split('\n').map(b => b.trim().replace(/^\*\s*/, '')).includes(branch);
        } catch (e) { /* treat as unmerged */ }

        let lastCommit = "";
        let age = "";
        try {
          lastCommit = runGit(projectRoot, ['log', '-1', '--format=%s', branch]);
          age = runGit(projectRoot, ['log', '-1', '--format=%cr', branch]);
        } catch (e) { /* leave empty */ }

        if (merged) {
          try {
            runGit(projectRoot, ['branch', '-D', branch]);
            staleBranches.push({ name: branch, age, lastCommit, merged: true, deleted: true });
          } catch (e) {
            staleBranches.push({ name: branch, age, lastCommit, merged: true, deleted: false });
          }
        } else {
          staleBranches.push({ name: branch, age, lastCommit, merged: false, deleted: false });
        }
      }
    } catch (e) {
      // Skip stale branch cleanup
    }

    const newHead = runGit(projectRoot, ['rev-parse', 'HEAD']).slice(0, 7);

    collector.emit('cycle.complete', projectId, {
      previousBranch: currentBranch, branchCleaned: deletedBranch, localCommitsDiscarded,
      previousHead, newHead, staleBranchCount: staleBranches.length,
      staleBranchesDeleted: staleBranches.filter(b => b.deleted).length,
    });

    return {
      ok: true, action: 'cycle_complete', previousBranch: currentBranch, deletedBranch, newHead,
      branch: working, synced: !workingBranchLocal, divergenceWarning, preservedPaths,
      staleBranches: staleBranches.length > 0 ? staleBranches : undefined,
      branchConfig, metadata: { timestamp }
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error), dirtyPaths: dirtyBefore ?? [] };
  }
}

/**
 * Tracked paths with uncommitted changes (modified, staged, deleted, renamed), from an observed
 * `git status --porcelain -z`. Untracked (`??`) entries are excluded. Sorted, de-duplicated.
 *
 * Not routed through runGit: runGit trims stdout, which would eat the leading status column of
 * the first entry (" M file.txt").
 */
function trackedDirtyPaths(projectRoot) {
  const res = spawnSync("git", ["status", "--porcelain", "-z"], { cwd: projectRoot, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(res.stderr?.trim() || "git status failed");
  }
  const entries = res.stdout.split("\0");
  const paths = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy === "??" || xy === "!!") continue;
    paths.add(entry.slice(3));
    // Renames/copies carry the original path as the NEXT NUL-separated field; skip it.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return [...paths].sort();
}

function commitOrStashHint(paths) {
  return `Commit or stash the uncommitted change(s) to ${paths.join(', ')} first, then re-run cycle_complete.`;
}

// ── backlog.feat.rks-ship-local-merge-on-non-github-remote ──
//
// `.rks/project.json` → `ship.pullRequests` decides whether runShip opens a PR (via `gh`) when
// the target branch exists on origin:
//   "auto"   (default; also any absent or invalid value) — PR only when origin is a GitHub remote
//   "always" — PR whenever the target exists on the remote (the pre-existing behaviour)
//   "never"  — never a PR: merge locally and push the target
export const SHIP_PULL_REQUEST_MODES = Object.freeze(["auto", "always", "never"]);

/**
 * Pure resolver: configured `pullRequests` value + origin URL → PR-or-local decision.
 * Absent or invalid values resolve exactly as "auto".
 * @returns {{ mode: "pr" } | { mode: "local", reason: "non_github_remote" | "pull_requests_never" }}
 */
export function resolveShipPullRequestMode({ pullRequests, originUrl } = {}) {
  const configured = SHIP_PULL_REQUEST_MODES.includes(pullRequests) ? pullRequests : "auto";
  if (configured === "always") return { mode: "pr" };
  if (configured === "never") return { mode: "local", reason: "pull_requests_never" };
  return isGitHubRemoteUrl(originUrl) ? { mode: "pr" } : { mode: "local", reason: "non_github_remote" };
}

/** The configured ship.pullRequests value: from the loaded project.json, else <projectRoot>/.rks/project.json. */
function readShipPullRequests(projectRoot, projectJson) {
  if (projectJson && typeof projectJson === "object") return projectJson.ship?.pullRequests;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, ".rks", "project.json"), "utf8"));
    return cfg?.ship?.pullRequests;
  } catch {
    return undefined;
  }
}

const SHIP_GIT_TIMEOUT_MS = 120_000;

/**
 * Local path for a target branch that EXISTS on origin: fast-forward the target from
 * origin/<target> (refusing if it has diverged), merge the feature branch with --no-ff, then
 * push the target. A rejected push leaves the merge commit in place locally.
 *
 * landing — the prepareLandingCandidate result when the landing gate prepared this ship
 * (backlog.feat.landing-gate-combined-tree-test), else null. Verified right after this
 * function's own fetch, before any checkout or merge.
 */
function localMergeAndPushTarget({ projectRoot, featureBranch, targetBranch, landing = null }) {
  const git = (args) => spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS });
  const stderrOf = (r) => (r.stderr || r.error?.message || "").trim();

  const fetch = git(["fetch", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`]);
  if (fetch.status !== 0) {
    return { ok: false, step: "merge", error: `Fetch of origin/${targetBranch} failed: ${stderrOf(fetch)}` };
  }

  // The fetch above observed the tip the fast-forward below would use: it must be the tip the
  // gate tested, HEAD must be the tested tree, and the local target must hold nothing untested.
  if (landing) {
    const landingVerify = verifyTargetUnmoved({ projectRoot, target: `origin/${targetBranch}`, expectedTargetSha: landing.targetSha, preparedSha: landing.preparedSha, localBranch: targetBranch });
    if (!landingVerify.ok) {
      return { ok: false, step: "landing_verify", error: `Landing verify refused the merge into ${targetBranch} (${landingVerify.reason}): the tree the gate tested is not the tree that would land`, landingVerify };
    }
  }

  const localExists = git(["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`]).status === 0;
  let behind = 0;
  if (localExists) {
    const counts = git(["rev-list", "--left-right", "--count", `${targetBranch}...origin/${targetBranch}`]);
    const [ahead, behindCount] = (counts.stdout || "").trim().split(/\s+/).map(Number);
    if (counts.status !== 0 || !Number.isFinite(ahead) || !Number.isFinite(behindCount)) {
      return { ok: false, step: "merge", error: `Could not compare ${targetBranch} with origin/${targetBranch}: ${stderrOf(counts)}` };
    }
    if (ahead > 0 && behindCount > 0) {
      return {
        ok: false, step: "merge",
        error: `Local ${targetBranch} has diverged from origin/${targetBranch} (${ahead} local commit(s) not on origin, ${behindCount} origin commit(s) not local). Refusing to merge; reconcile ${targetBranch} with origin/${targetBranch} first, then re-run the ship.`,
      };
    }
    behind = behindCount;
  }

  const checkout = localExists
    ? git(["checkout", targetBranch])
    : git(["checkout", "-b", targetBranch, `origin/${targetBranch}`]);
  if (checkout.status !== 0) {
    return { ok: false, step: "merge", error: `Checkout ${targetBranch} failed: ${stderrOf(checkout)}` };
  }

  if (behind > 0) {
    const ff = git(["merge", "--ff-only", `origin/${targetBranch}`]);
    if (ff.status !== 0) {
      git(["checkout", featureBranch]);
      return { ok: false, step: "merge", error: `Fast-forward of ${targetBranch} from origin/${targetBranch} failed: ${stderrOf(ff)}` };
    }
  }

  const merge = git(["merge", "--no-ff", featureBranch, ...provenanceMergeMessageArgs(`Merge ${featureBranch} into ${targetBranch}`, { defaultTool: "rks_ship" })]);
  if (merge.status !== 0) {
    git(["merge", "--abort"]);
    git(["checkout", featureBranch]);
    return { ok: false, step: "merge", error: `Local merge failed: ${stderrOf(merge)}` };
  }
  const commitId = (git(["rev-parse", "HEAD"]).stdout || "").trim() || null;

  const push = git(["push", "origin", targetBranch]);
  if (push.status !== 0) {
    // The merge commit stays on the local target branch and the feature branch is kept, so
    // nothing is lost; the push can be retried once the remote accepts it.
    return { ok: false, step: "push_target", commitId, error: `Push of ${targetBranch} to origin failed: ${stderrOf(push)}` };
  }

  git(["branch", "-d", featureBranch]);
  return { ok: true, commitId };
}

/**
 * The observed branch state after a refusal that follows a successful landing preparation
 * (backlog.fix.landing-refusal-hints-observed-branch-state). Each claim is gated on its own
 * observation on this call:
 *   - targetUntouched: the caller states it only where targetBranch was in fact not merged into
 *     (never on push_target, where the local target already holds the merge commit);
 *   - the landing merge commit: only when landing.mergedTarget is true, naming landing.preparedSha;
 *   - the feature-branch push: only when that push ran and returned status 0 on this call.
 * Returns null when landing is null (gate disabled, or the PR arm), so those refusals are unchanged.
 */
function landingRefusalNote({ landing, featureBranch, targetBranch, featureBranchPushed = false, targetUntouched = true, nothingPushed = false }) {
  if (!landing) return null;
  const claims = [];
  if (nothingPushed) claims.push(`Nothing was pushed on this call: ${targetBranch} was not merged into and not pushed, and ${featureBranch} was not pushed.`);
  else if (targetUntouched) claims.push(`${targetBranch} was not merged into and not pushed.`);
  if (landing.mergedTarget === true) {
    claims.push(`${featureBranch} now carries the landing merge commit ${landing.preparedSha} (${landing.target} at ${landing.targetSha} merged in before the gate).`);
  }
  if (featureBranchPushed) {
    claims.push(landing.mergedTarget === true
      ? `${featureBranch} was pushed to origin on this call, so origin's copy of ${featureBranch} also holds the landing merge commit ${landing.preparedSha}.`
      : `${featureBranch} was pushed to origin on this call.`);
  }
  return claims.join(" ");
}

/** `{ hint }` for a refusal after landing preparation, or `{}` when no landing was prepared. */
function landingRefusalHint(observed, next) {
  const note = landingRefusalNote(observed);
  return note === null ? {} : { hint: `${note} ${next}` };
}

export async function runShip({
  projectRoot, message, scope, type = "feat", files, branchName,
  branchType = "feature", prTitle, problemId, reason, projectId,
  // backlog.fix.cycle-complete-ungated-hard-reset: threaded through to runCycleComplete.
  // Defaults false — a ship does not implicitly consent to discarding unpushed local commits.
  discardLocalCommits = false,
  // backlog.fix.git-commit-broad-add-fallback: an absent or empty `files` stages everything
  // ONLY when the caller states stageAll: true; it is forwarded to runGitCommit unchanged.
  stageAll = false,
}) {
  const timestamp = new Date().toISOString();
  const steps = [];
  const collector = ensureTelemetryStorage(projectRoot);

  const effectiveReason = reason || (!problemId ? "off-rail" : undefined);
  collector.emit("ship.start", projectId, { message, scope, type, problemId });

  try {
    let targetBranch = "staging";
    let loadedProjectJson = null;
    try {
      const ctx = await loadContext(projectId);
      loadedProjectJson = ctx.projectJson ?? null;
      const branchCfg = getBranchConfig(ctx.record, ctx.projectJson);
      targetBranch = branchCfg.working || "staging";
    } catch { /* fallback to staging */ }

    const currentBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
    const alreadyOnFeatureBranch = currentBranch.startsWith("rks/");

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
    const hasChanges = status.stdout.trim().length > 0;

    let isAheadOfTarget = false;
    if (alreadyOnFeatureBranch && !hasChanges) {
      const ahead = spawnSync("git", ["rev-list", "--count", `${targetBranch}..HEAD`], { cwd: projectRoot, encoding: "utf8" });
      isAheadOfTarget = parseInt(ahead.stdout?.trim() || "0", 10) > 0;
    }

    // Reject an absent or empty files list without the stageAll opt-in BEFORE any branch is
    // created, so the refusal never strands a new branch (backlog.fix.git-commit-broad-add-fallback).
    if (hasChanges && stageAll !== true && !(Array.isArray(files) && files.length > 0)) {
      const error = "runShip: the files argument is absent or empty, and there is no all-files fallback. Pass an explicit files list, or stageAll: true to stage every change.";
      collector.emit("ship.failed", projectId, { step: "check_files", error });
      return { ok: false, error, metadata: { timestamp } };
    }

    if (!hasChanges && !isAheadOfTarget) {
      collector.emit("ship.failed", projectId, { step: "check_status", error: "No changes to ship" });
      return { ok: false, error: "No changes to ship", metadata: { timestamp } };
    }

    if (alreadyOnFeatureBranch) {
      steps.push({ step: "branch", ok: true, branch: currentBranch, baseBranch: targetBranch, reused: true });
      collector.emit("ship.step.completed", projectId, { step: "branch", branch: currentBranch });
    } else {
      const finalBranchName = branchName || slugify(message).slice(0, 40);
      const branchResult = await runGitBranch({ projectRoot, name: finalBranchName, type: branchType });

      if (!branchResult.ok) {
        collector.emit("ship.failed", projectId, { step: "branch", error: branchResult.error });
        return { ok: false, error: `Branch creation failed: ${branchResult.error}`, steps, metadata: { timestamp } };
      }

      steps.push({ step: "branch", ...branchResult });
      collector.emit("ship.step.completed", projectId, { step: "branch", branch: branchResult.branch });
    }

    if (hasChanges) {
      const commitResult = await runGitCommit({ projectRoot, message, scope, type, files, stageAll });

      if (!commitResult.ok) {
        collector.emit("ship.failed", projectId, { step: "commit", error: commitResult.error });
        return { ok: false, error: `Commit failed: ${commitResult.error}`, steps, metadata: { timestamp } };
      }

      steps.push({ step: "commit", ...commitResult });
      collector.emit("ship.step.completed", projectId, { step: "commit", commitId: commitResult.commitId });
    } else {
      steps.push({ step: "commit", skipped: true, reason: "already_committed" });
    }

    // The delivering arm is decided here, before the gate, so the landing preparation below
    // knows whether this ship lands locally (backlog.feat.landing-gate-combined-tree-test).
    // Both reads are read-only.
    const remoteCheck = spawnSync("git", ["ls-remote", "--heads", "origin", targetBranch], { cwd: projectRoot, encoding: "utf8" });
    const targetExistsOnRemote = remoteCheck.status === 0 && remoteCheck.stdout.trim().length > 0;

    // ship.pullRequests decides PR vs local merge, only when the target exists on the remote.
    let prDecision = null;
    if (targetExistsOnRemote) {
      const originUrl = spawnSync("git", ["remote", "get-url", "origin"], { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS }).stdout?.trim() || "";
      prDecision = resolveShipPullRequestMode({ pullRequests: readShipPullRequests(projectRoot, loadedProjectJson), originUrl });
    }
    const landsLocally = !targetExistsOnRemote || prDecision.mode === "local";

    // PR arm: the merge happens on the remote, so no landing candidate is prepared or verified
    // here. With the gate enabled the skip is volunteered as a step; with it off there is none.
    const landingSkip = landingSkipRecord({ projectRoot, landsLocally });
    if (landingSkip) {
      steps.push(landingSkip);
      collector.emit("ship.step.completed", projectId, landingSkip);
      console.error(`[rks_ship] landing gate skipped (${landingSkip.reason}): the PR arm merges on the remote, so the merged tree is not tested here; follow-up ${landingSkip.followUp}`);
    }

    // Landing candidate (backlog.feat.landing-gate-combined-tree-test). Part of the opt-in gate,
    // and only on an arm that merges locally: fetch the target first, then merge its tip into the
    // feature branch so the gate tests the tree that will land. A refusal pushes nothing.
    let landing = null;
    let landingBranch = null;
    if (landsLocally && landingGateEnabled(projectRoot)) {
      const landingTarget = targetExistsOnRemote ? `origin/${targetBranch}` : targetBranch;
      if (targetExistsOnRemote) {
        const landingFetch = spawnSync("git", ["fetch", "origin", `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`], { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS });
        if (landingFetch.status !== 0) {
          const error = `Fetch of origin/${targetBranch} before landing preparation failed: ${(landingFetch.stderr || landingFetch.error?.message || "").trim()}`;
          collector.emit("ship.failed", projectId, { step: "landing_candidate", error });
          return { ok: false, error, failedStep: "landing_candidate", steps, metadata: { timestamp } };
        }
      }
      const landingPrep = prepareLandingCandidate({ projectRoot, target: landingTarget, tool: "rks_ship" });
      steps.push({ step: "landing_candidate", ...landingPrep });
      if (!landingPrep.ok) {
        const error = `Landing candidate refused ship (${landingPrep.reason}): ${landingTarget} could not be combined with the feature branch`;
        collector.emit("ship.failed", projectId, { step: "landing_candidate", error, reason: landingPrep.reason });
        return { ok: false, error, failedStep: "landing_candidate", landingCandidate: landingPrep, steps, metadata: { timestamp } };
      }
      landing = landingPrep;
      // The branch that now holds preparedSha, observed here; refusal hints below name it.
      landingBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS }).stdout?.trim() || currentBranch;
      collector.emit("ship.step.completed", projectId, { step: "landing_candidate", target: landingTarget, targetSha: landingPrep.targetSha, preparedSha: landingPrep.preparedSha, mergedTarget: landingPrep.mergedTarget });
    }

    // Full-suite regression gate (backlog.feat.full-suite-regression-gate). OPT-IN ONLY:
    // with no fullSuiteGate in .rks/project.json it runs nothing and adds no step or field.
    // After the commit if/else (so it runs whether or not a commit was made, on a reused or
    // a new branch) and before the feature-branch push, the PR and the local merge. A block
    // pushes nothing and adds no pr or merge step. The story's own testFiles join a scoped run.
    const fullSuiteGate = runFullSuiteGate(projectRoot, { extraTestPaths: loadStoryTestFiles(projectRoot, problemId) ?? [] });
    if (fullSuiteGateApplies(fullSuiteGate)) {
      // testedSha is HEAD observed after the run, never the prepared SHA restated.
      const testedSha = landing ? readHeadSha(projectRoot) : null;
      steps.push(fullSuiteGateStep(fullSuiteGate, landing ? { landing, testedSha } : undefined));
      if (fullSuiteGate.blocked) {
        const error = `Full-suite regression gate blocked ship (${fullSuiteGate.reason})`;
        collector.emit("ship.failed", projectId, { step: "full_suite_gate", error, reason: fullSuiteGate.reason, newFailures: fullSuiteGate.newFailures ?? [] });
        return { ok: false, error, failedStep: "full_suite_gate", fullSuiteGate, ...landingRefusalHint({ landing, featureBranch: landingBranch, targetBranch, nothingPushed: true }, "Fix the new failing tests (fullSuiteGate.newFailures), or fix fullSuiteGate in .rks/project.json, then retry rks_ship."), steps, metadata: { timestamp } };
      }
      collector.emit("ship.step.completed", projectId, { step: "full_suite_gate", reason: fullSuiteGate.reason });
    }

    // Observed, never inferred from alreadyOnFeatureBranch: true only when the push below ran and
    // returned status 0 on this call (backlog.fix.landing-refusal-hints-observed-branch-state).
    let featureBranchPushed = false;
    if (alreadyOnFeatureBranch) {
      const pushResult = spawnSync("git", ["push", "-u", "origin", currentBranch], { cwd: projectRoot, encoding: "utf8" });
      featureBranchPushed = pushResult.status === 0;
      if (pushResult.status !== 0) {
        collector.emit("ship.failed", projectId, { step: "push", error: `Push failed: ${pushResult.stderr?.trim()}` });
        return { ok: false, error: `Push failed: ${pushResult.stderr?.trim()}`, ...landingRefusalHint({ landing, featureBranch: landingBranch, targetBranch }, "Fix the push of the feature branch, then retry rks_ship."), steps, metadata: { timestamp } };
      }
    }

    let prResult = null;
    let mergeResult = null;

    if (targetExistsOnRemote && prDecision.mode === "local") {
      const featureBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS }).stdout.trim();
      const local = localMergeAndPushTarget({ projectRoot, featureBranch, targetBranch, landing });
      if (!local.ok) {
        if (local.step === "push_target") {
          steps.push({ step: "pr", skipped: true, reason: prDecision.reason });
          steps.push({ step: "merge", ok: true, localMerge: true, pushed: false, from: featureBranch, into: targetBranch, commitId: local.commitId });
        }
        collector.emit("ship.failed", projectId, { step: local.step, error: local.error });
        if (local.step === "push_target") {
          // The merge is local only: HEAD sits on the target holding an unpushed merge commit and the
          // feature branch is kept. Report the observed HEAD and the retry step; no git state changes.
          const headBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8", timeout: SHIP_GIT_TIMEOUT_MS }).stdout?.trim() || null;
          // The local target holds the merge commit here, so no target-untouched claim is made.
          const landingNote = landingRefusalNote({ landing, featureBranch, targetBranch, featureBranchPushed, targetUntouched: false });
          return {
            ok: false,
            error: local.error,
            failedStep: local.step,
            headBranch,
            unpushedMergeCommit: local.commitId,
            hint: `The merge of ${featureBranch} into ${targetBranch} is local only (merge commit ${local.commitId ?? "unknown"} was not pushed) and ${featureBranch} was kept. Retry with \`git push origin ${targetBranch}\`, then run rks_cycle_complete.${landingNote ? ` ${landingNote}` : ""}`,
            steps,
            metadata: { timestamp },
          };
        }
        return { ok: false, error: local.error, failedStep: local.step, ...(local.landingVerify ? { landingVerify: local.landingVerify } : {}), ...landingRefusalHint({ landing, featureBranch, targetBranch, featureBranchPushed }, local.step === "landing_verify" ? "Retry rks_ship so the landing candidate is prepared and tested again." : "Resolve the failure above, then retry rks_ship so the landing candidate is prepared and tested again."), steps, metadata: { timestamp } };
      }
      steps.push({ step: "pr", skipped: true, reason: prDecision.reason });
      steps.push({ step: "merge", ok: true, localMerge: true, pushed: true, from: featureBranch, into: targetBranch, commitId: local.commitId });
      mergeResult = { ok: true, commitId: local.commitId };
      collector.emit("ship.step.completed", projectId, { step: "merge", localMerge: true, pushed: true, from: featureBranch, into: targetBranch });
    } else if (targetExistsOnRemote) {
      const finalPrTitle = prTitle || `${type}${scope ? `(${scope})` : ""}: ${message}`;
      const testResults = loadTestResultsFromRun(projectRoot);
      prResult = await runGitPR({ projectRoot, targetBranch, title: finalPrTitle, problemId, reason: effectiveReason, autoMerge: false, squash: true, testResults });

      if (!prResult.ok) {
        collector.emit("ship.failed", projectId, { step: "pr", error: prResult.error });
        return { ok: false, error: `PR creation failed: ${prResult.error}`, steps, metadata: { timestamp } };
      }

      steps.push({ step: "pr", ...prResult });
      collector.emit("ship.step.completed", projectId, { step: "pr", prUrl: prResult.url });

      mergeResult = await runStagingMerge({ projectRoot, prNumber: prResult.prNumber, problemId, reason: effectiveReason });

      if (!mergeResult.ok) {
        collector.emit("ship.failed", projectId, { step: "merge", error: mergeResult.error, prUrl: prResult.url });
        return { ok: false, error: `Merge failed: ${mergeResult.error}`, steps, prUrl: prResult.url, metadata: { timestamp } };
      }

      steps.push({ step: "merge", ...mergeResult });
      collector.emit("ship.step.completed", projectId, { step: "merge", commitId: mergeResult.commitId });
    } else {
      const featureBranch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
      // No-remote arm (backlog.feat.landing-gate-combined-tree-test): the local target must still
      // be the tip the gate tested, and HEAD the tested tree, before the checkout and the merge.
      if (landing) {
        const landingVerify = verifyTargetUnmoved({ projectRoot, target: targetBranch, expectedTargetSha: landing.targetSha, preparedSha: landing.preparedSha });
        if (!landingVerify.ok) {
          const error = `Landing verify refused the merge into ${targetBranch} (${landingVerify.reason}): the tree the gate tested is not the tree that would land`;
          collector.emit("ship.failed", projectId, { step: "landing_verify", error, reason: landingVerify.reason });
          return { ok: false, error, failedStep: "landing_verify", landingVerify, ...landingRefusalHint({ landing, featureBranch, targetBranch, featureBranchPushed }, "Retry rks_ship so the landing candidate is prepared and tested again."), steps, metadata: { timestamp } };
        }
      }
      const checkoutTarget = spawnSync("git", ["checkout", targetBranch], { cwd: projectRoot, encoding: "utf8" });
      if (checkoutTarget.status !== 0) {
        collector.emit("ship.failed", projectId, { step: "merge", error: `Checkout ${targetBranch} failed: ${checkoutTarget.stderr?.trim()}` });
        return { ok: false, error: `Checkout ${targetBranch} failed: ${checkoutTarget.stderr?.trim()}`, ...landingRefusalHint({ landing, featureBranch, targetBranch, featureBranchPushed }, "Resolve the failure above, then retry rks_ship so the landing candidate is prepared and tested again."), steps, metadata: { timestamp } };
      }
      const localMerge = spawnSync("git", ["merge", "--no-ff", featureBranch, ...provenanceMergeMessageArgs(`Merge ${featureBranch} into ${targetBranch}`, { defaultTool: "rks_ship" })], { cwd: projectRoot, encoding: "utf8" });
      if (localMerge.status !== 0) {
        spawnSync("git", ["merge", "--abort"], { cwd: projectRoot, encoding: "utf8" });
        spawnSync("git", ["checkout", featureBranch], { cwd: projectRoot, encoding: "utf8" });
        collector.emit("ship.failed", projectId, { step: "merge", error: `Local merge failed: ${localMerge.stderr?.trim()}` });
        return { ok: false, error: `Local merge failed: ${localMerge.stderr?.trim()}`, ...landingRefusalHint({ landing, featureBranch, targetBranch, featureBranchPushed }, "Resolve the failure above, then retry rks_ship so the landing candidate is prepared and tested again."), steps, metadata: { timestamp } };
      }
      spawnSync("git", ["branch", "-d", featureBranch], { cwd: projectRoot, encoding: "utf8" });

      steps.push({ step: "pr", skipped: true, reason: `${targetBranch} has no remote — used local merge` });
      steps.push({ step: "merge", ok: true, localMerge: true, from: featureBranch, into: targetBranch });
      collector.emit("ship.step.completed", projectId, { step: "merge", localMerge: true, from: featureBranch, into: targetBranch });
    }

    const cycleResult = await runCycleComplete({ projectRoot, projectId, discardLocalCommits });

    // A refused cycle-complete is already surfaced correctly here: falsy `ok` emits ship.failed
    // and returns ok:false. backlog.fix.cycle-complete-ungated-hard-reset only threads the opt-in;
    // the reporting below needed no change. `hint` is carried so the caller learns HOW to proceed
    // rather than just that it stopped.
    if (!cycleResult.ok) {
      collector.emit("ship.failed", projectId, { step: "cycle_complete", error: cycleResult.error, prUrl: prResult?.url });
      return {
        ok: false,
        error: `Cycle complete failed: ${cycleResult.error}`,
        ...(cycleResult.hint ? { hint: cycleResult.hint } : {}),
        ...(cycleResult.localCommitsDiscarded ? { localCommitsDiscarded: cycleResult.localCommitsDiscarded } : {}),
        steps, prUrl: prResult?.url, metadata: { timestamp },
      };
    }

    steps.push({ step: "cycle_complete", ...cycleResult });
    collector.emit("ship.step.completed", projectId, { step: "cycle_complete", branch: cycleResult.branch });

    const finalPrTitle = prTitle || `${type}${scope ? `(${scope})` : ""}: ${message}`;
    collector.emit("ship.success", projectId, {
      message, problemId,
      commitId: (steps.find(s => s.step === "commit") || {}).commitId || null,
      branch: (steps.find(s => s.step === "branch") || {}).branch || null,
      prUrl: prResult?.url || null, stepsCompleted: steps.length,
    });
    await collector.flush();

    return {
      ok: true, message: `Successfully shipped: ${finalPrTitle}`,
      commitId: (steps.find(s => s.step === "commit") || {}).commitId || null,
      branch: (steps.find(s => s.step === "branch") || {}).branch || null,
      prNumber: prResult?.prNumber || null, prUrl: prResult?.url || null,
      mergeCommitId: mergeResult?.commitId || null, steps, metadata: { timestamp },
    };
  } catch (error) {
    collector.emit("ship.failed", projectId, { step: "unknown", error: error.message || String(error) });
    await collector.flush();
    return { ok: false, error: error.message || String(error), steps, metadata: { timestamp } };
  }
}
