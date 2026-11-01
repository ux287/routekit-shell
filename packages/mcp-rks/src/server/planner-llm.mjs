/**
 * Planner LLM Module
 *
 * Handles LLM orchestration for plan generation including:
 * - Pre-LLM validation (snippet presence, prompt readiness)
 * - Reviewer mode detection and invocation
 * - LLM planner invocation with timing telemetry
 * - Result processing and prompt persistence
 */

import fs from "fs";
import path from "path";
import { runLlmPlanner } from "../llm/planner.mjs";
import { isImplementationReady, runReviewerMode } from "../llm/reviewer.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";
import { truncateText } from "./planner-note-steps.mjs";
import { extractCreateFileDirectives } from "./planner-utils.mjs";

// CREATE FILE complexity gate threshold
export const CREATE_FILE_MAX_AC = 4;

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
 * Validate prompt readiness before LLM invocation
 * @param {Object} options
 * @param {number} options.totalSnippetChars - Total characters of snippets
 * @param {boolean} options.hasSnippets - Whether any targets have snippets
 * @param {boolean} options.hasTargetFiles - Whether targetFiles are specified
 * @param {string[]} options.frontmatterTargets - Target files from frontmatter
 * @param {string} options.planningText - Full planning text
 * @param {string} options.planningSource - Planning source context
 * @param {string} options.slug - Run slug for telemetry
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} { enhancedRequirements, warnings }
 */
export function validatePromptReadiness({
  totalSnippetChars,
  hasSnippets,
  hasTargetFiles,
  frontmatterTargets,
  planningText,
  planningSource,
  requirementSummary,
  slug,
  projectId,
  uncoveredCreatePaths = [],
}) {
  const warnings = [];
  let enhancedRequirements = requirementSummary || planningText;

  // Emit pre-flight validation telemetry
  emitTelemetry("plan.prompt.validated", projectId, {
    promptLength: (planningText || "").length + (planningSource || "").length + totalSnippetChars,
    hasSnippetSection: hasSnippets,
    hasTargetFiles,
    targetFilesCount: frontmatterTargets?.length || 0,
    snippetSectionLength: totalSnippetChars,
    slug,
  });

  // Warn if targetFiles specified but no snippets fetched
  if (hasTargetFiles && !hasSnippets) {
    console.error(`[planner] WARNING: targetFiles specified (${frontmatterTargets?.length || 0} files) but no snippets in prompt`);

    // reason: 'rag_miss' = targets exist but RAG returned no snippets;
    // 'query_empty' = no targets to query (can't distinguish file_not_indexed from rag_miss at this layer)
    emitTelemetry("plan.prompt.snippets_missing", projectId, {
      targetFiles: frontmatterTargets,
      promptLength: (planningText || "").length,
      reason: frontmatterTargets?.length > 0 ? 'rag_miss' : 'query_empty',
      slug,
    });

    warnings.push("targetFiles specified but no snippets fetched");

    // Add enhanced directive asking LLM to generate executable actions anyway
    enhancedRequirements += `

IMPORTANT: Code snippets could not be fetched for the target files. You MUST still generate executable search_replace actions based on the file paths and story requirements. If you cannot determine the exact code patterns, make reasonable assumptions based on:
1. Common code patterns for the file type
2. Function/class names mentioned in the story
3. The structure described in acceptance criteria

Do NOT generate only note steps. Generate actual search_replace or create_file actions.`;
  }

  // op:create carve-out (backlog.fix.planner-note-step-degeneracy) — ADDITIVE, does NOT alter
  // the op:edit rag_miss directive above nor the pinned reason ternary. A create target with no
  // RAG snippet is EXPECTED to be empty (the file does not exist yet), so rag_miss must NOT
  // suppress create-step generation for it. Explicitly instruct the LLM to emit a create_file
  // step with non-empty content for each uncovered op:create path.
  if (Array.isArray(uncoveredCreatePaths) && uncoveredCreatePaths.length > 0) {
    enhancedRequirements += `

CREATE TARGETS (op:create — brand-new files, missing RAG snippet is EXPECTED and must NOT block generation): You MUST emit a "create_file" step with complete, non-empty content for EACH of these paths:
${uncoveredCreatePaths.map(p => `- ${p}`).join('\n')}`;
  }

  // Emit telemetry for prompt assembly
  emitTelemetry("plan.prompt.assembled", projectId, {
    promptLength: (planningText || "").length + (planningSource || "").length + totalSnippetChars,
    hasSnippetSection: hasSnippets,
    targetFilesCount: frontmatterTargets?.length || 0,
    slug,
  });

  return { enhancedRequirements, warnings };
}

