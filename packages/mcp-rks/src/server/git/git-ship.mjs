// Ship & cycle-complete orchestration — combines multiple git operations.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ensureTelemetryStorage } from "../telemetry/index.mjs";
import { loadContext, getBranchConfig, getWorkflowConfig } from "../project.mjs";
import {
  runGit,
  getCurrentBranch,
  slugify,
} from "./git-utils.mjs";
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

export async function runCycleComplete({ projectRoot, projectId }) {
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
  let workingBranchLocal = workflowConfig.workingBranchLocal || (working !== integration);
  if (!workingBranchLocal) {
    const remoteCheck = spawnSync("git", ["ls-remote", "--heads", "origin", working], { cwd: projectRoot, encoding: "utf8" });
    if (remoteCheck.status !== 0 || !remoteCheck.stdout.trim()) {
      workingBranchLocal = true;
    }
  }
  const collector = ensureTelemetryStorage(projectRoot);

  try {
    if (!workingBranchLocal) {
      runGit(projectRoot, ['fetch', 'origin']);
    }

    if (currentBranch !== working) {
      runGit(projectRoot, ['checkout', working]);
    }

    let divergenceWarning = null;
    let localCommitsDiscarded = 0;
    if (!workingBranchLocal) {
      try {
        const aheadBehind = runGit(projectRoot, ['rev-list', '--left-right', '--count', `${working}...origin/${working}`]).trim();
        const [ahead] = aheadBehind.split(/\s+/).map(Number);
        if (ahead > 0) {
          localCommitsDiscarded = ahead;
          divergenceWarning = `Warning: ${ahead} local commit(s) on ${working} will be lost by hard reset to origin/${working}`;
        }
      } catch (e) {
        // If rev-list fails, continue anyway
      }
    }

    if (!workingBranchLocal) {
      runGit(projectRoot, ['reset', '--hard', `origin/${working}`]);
    }

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
      branch: working, synced: !workingBranchLocal, divergenceWarning,
      staleBranches: staleBranches.length > 0 ? staleBranches : undefined,
      branchConfig, metadata: { timestamp }
    };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runShip({
  projectRoot, message, scope, type = "feat", files, branchName,
  branchType = "feature", prTitle, problemId, reason, projectId,
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

    const cycleResult = await runCycleComplete({ projectRoot, projectId });

    if (!cycleResult.ok) {
      collector.emit("ship.failed", projectId, { step: "cycle_complete", error: cycleResult.error, prUrl: prResult?.url });
      return { ok: false, error: `Cycle complete failed: ${cycleResult.error}`, steps, prUrl: prResult?.url, metadata: { timestamp } };
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
