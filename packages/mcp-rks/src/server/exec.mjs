import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { reviewPlan, computePlanHash } from "./plan-quality.mjs";
import {
  ensureDir,
  loadContext,
  slugify,
  enforceGuardrail,
  loadProjectProtectedConfig,
  isProtectedPath,
} from "./project.mjs";
import { recordTelemetry, buildTelemetryMetrics } from "./telemetry.mjs";
import { ensureTelemetryStorage } from "./telemetry/index.mjs";
import { runRefineTool } from "./refine.mjs";
import { findFunctionSlice, replaceSlice } from "../llm/slices.mjs";
import { handleRunCommandStep, runProjectTests } from "../exec/command-runner.mjs";
import { VALID_STEP_TYPES } from "./planner.mjs";
import { createBackup, restoreBackup, capturePartialDiff, cleanupWorkingTree } from "../exec/backup.mjs";
import { runCheckedGit, runGit, getCurrentBranch, isWorkingTreeClean, hasGitRepo, findLatestRunDir, getUncommittedFiles, assertCleanWorkingTree, isRuntimeArtifact } from "../utils/git.mjs";
import { runGitPR, runGitCommit } from "./git-tools.mjs";
import { assertNotProtectedBranch } from "./branch-protection.mjs";
import { generateFixPlan, applyFixPlan } from "./fix-planner.mjs";
import { applySearchReplace, applyCreateFile } from "./step-apply.mjs";
import { guardrailsOff, guardrailsOn } from "./guardrails-audit.mjs";
import { loadPlan } from "./plan-loader.mjs";
import { embedScopedFiles } from "../rag/embedding-pipeline.mjs";
import { loadStory } from "../shared/story-loader.mjs";
import { PHASE_GATE_EXEC } from "../workflow/phases.mjs";
import { advancePhase } from "../workflow/auto-phase.mjs";
import { ensureStoryOnRemote } from "./story-validator.mjs";
// extractFrontmatterField replaced by loadStory from shared/story-loader.mjs
import { resolveNotesDir, updateField } from "../dendron.mjs";
import {
  MAX_RETRY_ATTEMPTS,
  computeImplicitDirs,
  isTestFile,
  isTestFixStory,
  cleanupFeatureBranch,
  detectPerStepDivergence,
  computeUnexpectedFiles,
  parseTestCount,
  hashTestFiles,
  verifyTestFileIntegrity,
  rollback,
} from "./test-runner.mjs";
import {
  ExecPhase,
  initExecState,
  saveExecState,
  loadExecState,
  updateExecPhase,
  markStepCompleted,
  markExecFailed,
  markExecComplete,
  findIncompleteRuns,
} from "../workflow/exec-state.mjs";

// MAX_RETRY_ATTEMPTS, computeImplicitDirs, isTestFile, isTestFixStory extracted to ./test-runner.mjs

// cleanupFeatureBranch extracted to ./test-runner.mjs

// detectPerStepDivergence extracted to ./test-runner.mjs

// parseTestCount extracted to ./test-runner.mjs

// ensureStoryOnRemote extracted to ./story-validator.mjs

// applySearchReplace extracted to ./step-apply.mjs

// generateFixPlan and applyFixPlan extracted to ./fix-planner.mjs

/**
 * Decide whether to run `npm install` before the post-apply test phase: true when the applied plan
 * changed the root package.json (a dependency was added/changed) OR node_modules is missing — so a
 * just-declared dependency (e.g. a test runner like vitest) is resolvable when the tests run, inside
 * the governed flow with no off-rail detour. See backlog.fix.exec-post-apply-npm-install.
 * @param {string[]} appliedFiles - plan-written files (relative to projectRoot)
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function shouldInstallDeps(appliedFiles, projectRoot) {
  const touchedPackageJson = Array.isArray(appliedFiles) && appliedFiles.some(
    (f) => f === "package.json" || (typeof f === "string" && f.endsWith("/package.json"))
  );
  if (touchedPackageJson) return true;
  try {
    // node_modules missing but a package.json exists → deps were never installed; install them.
    // Require package.json — `npm install` is pointless/erroring without one (e.g. a bare dir).
    return fs.existsSync(path.join(projectRoot, "package.json"))
      && !fs.existsSync(path.join(projectRoot, "node_modules"));
  } catch {
    return false;
  }
}

async function checkForIncompletePreviousStory(projectRoot, currentLabel) {
  // Check for existing rks/* branches that aren't the current story
  const { execSync } = await import('child_process');
  try {
    const branches = execSync('git branch --list "rks/*"', { cwd: projectRoot, encoding: 'utf8' });
    const otherBranches = branches.split('\n')
      .map(b => b.trim().replace(/^\* /, ''))
      .filter(b => b && !b.includes(currentLabel || ''));

    if (otherBranches.length > 0) {
      return {
        blocked: true,
        reason: "incomplete_previous_story",
        message: `BLOCKED: Found unmerged feature branch(es) from previous story: ${otherBranches.join(', ')}`,
        branches: otherBranches,
        requiredAction: "Run rks_story_ship for the previous story first, then retry.",
        hint: "DO NOT 'optimize' by skipping steps. Complete one story fully before starting the next."
      };
    }
  } catch (e) {
    // git command failed, allow proceeding
  }
  return { blocked: false };
}

/**
 * backlog.fix.exec-rollback-strands-executing-phase
 *
 * Exits that are a RESUMABLE PAUSE, not a failure. These must NOT reset the phase: each one's own
 * prescribed remedy re-enters exec, which re-checks the `executing` gate (:319). Resetting here does
 * not un-stick the story — it wedges the very flow that was about to recover it.
 *   - needs_approval           — `rks_approve` re-enters exec.
 *   - incomplete_previous_story — "ship the previous story, THEN retry"; the retry re-enters exec.
 */
const EXEC_PHASE_RESET_CARVE_OUTS = new Set(["needs_approval", "incomplete_previous_story"]);

export function isResumablePause(result) {
  return EXEC_PHASE_RESET_CARVE_OUTS.has(result?.reason) || EXEC_PHASE_RESET_CARVE_OUTS.has(result?.status);
}

/**
 * backlog.fix.exec-rollback-strands-executing-phase
 *
 * THE PROBLEM: a story is at phase `executing` on ENTRY to exec (the plan writer makes that hop; exec
 * only gates on it). So EVERY exit — throw or `ok:false` return — leaves it there unless something
 * puts it back. `resetStalePhaseToArchApproved` existed but was wired to 2 of ~12 exits, so a scope
 * violation, a quality gate, a divergence, or any thrown error stranded the story at `executing`.
 * `rks_plan` refuses that phase, so the re-plan the failure message tells you to run is IMPOSSIBLE:
 * a recoverable failure becomes terminal and the story has to be deleted and recreated. A real
 * clean-machine greenfield UAT hit exactly this.
 *
 * THE FIX IS A THREE-REGION RECOVERY, and the three regions are NOT interchangeable — two of them
 * destroy your work if you use the wrong one. ARCH found all three the hard way:
 *
 *   1. FINALIZED (the commit landed) → PHASE RESET ONLY. NEVER rollback().
 *      The tail (markExecComplete etc.) can still throw AFTER a green, committed exec. rollback()
 *      would `git branch -D` the branch holding that commit — destroying a successful build because
 *      a JSON write failed. Committed work is never rolled back.
 *
 *   2. POST-MUTATION (branchName || backupMeta || guardrailsSession) → rollback(), then reset.
 *      A branch exists, or a backup was taken, or guardrails are OFF. rollback() is what restores
 *      the branch, the backup and the guardrails. A bare reset here would leak all three.
 *
 *   3. PRE-MUTATION (none of the three) → BARE PHASE RESET ONLY. NEVER rollback().
 *      Nothing has been mutated yet — and rollback()'s Step 5 (`cleanupWorkingTree`) is UNGUARDED,
 *      so with no branch/backup/session it degenerates to exactly one action: WIPING THE TREE. On
 *      the dirty-tree precondition failure (:258) that tree is dirty with the USER'S OWN uncommitted
 *      work, by definition. Calling rollback() here would delete it.
 *
 * The predicate is evaluated on STATE, never on a line number: a new exit path classifies itself.
 * (A `mutated` flag set at branch creation would be WRONG — that block is conditional on `gitRepo`,
 * and createBackup/guardrailsOff/runApplyTool all still run when it is skipped.)
 */
