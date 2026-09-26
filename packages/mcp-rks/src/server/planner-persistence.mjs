/**
 * Planner Persistence Module
 *
 * Handles persisting plan artifacts to the run folder:
 * - plan.json, plan.yaml
 * - problem.yaml
 * - run.json (run record)
 * - validate/report.md, learn.md scaffolds
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { spawnSync } from "child_process";
import { ensureDir } from "./project.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";
import { reviewPlan } from "./plan-quality.mjs";
import { autoCorrectSearchPatterns, validateSearchReplacePatterns } from "../validation/search-replace.mjs";
import { runRefineTool } from "./refine.mjs";
import { updateField, resolveNotesDir, readNote } from "../dendron.mjs";
import { validateTransition } from "../workflow/state-machine.mjs";
import { advancePhase } from "../workflow/auto-phase.mjs";
import { ensureExecStartPhase, decideExecStartAction } from "./exec-start-durability.mjs";

// Re-exported so existing importers (and their tests) are unaffected by the move.
// The implementation now lives in exec-start-durability.mjs, beside the phase write
// it governs, so both the worker and the parent-side net share one decision table.
export { decideExecStartAction };

/**
 * Emit telemetry event (best-effort, never throws)
 */
function emitTelemetry(event, projectId, data) {
  try {
    const collector = getTelemetryCollector();
    collector.emit(event, projectId, data);
  } catch (e) {
    // Telemetry is best-effort
  }
}

/**
 * Build the problem.yaml structure
 * @param {Object} options
 * @param {string} options.problemId - Problem ID or slug
 * @param {string} options.slug - Plan slug
 * @param {string} options.planSummary - Summary of the plan
 * @param {string} options.requirementSummary - Requirement summary fallback
 * @param {string} options.problemPath - Path to problem note (optional)
 * @param {string} options.projectRoot - Project root path
 * @param {string} options.projectId - Project ID
 * @param {Array} options.ragCodePreview - RAG code preview items
 * @param {string} options.generatedAt - ISO timestamp
 * @returns {Object} Problem YAML structure
 */
export function buildProblemYaml({
  problemId,
  slug,
  planSummary,
  requirementSummary,
  problemPath,
  projectRoot,
  projectId,
  ragCodePreview = [],
  generatedAt,
}) {
  return {
    id: problemId || slug,
    source: problemId ? "note" : "task",
    goal: planSummary || requirementSummary || null,
    scope: Array.from(
      new Set([
        ...(problemPath ? [path.relative(projectRoot, problemPath)] : []),
        ...(ragCodePreview.map((c) => c.path).filter(Boolean) || []),
      ])
    ),
    constraints: [],
    acceptance: [],
    meta: {
      projectId,
      generatedAt,
      problemPath: problemPath || null,
      slug,
    },
  };
}

/**
 * Build the plan.yaml structure
 * @param {Object} options
 * @param {string} options.slug - Plan slug
 * @param {string} options.projectId - Project ID
 * @param {Object} options.plan - Full plan object
 * @param {string} options.planStatus - Plan status
 * @returns {Object} Plan YAML structure
 */
export function buildPlanYaml({ slug, projectId, plan, planStatus }) {
  return {
    id: slug,
    projectId,
    problemId: plan.problemId,
    problemPath: plan.problemPath,
    summary: plan.planSummary,
    generatedAt: plan.generatedAt,
    status: plan.status || planStatus,
    guardrail: plan.guardrail || null,
    rag: plan.ragContextSummary || null,
    steps: (plan.steps || []).map((step, idx) => ({
      id: step.id || `step-${idx + 1}`,
      action: step.action,
      target: step.path || null,
      content: step.content || null,
      edits: step.edits || null,
      command: step.command || null,
      title: step.title || null,
      description: step.description || null,
      order: step.order ?? idx + 1,
    })),
  };
}

/**
 * Build the run record structure
 * @param {Object} options
 * @param {string} options.projectId - Project ID
 * @param {string} options.runFolder - Run folder path
 * @param {string} options.slug - Plan slug
 * @param {Object} options.plan - Full plan object
 * @param {string} options.planStatus - Plan status
 * @param {Object} options.paths - File paths object
 * @returns {Object} Run record structure
 */
