/**
 * Story Ship - Atomic and idempotent story completion
 *
 * Flow (always):
 *   feature branch → PR to working branch → merge → mark_implemented → cycle_complete
 *
 * With autoMergeIntegration: true (default):
 *   Also promotes working → integration branch
 *
 * Handles edge cases gracefully:
 * - PR already exists: skip creation
 * - PR already merged: skip merge
 * - Story already implemented: skip marking
 * - Already on working branch: skip cleanup
 */
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { runGitPR, runStagingMerge, runCycleComplete, runPromote } from './git-tools.mjs';
import { loadContext, getBranchConfig, getWorkflowConfig } from './project.mjs';
import { resolveNotesDir, updateField } from '../dendron.mjs';
import { advancePhase, reconcileExecutingBeforeShip } from '../workflow/auto-phase.mjs';
import { ensureTelemetryStorage } from '@routekit/telemetry';
import { assertNotOnProtectedBranch } from './branch-protection.mjs';
import { pollCiStatus } from './ci-polling.mjs';
import { getUncommittedFiles } from '../utils/git.mjs';
import { localMerge } from './git/local-merge.mjs';

/**
 * Build the `steps` entry recording the outcome of the review step.
 *
 * A SINGLE call site replaces the two inline pushes this step used to carry —
 * the success-branch literal and the `!reviewResult.ok` else-branch literal —
 * so no review outcome can be recorded by an inline object again. The old
 * success push read `ok: true, verdict: reviewResult.verdict` unconditionally,
 * which is how a reviewer that never ran was recorded as a pass.
 *
 * Defined ABOVE runStoryShipTool on purpose: tests/unit/ship-failure-branch-state.test.mjs
 * scans the source region from `runStoryShipTool` to buildShipFailure's JSDoc and
 * requires that every `ok: false` line in it belong to the ci_check step and that
 * no `return {` displaces the success return. This function has both, so it must
 * live outside that region.
 *
 * @param {object} reviewResult result from runReview
 */
export function buildReviewStepEntry(reviewResult = {}) {
  const r = reviewResult || {};
  // A reviewer that errored, was never configured, or reported itself
  // unavailable all mean the same thing here: the gate did not evaluate.
  const reviewerDidNotRun =
    r.reviewerUnavailable === true || r.llmFailed === true || r.ok === false;

  if (reviewerDidNotRun) {
    return {
      step: 'review',
      ok: false,
      // Never report a pass for a review that did not happen.
      verdict: r.verdict && r.verdict !== 'pass' ? r.verdict : 'unavailable',
      reviewerUnavailable: true,
      cause: r.cause === 'not_configured' ? 'not_configured' : 'call_failed',
      error: r.error || 'review_failed',
      reason: r.error || 'review_failed',
      findingCount: r.findings?.length || 0,
      ...(r.findings?.length ? { findings: r.findings } : {}),
    };
  }

  return {
    step: 'review',
    ok: true,
    verdict: r.verdict,
    summary: r.summary,
    findingCount: r.findings?.length || 0,
    // Carried so a block verdict can be acted on. CALLER CONTRACT: the result
    // passed here must already be redacted — a finding's `line` holds up to 100
    // chars of the matched diff line, which for a security pattern is the
    // credential assignment itself. runStoryShipTool redacts at the runReview
    // boundary, where review.mjs is already loaded.
    ...(r.findings?.length ? { findings: r.findings } : {}),
  };
}