/**
 * Check if story is implementation-ready (has SEARCH/REPLACE blocks)
 * @param {string} planningText - Full planning text
 * @returns {Object} { useReviewerMode, debugInfo }
 */
export function checkReviewerMode(planningText) {
  const _isReady = isImplementationReady(planningText);
  const debugInfo = {
    isImplementationReady: _isReady,
    skipEnvSet: !!process.env.RKS_SKIP_REVIEWER_MODE,
    planningTextLength: planningText?.length || 0,
    hasSearchBlock: /SEARCH:\s*```/i.test(planningText || "") || /^#{3,4}\s+SEARCH\s*$/m.test(planningText || ""),
    hasReplaceBlock: /```\s*\n\s*REPLACE:/i.test(planningText || "") || /^#{3,4}\s+REPLACE\s*$/m.test(planningText || ""),
  };

  console.error("[rks.plan] Reviewer mode check:", debugInfo);

  return {
    useReviewerMode: _isReady && !process.env.RKS_SKIP_REVIEWER_MODE,
    debugInfo,
  };
}

/**
 * Run reviewer mode for implementation-ready stories
 * @param {Object} options
 * @param {string} options.planningText - Full planning text
 * @param {string} options.projectRoot - Project root path
 * @param {string[]} options.frontmatterTargets - Target files from frontmatter
 * @param {string} options.runFolder - Run folder path
 * @param {string} options.slug - Run slug for telemetry
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Promise<Object>} LLM result
 */
export async function invokeReviewerMode({
  planningText,
  projectRoot,
  frontmatterTargets,
  runFolder,
  slug,
  projectId,
}) {
  console.error("[rks.plan] Story is implementation-ready, using reviewer mode");

  emitTelemetry("plan.reviewer_mode.start", projectId, {
    slug,
    storyLength: planningText?.length || 0,
  });

  const llmResult = await runReviewerMode({
    storyContent: planningText,
    projectRoot,
    targetFiles: frontmatterTargets,
    runFolder,
    checkCompleteness: true,
  });

  console.error("[rks.plan] Reviewer mode completed", {
    status: llmResult?.status,
    editsExtracted: llmResult?.validation?.editsExtracted,
    validationPassed: llmResult?.validation?.passed,
  });

  emitTelemetry("plan.reviewer_mode.complete", projectId, {
    slug,
    status: llmResult?.status,
    editsExtracted: llmResult?.validation?.editsExtracted || 0,
    editsValid: llmResult?.validation?.editsValid || 0,
    elapsedMs: llmResult?.meta?.elapsedMs || 0,
  });

  return llmResult;
}

/**
 * Run LLM planner with timing telemetry
 * @param {Object} options
 * @param {string} options.enhancedRequirements - Enhanced requirements text
 * @param {string} options.planningText - Full planning text
 * @param {string} options.planningSource - Planning source context
 * @param {Array} options.enhancedEditableTargets - Targets with RAG snippets
 * @param {Array} options.contextualRefs - Contextual references
 * @param {string} options.plannerMode - Planner mode (full, etc.)
 * @param {string} options.runFolder - Run folder path
 * @param {string} options.slug - Run slug for telemetry
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Promise<Object>} LLM result
 */
