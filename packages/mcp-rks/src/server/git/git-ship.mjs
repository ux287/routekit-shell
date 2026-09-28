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
import { runStagingMerge } from "./git-release.mjs";

/**
 * Load test results from the latest run.json in .rks/runs/.
 * Returns structured test data or null if unavailable.
 */
function loadTestResultsFromRun(projectRoot) {
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
        passCount: runData.testVerification.passCount || 0,
        failCount: runData.testVerification.failCount || 0,
        duration: runData.testVerification.duration ? `${(runData.testVerification.duration / 1000).toFixed(1)}s` : undefined,
        runner: runData.testVerification.runner || undefined,
        attempts: runData.attempts || 1,
        testsSkipped: false,
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
 * @returns Result carrying `preservedPaths` (ok) — tracked paths dirty before the sync step AND
 *   still dirty after it, from observed `git status` — or `dirtyPaths` (refusal) — tracked paths
 *   from the observed pre-sync status. Both are always arrays, `[]` on a clean tree.
 */
export async function runCycleComplete({ projectRoot, projectId, discardLocalCommits = false, discardUncommitted = false }) {
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

export async function runShip({
  projectRoot, message, scope, type = "feat", files, branchName,
  branchType = "feature", prTitle, problemId, reason, projectId,
  // backlog.fix.cycle-complete-ungated-hard-reset: threaded through to runCycleComplete.
  // Defaults false — a ship does not implicitly consent to discarding unpushed local commits.
  discardLocalCommits = false,
}) {
  const timestamp = new Date().toISOString();
  const steps = [];
  const collector = ensureTelemetryStorage(projectRoot);

  const effectiveReason = reason || (!problemId ? "off-rail" : undefined);
  collector.emit("ship.start", projectId, { message, scope, type, problemId });

  try {
    let targetBranch = "staging";
    try {
      const ctx = await loadContext(projectId);
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
      const commitResult = await runGitCommit({ projectRoot, message, scope, type, files });

      if (!commitResult.ok) {
        collector.emit("ship.failed", projectId, { step: "commit", error: commitResult.error });
        return { ok: false, error: `Commit failed: ${commitResult.error}`, steps, metadata: { timestamp } };
      }

      steps.push({ step: "commit", ...commitResult });
      collector.emit("ship.step.completed", projectId, { step: "commit", commitId: commitResult.commitId });
    } else {
      steps.push({ step: "commit", skipped: true, reason: "already_committed" });
    }

    if (alreadyOnFeatureBranch) {
      const pushResult = spawnSync("git", ["push", "-u", "origin", currentBranch], { cwd: projectRoot, encoding: "utf8" });
      if (pushResult.status !== 0) {
        collector.emit("ship.failed", projectId, { step: "push", error: `Push failed: ${pushResult.stderr?.trim()}` });
        return { ok: false, error: `Push failed: ${pushResult.stderr?.trim()}`, steps, metadata: { timestamp } };
      }
    }

    const remoteCheck = spawnSync("git", ["ls-remote", "--heads", "origin", targetBranch], { cwd: projectRoot, encoding: "utf8" });
    const targetExistsOnRemote = remoteCheck.status === 0 && remoteCheck.stdout.trim().length > 0;

    let prResult = null;
    let mergeResult = null;

    if (targetExistsOnRemote) {
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
      const checkoutTarget = spawnSync("git", ["checkout", targetBranch], { cwd: projectRoot, encoding: "utf8" });
      if (checkoutTarget.status !== 0) {
        collector.emit("ship.failed", projectId, { step: "merge", error: `Checkout ${targetBranch} failed: ${checkoutTarget.stderr?.trim()}` });
        return { ok: false, error: `Checkout ${targetBranch} failed: ${checkoutTarget.stderr?.trim()}`, steps, metadata: { timestamp } };
      }
      const localMerge = spawnSync("git", ["merge", "--no-ff", featureBranch, "-m", `Merge ${featureBranch} into ${targetBranch}`], { cwd: projectRoot, encoding: "utf8" });
      if (localMerge.status !== 0) {
        spawnSync("git", ["merge", "--abort"], { cwd: projectRoot, encoding: "utf8" });
        spawnSync("git", ["checkout", featureBranch], { cwd: projectRoot, encoding: "utf8" });
        collector.emit("ship.failed", projectId, { step: "merge", error: `Local merge failed: ${localMerge.stderr?.trim()}` });
        return { ok: false, error: `Local merge failed: ${localMerge.stderr?.trim()}`, steps, metadata: { timestamp } };
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
