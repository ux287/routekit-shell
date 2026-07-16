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
import { getTelemetryCollector } from "./telemetry/index.mjs";
import { reviewPlan } from "./plan-quality.mjs";
import { autoCorrectSearchPatterns, validateSearchReplacePatterns } from "../validation/search-replace.mjs";
import { runRefineTool } from "./refine.mjs";
import { updateField, resolveNotesDir, readNote } from "../dendron.mjs";
import { validateTransition } from "../workflow/state-machine.mjs";
import { advancePhase } from "../workflow/auto-phase.mjs";

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
export function decideExecStartAction(currentPhase) {
  if (currentPhase == null) return { reset: false, advance: true };
  if (currentPhase === "arch-approved") return { reset: false, advance: true };
  if (["planned", "executing", "executed"].includes(currentPhase)) return { reset: true, advance: true };
  // Post-release / terminal phases are immutable: refuse to persist an executable plan for them
  // rather than silently succeeding. (Unreachable via rks_plan today — PLANNABLE_PHASES excludes
  // these — but keeps the helper correct in isolation so a future caller can't leak the violation.)
  if (["released", "integrated"].includes(currentPhase)) return { reset: false, advance: false, reject: true };
  return { reset: false, advance: false };
}

/**
 * High-level orchestrator: quality review + persist + phase routing + final result.
 * Called by runPlanTool after plan assembly.
 */
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

  // Quality routing: update story phase
  if (normalizedProblem) {
    try {
      const notesDir = resolveNotesDir(projectRoot);
      if (planStatus === "note_only" || planStatus === "quality_failed") {
        updateField(notesDir, normalizedProblem, "phase", "draft");
        emitTelemetry("story.phase.changed", projectId, { storyId: normalizedProblem, from: "ready", to: "draft", reason: "quality_failed" });
      } else if (planStatus === "executable") {
        // R1.3e: route through advancePhase('exec_start'). advancePhase reads the
        // real on-disk phase, runs validateTransition, writes the new phase, and
        // emits telemetry. The v2 model: arch-approved → executing (via exec_start),
        // not ready → planned. Companion story refine-apply-resets-phase-to-arch-approved
        // ensures stories arriving here are at arch-approved (refine resets phase after
        // any non-decompose amendment) so exec_start succeeds.
        // P0-3: a BARE re-plan (no refine amendment) can arrive here at planned/executing.
        // Reset it to arch-approved before exec_start so re-plan is idempotent (re-lands at
        // executing) instead of returning state_transition_failed. No-op when already
        // arch-approved (first-plan unchanged). Guarded so a read/write failure can't corrupt
        // the note — advancePhase still validates the source phase below.
        // Reset only the POST-arch re-plan phases (planned/executing/executed) — NOT 'ready'
        // (pre-ARCH; resetting it would skip the arch gate) and not 'arch-approved' (no-op).
        // A 'ready' (pre-ARCH) story is a valid plannable phase, so an executable plan CAN
        // legitimately arrive here at 'ready'. exec_start.from is ["arch-approved"] only, so
        // advancing from 'ready' would return state_transition_failed and lose the plan. Route
        // through decideExecStartAction: advance (post-arch reset first) only from arch-approved;
        // for a pre-ARCH phase, persist the plan WITHOUT advancing (no arch-gate bypass, no crash).
        // (backlog.fix.planner-persist-ready-phase-exec-start-crash)
        let _phase;
        try { _phase = readNote(notesDir, normalizedProblem)?.phase; }
        catch (e) { console.error(`[planner] pre-exec_start phase read skipped: ${e?.message}`); }
        const _execStart = decideExecStartAction(_phase);
        if (_execStart.reject) {
          // Post-release / terminal phase: refuse to persist an executable plan (immutability).
          // (backlog.fix.planner-persist-reject-post-release-phase)
          emitTelemetry("story.phase.exec_start_rejected", projectId, {
            storyId: normalizedProblem, phase: _phase || null, planStatus, reason: "post_release_immutable",
          });
          console.error(`[planner] exec_start REJECTED: story ${normalizedProblem} at immutable phase '${_phase}' — refusing to persist an executable plan for an already-released story.`);
          return {
            ok: false, projectId, problemId: normalizedProblem, error: "phase_immutable_plan_rejected",
            message: `Refusing to persist an executable plan for '${normalizedProblem}' at immutable phase '${_phase}'.`,
          };
        }
        if (_execStart.reset) {
          try { updateField(notesDir, normalizedProblem, "phase", "arch-approved"); }
          catch (e) { console.error(`[planner] pre-exec_start phase reset skipped: ${e?.message}`); }
        }
        if (_execStart.advance) {
          const advanceResult = await advancePhase(projectRoot, normalizedProblem, "exec_start", projectId);
          if (advanceResult.ok) {
            try {
              spawnSync("git", ["add", `notes/${normalizedProblem}.md`], { cwd: projectRoot, encoding: "utf8" });
              spawnSync("git", ["commit", "-m", `docs(backlog): mark ${normalizedProblem} as ${advanceResult.to}`], { cwd: projectRoot, encoding: "utf8" });
            } catch { }
          } else {
            return {
              ok: false, projectId, problemId: normalizedProblem, error: "state_transition_failed",
              message: `Phase transition failed: ${advanceResult.error}`,
            };
          }
        } else {
          // Pre-ARCH plannable phase (e.g. 'ready'): the executable plan is valid and already
          // persisted above; leave the phase for a real arch-approved transition rather than
          // crashing on exec_start. The ARCH gate still governs whether exec may proceed.
          emitTelemetry("story.phase.exec_start_skipped", projectId, {
            storyId: normalizedProblem, phase: _phase || null, planStatus, reason: "pre_arch_not_advanced",
          });
          console.error(`[planner] exec_start skipped: story ${normalizedProblem} at phase '${_phase || "(unknown)"}' is pre-ARCH; executable plan persisted without advancing to executing.`);
        }
      }
    } catch (e) { console.error(`[planner] phase routing failed: ${e?.message}`); }
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