export function buildRunRecord({
  projectId,
  runFolder,
  slug,
  plan,
  planStatus,
  paths,
}) {
  return {
    projectId,
    runId: path.basename(runFolder),
    slug,
    problemId: plan.problemId,
    problemPath: plan.problemPath,
    status: plan.status || planStatus || "note_only",
    timestamps: {
      plannedAt: plan.generatedAt,
      validatedAt: null,
      appliedAt: null,
    },
    summary: plan.planSummary || null,
    telemetry: {
      ragNotes: plan.ragContextSummary?.notesHitCount ?? null,
      ragCode: plan.ragContextSummary?.codeHitCount ?? null,
      ragKg: plan.ragContextSummary?.kgHitCount ?? null,
      outcome: "planned",
      exitCode: null,
    },
    paths: {
      problem: paths.problemPath,
      planYaml: paths.planYamlPath,
      planJson: paths.planJsonPath,
      validateReport: paths.validateReportPath,
      applyLog: paths.applyLogPath,
      learn: paths.learnPath,
    },
    legacy: {
      planJson: true,
      llmOutput: fs.existsSync(path.join(runFolder, "llm-output.json")),
    },
  };
}

/**
 * Persist all run files to the run folder
 * @param {Object} options
 * @param {string} options.runFolder - Run folder path
 * @param {Object} options.plan - Full plan object
 * @param {Object} options.problemYaml - Problem YAML structure
 * @param {Object} options.planYaml - Plan YAML structure
 * @param {string} options.slug - Plan slug
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} Paths to all created files
 */
export function persistRunFiles({
  runFolder,
  plan,
  problemYaml,
  planYaml,
  slug,
  projectId = null,
}) {
  // Create subdirectories
  const validateDir = path.join(runFolder, "validate");
  const applyDir = path.join(runFolder, "apply");
  ensureDir(validateDir);
  ensureDir(applyDir);

  // Define all paths
  const planJsonPath = path.join(runFolder, "plan.json");
  const planYamlPath = path.join(runFolder, "plan.yaml");
  const problemPath = path.join(runFolder, "problem.yaml");
  const validateReportPath = path.join(validateDir, "report.md");
  const applyLogPath = path.join(applyDir, "apply.log");
  const learnPath = path.join(runFolder, "learn.md");
  const runJsonPath = path.join(runFolder, "run.json");

  // Write plan.json
  fs.writeFileSync(planJsonPath, JSON.stringify(plan, null, 2));

  // Write problem.yaml
  fs.writeFileSync(problemPath, yaml.dump(problemYaml), "utf8");

  // Write plan.yaml
  fs.writeFileSync(planYamlPath, yaml.dump(planYaml, { lineWidth: -1 }), "utf8");

  // Create validation report scaffold if not exists
  if (!fs.existsSync(validateReportPath)) {
    fs.writeFileSync(
      validateReportPath,
      `# Validation Report\n\nNot validated yet. Generated at ${plan.generatedAt} for ${slug}.\n`,
      "utf8"
    );
  }

  // Create learnings scaffold if not exists
  if (!fs.existsSync(learnPath)) {
    fs.writeFileSync(
      learnPath,
      `# Learnings\n\nAdd learnings for run ${slug} here after validate/apply.\n`,
      "utf8"
    );
  }

  // Build and write run record
  const runRecord = buildRunRecord({
    projectId: plan.projectId,
    runFolder,
    slug,
    plan,
    planStatus: plan.status,
    paths: {
      problemPath,
      planYamlPath,
      planJsonPath,
      validateReportPath,
      applyLogPath,
      learnPath,
    },
  });
  fs.writeFileSync(runJsonPath, JSON.stringify(runRecord, null, 2));

  // Emit telemetry
  emitTelemetry("persistence.run.saved", projectId, {
    slug,
    runFolder: path.basename(runFolder),
    filesCreated: [
      "plan.json",
      "plan.yaml",
      "problem.yaml",
      "run.json",
      "validate/report.md",
      "learn.md",
    ],
  });

  return {
    planJsonPath,
    planYamlPath,
    problemPath,
    validateReportPath,
    applyLogPath,
    learnPath,
    runJsonPath,
  };
}

/**
 * Update an existing run record
 * @param {string} runFolder - Run folder path
 * @param {Object} updates - Fields to update
 * @param {string} projectId - Project ID for telemetry
 * @returns {Object} Updated run record
 */
export function updateRunRecord(runFolder, updates, projectId = null) {
  const runJsonPath = path.join(runFolder, "run.json");

  if (!fs.existsSync(runJsonPath)) {
    throw new Error(`Run record not found: ${runJsonPath}`);
  }

  const runRecord = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
  const updated = { ...runRecord, ...updates };

  // Handle nested updates
  if (updates.timestamps) {
    updated.timestamps = { ...runRecord.timestamps, ...updates.timestamps };
  }
  if (updates.telemetry) {
    updated.telemetry = { ...runRecord.telemetry, ...updates.telemetry };
  }

  fs.writeFileSync(runJsonPath, JSON.stringify(updated, null, 2));

  emitTelemetry("persistence.run.updated", projectId, {
    slug: runRecord.slug,
    updatedFields: Object.keys(updates),
  });

  return updated;
}