export async function invokeLlmPlanner({
  enhancedRequirements,
  planningText,
  planningSource,
  enhancedEditableTargets,
  contextualRefs,
  plannerMode,
  runFolder,
  slug,
  projectId,
  uncoveredCreatePaths = [],
}) {
  console.error("[rks.plan] runLlmPlanner starting");

  // Add LLM timing telemetry
  let llmTimer = null;
  try {
    const collector = getTelemetryCollector();
    llmTimer = collector.startTimer("mcp.llm.call", projectId, {
      tool: "rks_plan",
      slug,
      mode: plannerMode,
    });
    collector.emit("mcp.llm.start", projectId, {
      tool: "rks_plan",
      slug,
      promptLength: (enhancedRequirements || "").length,
      targetCount: enhancedEditableTargets?.length || 0,
    });
  } catch (e) { /* telemetry is best-effort */ }

  const llmResult = await runLlmPlanner({
    requirements: enhancedRequirements,
    fullRequirements: planningText,
    context: planningSource,
    editableTargets: enhancedEditableTargets,
    contextualRefs,
    plannerMode,
    runFolder,
    useReplay: true,
    uncoveredCreatePaths,
    // Thread attribution onto the hot path. runLlmPlanner forwards llmContext as the LLM
    // client `context` (planner.mjs:1407), where the token-usage emitter reads problemId
    // and projectId (clients.mjs). Without this, the token event carries no problemId —
    // it buckets to '(off-rail)' in both readers — and no projectId, so it lands outside
    // the project's telemetry dir. slug === problemId (used as such at L390).
    llmContext: { problemId: slug, projectId },
  });

  // Complete LLM timing telemetry
  try {
    if (llmTimer) {
      llmTimer.complete({
        status: llmResult?.status || "unknown",
        stepsGenerated: llmResult?.actions?.length || 0,
      });
    }
    const collector = getTelemetryCollector();
    collector.emit("mcp.llm.complete", projectId, {
      tool: "rks_plan",
      slug,
      status: llmResult?.status || "unknown",
      stepsGenerated: llmResult?.actions?.length || 0,
    });
  } catch (e) { /* telemetry is best-effort */ }

  console.error("[rks.plan] runLlmPlanner completed", { status: llmResult?.status });

  return llmResult;
}

/**
 * Detect if story has CREATE FILE directive
 * @param {string} planningText - Full planning text
 * @param {string[]} frontmatterTargets - Target files from frontmatter
 * @returns {boolean}
 */
export function detectCreateFileDirective(planningText, frontmatterTargets) {
  // Body: ONLY the directive grammar plan_ready binds (extractCreateFileDirectives — the colon
  // comment form and the line-anchored colon heading form). Headings such as `### path (create)`,
  // `(new file)` or a bare `### path` bind blocks but are never create declarations, and neither
  // is a bullet, a colon-less comment or a bare "(CREATE FILE)" mention.
  // backlog.fix.create-target-grammar-drift-refine-and-po-prompt
  if (planningText && extractCreateFileDirectives(planningText).length > 0) return true;
  // Check frontmatter targets for a create marker. `op: "create"` is the DOCUMENTED
  // convention and normalizeTargetFiles / planner-context both honour it, so recognising
  // only `create: true` here left create-file stories written the documented way
  // undetected. The `typeof t === "object"` guard must survive: frontmatterTargets is a
  // plain string array on some call paths.
  if (Array.isArray(frontmatterTargets)) {
    for (const t of frontmatterTargets) {
      if (typeof t === "object" && (t?.create === true || t?.op === "create")) return true;
    }
  }
  return false;
}

/**
 * Count acceptance criteria in story
 * @param {string} planningText - Full planning text
 * @returns {number}
 */
export function countAcceptanceCriteria(planningText) {
  if (!planningText) return 0;
  const matches = planningText.match(/- \[[ x]\]/g);
  return matches ? matches.length : 0;
}

/**
 * Save prompt to run folder for debugging
 * @param {Object} llmResult - LLM result with prompt
 * @param {string} runFolder - Run folder path
 * @param {string} slug - Run slug for telemetry
 * @param {string} projectId - Project ID for telemetry
 */