async function runExecTool(params) {
  const ctx = {
    projectId: params.projectId,
    projectRoot: null,
    baseBranch: null,
    runDir: null,
    storyId: null,
    branchName: null,
    backupMeta: null,
    guardrailsSession: null,
    finalized: false,
  };

  try {
    const result = await runExecToolInner(params, ctx);
    // Return-value inspection: a try/catch does not intercept `return`, and most of exec's failures
    // are returns, not throws. Idempotent — the reset no-ops unless the phase is actually `executing`.
    if (result?.ok === false && !isResumablePause(result)) {
      resetStalePhaseToArchApproved(ctx.projectRoot, ctx.storyId);
    }
    return result;
  } catch (err) {
    await recoverExecFailure(ctx, err);
    throw err;
  }
}

export async function recoverExecFailure(ctx, err) {
  const reason = err?.message ? `exec_threw: ${String(err.message).slice(0, 80)}` : "exec_threw";
  try {
    if (ctx.finalized) {
      // Region 1 — the commit landed. Never destroy it.
    } else if (ctx.branchName || ctx.backupMeta || ctx.guardrailsSession) {
      // Region 2 — real mutations exist. rollback() restores branch + backup + guardrails.
      await rollback(ctx.projectRoot, {
        runDir: ctx.runDir,
        branchName: ctx.branchName,
        baseBranch: ctx.baseBranch,
        backupMeta: ctx.backupMeta,
        guardrailsSession: ctx.guardrailsSession,
        projectId: ctx.projectId,
        reason,
      });
    }
    // Region 3 — pre-mutation: fall through. Nothing to roll back, and rollback() would wipe the tree.
  } catch (rollbackErr) {
    console.error(`[rks.exec] rollback during failure recovery failed: ${rollbackErr?.message}`);
  }
  // Every region resets the phase — that is the whole point of the story.
  resetStalePhaseToArchApproved(ctx.projectRoot, ctx.storyId);
}