/**
 * Decide how persistAndFinalize should handle the exec_start phase transition for an
 * executable plan, based on the story's current on-disk phase.
 *
 * exec_start.from is ["arch-approved"] only (workflow/phases.mjs) and is the SOLE transition
 * into "executing". PLANNABLE_PHASES admits "ready", so an executable plan can legitimately
 * arrive here at a pre-ARCH phase (e.g. a bare rks_plan with no refine-apply amendment).
 * Calling advancePhase("exec_start") from "ready" returns state_transition_failed and the
 * (valid) plan is lost / surfaced to the caller as worker_crashed. This helper keeps the
 * three intended behaviors and adds a safe pre-ARCH path:
 *  - "arch-approved"                       → advance (normal first-plan path)
 *  - planned / executing / executed        → reset to arch-approved, then advance (P0-3 idempotent re-plan)
 *  - "ready"/"draft" (pre-ARCH plannable)   → do NOT advance (preserve the ARCH gate) and do NOT
 *                                            crash; the executable plan is persisted as-is
 *  - "released"/"integrated" (post-release) → REJECT loudly: an executable plan for an immutable,
 *                                            already-released story must not silently persist
 *                                            (defensive — upstream PLANNABLE_PHASES gates this today)
 *  - null/undefined (note read failed)     → advance and let advancePhase validate (preserve prior behavior)
 *
 * (backlog.fix.planner-persist-ready-phase-exec-start-crash,
 *  backlog.fix.planner-persist-reject-post-release-phase)
 * @param {string|undefined|null} currentPhase
 * @returns {{ reset: boolean, advance: boolean, reject?: boolean }}
 */
// MOVED to ./exec-start-durability.mjs and re-exported at the top of this file, so the
// decision table sits beside the phase write it governs and both the detached worker and
// the parent-side durability net share one copy. Behaviour is unchanged.

/**
 * High-level orchestrator: quality review + persist + phase routing + final result.
 * Called by runPlanTool after plan assembly.
 */
/**
 * Commit the story note's phase write to GIT.
 *
 * This previously sat inline inside an EMPTY catch. `spawnSync` does not throw
 * on a non-zero exit, so that catch could never fire and a failed commit was
 * indistinguishable from a successful one. That is load-bearing: verifying the
 * phase write reached DISK is not enough, because the exec backup stash resets
 * the worktree to HEAD — an uncommitted phase write is exactly what gets lost.
 *
 * Extracted as a named export so the failure path is testable by injecting a
 * spawn stub, without standing up the whole persistAndFinalize pipeline.
 *
 * @param {typeof spawnSync} spawn injectable for testing.
 * @returns {{ committed: boolean, commitError: null | { command: string, status: number, stderr: string } }}
 */
export function commitPhaseWrite(projectRoot, normalizedProblem, toPhase, spawn = spawnSync) {
  const notePath = `notes/${normalizedProblem}.md`;
  const opts = { cwd: projectRoot, encoding: "utf8" };

  const addRes = spawn("git", ["add", notePath], opts);
  if (addRes?.status !== 0) {
    return {
      committed: false,
      commitError: { command: `git add ${notePath}`, status: addRes?.status ?? null, stderr: (addRes?.stderr || "").trim() },
    };
  }

  const message = `docs(backlog): mark ${normalizedProblem} as ${toPhase}`;
  const commitRes = spawn("git", ["commit", "-m", message], opts);
  if (commitRes?.status !== 0) {
    return {
      committed: false,
      commitError: { command: `git commit -m "${message}"`, status: commitRes?.status ?? null, stderr: (commitRes?.stderr || "").trim() },
    };
  }

  return { committed: true, commitError: null };
}