export function savePromptToRunFolder(llmResult, runFolder, slug, projectId) {
  if (!llmResult?.prompt || !runFolder) return;

  try {
    const promptPath = path.join(runFolder, "prompt.txt");
    fs.writeFileSync(promptPath, llmResult.prompt);

    emitTelemetry("plan.prompt.saved", projectId, {
      path: promptPath,
      size: llmResult.prompt.length,
      slug,
    });

    console.error(`[planner] Saved prompt to ${promptPath} (${llmResult.prompt.length} chars)`);
  } catch (e) {
    console.error(`[planner] Failed to save prompt: ${e?.message}`);
  }
}

/**
 * Process LLM result into actions array
 * @param {Object} llmResult - Raw LLM result
 * @returns {Object} { actions, status, debug }
 */
export function processLlmResult(llmResult) {
  if (!llmResult) {
    return { actions: null, status: "error", debug: null };
  }

  const status = llmResult.status || "note_only";
  const debug = {
    promptPreview: llmResult.prompt ? truncateText(llmResult.prompt, 320) : null,
    rawPreview: llmResult.raw ? truncateText(llmResult.raw, 320) : null,
    error: llmResult.error || null,
  };

  let actions = null;
  if (llmResult.actions && Array.isArray(llmResult.actions) && llmResult.actions.length) {
    actions = llmResult.actions.map((action, idx) => {
      const content = Array.isArray(action.content) ? action.content.join("\n") : action.content;
      return {
        title: action.title || truncateText(content || action.command || action.path || `LLM action ${idx + 1}`, 120),
        description: action.description || action.title || "",
        order: idx + 1,
        ...action,
        ...(content !== undefined ? { content } : {}),
      };
    });
  }

  return { actions, status, debug };
}

/**
 * Path match used for target coverage — the same rule as evaluatePlanGuard (planner.mjs):
 * equal, or either path endsWith the other.
 */