export async function runStoryShipTool({ projectId, problemId }) {
  const steps = [];
  const shipStartMs = Date.now();
  let stepsCompleted = 0;
  let stepsSkipped = 0;
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;

  // Load branch and workflow config
  const branchConfig = getBranchConfig(context.record, context.projectJson);
  const workflowConfig = getWorkflowConfig(context.record, context.projectJson);
  const { working, integration } = branchConfig;
  const { autoMergeIntegration } = workflowConfig;
  
  // Detect if working branch is local-only: 3-branch topology OR runtime remote check
  let workingBranchIsLocal = working !== integration;
  if (!workingBranchIsLocal) {
    // Safety net: if the working branch doesn't exist on the remote, treat as local-only
    const remoteCheck = spawnSync('git', ['ls-remote', '--heads', 'origin', working], { cwd: projectRoot, encoding: 'utf8' });
    if (remoteCheck.status !== 0 || !remoteCheck.stdout.trim()) {
      workingBranchIsLocal = true;
    }
  }

  // Get current branch for telemetry
  const currentBranch = spawnSync('git', ['branch', '--show-current'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim();

  // CRITICAL: Refuse to run if somehow on a protected branch
  try {
    assertNotOnProtectedBranch(projectRoot, currentBranch, 'run story_ship from');
  } catch (err) {
    return buildShipFailure({
      worktreeBranch: currentBranch,
      baseBranch: working,
      error: err.message,
      hint: 'story_ship should be run from a feature branch (rks/*), not from a protected branch'
    });
  }

  // Emit start telemetry
  const collector = ensureTelemetryStorage(projectRoot);
  collector.emit('story_ship.start', projectId, { storyId: problemId, branch: currentBranch, autoMergeIntegration, workingBranch: working });

  // PREFLIGHT: dirty-tree check BEFORE any git checkout/merge/push.
  // Uses getUncommittedFiles from utils/git.mjs (same helper exec.mjs uses).
  // Excludes notes/ files for consistency with exec.mjs — notes are
  // governor-managed project metadata and travel via a separate commit path.
  const preflightDirty = getUncommittedFiles(projectRoot, { filterRks: true })
    .filter(f => !f.startsWith('notes/'));
  if (preflightDirty.length > 0) {
    collector.emit('story_ship.failed', projectId, {
      storyId: problemId,
      failedStep: 'preflight_dirty_tree',
      dirtyFiles: preflightDirty.slice(0, 20),
      dirtyCount: preflightDirty.length,
      worktreeBranch: currentBranch,
    });
    return buildShipFailure({
      worktreeBranch: currentBranch,
      baseBranch: working,
      error: `Dirty working tree — cannot ship`,
      failedStep: 'preflight_dirty_tree',
      dirtyFiles: preflightDirty,
      hint: 'commit or stash your changes before running rks_story_ship; notes/ files are auto-excluded (they are governor-managed)',
      steps: [],
    });
  }

  // Check if we're already on working branch (idempotent case)
  if (currentBranch === working) {
    collector.emit('story_ship.step.skipped', projectId, { step: 'all', reason: 'already_on_working_branch' });
    stepsSkipped = 3;
    return {
      ok: true,
      summary: `Already on ${working} - story may have been shipped previously`,
      steps: [{ step: 'check', skipped: true, reason: 'already_on_working_branch' }],
      stepsCompleted: 0,
      stepsSkipped: 3,
      idempotent: true,
      workingBranch: working
    };
  }

  // Step 1: Create PR to working branch (or find existing)
  let prUrl = null;
  const existingPR = spawnSync('gh', ['pr', 'view', '--json', 'url,state'], { cwd: projectRoot, encoding: 'utf8' });

  if (existingPR.status === 0) {
    const prData = JSON.parse(existingPR.stdout);
    prUrl = prData.url;
    if (prData.state === 'MERGED') {
      steps.push({ step: 'working_pr', skipped: true, reason: 'already_merged', url: prUrl });
      collector.emit('story_ship.step.skipped', projectId, { step: 'working_pr', reason: 'already_merged' });
      stepsSkipped++;
    } else if (prData.state === 'OPEN') {
      steps.push({ step: 'working_pr', skipped: true, reason: 'already_exists', url: prUrl });
      collector.emit('story_ship.step.skipped', projectId, { step: 'working_pr', reason: 'already_exists' });
      stepsSkipped++;
    }
  } else {
    // No existing PR - handle based on workflow type
    if (workingBranchIsLocal) {
      // 3-branch workflow: local merge only, no push, no PR
      collector.emit('story_ship.step.started', projectId, { step: 'local_merge', branch: currentBranch, target: working });
      const mergeResult = localMerge(projectRoot, currentBranch, working);
      
      if (!mergeResult.ok) {
        collector.emit('story_ship.failed', projectId, { storyId: problemId, failedStep: 'local_merge', error: mergeResult.error, worktreeBranch: currentBranch });
        return buildShipFailure({
          worktreeBranch: currentBranch,
          baseBranch: working,
          error: `Failed at local_merge: ${mergeResult.error}`,
          steps,
          hint: "Resolve merge conflicts and retry rks_story_ship"
        });
      }
      
      steps.push({ step: 'local_merge', ok: true, from: currentBranch, to: working, warning: mergeResult.warning });
      collector.emit('story_ship.step.completed', projectId, { step: 'local_merge', result: { from: currentBranch, to: working } });
      stepsCompleted++;
      
      // Skip PR-related steps since we merged locally
      steps.push({ step: 'working_pr', skipped: true, reason: 'local_merge_workflow' });
      steps.push({ step: 'working_merge', skipped: true, reason: 'local_merge_workflow' });
      stepsSkipped += 2;
      
    } else {
      // Default workflow: push and create PR
      const remoteCheck = spawnSync('git', ['ls-remote', '--heads', 'origin', currentBranch], { cwd: projectRoot, encoding: 'utf8' });
      const isOnRemote = remoteCheck.stdout.includes(currentBranch);

      if (!isOnRemote) {
        // Push the branch to remote first
        collector.emit('story_ship.step.started', projectId, { step: 'push_branch', branch: currentBranch });
        const pushResult = spawnSync('git', ['push', '-u', 'origin', currentBranch], { cwd: projectRoot, encoding: 'utf8' });

        if (pushResult.status !== 0) {
          const pushError = pushResult.stderr?.trim() || 'Unknown push error';
          collector.emit('story_ship.failed', projectId, { storyId: problemId, failedStep: 'push_branch', error: pushError, worktreeBranch: currentBranch });
          return buildShipFailure({
            worktreeBranch: currentBranch,
            baseBranch: working,
            error: `Failed to push branch to remote: ${pushError}`,
            steps,
            hint: "Check git remote configuration and retry rks_story_ship"
          });
        }

        steps.push({ step: 'push_branch', ok: true, branch: currentBranch });
        collector.emit('story_ship.step.completed', projectId, { step: 'push_branch', result: { branch: currentBranch } });
        stepsCompleted++;
      }

      // Build optional cost block for PR body
      let costBlock = null;
      const includeCostReport = context.projectJson?.prBodyIncludeCostReport !== false;
      if (includeCostReport) {
        try {
          const { generateCostReport } = await import('@routekit/telemetry/cost-report');
          const costReport = generateCostReport(projectRoot, { scope: 'story', storyId: problemId, format: 'markdown' });
          if (!costReport.noData) costBlock = costReport.markdown;
        } catch { /* best-effort — never block ship on cost report failure */ }
      }

      // Now create PR targeting working branch
      const prResult = await runGitPR({ projectRoot, targetBranch: working, problemId, costBlock });
      if (!prResult.ok) {
        collector.emit('story_ship.failed', projectId, { storyId: problemId, failedStep: 'working_pr', error: prResult.error, worktreeBranch: currentBranch });
        return buildShipFailure({
          worktreeBranch: currentBranch,
          baseBranch: working,
          error: `Failed at working_pr: ${prResult.error}`,
          steps,
          hint: "Fix the PR issue and retry rks_story_ship"
        });
      }
      prUrl = prResult.url;
      steps.push({ step: 'working_pr', ok: true, url: prUrl, targetBranch: working });
      collector.emit('story_ship.step.completed', projectId, { step: 'working_pr', result: { url: prUrl, targetBranch: working } });
      stepsCompleted++;
    }
  }

  // Step 1.5: Run code review (if enabled)
  try {
    const { runReview, loadReviewPolicy, redactReview } = await import('./review.mjs');
    const policy = loadReviewPolicy(projectRoot);

    if (policy.enabled) {
      collector.emit('story_ship.step.started', projectId, { step: 'review' });
      // Redact at the boundary. Everything downstream — the step entry AND the
      // `review:` field on the ship-failure payloads below — reads this object,
      // so redacting only one of them would leave a raw credential-bearing
      // finding sitting beside a redacted one in the same response.
      const reviewResult = redactReview(await runReview({
        projectId,
        problemId,
        targetBranch: working,
      }));

      // Single step-entry call site covering BOTH the reviewResult.ok path and
      // its else path — no review outcome is recorded by an inline literal.
      const reviewStep = buildReviewStepEntry(reviewResult);
      steps.push(reviewStep);
      if (reviewStep.ok) {
        collector.emit('story_ship.step.completed', projectId, { step: 'review', result: { verdict: reviewResult.verdict } });
        stepsCompleted++;
      } else {
        collector.emit('story_ship.step.skipped', projectId, { step: 'review', reason: reviewStep.reason || 'review_failed' });
        stepsSkipped++;
      }

      // Unavailability is evaluated OUTSIDE the reviewResult.ok / else split, so
      // the halt is reachable from both and neither branch can carry a reviewer
      // that never ran through to the merge. This is the fail-open being closed:
      // a 404 on a retired model id previously surfaced as verdict 'pass'.
      // Note this fires for a missing credential too — cause distinguishes the
      // two in the payload, but NOT in the halt decision. Making the halt
      // conditional on an env var would be a bypass by omission.
      if (!reviewStep.ok && policy.failOpen !== true) {
        collector.emit('story_ship.failed', projectId, {
          storyId: problemId,
          failedStep: 'review',
          reason: 'reviewer_unavailable',
          cause: reviewStep.cause,
          worktreeBranch: currentBranch,
        });
        return buildShipFailure({
          worktreeBranch: currentBranch,
          baseBranch: working,
          error: `Code review did not run: ${reviewStep.error}`,
          failedStep: 'review',
          reviewerUnavailable: true,
          cause: reviewStep.cause,
          review: reviewResult,
          steps,
          prUrl,
          hint: 'The review gate cannot report a pass for a review that did not run. Either configure an ANTHROPIC_API_KEY credential for the reviewer, or record an explicit opt-out by setting enabled: false or failOpen: true in .rks/review-policy.yaml',
        });
      }

      // If verdict is 'block', stop the ship process. Unchanged, and still fires
      // under failOpen:true — a degraded review whose pattern findings include a
      // blocker still halts.
      if (reviewResult.verdict === 'block') {
        collector.emit('story_ship.failed', projectId, { storyId: problemId, failedStep: 'review', reason: 'review_blocked', worktreeBranch: currentBranch });
        return buildShipFailure({
          worktreeBranch: currentBranch,
          baseBranch: working,
          error: 'Code review blocked merge',
          review: reviewResult,
          steps,
          prUrl,
          hint: 'Address the review findings and retry rks_story_ship',
        });
      }
    } else {
      steps.push({ step: 'review', skipped: true, reason: 'disabled_in_policy' });
      stepsSkipped++;
    }
  } catch (reviewErr) {
    // Review module not available or error - continue with warning
    steps.push({ step: 'review', skipped: true, reason: reviewErr.message });
    stepsSkipped++;
  }

  // Step 2: Merge the PR to working branch (skip if we did local merge)
  const didLocalMerge = workingBranchIsLocal && steps.some(s => s.step === 'local_merge' && s.ok);
  
  if (!didLocalMerge) {
    const prStatus = spawnSync('gh', ['pr', 'view', '--json', 'state'], { cwd: projectRoot, encoding: 'utf8' });
    let prState = 'OPEN';
    if (prStatus.status === 0) {
      prState = JSON.parse(prStatus.stdout).state;
    }

    if (prState === 'MERGED') {
      steps.push({ step: 'working_merge', skipped: true, reason: 'already_merged' });
      collector.emit('story_ship.step.skipped', projectId, { step: 'working_merge', reason: 'already_merged' });
      stepsSkipped++;
    } else {
      // Extract PR number from URL (e.g., https://github.com/user/repo/pull/123)
      const prNumber = prUrl ? parseInt(prUrl.split('/').pop(), 10) : null;
      const mergeResult = await runStagingMerge({ projectRoot, prNumber, problemId });
      if (!mergeResult.ok) {
        // Check if the error is because it's already merged
        if (mergeResult.error?.includes('not mergeable') || mergeResult.error?.includes('already merged')) {
          steps.push({ step: 'working_merge', skipped: true, reason: 'already_merged' });
          collector.emit('story_ship.step.skipped', projectId, { step: 'working_merge', reason: 'already_merged' });
          stepsSkipped++;
        } else {
          collector.emit('story_ship.failed', projectId, { storyId: problemId, failedStep: 'working_merge', error: mergeResult.error, worktreeBranch: currentBranch });
          return buildShipFailure({
            worktreeBranch: currentBranch,
            baseBranch: working,
            error: `Failed at working_merge: ${mergeResult.error}`,
            steps,
            prUrl,
            hint: "Fix the merge issue and retry rks_story_ship"
          });
        }
      } else {
        steps.push({ step: 'working_merge', ok: true, commitId: mergeResult.commitId });
        collector.emit('story_ship.step.completed', projectId, { step: 'working_merge', result: { commitId: mergeResult.commitId } });
        stepsCompleted++;
      }
    }
  }

  // Step 2.5: Poll CI status after merge (best-effort, non-blocking)
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const mergeCommit = steps.find(s => s.step === 'working_merge' && s.ok)?.commitId;

  if (mergeCommit && ghToken) {
    try {
      // Detect owner/repo from git remote
      const remoteUrl = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf8' }).stdout.trim();
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);

      if (match) {
        const [, owner, repo] = match;
        collector.emit('ci.poll.start', projectId, { sha: mergeCommit, owner, repo });
        const ciPollStartMs = Date.now();

        const ciResult = await pollCiStatus(owner, repo, mergeCommit, ghToken, {
          pollIntervalMs: 10_000,
          timeoutMs: 300_000,
        });

        if (ciResult.status === 'pass') {
          steps.push({ step: 'ci_check', ok: true, status: ciResult.status, name: ciResult.name });
          collector.emit('ci.poll.pass', projectId, {
            sha: mergeCommit,
            conclusion: ciResult.conclusion,
            checkNames: ciResult.name ? [ciResult.name] : [],
            latencyMs: Date.now() - ciPollStartMs,
          });
          stepsCompleted++;
        } else if (ciResult.status === 'fail') {
          steps.push({ step: 'ci_check', ok: false, status: ciResult.status, conclusion: ciResult.conclusion, name: ciResult.name, url: ciResult.url });
          collector.emit('ci.poll.fail', projectId, { sha: mergeCommit, conclusion: ciResult.conclusion, name: ciResult.name, url: ciResult.url });
          stepsCompleted++;
          // Non-blocking: CI failure is reported but doesn't stop the ship
        } else {
          steps.push({ step: 'ci_check', skipped: true, reason: 'timeout', status: ciResult.status });
          collector.emit('ci.poll.fail', projectId, { sha: mergeCommit, reason: 'timeout' });
          stepsSkipped++;
        }
      } else {
        steps.push({ step: 'ci_check', skipped: true, reason: 'could_not_detect_remote' });
        stepsSkipped++;
      }
    } catch (ciErr) {
      steps.push({ step: 'ci_check', skipped: true, reason: ciErr.message });
      stepsSkipped++;
    }
  } else {
    steps.push({ step: 'ci_check', skipped: true, reason: !ghToken ? 'no_github_token' : 'no_merge_commit' });
    stepsSkipped++;
  }

  // Step 3: Mark story as implemented (if provided and not already)
  if (problemId) {
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);
    const implementedPath = path.join(notesDir, problemId.replace(/^backlog\./, 'backlog.z_implemented.') + '.md');

    if (fs.existsSync(implementedPath)) {
      steps.push({ step: 'mark_implemented', skipped: true, reason: 'already_implemented' });
      collector.emit('story_ship.step.skipped', projectId, { step: 'mark_implemented', reason: 'already_implemented' });
      stepsSkipped++;
    } else if (fs.existsSync(storyPath)) {
      try {
        updateField(notesDir, problemId, 'status', 'implemented');
        // Reconcile a story stuck at 'executing' (rks_exec's exec_end didn't complete)
        // up to 'executed' FIRST, so the ship hop below (executed → integrated) succeeds
        // instead of rejecting as "executing → integrated" and leaving the story stuck.
        // No-op when the story is already 'executed' (the normal happy path).
        await reconcileExecutingBeforeShip(projectRoot, problemId, projectId);
        // R1.3-followup: route through advancePhase('ship') instead of direct
        // updateField. advancePhase validates the executed → integrated transition
        // and emits telemetry. The rename below stays as the archival side-effect
        // (matches R1.3f cycle-complete-agent pattern). Ordering: advancePhase BEFORE
        // renameSync so a failed phase write doesn't leave a renamed file with
        // stale phase.
        const advanceResult = await advancePhase(projectRoot, problemId, 'ship', projectId);
        if (!advanceResult.ok) {
          steps.push({ step: 'mark_implemented', skipped: true, reason: `phase write rejected: ${advanceResult.error}` });
          collector.emit('story_ship.step.skipped', projectId, { step: 'mark_implemented', reason: advanceResult.error });
          stepsSkipped++;
        } else {
          // Move to z_implemented
          const newProblemId = problemId.replace(/^backlog\./, 'backlog.z_implemented.');
          // Update the id field to match the new filename hierarchy
          updateField(notesDir, problemId, 'id', newProblemId);
          const newPath = path.join(notesDir, `${newProblemId}.md`);
          fs.renameSync(storyPath, newPath);
          // Commit the backlog rename so downstream steps (cycle_complete, promote) see a clean tree
          spawnSync('git', ['add', storyPath, newPath], { cwd: projectRoot, encoding: 'utf8' });
          spawnSync('git', ['commit', '-m', `chore: mark ${problemId} as implemented`], { cwd: projectRoot, encoding: 'utf8' });
          steps.push({ step: 'mark_implemented', ok: true, newPath: newProblemId });
          collector.emit('story_ship.step.completed', projectId, { step: 'mark_implemented', result: { newPath: newProblemId } });
          stepsCompleted++;
        }
      } catch (err) {
        // Non-fatal - story marking is best effort
        steps.push({ step: 'mark_implemented', skipped: true, reason: err.message });
        stepsSkipped++;
      }
    }
  }

  // Step 4: Complete the cycle (cleanup branch, sync to working branch)
  const cycleResult = await runCycleComplete({ projectRoot, projectId });
  if (!cycleResult.ok) {
    // Non-fatal for cycle complete - we're mostly done
    steps.push({ step: 'cycle_complete', skipped: true, reason: cycleResult.error });
    collector.emit('story_ship.step.skipped', projectId, { step: 'cycle_complete', reason: cycleResult.error });
    stepsSkipped++;
  } else {
    steps.push({ step: 'cycle_complete', ok: true, branch: cycleResult.branch });
    collector.emit('story_ship.step.completed', projectId, { step: 'cycle_complete', result: { branch: cycleResult.branch } });
    stepsCompleted++;
  }

  // Step 5 (optional): Auto-promote to integration if enabled
  let promoteResult = null;
  if (autoMergeIntegration && working !== integration) {
    // Promote working → integration to trigger CI/preview builds
    try {
      promoteResult = await runPromote({ projectRoot, projectId });
      if (promoteResult.ok) {
        steps.push({ step: 'promote', ok: true, from: working, to: integration });
        collector.emit('story_ship.step.completed', projectId, { step: 'promote', result: { from: working, to: integration } });
        stepsCompleted++;
      } else {
        steps.push({ step: 'promote', skipped: true, reason: promoteResult.error });
        collector.emit('story_ship.step.skipped', projectId, { step: 'promote', reason: promoteResult.error });
        stepsSkipped++;
      }
    } catch (err) {
      steps.push({ step: 'promote', skipped: true, reason: err.message });
      stepsSkipped++;
    }
  }

  // Success telemetry
  collector.emit('story_ship.success', projectId, {
    storyId: problemId,
    durationMs: Date.now() - shipStartMs,
    stepsCompleted,
    stepsSkipped,
    prUrl,
    workingBranch: working,
    autoPromoted: autoMergeIntegration && working !== integration
  });

  // Build next steps message - no promote/release suggestions (human-led checkpoints)
  const nextMessage = `You are now on ${working} with a clean working tree. Ready for the next story.`;

  return {
    ok: true,
    summary: `Story shipped: ${stepsCompleted} step(s) completed, ${stepsSkipped} skipped (idempotent)`,
    steps,
    stepsCompleted,
    stepsSkipped,
    prUrl,
    workingBranch: working,
    autoPromoted: autoMergeIntegration && working !== integration,
    next: nextMessage
  };
}