export async function persistAndFinalize({
  plan, planStatus, projectRoot, projectId, normalizedProblem, normalizedTask,
  normalizedLabel, finalSlug, runFolder, planningText, storyMeta,
  frontmatterTargets, frontmatterCreateFiles, autoEmbedded, taskModeSuggestion, combinedSteps,
}) {
  // Auto-correct whitespace in search_replace patterns
  autoCorrectSearchPatterns(plan, projectRoot);

  // Run quality review
  // Build op-aware coverage targets: frontmatterTargets is every target path; frontmatterCreateFiles
  // is the op:create subset. (backlog.fix.plan-review-validates-target-coverage)
  const coverageTargets = (Array.isArray(frontmatterTargets) ? frontmatterTargets : []).map(p => ({
    path: p,
    op: (frontmatterCreateFiles && typeof frontmatterCreateFiles.has === 'function' && frontmatterCreateFiles.has(p)) ? 'create' : 'edit',
  }));
  const qualityReview = await reviewPlan({ projectRoot, plan, problemContent: planningText, storyMeta, targetFiles: coverageTargets });
  plan.qualityReview = {
    hash: qualityReview.hash, reviewedAt: new Date().toISOString(),
    passed: qualityReview.ok, errors: qualityReview.errors || [], warnings: qualityReview.warnings || [],
  };

  const planJsonPath = path.join(runFolder, "plan.json");

  if (!qualityReview.ok) {
    fs.writeFileSync(planJsonPath, JSON.stringify(plan, null, 2));
    try { const rc = path.join(runFolder, "llm-output.json"); if (fs.existsSync(rc)) fs.unlinkSync(rc); } catch { }
    return {
      ok: false, status: "quality_failed", projectId, slug: finalSlug, runFolder,
      planPath: planJsonPath, errors: qualityReview.errors, warnings: qualityReview.warnings,
      suggestions: qualityReview.suggestions,
    };
  }

  // Persist all files using existing helpers
  const problemYamlData = buildProblemYaml({
    problemId: normalizedProblem, slug: finalSlug, planSummary: plan.planSummary,
    problemPath: plan.problemPath, projectRoot, projectId,
    ragCodePreview: plan.ragContextPreview?.code, generatedAt: plan.generatedAt,
  });
  const planYamlData = buildPlanYaml({ slug: finalSlug, projectId, plan, planStatus });
  autoCorrectSearchPatterns(planYamlData, projectRoot);
  validateSearchReplacePatterns(planYamlData, projectRoot);

  const paths = persistRunFiles({
    runFolder, plan, planJsonPath, problemYaml: problemYamlData,
    planYaml: planYamlData, slug: finalSlug,
  });

  const runRecord = buildRunRecord({
    projectId, runFolder, slug: finalSlug, plan, planStatus, paths,
  });
  fs.writeFileSync(path.join(runFolder, "run.json"), JSON.stringify(runRecord, null, 2));

  console.error(`[rks.plan] project=${projectId} slug=${finalSlug} steps=${combinedSteps.length} problem=${normalizedProblem || "(none)"} -> ${paths.planYaml}`);

  // Refinement suggestions for note-only plans
  let refinementSuggestions = null;
  if (planStatus === "note_only" && normalizedProblem) {
    try {
      const refineResult = await runRefineTool({ projectRoot, problemId: normalizedProblem, trigger: "plan_failed", context: null, projectId });
      if (refineResult?.ok && refineResult?.suggestions?.length > 0) refinementSuggestions = refineResult.suggestions;
    } catch (e) { console.error(`[planner] refinement analysis failed: ${e?.message}`); }
  }

  // Phase routing. EXHAUSTIVE over PLAN_STATUS_VALUES — a non-exhaustive branch here
  // is the defect this block was rewritten for: needs_refinement and error fell through
  // with no phase write, no telemetry and no error, and persistAndFinalize still returned
  // ok:true. A child project deadlocked because the story could never reach 'executing'.
  //
  // The catch is NOT swallowing any more. A failed state write returns a structured
  // phase_write_failed that RETAINS the plan artifacts — the plan is good; only the
  // state write failed, and discarding a valid plan would be its own defect.
  let phaseWrite = null;
  // null = no commit was attempted; true/false = the commit's actual outcome.
  let committed = null;
  let commitError = null;
  if (normalizedProblem) {
    const notesDir = resolveNotesDir(projectRoot);
    const planFailure = (error, extra = {}) => ({
      ok: false,
      status: "phase_write_failed",
      projectId,
      problemId: normalizedProblem,
      slug: finalSlug,
      phaseWrite: { attempted: true, from: extra.from ?? null, to: extra.to ?? "executing", error },
      // Plan artifacts are RETAINED — see above.
      runId: path.basename(runFolder),
      runFolder,
      planPath: paths.planYaml,
      planJsonPath,
      message: `Plan persisted, but the story phase write failed: ${error}`,
    });

    if (planStatus === "note_only" || planStatus === "quality_failed") {
      try {
        updateField(notesDir, normalizedProblem, "phase", "draft");
        emitTelemetry("story.phase.changed", projectId, { storyId: normalizedProblem, from: "ready", to: "draft", reason: "quality_failed" });
        phaseWrite = { attempted: true, ok: true, to: "draft" };
      } catch (e) {
        return planFailure(`draft write failed: ${e?.message || e}`, { to: "draft" });
      }
    } else if (planStatus === "executable") {
      const res = await ensureExecStartPhase({ projectRoot, problemId: normalizedProblem, projectId, notesDir });
      if (res.rejected) {
        emitTelemetry("story.phase.exec_start_rejected", projectId, {
          storyId: normalizedProblem, phase: res.from || null, planStatus, reason: "post_release_immutable",
        });
        return {
          ok: false, projectId, problemId: normalizedProblem, error: "phase_immutable_plan_rejected",
          message: `Refusing to persist an executable plan for '${normalizedProblem}' at immutable phase '${res.from}'.`,
        };
      }
      if (!res.ok) return planFailure(res.error || "state_transition_failed", { from: res.from, to: res.to });
      if (res.skipped) {
        emitTelemetry("story.phase.exec_start_skipped", projectId, {
          storyId: normalizedProblem, phase: res.from || null, planStatus, reason: res.skipped,
        });
      } else if (res.verified) {
        const outcome = commitPhaseWrite(projectRoot, normalizedProblem, res.to);
        committed = outcome.committed;
        commitError = outcome.commitError;
        if (committed === false) {
          console.error(`[rks.plan] phase commit FAILED for ${normalizedProblem}: ${commitError.command} exited ${commitError.status}: ${commitError.stderr}`);
          emitTelemetry("story.phase.exec_start_commit_failed", projectId, {
            storyId: normalizedProblem, phase: res.to || null, planStatus,
            command: commitError.command, status: commitError.status,
          });
        }
      }
      phaseWrite = { attempted: res.attempted, ok: true, from: res.from ?? null, to: res.to, verified: !!res.verified, skipped: res.skipped ?? null, committed, ...(commitError ? { commitError } : {}) };
    } else {
      // EXHAUSTIVE TAIL — needs_refinement, error, and any status added later.
      // Not a silent fall-through: the outcome is named and emitted so the same
      // class of bug cannot recur invisibly.
      emitTelemetry("story.phase.exec_start_skipped", projectId, {
        storyId: normalizedProblem, phase: null, planStatus, reason: `plan_status_${planStatus}`,
      });
      phaseWrite = { attempted: false, ok: true, from: null, to: null, skipped: `plan_status_${planStatus}` };
    }
  }

  // Coverage checks
  let coverageWarning = null;
  if (frontmatterTargets?.length > 0) {
    const plannedFiles = new Set((plan.steps || []).filter(s => s.path && s.action !== "note").map(s => s.path));
    const uncovered = frontmatterTargets.filter(t => !plannedFiles.has(t));
    if (uncovered.length > 0) {
      coverageWarning = { covered: frontmatterTargets.length - uncovered.length, total: frontmatterTargets.length, uncoveredFiles: uncovered };
    }
  }

  const noteSteps = (plan.steps || []).filter(s => s.action === "note");
  const isExecutable = planStatus === "executable" && noteSteps.length === 0 && !(coverageWarning?.uncoveredFiles?.length > 0);
  const execIssues = [];
  if (coverageWarning?.uncoveredFiles?.length > 0) execIssues.push(`Plan does not cover ${coverageWarning.uncoveredFiles.length} targetFiles`);
  if (noteSteps.length > 0) execIssues.push(`Plan contains ${noteSteps.length} note step(s)`);
  if (planStatus === "note_only") execIssues.push("No executable steps generated");

  const planMode = normalizedProblem ? "problemId" : "task";

  return {
    ok: true, projectId, problemId: normalizedProblem, slug: finalSlug,
    // Travels to the parent through the worker marker so the parent-side durability
    // net knows whether the worker's transition actually landed.
    phaseWrite,
    runId: path.basename(runFolder), runFolder, planPath: paths.planYaml, planJsonPath,
    problemPath: paths.problem, steps: plan.steps.length, autoEmbedded, planMode,
    taskModeWarning: planMode === "task" ? "Plan generated from free-text task" : null,
    taskModeSuggestion: taskModeSuggestion || null,
    coverageWarning, refinementSuggestions, executable: isExecutable,
    execIssues: execIssues.length > 0 ? execIssues : null,
    requiredNext: !isExecutable
      ? `rks_refine { "projectId": "${projectId}", "problemId": "${normalizedProblem}" }`
      : `rks_exec { "projectId": "${projectId}" }`,
  };
}

export default {
  buildProblemYaml,
  buildPlanYaml,
  buildRunRecord,
  persistRunFiles,
  updateRunRecord,
  persistAndFinalize,
};