function targetPathsMatch(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/**
 * Edit-target supplement for reviewer mode.
 *
 * Computes the uncovered edit targets — entries of enhancedEditableTargets with a truthy
 * liveContent whose path matches no executable (non-note) reviewer action — and, when there
 * are any, runs invokeLlmPlanner ONCE scoped to them. Only supplemental actions whose path is
 * one of those uncovered edit paths are kept (appended after the reviewer actions); every
 * other supplemental action is discarded.
 *
 * When the supplement runs, the returned status/error describe the supplement, never the
 * reviewer's no_explicit_edits text:
 *   - every uncovered target has a kept action → supplement status / supplement error (or null)
 *   - resolves null/undefined → status "error", "edit-target supplement returned no result"
 *   - some uncovered target has no kept action → supplement status unless absent or
 *     "executable" (then "note_only"); supplement error, else
 *     "edit-target supplement returned no actions for: <paths>"
 *   - rejects → reviewer actions unchanged, status "error",
 *     "edit-target supplement failed: <message>" (never throws)
 *
 * When no target is uncovered, no call is made and llmResult is returned unchanged.
 *
 * @returns {Promise<Object>} the (possibly merged) llmResult
 */
export async function supplementUncoveredEditTargets({
  llmResult,
  enhancedRequirements,
  planningText,
  planningSource,
  enhancedEditableTargets,
  contextualRefs,
  plannerMode,
  slug,
  projectId,
}) {
  const reviewerActions = Array.isArray(llmResult?.actions) ? llmResult.actions : [];
  const coveredPaths = reviewerActions
    .filter((a) => a && a.action !== "note" && a.path)
    .map((a) => a.path);
  const uncoveredEditTargets = (enhancedEditableTargets || []).filter(
    (t) => t && t.liveContent && t.path && !coveredPaths.some((p) => targetPathsMatch(p, t.path)),
  );
  if (uncoveredEditTargets.length === 0) return llmResult;

  const uncoveredEditPaths = uncoveredEditTargets.map((t) => t.path);
  console.error(`[rks.plan] Reviewer mode: supplementing with LLM for ${uncoveredEditPaths.length} uncovered edit target(s):`, uncoveredEditPaths);

  let editResult;
  try {
    editResult = await invokeLlmPlanner({
      enhancedRequirements,
      planningText,
      planningSource,
      enhancedEditableTargets: uncoveredEditTargets,
      contextualRefs,
      plannerMode,
      runFolder: null, // don't overwrite reviewer replay
      slug,
      projectId,
      uncoveredCreatePaths: [],
    });
  } catch (e) {
    const message = e?.message ?? String(e);
    console.error("[rks.plan] Edit-target supplement failed:", message);
    return {
      ...llmResult,
      actions: reviewerActions,
      status: "error",
      error: `edit-target supplement failed: ${message}`,
    };
  }

  if (editResult === null || editResult === undefined) {
    return {
      ...llmResult,
      actions: reviewerActions,
      status: "error",
      error: "edit-target supplement returned no result",
    };
  }

  const keptActions = (Array.isArray(editResult.actions) ? editResult.actions : [])
    .filter((a) => a && a.path && uncoveredEditPaths.includes(a.path));
  const missingPaths = uncoveredEditPaths.filter(
    (p) => !keptActions.some((a) => a.path === p),
  );

  if (keptActions.length > 0) {
    console.error(`[rks.plan] Edit-target supplement: merging ${keptActions.length} step(s)`);
  }

  const supplementError = editResult.error || null;
  let status;
  let error;
  if (missingPaths.length === 0) {
    status = editResult.status;
    error = supplementError;
  } else {
    status = editResult.status && editResult.status !== "executable" ? editResult.status : "note_only";
    error = supplementError || `edit-target supplement returned no actions for: ${missingPaths.join(", ")}`;
  }

  return {
    ...llmResult,
    actions: [...reviewerActions, ...keptActions],
    status,
    error,
  };
}

/**
 * Orchestrate full LLM planning flow
 * @param {Object} options - All options needed for planning
 * @returns {Promise<Object>} { llmActions, llmStatus, llmDebug, refinementRequired? }
 */
export async function orchestrateLlmPlanning({
  planningText,
  planningSource,
  requirementSummary,
  enhancedEditableTargets,
  contextualRefs,
  frontmatterTargets,
  plannerMode,
  runFolder,
  projectRoot,
  slug,
  projectId,
  uncoveredCreatePaths = [],
}) {
  // plan.* lifecycle telemetry (plan.start / plan.complete / plan.failed) is owned by the OUTER
  // orchestrator (runPlanTool in planner.mjs) so every plan path — including the LLM-bypassing
  // early-exit and the pre-flight/readiness failures — emits exactly one start + one terminal.
  // Emitting here too would double-count every run in the operations rollup once the detached
  // plan worker actually persists telemetry. See backlog.feat.plan-exec-telemetry-lifecycle-events.

  // CREATE FILE complexity advisory (N2 Option 1) — a high acceptance-criteria count
  // on a create-file story is NO LONGER a hard block. create+update-same-file is now
  // supported (backlog.feat.search-replace-same-plan-created-path-exemption), so a
  // create story may legitimately create AND edit its file; and the decompose decision
  // is owned by the grounded PO concern-separation review (how many INDEPENDENT
  // concerns, not a raw AC count). We emit the gate event as a NON-BLOCKING advisory
  // for observability, but never force refinement on the count.
  const hasCreateFile = detectCreateFileDirective(planningText, frontmatterTargets);
  const acCount = countAcceptanceCriteria(planningText);

  if (hasCreateFile) {
    emitTelemetry("planner.create_file_gate", projectId, {
      problemId: slug,
      hasCreateFile: true,
      acCount,
      threshold: CREATE_FILE_MAX_AC,
      overThreshold: acCount > CREATE_FILE_MAX_AC,
      // advisory only — planning is NOT blocked on the AC count (N2 Option 1)
      gateTriggered: false,
    });
  }

  // Calculate snippet stats
  const hasSnippets = enhancedEditableTargets?.some(t => t.ragSnippets?.length > 0);
  const totalSnippetChars = enhancedEditableTargets?.reduce((sum, t) =>
    sum + (t.ragSnippets || []).reduce((s, snip) => s + (snip?.length || 0), 0), 0) || 0;
  const hasTargetFiles = frontmatterTargets?.length > 0;

  // Validate prompt readiness
  const { enhancedRequirements } = validatePromptReadiness({
    totalSnippetChars,
    hasSnippets,
    hasTargetFiles,
    frontmatterTargets,
    planningText,
    planningSource,
    requirementSummary,
    slug,
    projectId,
    uncoveredCreatePaths,
  });

  // Check if story is implementation-ready
  const { useReviewerMode } = checkReviewerMode(planningText);

  let llmResult = null;

  if (useReviewerMode) {
    llmResult = await invokeReviewerMode({
      planningText,
      projectRoot,
      frontmatterTargets,
      runFolder,
      slug,
      projectId,
    });

    // Check if refinement is required due to stale patterns
    if (llmResult.refinementRequired) {
      return {
        llmActions: null,
        llmStatus: "refinement_required",
        llmDebug: null,
        refinementRequired: true,
        reason: "stale_edits",
        error: llmResult.error,
        staleEdits: llmResult.staleEdits,
      };
    }

    // Reviewer mode DOES synthesize create_file steps, from create blocks it extracted
    // (reviewer.mjs editsToSteps turns an action:create edit into a create_file step).
    // The supplement pass below covers only the paths left UNCOVERED by those steps.
    // If there are uncovered op:create paths that are genuinely NEW (no liveContent),
    // call the LLM now to get those steps. Paths with liveContent are existing files —
    // never supplement for them, as that would prompt the LLM to generate create_file
    // for a file that already exists on disk.
    const existingLivePaths = new Set(
      (enhancedEditableTargets || []).filter(t => t.liveContent).map(t => t.path).filter(Boolean)
    );
    const filteredSupplementPaths = uncoveredCreatePaths.filter(p => !existingLivePaths.has(p));
    if (filteredSupplementPaths.length > 0) {
      console.error(`[rks.plan] Reviewer mode: supplementing with LLM for ${filteredSupplementPaths.length} uncovered create path(s):`, filteredSupplementPaths);
      try {
        const createResult = await invokeLlmPlanner({
          enhancedRequirements,
          planningText,
          planningSource,
          enhancedEditableTargets,
          contextualRefs,
          plannerMode,
          runFolder: null, // don't overwrite reviewer replay
          slug,
          projectId,
          uncoveredCreatePaths: filteredSupplementPaths,
        });
        const createActions = (createResult?.actions || []).filter(a => a.action === 'create_file');
        if (createActions.length > 0) {
          console.error(`[rks.plan] Reviewer mode supplement: merging ${createActions.length} create_file step(s)`);
          llmResult = {
            ...llmResult,
            actions: [...(llmResult.actions || []), ...createActions],
          };
        }
      } catch (e) {
        console.error('[rks.plan] Reviewer mode supplement failed — proceeding with reviewer edits only:', e?.message);
      }
    }

    // Edit-target supplement (backlog.fix.reviewer-anchor-only-targets-get-no-llm-pass).
    // Reviewer mode skips identity anchors (SEARCH === REPLACE), so an existing op:edit
    // target whose only blocks are location anchors gets no executable reviewer step and,
    // before this pass, never reached an LLM. Give exactly those targets one scoped LLM pass.
    llmResult = await supplementUncoveredEditTargets({
      llmResult,
      enhancedRequirements,
      planningText,
      planningSource,
      enhancedEditableTargets,
      contextualRefs,
      plannerMode,
      slug,
      projectId,
    });
  } else {
    llmResult = await invokeLlmPlanner({
      enhancedRequirements,
      planningText,
      planningSource,
      enhancedEditableTargets,
      contextualRefs,
      plannerMode,
      runFolder,
      slug,
      projectId,
      uncoveredCreatePaths,
    });
  }

  // Save prompt to run folder
  savePromptToRunFolder(llmResult, runFolder, slug, projectId);

  // Process result
  const { actions, status, debug } = processLlmResult(llmResult);

  return {
    llmActions: actions,
    llmStatus: status,
    llmDebug: debug,
  };
}

export default {
  validatePromptReadiness,
  checkReviewerMode,
  invokeReviewerMode,
  invokeLlmPlanner,
  savePromptToRunFolder,
  processLlmResult,
  orchestrateLlmPlanning,
};