/**
 * Build the return payload for every `ok: false` exit of runStoryShipTool.
 *
 * Callers pass their own fields (error, failedStep, steps, prUrl, review, hint);
 * this stamps `worktreeBranch`, `baseBranch` and an explicit `branchRestored: false`
 * on top, and appends both branch names to the hint so an LLM caller that reads
 * only the hint still learns which branch the worktree was left on.
 *
 * DO NOT add a checkout, switch or spawn to this helper. Restoring the base branch
 * on failure looks helpful and is a bug: the `currentBranch === working` short-circuit
 * near the top of runStoryShipTool (story-ship.mjs:98 as of this commit) returns
 * `ok: true` with `idempotent: true` WITHOUT doing any work. So if a failed ship put
 * the worktree back on the base branch, the operator's natural next action — retrying
 * rks_story_ship — would falsely report the story as already shipped. Auto-restore
 * converts a loud failure into a silent false success. Report the branch; never move it.
 *
 * Exported so backlog.fix.ship-review-fail-closed can route its new failure exit
 * through the same payload, and so the contract is unit-testable with no git repo.
 */
export function buildShipFailure({ worktreeBranch, baseBranch, hint, ...rest }) {
  const branchNote =
    `worktree remains on \`${worktreeBranch}\` and was NOT restored — ` +
    `the next operation runs against \`${worktreeBranch}\`, not \`${baseBranch}\``;
  return {
    ...rest,
    ok: false,
    worktreeBranch,
    baseBranch,
    branchRestored: false,
    hint: hint ? `${hint}. ${branchNote}` : branchNote,
  };
}