async function runExecToolInner({ projectId, label, skipTests = false, autoCommit = false, dryRun = false }, ctx) {
  const slug = label ? slugify(label) : null;
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  const baseBranch = context.projectJson?.baseBranch || "staging";
  ctx.projectRoot = projectRoot;
  ctx.baseBranch = baseBranch;
  console.error("[debug-runExecTool] projectRoot:", projectRoot);

  // GUARDRAIL: Block if there are unmerged branches from previous stories
  const incompleteCheck = await checkForIncompletePreviousStory(projectRoot, label || '');
  if (incompleteCheck.blocked) {
    return {
      ok: false,
      error: incompleteCheck.message,
      reason: incompleteCheck.reason,
      branches: incompleteCheck.branches,
      requiredAction: incompleteCheck.requiredAction,
      hint: incompleteCheck.hint
    };
  }

  // GOVERNANCE: Hash test files before applying changes (for protection verification later)
  const testFileHashes = new Map();
  const testDirs = ['__tests__', 'tests', 'test'];
  for (const dir of testDirs) {
    const testPath = path.join(projectRoot, 'packages/mcp-rks/src', dir);
    if (fs.existsSync(testPath)) {
      const files = fs.readdirSync(testPath).filter(f => f.endsWith('.test.mjs') || f.endsWith('.spec.mjs'));
      for (const file of files) {
        const fullPath = path.join(testPath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        testFileHashes.set(fullPath, createHash('sha256').update(content).digest('hex'));
      }
    }
  }
  if (testFileHashes.size > 0) {
    console.error(`[rks.exec] Hashed ${testFileHashes.size} test files for protection`);
  }

  // Load plan first (needed for dirty tree validation against plan targets)
  const { plan, runDir, runId, slug: selectedSlug } = loadPlan(projectRoot, slug);
  // The story id is what the phase reset needs. A throw BEFORE this point cannot be reset (we do not
  // yet know which story we are in) — that residual is accepted and recorded in the story.
  ctx.runDir = runDir;
  ctx.storyId = plan.problemId || null;

  // Auto-clean stale incomplete runs from previous sessions
  const incompleteRuns = findIncompleteRuns(projectRoot);
  for (const staleRun of incompleteRuns) {
    if (staleRun.runId !== runId) {
      console.error(`[rks.exec] Auto-cleaning stale exec run: ${staleRun.runId} (phase: ${staleRun.state.currentPhase})`);
      markExecFailed(staleRun.runDir, 'auto-cleanup', 'Stale run cleaned by new exec session');
    }
  }

  // Initialize exec state for this run
  const execState = initExecState({
    runId,
    storyId: plan.problemId || null,
    totalSteps: plan.steps?.length || 0,
    branchName: null, // Will be set after branch creation
  });
  saveExecState(runDir, execState);

  // Initialize telemetry collector with JSONL storage
  const collector = ensureTelemetryStorage(projectRoot);
  const telemetryTimer = collector.startTimer("exec", projectId, { label, slug: selectedSlug });
  const execStartMs = Date.now();
  const correlationId = telemetryTimer.correlationId;
  const runIdValue = runDir ? path.basename(runDir) : null;

  if (hasGitRepo(projectRoot)) {
    // Exclude the current story's note file(s) from the dirty check — they are legitimately
    // modified by rks_refine snippet injection and should not block exec.
    const problemId = plan.problemId || null;
    const storyNoteExclusions = new Set();
    if (problemId) {
      storyNoteExclusions.add(`notes/${problemId}.md`);
      // Also exclude child story notes (e.g. notes/<problemId>.child-1.md)
      const allDirtyPre = getUncommittedFiles(projectRoot);
      for (const f of allDirtyPre) {
        if (f.startsWith(`notes/${problemId}.`) && f.endsWith('.md')) {
          storyNoteExclusions.add(f);
        }
      }
    }

    // Enhanced dirty tree check: reject ALL uncommitted changes to prevent bundling
    const allDirtyFiles = getUncommittedFiles(projectRoot);
    const excludedNotes = allDirtyFiles.filter(f => storyNoteExclusions.has(f));
    if (excludedNotes.length > 0) {
      try {
        collector.emit('exec.story_notes_excluded', projectId, { count: excludedNotes.length, files: excludedNotes, problemId });
      } catch (e) { /* telemetry is best-effort */ }
    }
    // Also exclude all notes/ files — they are governor-managed project metadata, never part of
    // exec commits (they travel via a separate git add notes/ step). In multi-story epic work,
    // many story notes sit dirty on staging while individual stories execute one at a time.
    // Exempt known runtime artifacts (lockfiles, rks-generated state) so an artifacts-only dirty
    // tree does not block exec — they are never part of plan commits. Specific patterns only (the
    // pattern list deliberately has no broad .routekit/ prefix, which would mask tracked guardrail
    // config). See backlog.fix.exec-dirty-tree-gate-exempts-generated-files.
    const dirtyFiles = allDirtyFiles.filter(f => !storyNoteExclusions.has(f) && !f.startsWith('notes/') && !isRuntimeArtifact(f));
    if (dirtyFiles.length > 0) {
      const planTargetFiles = new Set(
        (plan?.steps || []).flatMap(s => [s.target, s.path].filter(Boolean))
      );
      const unrelatedFiles = dirtyFiles.filter(f => !planTargetFiles.has(f));
      const planTargetFiles_dirty = dirtyFiles.filter(f => planTargetFiles.has(f));

      // Log telemetry for dirty tree detection
      try {
        collector.emit("exec.dirty_tree_detected", projectId, {
          totalDirtyFiles: dirtyFiles.length,
          unrelatedFiles: unrelatedFiles.length,
          planTargetFiles: planTargetFiles_dirty.length,
          fileList: dirtyFiles.slice(0, 10),
          slug: selectedSlug || "unknown"
        });
      } catch (e) { /* telemetry is best-effort */ }

      // Build comprehensive error message
      let errorMessage = `rks.exec: Cannot proceed with uncommitted changes in working tree (${dirtyFiles.length} file(s)):`;
      
      if (unrelatedFiles.length > 0) {
        const unrelatedList = unrelatedFiles.slice(0, 10).join('\n    ');
        const moreUnrelated = unrelatedFiles.length > 10 ? `\n    ... and ${unrelatedFiles.length - 10} more` : '';
        errorMessage += `\n\n  Unrelated files (${unrelatedFiles.length}):${moreUnrelated}\n    ${unrelatedList}`;
      }
      
      if (planTargetFiles_dirty.length > 0) {
        const targetList = planTargetFiles_dirty.slice(0, 5).join('\n    ');
        const moreTargets = planTargetFiles_dirty.length > 5 ? `\n    ... and ${planTargetFiles_dirty.length - 5} more` : '';
        errorMessage += `\n\n  Plan target files (${planTargetFiles_dirty.length}):${moreTargets}\n    ${targetList}`;
      }
      
      errorMessage += `\n\nRationale: rks.exec creates commits that should only contain plan-generated changes.\nPre-existing changes would be bundled into the commit without validation.\n\nTo proceed:\n  1. Save work-in-progress: rks_stash\n  2. Commit changes intentionally: rks_git_commit\n  3. Discard unwanted changes: git restore <files>`;
      
      telemetryTimer.fail({ error: "dirty_tree", totalFiles: dirtyFiles.length, unrelatedFiles: unrelatedFiles.length });
      throw new McpError(ErrorCode.InvalidRequest, errorMessage);
    }

    const currentBranch = getCurrentBranch(projectRoot);
    if (currentBranch !== baseBranch) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `rks.exec: expected to run from base branch "${baseBranch}" but you're on "${currentBranch}". Checkout the base branch and retry.`
      );
    }
  }

  // Load story testFiles for scoped test runs (before baseline so both call sites can use it)
  let storyTestFiles = null;
  let storyTargetFiles = null;
  const earlyProblemId = plan?.problemId;
  if (earlyProblemId) {
    try {
      const earlyStory = loadStory(projectRoot, earlyProblemId);
      const tf = earlyStory.frontmatter.testFiles;
      storyTestFiles = Array.isArray(tf) && tf.length > 0 ? tf : null;
      storyTargetFiles = earlyStory.targetFiles || earlyStory.frontmatter?.targetFiles || null;
    } catch {
      // testFiles unavailable — fall back to full suite
    }
  }

  // Run baseline tests (must pass before we touch anything)
  // Exception: test-fix stories are allowed to run when tests are failing
  const testFixMode = isTestFixStory(plan, storyTargetFiles);

  if (!skipTests && !testFixMode) {
    console.error("[rks.exec] Running baseline tests...");
    const baseline = runProjectTests(projectRoot, { testPaths: storyTestFiles });
    if (!baseline.skipped && !baseline.passed) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `rks.exec: Cannot apply - tests already failing. Fix tests first.\n${baseline.summary}`
      );
    }
    if (baseline.skipped) {
      console.error("[rks.exec] Baseline tests skipped:", baseline.reason);
    } else {
      console.error("[rks.exec] Baseline tests passed");
    }
  } else if (!skipTests && testFixMode) {
    console.error("[rks.exec] Test-fix story detected - skipping baseline test check");
  } else {
    console.error("[rks.exec] Skipping baseline tests (--skip-tests)");
  }
  const planPath = path.join(runDir, "plan.yaml");

  // Phase enforcement: a successful rks_plan advances the story to PHASE_GATE_EXEC
  // (v2: "executing" via the exec_start transition); rks_exec runs only from there.
  const problemId = plan?.problemId;
  let preCommands = [];
  if (problemId && !process.env.RKS_SKIP_PHASE_CHECK) {
    try {
      const story = loadStory(projectRoot, problemId);
      const currentPhase = story.frontmatter.phase || "draft";
      if (currentPhase !== PHASE_GATE_EXEC) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `rks.exec: Story phase is "${currentPhase}", expected "${PHASE_GATE_EXEC}" (a successful rks_plan leaves the story at "${PHASE_GATE_EXEC}"). Run/re-run rks_plan; if a prior exec was interrupted, recover with rks_exec_abort.`
        );
      }
      // Extract preCommands from frontmatter
      const rawPreCommands = story.frontmatter.preCommands;
      if (rawPreCommands) {
        preCommands = Array.isArray(rawPreCommands) ? rawPreCommands : [rawPreCommands];
      }
    } catch (e) {
      if (e instanceof McpError) throw e;
      console.error(`[rks.exec] phase check failed: ${e?.message}`);
    }
  }

  console.error(
    `[rks.exec] project=${projectId} slug=${selectedSlug} run=${runDir}`
  );

  // Verify plan integrity if it was previously reviewed
  // Note: hash was computed BEFORE qualityReview was added, so exclude it
  if (plan.qualityReview?.hash) {
    const { qualityReview, ...planWithoutReview } = plan;
    const currentHash = computePlanHash(planWithoutReview);
    if (currentHash !== plan.qualityReview.hash) {
      try { collector.emit("exec.failed", projectId, { problemId: plan.problemId || null, reason: "integrity_failed", durationMs: Date.now() - execStartMs }); } catch (e) { /* telemetry is best-effort */ }
      try { await collector.flush(); } catch (e) { /* best-effort: persist exec.failed before early return */ }
      return {
        ok: false,
        status: "integrity_failed",
        message: "Plan modified after quality review. Re-run rks.plan.",
        expectedHash: plan.qualityReview.hash,
        actualHash: currentHash,
      };
    }
  }

  // Run QA Agent review on planned tests (if test files exist in plan)
  const testSteps = (plan.steps || []).filter(s =>
    (s.path || s.target || '').match(/\.(test|spec)\.(mjs|js|ts)$/)
  );
  if (testSteps.length > 0 && !process.env.RKS_SKIP_QA_REVIEW) {
    const { runQaAgentReview } = await import('./qa-agent.mjs');
    const testCode = testSteps.map(s => s.content || '').join('\n\n');
    const implSteps = (plan.steps || []).filter(s =>
      !(s.path || s.target || '').match(/\.(test|spec)\.(mjs|js|ts)$/)
    );
    const implCode = implSteps.map(s => s.content || '').join('\n\n');

    const qaResult = await runQaAgentReview({
      plan,
      tddApplicable: plan.tddApplicable || 'unknown',
      testCode,
      implementationCode: implCode,
      projectId,
    });

    if (qaResult.blocked) {
      try { collector.emit("exec.failed", projectId, { problemId: plan.problemId || null, reason: "qa_blocked", durationMs: Date.now() - execStartMs }); } catch (e) { /* telemetry is best-effort */ }
      try { await collector.flush(); } catch (e) { /* best-effort: persist exec.failed before early return */ }
      return {
        ok: false,
        status: "qa_blocked",
        message: "QA Agent found exploitable gaps in planned tests",
        exploitableGaps: qaResult.exploitableGaps,
        missingTestCases: qaResult.missingTestCases,
        reasoning: qaResult.reasoning,
        hint: "Address the gaps and re-run rks_plan",
      };
    }

    if (qaResult.verdict === 'warn') {
      console.warn(`[rks.exec] QA Agent warnings: ${qaResult.reasoning}`);
    }
  }

  // Re-run quality check (target files may have changed on disk)
  const qualityRecheck = await reviewPlan({ projectRoot, plan });
  if (!qualityRecheck.ok) {
    try { collector.emit("exec.failed", projectId, { problemId: plan.problemId || null, reason: "quality_failed", durationMs: Date.now() - execStartMs }); } catch (e) { /* telemetry is best-effort */ }
    try { await collector.flush(); } catch (e) { /* best-effort: persist exec.failed before early return */ }
    return {
      ok: false,
      status: "quality_failed",
      message: "Plan failed quality check at execution time",
      errors: qualityRecheck.errors,
      warnings: qualityRecheck.warnings,
    };
  }

  // Safety net: reject plans containing non-executable steps.
  // The planner's validateStep + retry logic should prevent these from reaching exec,
  // but this guard catches any that slip through.
  const noteSteps = (plan.steps || []).filter(step => !VALID_STEP_TYPES.includes(step.action));
  if (noteSteps.length > 0) {
    const noteDetails = noteSteps.map(s => s.title || s.description || "Unnamed").join(", ");
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Plan contains ${noteSteps.length} non-executable step(s): ${noteDetails}. Run rks_refine to fix the story, then retry rks.plan.`
    );
  }

  // Dry-run mode: preview what would be applied without making changes

  // Dry-run mode: preview what would be applied without making changes
  if (dryRun) {
    console.error("[rks.exec] Dry-run mode - previewing changes without applying");
    const wouldApply = (plan.steps || []).map((s, idx) => ({
      step: idx + 1,
      action: s.action,
      file: s.path || s.target || null,
      preview: s.content ? String(s.content).slice(0, 300) + (s.content.length > 300 ? "..." : "") : null,
    }));
    const filesAffected = [...new Set(wouldApply.filter(s => s.file).map(s => s.file))];
    return {
      ok: true,
      status: "dry_run",
      projectId,
      slug: selectedSlug,
      runFolder: runDir,
      stepsCount: plan.steps?.length || 0,
      filesAffected,
      wouldApply,
      message: "Dry-run complete. No files were modified and no branch was created.",
    };
  }

  // Check for guardrail-critical plans - require approval before execution
  const guardrailLevel = plan.guardrail?.id || plan.guardrail?.level || null;
  if (guardrailLevel === "guardrail-critical") {
    console.error("[rks.exec] Guardrail-critical plan detected, creating approval request...");

    // Compute plan hash for integrity verification
    const planContent = fs.readFileSync(planPath, "utf8");
    const planHash = createHash("sha256").update(planContent).digest("hex");

    // Build diff preview from plan steps
    const diff = (plan.steps || []).map((s) => ({
      file: s.path || s.target || null,
      action: s.action || null,
      preview: s.content ? String(s.content).slice(0, 500) : null,
    }));

    // Dry-run mode: return preview without creating approval or applying
    const dryRun = Boolean(typeof options !== "undefined" && options.dryRun);
    if (dryRun) {
      const wouldApply = diff.map((d) => ({
        step: null,
        action: d.action,
        file: d.file,
        diff: d.preview,
      }));
      return {
        status: "dry_run",
        wouldApply,
        warnings: [],
      };
    }

    // Create approval request file
    const approvalsDir = path.join(projectRoot, ".rks", "approvals");
    ensureDir(approvalsDir);
    const approvalFile = path.join(approvalsDir, `${runId}.json`);
    const approvalRequest = {
      planId: runId,
      planHash,
      planPath,
      status: "pending",
      createdAt: new Date().toISOString(),
      diff,
    };
    fs.writeFileSync(approvalFile, JSON.stringify(approvalRequest, null, 2), "utf8");
    console.error(`[rks.exec] Approval request created: ${approvalFile}`);

    // Return needs_approval response instead of throwing
    return {
      ok: false,
      status: "needs_approval",
      guardrail: "guardrail-critical",
      planId: runId,
      planHash,
      diff,
      approveCommand: `rks_approve({ projectId: "${projectId}", planId: "${runId}", confirm: true })`,
    };
  }

  // All precondition checks passed — emit exec.start
  try {
    collector.emit("exec.start", projectId, {
      problemId: plan.problemId || null,
      stepCount: plan.steps?.length || 0,
      planHash: plan.qualityReview?.hash || null,
      branchName: selectedSlug ? `rks/${selectedSlug}` : null,
    });
  } catch (e) { /* telemetry is best-effort */ }

  const guardrailExec = enforceGuardrail("rks.exec", {
    projectRoot,
    slug: selectedSlug,
  });

  let branchName = null;
  const gitRepo = hasGitRepo(projectRoot);
  if (gitRepo && selectedSlug) {
    branchName = `rks/${selectedSlug}`;
    ctx.branchName = branchName;

    // Stage ALL uncommitted notes files (modified or untracked) to carry to feature branch
    const notesDir = path.join(projectRoot, "notes");
    if (fs.existsSync(notesDir)) {
      const notesStatus = spawnSync("git", ["status", "--porcelain", "notes/"], { cwd: projectRoot, encoding: "utf8" });
      if (notesStatus.stdout.trim()) {
        runGit(projectRoot, ["add", "notes/"]);
        const lines = notesStatus.stdout.trim().split("\n").length;
        console.error(`[rks.exec] staged ${lines} uncommitted notes file(s)`);
      }
    }

    // CRITICAL: Block if baseBranch is protected (main, or staging in 3-branch)
    assertNotProtectedBranch(projectRoot, baseBranch, 'create feature branch from');

    runGit(projectRoot, ["checkout", baseBranch]);

    // Auto-cleanup orphaned self-branch from a prior interrupted build
    const existingBranch = spawnSync("git", ["branch", "--list", branchName], { cwd: projectRoot, encoding: "utf8" });
    if (existingBranch.stdout.trim()) {
      console.error(`[rks.exec] Orphaned branch detected: ${branchName} — auto-cleaning`);
      const cleanup = cleanupFeatureBranch(projectRoot, branchName, baseBranch);
      saveExecState(runDir, { ...execState, orphanedBranchCleaned: branchName });
      try {
        collector.emit("exec.orphaned_branch_cleaned", projectId, { branchName, checkoutOk: cleanup.checkoutOk, branchDeleteOk: cleanup.branchDeleteOk });
      } catch (e) { /* telemetry is best-effort */ }
      if (!cleanup.checkoutOk || !cleanup.branchDeleteOk) {
        const cleanupError = `Failed to clean up orphaned branch ${branchName}: checkout=${cleanup.checkoutOk}, delete=${cleanup.branchDeleteOk}. Delete it manually with: git branch -D ${branchName}`;
        markExecFailed(runDir, "orphaned_branch_cleanup", cleanupError);
        throw new McpError(ErrorCode.InvalidParams, cleanupError);
      }
    }

    updateExecPhase(runDir, ExecPhase.CREATING_BRANCH, { branchName });
    try {
      runGit(projectRoot, ["checkout", "-b", branchName, baseBranch]);
      updateExecPhase(runDir, ExecPhase.APPLYING_STEPS, { branchName });
    } catch (error) {
      markExecFailed(runDir, "branch_creation", error.message);
      throw new McpError(ErrorCode.InternalError, error.message);
    }
  }

  // Create backup before apply for rollback on failure
  let backupMeta = null;
  try {
    backupMeta = createBackup(projectRoot);
    ctx.backupMeta = backupMeta;
    console.error(`[rks.exec] Backup created: ${backupMeta.type}`);
  } catch (err) {
    console.warn(`[rks.exec] Backup failed (continuing without): ${err.message}`);
  }

  // Run preCommands before applying file changes
  const preCommandResults = [];
  // Snapshot files BEFORE preCommands so their side effects are excluded from scope check
  const preCommandBaseline = new Set(getUncommittedFiles(projectRoot));
  if (preCommands.length > 0) {
    console.error(`[rks.exec] Running ${preCommands.length} preCommand(s)...`);
    for (const cmd of preCommands) {
      try {
        console.error(`[rks.exec] preCommand: ${cmd}`);
        const result = spawnSync("sh", ["-c", cmd], {
          cwd: projectRoot,
          encoding: "utf8",
          timeout: 120000,
        });
        const ok = result.status === 0;
        preCommandResults.push({
          command: cmd,
          ok,
          exitCode: result.status,
          stdout: result.stdout?.slice(0, 500) || "",
          stderr: result.stderr?.slice(0, 500) || "",
        });
        if (ok) {
          console.error(`[rks.exec] preCommand succeeded: ${cmd}`);
        } else {
          console.warn(`[rks.exec] preCommand failed (exit ${result.status}): ${cmd}`);
        }
      } catch (err) {
        console.error(`[rks.exec] preCommand error: ${err.message}`);
        preCommandResults.push({
          command: cmd,
          ok: false,
          error: err.message,
        });
      }
    }
  }
  // Capture files generated by preCommands (e.g., package-lock.json from npm install)
  const postPreCommandFiles = new Set(getUncommittedFiles(projectRoot));
  const preCommandGeneratedFiles = new Set(
    [...postPreCommandFiles].filter(f => !preCommandBaseline.has(f))
  );
  if (preCommandGeneratedFiles.size > 0) {
    console.error(`[rks.exec] preCommand generated ${preCommandGeneratedFiles.size} file(s): ${[...preCommandGeneratedFiles].join(', ')}`);
  }

  // Toggle guardrails off for apply phase
  const planTargetFilesForScope = (plan.steps || []).map(s => s.target || s.path).filter(Boolean);
  let guardrailsSession = null;
  const offRailStartTime = Date.now();
  try {
    guardrailsSession = await guardrailsOff(
      projectRoot,
      `exec: applying plan ${selectedSlug}`,
      "all",
      plan.problemId || null,
      projectId
    );
    ctx.guardrailsSession = guardrailsSession;
    collector.emit("exec.guardrails_off", projectId, {
      problemId: plan.problemId || null,
      targetFiles: planTargetFilesForScope,
      branchName,
      planHash: plan.qualityReview?.hash || null,
      stepCount: plan.steps?.length || 0,
      correlationId,
    });
  } catch (e) {
    console.warn(`[rks.exec] guardrailsOff failed (continuing): ${e.message}`);
  }

  const applyResult = await runApplyTool({
    projectId,
    label: selectedSlug,
    _execContext: true,  // Signal we're in exec context
    // backlog.fix.dependency-add-contract-executable: the per-step guard INSIDE runApplyTool needs
    // this to apply the same exemptions as the final guard. It is a local of runExecToolInner, so
    // runApplyTool could not see it — and silently never exempted what the final guard did.
    preCommandGeneratedFiles,
  });

  // Per-step divergence detected inside runApplyTool — propagate immediately
  if (applyResult.error === "exec.diverged") {
    if (guardrailsSession?.ok) {
      try {
        await guardrailsOn(projectRoot, { skipAutoShip: true }, projectId);
      } catch (e) {
        console.warn(`[rks.exec] guardrailsOn failed on divergence path: ${e.message}`);
      }
    }
    return applyResult;
  }

  let appliedFiles = applyResult.appliedFiles || [];
  let stepsApplied = applyResult.stepsApplied || 0;

  // GOVERNANCE: Verify scope - only expected files should be modified.
  //
  // backlog.fix.dependency-add-contract-executable: ONE rule, shared with the per-step guard inside
  // runApplyTool (which used to be a separate copy that silently disagreed with this one). A
  // `run_command` step has no target/path, so an `npm install` the plan was TOLD to emit wrote
  // package.json + package-lock.json straight into unexpectedFiles — and exec rolled back the plan
  // for following its own instructions. The rule exempts those writes only when the plan genuinely
  // declares a dependency-add step; a blanket filename pass would be a hole in this guard.
  const expectedFiles = new Set((plan.steps || []).map(s => s.target || s.path).filter(Boolean));
  const modifiedFiles = getUncommittedFiles(projectRoot);
  const unexpectedFiles = computeUnexpectedFiles({
    steps: plan.steps || [],
    modifiedFiles,
    expectedFiles,
    preCommandGeneratedFiles,
  });
  if (unexpectedFiles.length > 0) {
    console.error(`[rks.exec] SCOPE VIOLATION: Unexpected files modified: ${unexpectedFiles.join(', ')}`);
    const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'scope_violation' });
    return {
      ok: false,
      rolledBack: true,
      partialDiffPath: rb.partialDiffPath,
      error: 'Scope violation - unexpected files modified',
      expectedFiles: [...expectedFiles],
      unexpectedFiles,
      hint: 'Plan modified files outside its declared scope. Changes have been rolled back.'
    };
  }

  // GOVERNANCE: Verify test files unchanged (unless this is a test-fix story)
  if (!isTestFixStory(plan) && testFileHashes.size > 0) {
    for (const [filePath, originalHash] of testFileHashes) {
      if (fs.existsSync(filePath)) {
        const currentContent = fs.readFileSync(filePath, 'utf8');
        const currentHash = createHash('sha256').update(currentContent).digest('hex');
        if (currentHash !== originalHash) {
          console.error(`[rks.exec] TEST FILE MODIFIED: ${filePath}`);
          const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'test_file_modified' });
          return {
            ok: false,
            rolledBack: true,
            partialDiffPath: rb.partialDiffPath,
            error: 'Test file modified without authorization',
            file: filePath,
            hint: 'Tests should not be modified unless the story explicitly targets them. Changes have been rolled back.'
          };
        }
      }
    }
    console.error(`[rks.exec] Test file integrity verified (${testFileHashes.size} files unchanged)`);
  }

  // Layer D: Static analysis on test files before running tests
  const testFilesApplied = appliedFiles.filter(f =>
    f.match(/\.(test|spec)\.(mjs|js|ts)$/)
  );
  if (testFilesApplied.length > 0 && !process.env.RKS_SKIP_STATIC_ANALYSIS) {
    const { analyzeTestQuality } = await import('./test-static-analysis.mjs');
    const staticResult = analyzeTestQuality(projectRoot, testFilesApplied);

    if (!staticResult.ok) {
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'static_analysis_failed' });
      return {
        ok: false,
        status: 'static_analysis_failed',
        message: 'Test quality issues detected by static analysis',
        issues: staticResult.issues,
        warnings: staticResult.warnings,
        summary: staticResult.summary,
        rolledBack: true,
        partialDiffPath: rb.partialDiffPath,
        hint: 'Fix the test quality issues and re-run rks_exec',
      };
    }

    // Log warnings but don't block
    if (staticResult.warnings.length > 0) {
      console.warn(`[rks.exec] Static analysis warnings: ${staticResult.warnings.length}`);
      for (const w of staticResult.warnings.slice(0, 3)) {
        console.warn(`  - ${w.file}: ${w.message}`);
      }
    }
  }

  // Install declared dependencies before running tests. A plan that adds a dependency (e.g. a test
  // runner like vitest) writes package.json, but nothing else installs it — so the post-apply test
  // phase would die on "Cannot find package ...". Run a bounded, best-effort `npm install` when the
  // plan touched package.json (or node_modules is missing), in the governed flow — no off-rail
  // detour. Non-fatal: a failed/slow install just lets the test phase surface the real error.
  // See backlog.fix.exec-post-apply-npm-install.
  if (shouldInstallDeps(appliedFiles, projectRoot)) {
    const installStart = Date.now();
    console.error("[rks.exec] package.json changed (or node_modules missing) — installing dependencies before tests...");
    let installOk = false;
    try {
      const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: projectRoot, timeout: 180000, encoding: "utf8",
      });
      installOk = r.status === 0;
      if (installOk) {
        console.error("[rks.exec] dependencies installed.");
      } else {
        console.warn(`[rks.exec] npm install exited ${r.status ?? "(timeout/signal)"} — proceeding; the test phase will surface any unresolved dependency.\n${(r.stderr || "").slice(0, 500)}`);
      }
    } catch (e) {
      console.warn(`[rks.exec] npm install failed to spawn: ${e?.message} — proceeding to tests.`);
    }
    try { collector.emit("exec.deps_installed", projectId, { installed: true, ok: installOk, durationMs: Date.now() - installStart }); } catch { /* telemetry best-effort */ }
  }

  // Track attempts for retry logic
  let attemptNumber = 1;
  let testsPassed = false;
  let testsSkipped = false;
  let lastVerification = null;
  let lastTestLogPath = null;
  const testStartTime = Date.now();

  // Run verification tests after apply (with retry loop)
  if (!skipTests && appliedFiles.length > 0) {
    while (attemptNumber <= MAX_RETRY_ATTEMPTS + 1) {
      console.error(`[rks.exec] Running verification tests (attempt ${attemptNumber})...`);
      const verification = runProjectTests(projectRoot, { testPaths: storyTestFiles });
      lastVerification = verification;

      if (verification.skipped) {
        console.error("[rks.exec] Verification tests skipped:", verification.reason);
        testsSkipped = true;
        break;
      }

      if (verification.passed) {
        console.error(`[rks.exec] Verification tests passed (attempt ${attemptNumber})`);
        testsPassed = true;
        updateExecPhase(runDir, ExecPhase.COMMITTING, { testsPassed: true });
        break;
      }

      // Tests failed - log the failure
      const testLogPath = path.join(runDir, attemptNumber === 1 ? "tests-failed.log" : `tests-failed-attempt-${attemptNumber}.log`);
      try {
        fs.writeFileSync(testLogPath, verification.output || "Tests failed (no output captured)");
        console.error(`[rks.exec] Test output written to ${testLogPath}`);
        lastTestLogPath = testLogPath;
      } catch (err) {
        console.warn(`[rks.exec] Failed to write test log: ${err.message}`);
      }

      // Check if we have retries left
      if (attemptNumber > MAX_RETRY_ATTEMPTS) {
        console.error(`[rks.exec] Max retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded. Giving up.`);
        break;
      }

      // Generate fix plan
      console.error(`[rks.exec] Tests failed, generating fix plan (retry ${attemptNumber} of ${MAX_RETRY_ATTEMPTS})...`);
      const fixPlan = await generateFixPlan({
        projectRoot,
        runDir,
        originalPlan: plan,
        appliedFiles,
        testOutput: verification.output || "",
        attemptNumber,
      });

      if (!fixPlan || !fixPlan.steps || fixPlan.steps.length === 0) {
        console.warn("[rks.exec] Fix plan generation failed or returned empty plan. Giving up.");
        break;
      }

      // Apply fix plan
      console.error(`[rks.exec] Applying fix plan (${fixPlan.steps.length} steps)...`);
      const fixResult = await applyFixPlan({
        projectId,
        projectRoot,
        plan: fixPlan,
        runDir,
        attemptNumber: attemptNumber + 1,
      });

      if (!fixResult.ok) {
        console.error(`[rks.exec] Fix plan apply failed: ${fixResult.error}`);
        break;
      }

      // Track additional files modified by fix plan
      for (const f of fixResult.appliedFiles || []) {
        if (!appliedFiles.includes(f)) {
          appliedFiles.push(f);
        }
      }
      stepsApplied += fixResult.stepsApplied || 0;

      attemptNumber++;
    }

    // Update run.json with attempt tracking
    const runJsonPath = path.join(runDir, "run.json");
    let runMeta = {};
    if (fs.existsSync(runJsonPath)) {
      try {
        runMeta = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      } catch {
        runMeta = {};
      }
    }
    runMeta.attempts = attemptNumber;
    runMeta.testsPassed = testsPassed;
    runMeta.testsSkipped = testsSkipped;
    if (!testsPassed && lastTestLogPath) {
      runMeta.paths = runMeta.paths || {};
      runMeta.paths.testsFailedLog = lastTestLogPath;
    }
    fs.writeFileSync(runJsonPath, JSON.stringify(runMeta, null, 2));

    // If tests still failing after retries, attempt rollback and return failure
    if (!testsPassed && !testsSkipped) {
      console.error(`[rks.exec] Tests failed after ${attemptNumber} attempts. Rolling back...`);
      const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason: 'test_failure' });

      // Log rollback to apply.log
      if (runDir) {
        const applyLogPath = path.join(runDir, "apply", "apply.log");
        try {
          ensureDir(path.dirname(applyLogPath));
          fs.appendFileSync(applyLogPath, `\n[rollback] ${new Date().toISOString()} - ${JSON.stringify(rb)}\n`);
        } catch (logErr) {
          console.warn(`[rks.exec] Failed to write rollback to apply.log: ${logErr.message}`);
        }
      }

      const problemId = plan.problemId || plan.problemPath?.replace(/^notes\//, "").replace(/\.md$/, "");

      // Re-plannability: a test-failed rollback must NOT leave the story stranded at
      // 'executing' (excluded from PLANNABLE_PHASES) — that wedges every subsequent re-plan
      // with state_transition_failed. Reset to 'arch-approved' so the story is re-plannable.
      resetStalePhaseToArchApproved(projectRoot, problemId);

      // Attempt to get refinement suggestions
      let refinementSuggestions = null;
      if (problemId) {
        try {
          const refineResult = await runRefineTool({
            projectRoot,
            problemId,
            trigger: "test_failed",
            context: `Tests failed after ${attemptNumber} attempt(s)`,
            testOutput: lastVerification?.output || "",
            projectId,
          });
          if (refineResult?.ok && refineResult?.suggestions?.length > 0) {
            refinementSuggestions = refineResult.suggestions;
          }
        } catch (e) {
          console.error(`[exec] refinement analysis failed: ${e?.message}`);
        }
      }

      telemetryTimer.fail({
        testsFailed: true,
        attempts: attemptNumber,
        stepsApplied: stepsApplied.length,
        correlationId,
        runId: runIdValue
      });
      return {
        ok: false,
        testsFailed: true,
        rolledBack: true,
        partialDiffPath: rb.partialDiffPath,
        projectId,
        slug: selectedSlug,
        branch: branchName,
        runFolder: runDir,
        runId: path.basename(runDir),
        stepsApplied,
        appliedFiles,
        attempts: attemptNumber,
        rollback: rb,
        refinementSuggestions,
        directive: "TESTS FAILED - FIX REQUIRED",
        requiredActions: [
          "1. Triage: Analyze failures in tests-failed*.log to identify root cause",
          "2. Fix: Apply fix (in current story or create blocking bug story)",
          "3. Re-test: Run rks_exec again to verify fix",
          "4. Loop: Repeat until all tests pass - do NOT ship until green"
        ],
        warning: "Do NOT ship until all tests pass. If fix requires a separate story, that story is part of THIS delivery package - both ship together.",
        hint: `Tests failed after ${attemptNumber} attempt(s). See tests-failed*.log for details.${rb.restored ? " Rollback applied." : ""}`,
        testsFailedLog: lastTestLogPath || null,
      };
    }
  } else if (skipTests) {
    console.error("[rks.exec] Skipping verification tests (--skip-tests)");
    testsSkipped = true;
  }

  if (gitRepo && appliedFiles.length) {
    try {
      runGit(projectRoot, ["add", ...appliedFiles]);
    } catch (error) {
      console.error(`[rks.exec] git add failed: ${error.message}`);
    }
  } else if (!gitRepo) {
    console.error("[rks.exec] No git repo detected; files written without staging.");
  }

  try {
    const timestamp = new Date().toISOString();
    const guardrailScenario = guardrailExec?.scenario?.id || plan.guardrail?.id || null;
    // Await the telemetry call to allow future async implementations and ensure errors are caught here.
    await recordTelemetry(projectRoot, {
      projectId,
      runId,
      slug: selectedSlug,
      branch: branchName,
      timestamp,
      metrics: buildTelemetryMetrics(plan, appliedFiles.length),
      guardrail: guardrailScenario ? { scenario: guardrailScenario, status: "pass" } : null,
      correlationId,
      runIdValue
    });

    // Emit to new JSONL-based collector
    telemetryTimer.complete({
      slug: selectedSlug,
      branch: branchName,
      stepsApplied: appliedFiles.length,
      testsRan: !skipTests && !testsSkipped,
      testsPassed,
      runId,
      guardrail: guardrailScenario,
      correlationId,
      runIdValue
    });
    try {
      collector.emit("exec.complete", projectId, {
        problemId: plan.problemId || null,
        slug: selectedSlug,
        durationMs: Date.now() - execStartMs,
        filesChanged: [...appliedFiles],
        testsPassed,
      });
    } catch (e) { /* telemetry is best-effort */ }
    await collector.flush();
  } catch (error) {
    console.warn(`[rks.exec] telemetry recording failed: ${error.message}`);
  }

  // Commit changes only (no PR creation) if tests passed (or autoCommit with skipped tests) and we're on a feature branch
  let commitResult = null;
  const shouldCommit = (testsPassed || testsSkipped) && branchName && branchName.startsWith("rks/");
  if (shouldCommit) {
    console.error(`[rks.exec] Tests passed, committing changes for ${branchName} to ${baseBranch}`);

    // First commit all staged changes
    try {
      commitResult = await runGitCommit({
        projectRoot,
        message: plan.problemId || selectedSlug,
        scope: "exec",
        type: "feat",
        files: [...appliedFiles],
      });
      if (commitResult.ok) {
        console.error(`[rks.exec] Committed changes: ${commitResult.commitId}`);
      } else {
        console.error(`[rks.exec] Commit skipped: ${commitResult.error}`);
      }
    } catch (err) {
      console.warn(`[rks.exec] Commit error: ${err.message}`);
      commitResult = { ok: false, error: err.message };
    }
  }

  // backlog.fix.exec-rollback-strands-executing-phase: THE FINALIZED BOUNDARY.
  //
  // Past this line there is DURABLE WORK that must never be destroyed, so a throw in the tail below
  // gets a phase reset and NOTHING else — no rollback(), which would `git branch -D` the branch
  // holding the commit we just made.
  //
  // Two arms, and both are load-bearing:
  //   - commitResult.ok === true  → a commit exists on rks/<slug>. (runGitCommit is wrapped in its
  //     own try/catch above that swallows failure into {ok:false}, so this is the exact signal.)
  //   - !shouldCommit → a green exec with no commit to make. Reaching here at all means tests passed
  //     or were skipped (the red-test path returned long ago), so the applied edits are GOOD. In a
  //     NON-GIT project createBackup takes the file-copy path, which means backupMeta is truthy and
  //     the post-mutation predicate would otherwise be TRUE — sending a tail throw into rollback()
  //     and restoring the backup OVER the green edits. This arm is what stops that.
  //
  // A FAILED commit leaves this false: nothing durable exists, so post-mutation rollback() is still
  // the right answer.
  if (!shouldCommit || commitResult?.ok === true) {
    ctx.finalized = true;
  }

  // Restore guardrails after apply+commit
  if (guardrailsSession?.ok) {
    try {
      await guardrailsOn(projectRoot, { skipAutoShip: true }, projectId);
      collector.emit("exec.guardrails_on", projectId, {
        problemId: plan.problemId || null,
        filesChanged: appliedFiles.length,
        testsPassed,
        durationMs: Date.now() - offRailStartTime,
        branchName,
        correlationId,
      });
    } catch (e) {
      console.warn(`[rks.exec] guardrailsOn failed (continuing): ${e.message}`);
    }
  }

  // R1.3 — rks_exec writer advances phase via the v2 op `exec_end`
  // (executing→executed). Since R1.3e the plan writer leaves the story at
  // `executing` and rks_exec gates on PHASE_GATE_EXEC === "executing" (see
  // workflow/phases.mjs), so exec_end's from:["executing"] matches the live
  // phase on completion. (Pre-gate-flip this advance silently failed: exec ran
  // at `planned` while exec_end requires `executing`.)
  if (problemId) {
    try {
      const result = await advancePhase(projectRoot, problemId, "exec_end", "rks.exec");
      if (result.ok) {
        console.error(`[rks.exec] Updated ${problemId} to phase: ${result.to}`);
      } else {
        console.error(`[rks.exec] Failed to update phase: ${result.error}`);
      }
    } catch (e) {
      console.error(`[rks.exec] Failed to update phase: ${e?.message}`);
    }
  }

  // Telemetry completion will be handled by the main success path below

  // Check if any applied files are test files — warn if none
  const appliedTestFiles = appliedFiles.filter(f => isTestFile(typeof f === "string" ? f : f.path || f.file || ""));
  const noNewTests = appliedTestFiles.length === 0;

  // Check testExempt from story frontmatter
  let storyTestExempt = false;
  if (problemId) {
    try {
      const storyData = loadStory(projectRoot, problemId);
      const testExemptVal = storyData.frontmatter.testExempt;
      storyTestExempt = testExemptVal === "true" || testExemptVal === true;
    } catch (e) { /* best-effort */ }
  }

  const testCoverageWarning = noNewTests && !storyTestExempt && !testsSkipped
    ? "No test files were added or modified in this plan. Consider adding tests for new functionality."
    : null;

  // Mark exec as complete
  markExecComplete(runDir, {
    testsPassed,
    commitId: commitResult?.commitId || null,
  });

  // Scoped auto-embed: re-index only the files exec touched so subsequent
  // planner calls get accurate RAG content (closes op:create → op:edit gap).
  // Failure is non-fatal — exec result is returned regardless.
  if (appliedFiles.length > 0) {
    try {
      const embedResult = await embedScopedFiles(projectRoot, appliedFiles);
      if (!embedResult.ok) {
        console.warn(`[rks.exec] auto-embed warning: ${embedResult.error}`);
      } else {
        console.error(`[rks.exec] auto-embedded ${embedResult.filesEmbedded} file(s)`);
      }
    } catch (e) {
      console.warn(`[rks.exec] auto-embed failed (non-fatal): ${e?.message}`);
    }
  }

  // Build result
  const problemIdForShip = problemId || selectedSlug;
  const requiredNextStep = problemIdForShip
    ? `rks_story_ship { projectId: "${projectId}", problemId: "${problemIdForShip}" }`
    : `rks_story_ship { projectId: "${projectId}" }`;

  return {
    ok: true,
    projectId,
    slug: selectedSlug,
    branch: branchName,
    runFolder: runDir,
    runId: path.basename(runDir),
    stepsApplied,
    appliedFiles,
    preCommandResults: preCommandResults.length > 0 ? preCommandResults : undefined,
    testsRan: !skipTests && !testsSkipped,
    testsPassed: testsPassed,
    testsSkipped: testsSkipped,
    attempts: attemptNumber,
    testVerification: testsSkipped ? null : lastVerification ? {
      passed: testsPassed,
      passCount: parseTestCount(lastVerification.output, 'passed'),
      failCount: parseTestCount(lastVerification.output, 'failed'),
      duration: Date.now() - testStartTime,
      attempts: attemptNumber,
    } : null,
    ...(testCoverageWarning ? { testCoverageWarning } : {}),
    status: 'pending_ship',
    requiredNext: requiredNextStep,
    message: `Exec complete. REQUIRED: Run ${requiredNextStep} to complete the story.`,
  };
}

async function runApplyTool({ projectId, label, _execContext = false, force = false,
  // OPTIONAL by necessity: rks_apply (server.mjs) calls this with neither. Defaulting to an
  // empty Set is also semantically right there — that path runs no preCommands.
  preCommandGeneratedFiles = new Set() }) {
  // Reject direct calls unless force flag is set
  if (!_execContext && !force) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "rks.apply cannot be called directly. Use rks.exec instead. For testing: pass force=true"
    );
  }
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  const collector = ensureTelemetryStorage(projectRoot);
  const slug = label ? slugify(label) : null;
  const { plan, runDir, runMeta: initialRunMeta } = loadPlan(projectRoot, slug);
  let runMeta = initialRunMeta;
  const runJsonPath = path.join(runDir, "run.json");
  const branchName = null;  // runApplyTool doesn't create branches
  const baseBranch = null;
  const correlationId = runMeta?.correlationId || null;

  const applyDir = path.join(runDir, "apply");
  ensureDir(applyDir);
  const applyLogPath = path.join(applyDir, "apply.log");
  const logLines = [];
  const writeLog = (line) => logLines.push(line);

  const appliedFiles = [];
  const stepsApplied = [];

  const getTargetPath = (step) => step?.target || step?.path || null;

  const finalizeRunMeta = (outcome) => {
    const now = new Date().toISOString();
    const currentTimestamps = runMeta.timestamps || {};
    runMeta = {
      ...runMeta,
      timestamps: { ...currentTimestamps, appliedAt: now },
      telemetry: { ...(runMeta.telemetry || {}), outcome },
    };
    fs.writeFileSync(runJsonPath, JSON.stringify(runMeta, null, 2));
  };

  try {
    const protectedConfig = loadProjectProtectedConfig(projectRoot);
    const protectedPatterns = [
      ...(protectedConfig.protected || []),
      ...(protectedConfig.projectProtected || []),
    ];

    for (const step of plan.steps) {
      if (!step || !step.action) continue;
      const action = step.action;
      const target = getTargetPath(step);

      if (action === "note") {
        writeLog(`skip: ${action}`);
        continue;
      }

      if (action === "run_command") {
        const cmd = step.command;
        if (!cmd || !cmd.trim()) {
          writeLog(`skip: run_command (no command)`);
          continue;
        }

        try {
          const result = await handleRunCommandStep(cmd, {
            projectRoot,
            planApproved: true,
            timeout: 60000,
          });

          if (result.executed) {
            writeLog(`run_command: ${cmd}`);
            writeLog(`  classification: ${result.classification}`);
            writeLog(`  exit_code: ${result.exec.code}`);
            if (result.exec.stdout) writeLog(`  stdout: ${result.exec.stdout.slice(0, 200)}`);
            if (result.exec.stderr) writeLog(`  stderr: ${result.exec.stderr.slice(0, 200)}`);

            if (result.exec.code !== 0) {
              throw new McpError(
                ErrorCode.InternalError,
                `run_command failed (exit ${result.exec.code}): ${cmd}`
              );
            }
            stepsApplied.push(action);
          } else if (result.skipped) {
            writeLog(`skip: run_command (${result.reason}): ${cmd}`);
          }
        } catch (err) {
          if (err instanceof McpError) throw err;
          throw new McpError(ErrorCode.InternalError, `run_command error: ${err.message}`);
        }
        continue;
      }

      if (!target || typeof target !== "string" || !target.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "Step missing path/target");
      }

      const absPath = path.join(projectRoot, target);

      if (isProtectedPath(target, protectedPatterns)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Attempted to edit protected file: ${target}. See .rks/protected-files.yml.`
        );
      }

      if (action === "create_file") {
        applyCreateFile(absPath, step.content ?? "");
        writeLog(`wrote: ${target}`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else if (action === "edit_file") {
        if (!fs.existsSync(absPath)) {
          throw new McpError(ErrorCode.InvalidParams, `Cannot edit missing file: ${target}`);
        }
        if (!step.content || !String(step.content).trim()) {
          throw new McpError(ErrorCode.InvalidParams, `edit_file step missing content for ${target}`);
        }
        const scope = step.scope || "file";
        if (!step.scope || scope === "file") {
          fs.writeFileSync(absPath, step.content, "utf8");
          writeLog(`wrote: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else if (scope === "function" && step.targetId) {
          const sourceText = fs.readFileSync(absPath, "utf8");
          const slice = findFunctionSlice(sourceText, step.targetId);
          if (!slice) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Function ${step.targetId} not found or ambiguous in ${target}`
            );
          }
          const updated = replaceSlice(sourceText, slice, step.content);
          fs.writeFileSync(absPath, updated, "utf8");
          writeLog(`wrote function slice: ${target} (${step.targetId})`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unsupported edit scope for ${target}: ${scope}`);
        }
      } else if (action === "delete_file") {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { force: true });
          writeLog(`deleted: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          writeLog(`skip delete (missing): ${target}`);
        }
      } else if (action === "search_replace") {
        if (!Array.isArray(step.edits) || step.edits.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, `search_replace step missing edits for ${target}`);
        }
        const result = applySearchReplace(absPath, step.edits);
        writeLog(`search_replace: ${target} (${result.applied} edits)`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else {
        writeLog(`skip unsupported action: ${action}`);
      }

      // Per-step divergence detection (only in exec context, not force/test mode)
      if (_execContext) {
        const stepIndex = plan.steps.indexOf(step);
        const expectedFilesThrough = new Set(
          plan.steps.slice(0, stepIndex + 1).map(s => s.target || s.path).filter(Boolean)
        );
        const divergenceCheck = detectPerStepDivergence(
          projectRoot,
          expectedFilesThrough,
          preCommandGeneratedFiles,
          plan.steps || [],
        );
        if (divergenceCheck.diverged) {
          console.error(`[rks_exec] PER-STEP DIVERGENCE at step ${stepIndex}: ${divergenceCheck.unexpectedFiles.join(', ')}`);
          writeLog(`DIVERGENCE at step ${stepIndex}: unexpected files ${divergenceCheck.unexpectedFiles.join(', ')}`);
          collector.emit("exec.divergence_detected", projectId, {
            unexpectedFiles: divergenceCheck.unexpectedFiles,
            stepIndex,
            problemId: plan.problemId || null,
            branchName,
            correlationId,
          });

          const rb = await rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta: null, guardrailsSession: null, projectId, reason: 'per_step_divergence' });

          fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
          finalizeRunMeta("diverged");

          return {
            ok: false,
            error: "exec.diverged",
            stepIndex,
            expectedFiles: divergenceCheck.expectedFiles,
            actualFiles: divergenceCheck.actualFiles,
            unexpectedFiles: divergenceCheck.unexpectedFiles,
            missingFiles: divergenceCheck.missingFiles,
            diffSummary: `Step ${stepIndex} modified unexpected files: ${divergenceCheck.unexpectedFiles.join(', ')}`,
            partialDiffPath: rb.partialDiffPath,
            rolledBack: true,
          };
        }
      } // end if (_execContext) divergence check
    }

    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
    finalizeRunMeta("applied");

    // Layer 3: Test coverage analysis
    const testFilesModified = appliedFiles.filter(isTestFile);
    const codeFilesModified = appliedFiles.filter(f => 
      !isTestFile(f) && f.match(/\.(js|mjs|ts)$/)
    );

    let testCoverageWarning = null;
    if (codeFilesModified.length > 0 && testFilesModified.length === 0) {
      testCoverageWarning = `Modified ${codeFilesModified.length} code file(s) but no test files were updated`;
      console.error(`[rks_exec] Warning: ${testCoverageWarning}`);
    }

    return {
      ok: true,
      projectId,
      slug: slug || runMeta.slug || path.basename(runDir).split("_").slice(1).join("_"),
      runId: path.basename(runDir),
      stepsApplied: stepsApplied.length,
      appliedFiles,
      testFilesModified,
      codeFilesModified: codeFilesModified.length,
      testCoverageWarning,
    };
  } catch (error) {
    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n${error.message}\n`, "utf8");
    finalizeRunMeta("failed");
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error.message || String(error));
  }
}

/**
 * Reset a story stranded at 'executing' back to 'arch-approved' so it is re-plannable.
 * A test-failed rollback or aborted run must not leave the phase at 'executing' (excluded
 * from PLANNABLE_PHASES) — that wedges every re-plan with state_transition_failed. This is a
 * RESET, not a forward transition (advancePhase has no reverse edge out of 'executing'), so
 * the field is written directly. Best-effort no-op when the story isn't at 'executing' or
 * can't be loaded. Returns true iff a reset was applied.
 */
export function resetStalePhaseToArchApproved(projectRoot, storyId) {
  if (!storyId) return false;
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const story = loadStory(projectRoot, storyId);
    if (story?.frontmatter?.phase === PHASE_GATE_EXEC) {
      updateField(notesDir, storyId, "phase", "arch-approved");
      return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/**
 * Abort an incomplete exec run and clean up state.
 * Use this when exec fails mid-execution and leaves behind incomplete state.
 */
async function runExecAbortTool({ projectId, reason }) {
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;

  // Find incomplete exec run using same logic as exec detection
  const incompleteRuns = findIncompleteRuns(projectRoot);
  const incompleteRun = incompleteRuns.length > 0 ? {
    runId: incompleteRuns[0].runId,
    statePath: path.join(projectRoot, ".rks", "runs", incompleteRuns[0].runId, "exec-state.json"),
    phase: incompleteRuns[0].state.currentPhase,
    storyId: incompleteRuns[0].state.storyId,
    completedSteps: incompleteRuns[0].state.completedSteps?.length || 0,
  } : null;

  if (!incompleteRun) {
    // P0-2 RESET leg: there's no recoverable run record, but a story can still be stranded
    // at phase 'executing' (exec interrupted before/without a usable exec-state). Scan the
    // notes for executing stories and reset EXACTLY ONE back to 'arch-approved' so rks_plan
    // re-accepts it. 0 → unchanged no-op; >1 → refuse and list candidates (never guess which).
    const notesDir = resolveNotesDir(projectRoot);
    const stranded = [];
    try {
      if (fs.existsSync(notesDir)) {
        for (const file of fs.readdirSync(notesDir)) {
          if (!file.endsWith(".md")) continue;
          const content = fs.readFileSync(path.join(notesDir, file), "utf8");
          if (!/^phase:\s*["']?executing["']?\s*$/m.test(content)) continue;
          const idMatch = content.match(/^id:\s*["']?([^"'\n]+)["']?\s*$/m);
          stranded.push(idMatch ? idMatch[1].trim() : file.replace(/\.md$/, ""));
        }
      }
    } catch (e) { /* scan is best-effort */ }

    if (stranded.length === 0) {
      return {
        ok: false,
        error: "No incomplete exec run found",
        hint: "Nothing to abort. You can run rks_exec to start a new execution.",
      };
    }
    if (stranded.length > 1) {
      return {
        ok: false,
        error: "Multiple stories stranded at phase 'executing'",
        candidates: stranded,
        hint: `Ambiguous recovery: ${stranded.length} stories are at phase 'executing' (${stranded.join(", ")}). Abort will not guess which to reset — re-run rks_plan on the intended story, or resolve manually.`,
      };
    }

    // Exactly one stranded story — reset it to arch-approved (a reset, not a forward op,
    // so write the field directly, mirroring the planner-persistence re-plan reset).
    const storyId = stranded[0];
    updateField(notesDir, storyId, "phase", "arch-approved");
    try {
      const collector = ensureTelemetryStorage(projectRoot);
      collector.emit("exec.abort", projectId, { reason: reason || "manual", phase: "executing", storyId, recovery: "stranded_reset" });
    } catch (e) { /* telemetry is best-effort */ }
    return {
      ok: true,
      resetStory: storyId,
      phase: "arch-approved",
      storyId,
      requiredNext: `rks_plan { "projectId": "${projectId}", "problemId": "${storyId}" }`,
      hint: `Story ${storyId} was stranded at 'executing' with no recoverable run; reset to 'arch-approved'. Re-run rks_plan to re-drive it.`,
    };
  }

  // Clean up working tree
  try {
    cleanupWorkingTree(projectRoot);
  } catch (e) {
    // Best effort cleanup
  }

  // Remove exec state file
  try {
    fs.unlinkSync(incompleteRun.statePath);
  } catch (e) {
    // Best effort removal
  }

  // Emit telemetry
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit("exec.abort", projectId, {
      runId: incompleteRun.runId,
      reason: reason || "manual",
      phase: incompleteRun.phase,
      storyId: incompleteRun.storyId,
    });
  } catch (e) {
    // Telemetry is best-effort
  }

  // Also reset the story's lifecycle phase: an aborted run must not leave the story stranded
  // at 'executing' (excluded from PLANNABLE_PHASES), which would wedge re-plan. The no-record
  // leg above already does this; the run-record leg must too.
  resetStalePhaseToArchApproved(projectRoot, incompleteRun.storyId);

  return {
    ok: true,
    abortedRun: incompleteRun.runId,
    phase: incompleteRun.phase,
    storyId: incompleteRun.storyId,
    requiredNext: `rks_plan { "projectId": "${projectId}" }`,
    hint: "Exec aborted. You can now retry with rks_plan or refine the story.",
  };
}

export {
  runExecTool,
  runApplyTool,
  runExecAbortTool,
  cleanupFeatureBranch,
  runCheckedGit,
  getCurrentBranch,
  isWorkingTreeClean,
  hasGitRepo,
  runGit,
  getUncommittedFiles,
  assertCleanWorkingTree,
};
