const PLANNER_DEBUG = process.env.ROUTEKIT_PLANNER_DEBUG === "1";
const MAX_NOTE_ONLY_RETRIES = 2; // Retry up to 2 times when LLM produces only note steps

// Canonical list of step types that rks_exec can execute.
// Both the planner (validateStep) and exec (note-step safety net) reference this constant
// so the two cannot diverge silently.
export const VALID_STEP_TYPES = ['search_replace', 'create_file', 'edit_file', 'delete_file', 'run_command'];
// getCodeSnippets now accessed via planner-context.mjs (fetchCodeSnippets/getCodeContext)
import { reviewPlan, computePlanHash, checkOpMatch, isSynthesizedBody } from "./plan-quality.mjs";
import { getLastEmbedTime, ensureRagIndex, runRagEmbed } from "../rag/tools.mjs";
import { runRefineTool } from "./refine.mjs";
import { runPlanReadyTool } from "./plan-ready.mjs";
import { updateField, resolveNotesDir } from "../dendron.mjs";
import { validateTransition, getValidNextPhases } from "../workflow/state-machine.mjs";
import {
  truncateText,
  extractSectionLines,
  detectFileMetadata,
  guessFilePath,
  buildContentForPath,
  parseListAndTables,
  isParserWork,
  isTestWork,
  isDocWork,
  summarizeProblemNote,
  readPackageScripts,
  formatScriptsForPrompt,
  readSnippet,
  extractSnippet,
  readSnippetForTarget,
  normalizeRagPath,
  getCodemapPath,
  getAnalysisPath,
  readCodemap,
  readAnalysis,
  classifyPlanStatus,
  runsRoot,
  detectFrameworkFromFiles,
  writeJson,
} from "./planner-prompts.mjs";
import { loadStory } from "../shared/story-loader.mjs";
import { fetchCodeSnippets, injectCodeSnippetsIntoPrompt, extractKeywordsFromStory, getCodeContext, isRagIndexFresh, getChangedNotesSinceEmbed, gatherTargetContext, hasRagTruncation, extractSearchReplaceBlocks } from "./planner-context.mjs";

/**
 * Normalize targetFiles from frontmatter to a consistent object format.
 * Supports both string format and object format:
 * - String: "src/foo.ts" → { path: "src/foo.ts", action: "EDIT" }
 * - Object: { path: "src/foo.ts", action: "CREATE" } → unchanged
 * - Legacy: { path: "src/foo.ts", create: true } → { path: "src/foo.ts", action: "CREATE" }
 *
 * @param {Array<string|object>} targetFiles - Array of targetFiles from frontmatter
 * @returns {Array<{path: string, action: string, reason?: string}>}
 */
// Re-export from shared module — single source of truth for targetFiles normalization
export { normalizeTargetFiles } from "../shared/normalize-target-files.mjs";

// fetchCodeSnippets, injectCodeSnippetsIntoPrompt extracted to ./planner-context.mjs
// plannerDebug defined in planner-context.mjs

// extractKeywordsFromStory extracted to ./planner-context.mjs

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import yaml from "js-yaml";
import matter from "gray-matter";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { loadNoteContent, resolveNotePath } from "../dendron-notes.mjs";
import { getRagContext } from "../rag-context.mjs";
import { runLlmPlanner, validateSearchReplacePatterns as validateSearchPatternsFromPlanner, extractMustEditPaths } from "../llm/planner.mjs";
import { isImplementationReady, runReviewerMode } from "../llm/reviewer.mjs";
import { parseTargetsFromMarkdown, loadEditableTargets, resolveTargetPaths, looksLikeGlob, parseImplementationCodeBlocks } from "../llm/targets.mjs";
import { validateSearchReplacePatterns, autoCorrectSearchPatterns } from "../validation/search-replace.mjs";
import { extractCreateFileBlocks } from "./planner-utils.mjs";
import { detectCreateFileDirective, countAcceptanceCriteria, CREATE_FILE_MAX_AC, orchestrateLlmPlanning } from "./planner-llm.mjs";
import { persistAndFinalize } from "./planner-persistence.mjs";
import {
  repoRoot,
  ensureDir,
  slugify,
  pascalCase,
  listRelativeFiles,
  extractPageName,
  buildPageContent,
  loadContext,
  enforceGuardrail,
  isProtectedPath,
} from "./project.mjs";
import { execSync } from "child_process";
import { getCurrentBranch, isWorkingTreeClean, getUncommittedFiles, commitFiles, findLatestRunDir, getStagingSyncStatus, isRuntimeArtifact } from "../utils/git.mjs";
import { getTelemetryCollector } from "./telemetry/index.mjs";


// isRagIndexFresh, getChangedNotesSinceEmbed extracted to ./planner-context.mjs

import { MAX_SNIPPET_LINES } from "./planner-utils.mjs";

// truncateText extracted to ./planner-prompts.mjs

// extractSectionLines extracted to ./planner-prompts.mjs

// detectFileMetadata extracted to ./planner-prompts.mjs

// guessFilePath extracted to ./planner-prompts.mjs

// buildContentForPath extracted to ./planner-prompts.mjs

// parseListAndTables, isParserWork, isTestWork, isDocWork extracted to ./planner-prompts.mjs

import { resolveTarget } from "./planner-note-steps.mjs";

// Re-export extractMustEditPaths so consumers can import it from this module
export { extractMustEditPaths } from "../llm/planner.mjs";

/**
 * Post-generation filter: remove any create_file steps whose path is in mustEditPaths.
 * Provides a belt-and-suspenders guard against LLM ignoring prompt instructions.
 * @param {Array} steps - Plan steps from LLM output
 * @param {string[]} mustEditPaths - Paths that must use search_replace, never create_file
 * @returns {Array} Filtered steps
 */
export function filterMustEditSteps(steps, mustEditPaths) {
  if (!Array.isArray(steps) || !mustEditPaths?.length) return steps;
  const mustEditSet = new Set(mustEditPaths);
  const filtered = steps.filter(s => {
    if (s.action !== 'create_file') return true;
    const p = s.path || s.target;
    return !mustEditSet.has(p);
  });
  if (filtered.length < steps.length) {
    const stripped = steps
      .filter(s => s.action === 'create_file' && mustEditSet.has(s.path || s.target))
      .map(s => s.path || s.target);
    console.error(`[planner] mustEdit guard: stripped ${steps.length - filtered.length} create_file step(s) for op:edit/@@SEARCH target(s): ${stripped.join(', ')}`);
  }
  return filtered;
}

/**
 * Build the LOUD structural-failure signal for an un-authorable create-only target: the
 * planner has NO model-escalation ladder, so when the LLM returns no usable content for an
 * op:create target we must FAIL LOUD, not stub-and-succeed (a placeholder file would ship).
 * Carries a machine-readable discriminator (failureClass:'structural') the outer refine→plan
 * loop keys on to short-circuit, plus a message NAMING the target(s) and stating the failure
 * is NOT refinable — distinct from the generic refinable "run rks_refine" hint.
 * PARTs A/B of backlog.fix.planner-note-step-degeneracy.
 * @param {string[]} uncoveredCreateTargets
 * @returns {{ failureClass:string, uncoveredCreateTargets:string[], refinable:false, message:string }}
 */
export function buildStructuralFailure(uncoveredCreateTargets) {
  const targets = Array.isArray(uncoveredCreateTargets) ? uncoveredCreateTargets.filter(Boolean) : [];
  const named = targets.join(", ") || "(unnamed create target)";
  return {
    failureClass: "structural",
    uncoveredCreateTargets: targets,
    refinable: false,
    message: `planner could not author create-only target(s) ${named} — the model returned no usable content. Hand-author the file(s) or escalate to a stronger model; decompose/analyze will not help.`,
  };
}

function validateStep(step, allowedTargets = null, projectRoot = repoRoot) {
  if (!step || typeof step !== "object") return null;
  if (step.action === "note") return step;
  const containsDiffMarkers = (text) => {
    if (!text || typeof text !== "string") return false;
    if (/diff --git/i.test(text)) return true;
    if (/^@@/m.test(text)) return true;
    if (/^\+\+\+ /m.test(text) || /^--- /m.test(text)) return true;
    const lines = text.split("\n");
    return lines.some((line) => {
      if (/^---\s*$/.test(line) || /^\+\+\+\s*$/.test(line)) return false;
      return /^\+[^\s]/.test(line) || /^-[^\s]/.test(line);
    });
  };
  const hasMergeMarkers = (text) => {
    if (!text || typeof text !== "string") return false;
    // Match actual git merge markers (at line start with proper context)
    // Avoids false positives on visual separators like "===================="
    return /^<<<<<<<\s|^=======\s*$|^>>>>>>>\s/m.test(text);
  };
  if (step.action === "run_command") {
    if (!step.command || !step.command.trim()) return { _invalid: true, _invalidReason: "empty command", title: step.title, order: step.order };
    return step;
  }
  if (step.action === "search_replace") {
    if (!step.path || typeof step.path !== "string" || !step.path.trim() || step.path.includes("..")) {
      return { _invalid: true, _invalidReason: "missing or invalid path", title: step.title, description: step.description, order: step.order };
    }
    if (!Array.isArray(step.edits) || step.edits.length === 0) {
      return { _invalid: true, _invalidReason: "missing edits array", title: step.title, description: step.description, order: step.order };
    }
    for (const edit of step.edits) {
      if (!edit || typeof edit !== "object") {
        return { _invalid: true, _invalidReason: "invalid edit object", title: step.title, description: step.description, order: step.order };
      }
      if (!edit.search || typeof edit.search !== "string" || !edit.search.trim()) {
        return { _invalid: true, _invalidReason: "invalid edit: missing search string", title: step.title, description: step.description, order: step.order };
      }
      if (typeof edit.replace !== "string") {
        return { _invalid: true, _invalidReason: "invalid edit: missing replace string", title: step.title, description: step.description, order: step.order };
      }
    }
    // Validate file exists for search_replace
    const abs = path.join(projectRoot, step.path);
    if (!fs.existsSync(abs)) {
      return { _invalid: true, _invalidReason: "file not found for search_replace", title: step.title, description: step.description, order: step.order };
    }
    return step;
  }
  if (step.action === "edit_file" || step.action === "create_file" || step.action === "delete_file") {
    const isNotesPath = typeof step.path === "string" && step.path.startsWith("notes/");
    const isMarkdown = typeof step.path === "string" && step.path.endsWith(".md");
    if (
      !step.path ||
      typeof step.path !== "string" ||
      step.path.includes("\n") ||
      !step.path.trim() ||
      step.path.includes("..")
    ) {
      return { _invalid: true, _invalidReason: "missing or invalid path", title: step.title, description: step.description, order: step.order };
    }
    const allowedFiles = allowedTargets?.allowFiles ? new Set(allowedTargets.allowFiles) : null;
    const allowedPatterns = allowedTargets?.allowPatterns || null;
    const allowedMatch = !allowedTargets
      ? true
      : step.action === "create_file"
        ? Boolean(allowedPatterns && isProtectedPath(step.path, allowedPatterns))
        : Boolean(allowedFiles && allowedFiles.has(step.path));
    if (allowedTargets && !allowedMatch) {
      return { action: "note", title: step.title, description: `${step.description || ""} (path not in Targets)`.trim(), order: step.order, _invalidReason: "path not in editable targets" };
    }
    if (step.action === "edit_file" && !isNotesPath && !isMarkdown) {
      const abs = path.join(projectRoot, step.path);
      if (!fs.existsSync(abs)) {
        return { _invalid: true, _invalidReason: "file not found for edit_file", title: step.title, description: step.description, order: step.order };
      }
    }
    if (step.action === "delete_file") return step;
    if (!step.content || !String(step.content).trim()) {
      return { _invalid: true, _invalidReason: "missing content", title: step.title, description: step.description, order: step.order };
    }
    if (containsDiffMarkers(step.content)) {
      return { _invalid: true, _invalidReason: "diff-style content rejected", title: step.title, description: step.description, order: step.order };
    }
    if (hasMergeMarkers(step.content)) {
      return { _invalid: true, _invalidReason: "merge markers detected", title: step.title, description: step.description, order: step.order };
    }
    return step;
  }
  return { _invalid: true, _invalidReason: "unrecognized action type", title: step.title, description: step.description, order: step.order };
}

function buildNoteDrivenSteps(markdown, projectRoot = repoRoot) {
  if (!markdown) return [];
  const sectionPatterns = [
    /^#{1,6}\s+requirements/i,
    /^#{1,6}\s+acceptance/i,
    /^#{1,6}\s+implementation tasks/i,
    /^#{1,6}\s+implementation steps/i,
    /^#{1,6}\s+constraints/i,
  ];
  const sectionLines = sectionPatterns.flatMap((pattern) => extractSectionLines(markdown, pattern));
  const items = parseListAndTables(sectionLines);

  const toAction = (item, index) => {
    const normalized = (item.text || "").replace(/\s+/g, " ").trim();
    const base = {
      title: truncateText(normalized, 120) || `Requirement ${index + 1}`,
      description: item.text || "",
      order: index + 1,
    };
    const mapped = resolveTarget(item, normalized, projectRoot);
    if (mapped) return { ...base, ...mapped };
    return { ...base, action: "note" };
  };

  const steps = items.map((item, idx) => {
    if (item.type === "table") {
      return toAction(item, idx);
    }
    return toAction(item, idx);
  });

  // Use arrow function to avoid .map() passing (element, index, array) as arguments
  // which would make projectRoot receive the array instead of the string
  const validated = steps.map((s) => validateStep(s, null, projectRoot)).filter(Boolean);
  if (validated.length) return validated;
  const fallback = truncateText(markdown, 240);
  return fallback
    ? [
      {
        action: "note",
        title: "Review problem note",
        description: fallback,
        order: 1,
      },
    ]
    : [];
}

// summarizeProblemNote, getCodemapPath, getAnalysisPath, readCodemap, readAnalysis extracted to ./planner-prompts.mjs

/**
 * Read package.json from projectRoot and return the scripts object, or null.
 */
// readPackageScripts extracted to ./planner-prompts.mjs

// formatScriptsForPrompt extracted to ./planner-prompts.mjs

// readSnippet, extractSnippet, readSnippetForTarget, normalizeRagPath extracted to ./planner-prompts.mjs

// classifyPlanStatus, runsRoot, detectFrameworkFromFiles extracted to ./planner-prompts.mjs

function buildCodemap({ projectRoot, projectId, kg } = {}) {
  const framework = kg?.framework || detectFrameworkFromFiles(projectRoot);
  const kgCodeRoots = Array.isArray(kg?.code_roots) && kg.code_roots.length
    ? kg.code_roots
    : framework === "eleventy-nunjucks"
      ? ["src", "notes"]
      : framework === "astro"
        ? ["src", "public", "notes"]
        : [path.join("src", "pages"), path.join("src", "components")];

  const codeMaps = {};
  for (const root of kgCodeRoots) {
    codeMaps[root] = listRelativeFiles(projectRoot, root);
  }

  const pageRoots = Array.isArray(kg?.codemap?.page_roots) && kg.codemap.page_roots.length
    ? kg.codemap.page_roots
    : framework === "eleventy-nunjucks"
      ? ["src"]
      : framework === "astro"
        ? [path.join("src", "pages")]
        : [path.join("src", "pages")];

  const componentRoots = Array.isArray(kg?.codemap?.component_roots) && kg.codemap.component_roots.length
    ? kg.codemap.component_roots
    : framework === "eleventy-nunjucks"
      ? [path.join("src", "_includes", "components"), path.join("src", "_includes", "layouts")]
      : [path.join("src", "components")];

  const collectRoots = (roots) =>
    Array.from(
      new Set(
        (roots || []).flatMap((root) => codeMaps[root] || listRelativeFiles(projectRoot, root))
      )
    ).sort();

  const pages = collectRoots(pageRoots);
  const components = collectRoots(componentRoots);
  const codemap = {
    projectId,
    generatedAt: new Date().toISOString(),
    framework,
    kg,
    pages,
    components,
    codeRoots: codeMaps,
  };

  return { framework, pages, components, codeMaps, codemap };
}

async function runAnalyzeTool({ projectId }) {
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;
  console.error(`[rks.analyze] project=${projectId} root=${projectRoot}`);
  const { framework, pages, components, codeMaps, codemap } = buildCodemap({
    projectRoot,
    projectId,
    kg: context.kg,
  });
  const codemapPath = getCodemapPath(projectRoot, projectId);
  ensureDir(path.dirname(codemapPath));
  fs.writeFileSync(codemapPath, JSON.stringify(codemap, null, 2));

  let scripts = [];
  const pkgPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      scripts = Object.keys(pkg.scripts || {});
    } catch {
      scripts = [];
    }
  }
  const analysis = {
    projectId,
    generatedAt: new Date().toISOString(),
    framework,
    codeRoots: Object.keys(codeMaps),
    scripts,
  };
  const analysisPath = getAnalysisPath(projectRoot, projectId);
  ensureDir(path.dirname(analysisPath));
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

  return {
    ok: true,
    projectId,
    codemapPath,
    pages,
    components,
    analysisPath,
    scripts,
  };
}

/**
 * Entry point for rks_plan: reads story frontmatter and gates on decomposed phase
 * before proceeding to full planning.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {string} problemId   - Story ID (e.g. "backlog.feat.my-story")
 * @returns {Promise<object>}  - { ok, error?, ... }
 */
export async function planProblem(projectRoot, problemId) {
  const notePath = path.join(projectRoot, 'notes', problemId + '.md');
  let frontmatter = {};
  try {
    const raw = fs.readFileSync(notePath, 'utf8');
    const parsed = matter(raw);
    frontmatter = parsed.data || {};
  } catch (e) {
    return { ok: false, error: 'note_not_found', message: `Could not read story note: ${e.message}` };
  }

  // Decomposed gate: story has been split into child stories — cannot plan the parent directly.
  // This gate runs before any RAG or LLM invocation.
  if (frontmatter.phase === 'decomposed') {
    const children = frontmatter.children;
    return {
      ok: false,
      error: 'story_decomposed',
      message: `Story ${problemId} is decomposed into child stories. Build each child story instead of the parent.`,
      childStories: Array.isArray(children) ? children : [],
    };
  }

  // Not decomposed — return a placeholder error since full planning requires loadContext(projectId)
  return { ok: false, error: 'no_project_context', message: 'planProblem requires a full project context; call runPlanTool with a projectId instead.' };
}

async function runPlanTool({ projectId, task, problemId, label, autoEmbed = true, _noteOnlyRetryCount = 0, _enhancedContext = null }) {
  let normalizedTask = task?.trim() ? task.trim() : null;
  let normalizedProblem = problemId?.trim() ? problemId.trim() : null;

  // Auto-resolve task to problemId if it looks like a note path and the note exists
  if (normalizedTask && !normalizedProblem && /^[a-z0-9._-]+$/i.test(normalizedTask)) {
    const context = await loadContext(projectId);
    const resolved = resolveNotePath(context.record.root, normalizedTask);
    if (resolved) {
      normalizedProblem = normalizedTask;
      normalizedTask = null; // Clear task so planningText uses note content
    }
  }

  // When both task and problemId are provided, problemId takes precedence
  if (normalizedTask && normalizedProblem) {
    normalizedTask = null;
  }

  if (!normalizedTask && !normalizedProblem) {
    throw new McpError(ErrorCode.InvalidParams, "rks.plan requires either a task or a problemId.");
  }
  const planStartMs = Date.now();
  const context = await loadContext(projectId);
  const projectRoot = context.record.root;

  // plan.start — emitted once per invocation, after input validation, before expensive operations
  try { getTelemetryCollector().emit("plan.start", projectId, { problemId: normalizedProblem, task: normalizedTask ? normalizedTask.slice(0, 120) : null }); } catch (e) { /* telemetry is best-effort */ }

  // If using task mode with a label, check if a matching backlog note exists
  let taskModeSuggestion = null;
  if (normalizedTask && label) {
    const candidateId = `backlog.${slugify(label.trim()).replace(/-/g, '.')}`;
    const candidateNote = resolveNotePath(projectRoot, candidateId);
    if (candidateNote) {
      taskModeSuggestion = `A backlog note "${candidateId}" exists. Consider using problemId instead of task for full quality gate validation.`;
      console.error(`[rks.plan] WARNING: ${taskModeSuggestion}`);
    }
  }

  let autoEmbedded = false;
  await ensureRagIndex(projectRoot);
  let codemap = readCodemap(projectRoot, projectId);
  if (!codemap) {
    // F1: the codemap (analyze) is a plan precondition. Rather than require the operator
    // to run rks.analyze first, auto-run it once here, then re-read. Bounded to a SINGLE
    // attempt — if the codemap is still absent afterward, fail with a clear error (no loop).
    // RKS_NO_AUTO_ANALYZE=1 preserves the legacy require-analyze-first behavior.
    if (process.env.RKS_NO_AUTO_ANALYZE === "1") {
      throw new McpError(ErrorCode.InvalidParams, "Run rks.analyze before planning.");
    }
    console.error(`[rks.plan] codemap missing for ${projectId} — auto-running rks.analyze once`);
    await runAnalyzeTool({ projectId });
    codemap = readCodemap(projectRoot, projectId);
    if (!codemap) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Codemap still missing after auto-analyze. Run rks.analyze manually and check the project's code roots (kg.yaml).",
      );
    }
  }

  // Pre-plan readiness gate: validate story has required fields BEFORE expensive operations
  // This BLOCKS planning if story is not ready - use RKS_SKIP_READINESS=1 to bypass
  // IMPORTANT: This runs BEFORE auto-embed/pre-flight to fail fast on incomplete stories
  if (normalizedProblem && !process.env.RKS_SKIP_READINESS) {
    try {
      const readinessResult = await runPlanReadyTool({
        projectId,
        problemId: normalizedProblem,
        projectRoot,
      });

      // BLOCK if story is not ready (issues found)
      if (!readinessResult.ready) {
        console.error(`[rks.plan] BLOCKED: story not ready: ${normalizedProblem} - ${readinessResult.issues?.length || 0} issues`);

        try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, reason: "not_ready", durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
        return {
          ok: false,
          error: "Story not ready for planning - refinement required",
          problemId: normalizedProblem,
          currentPhase: readinessResult.currentPhase,
          issues: readinessResult.issues,
          warnings: readinessResult.warnings,
          hint: "REQUIRED: Fix the issues listed above, then retry rks_plan. Use rks_refine to get suggestions.",
          workflow: [
            "1. Run rks_refine to get specific suggestions",
            "2. Run rks_refine_apply to apply fixes",
            "3. Run rks_plan_ready to verify",
            "4. Retry rks_plan"
          ]
        };
      }

      // Log warnings but don't block
      if (readinessResult.warnings?.length > 0) {
        console.error(`[rks.plan] ${readinessResult.warnings.length} warnings (non-blocking): ${readinessResult.warnings.map(w => w.check).join(", ")}`);
      }
    } catch (e) {
      console.error(`[rks.plan] readiness check failed: ${e?.message}`);
      // Don't block on readiness check failure - let planning proceed
    }
  }

  // Pre-flight checks (skip with RKS_SKIP_PREFLIGHT=1 for testing)
  if (!process.env.RKS_SKIP_PREFLIGHT) {
    const baseBranch = context.projectJson?.baseBranch || "staging";
    const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
    if (currentBranch !== baseBranch) {
      try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, reason: "wrong_branch", durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
      return {
        ok: false,
        error: `Plan from base branch '${baseBranch}', not '${currentBranch}'`,
        hint: `git checkout ${baseBranch}`,
      };
    }
    // Check if staging is synced with origin
    const syncStatus = getStagingSyncStatus(projectRoot);
    if (syncStatus.behindBy > 0) {
      return {
        ok: false,
        error: `Branch is ${syncStatus.behindBy} commit(s) behind origin`,
        hint: "Run rks_sync_staging first to sync with origin",
        behindBy: syncStatus.behindBy,
        aheadBy: syncStatus.aheadBy,
        diverged: syncStatus.diverged
      };
    }
    if (!isWorkingTreeClean(projectRoot, { filterRks: false, throwOnError: false })) {
      const dirtyFiles = getUncommittedFiles(projectRoot, { filterRks: false });
      const noteFiles = dirtyFiles.filter(f => f.startsWith("notes/") && f.endsWith(".md"));
      const nonNoteFiles = dirtyFiles.filter(f => !f.startsWith("notes/") || !f.endsWith(".md"));
      // Filter out known RKS/Dendron runtime artifacts from non-note files
      const blockingFiles = nonNoteFiles.filter(f => !isRuntimeArtifact(f));

      if (noteFiles.length > 0) {
        console.error(`[rks.plan] Auto-committing ${noteFiles.length} note file(s) before planning...`);
        if (nonNoteFiles.length > 0) {
          console.error(`[rks.plan] ${nonNoteFiles.length} non-note file(s) found: ${nonNoteFiles.length - blockingFiles.length} runtime artifact(s) filtered, ${blockingFiles.length} blocking`);
        }
        try {
          commitFiles(projectRoot, noteFiles, "docs(backlog): update notes for planning");
          console.error("[rks.plan] Auto-commit completed");
        } catch (commitErr) {
          return {
            ok: false,
            error: "Failed to auto-commit notes",
            hint: commitErr.message || "Commit notes manually",
          };
        }
      }

      if (blockingFiles.length > 0) {
        try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, reason: "dirty_tree", durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
        return {
          ok: false,
          error: `Working tree has ${blockingFiles.length} uncommitted non-note file(s)`,
          hint: "Commit or stash changes before planning",
          dirtyFiles: blockingFiles.slice(0, 10),
        };
      }
    }
    const notesDir = path.join(projectRoot, "notes");
    if (!isRagIndexFresh(projectRoot, notesDir)) {
      if (autoEmbed) {
        const changedNotes = getChangedNotesSinceEmbed(projectRoot, notesDir);
        if (changedNotes && changedNotes.length > 0) {
          console.error(`[rks.plan] RAG index stale - incrementally embedding ${changedNotes.length} changed notes...`);
          try {
            await runRagEmbed(projectRoot, { files: changedNotes });
            autoEmbedded = true;
            console.error("[rks.plan] incremental auto-embed completed");
          } catch (embedErr) {
            console.error(`[rks.plan] incremental auto-embed failed: ${embedErr?.message}`);
            return {
              ok: false,
              error: "RAG index is stale and incremental auto-embed failed",
              hint: "Run rag_embed manually to refresh context",
            };
          }
        } else {
          // No previous embed or can't determine changes - full re-embed
          console.error("[rks.plan] RAG index stale - full auto-embedding notes...");
          try {
            await runRagEmbed(projectRoot, { glob: "notes/**/*.md" });
            autoEmbedded = true;
            console.error("[rks.plan] full auto-embed completed");
          } catch (embedErr) {
            console.error(`[rks.plan] auto-embed failed: ${embedErr?.message}`);
            return {
              ok: false,
              error: "RAG index is stale and auto-embed failed",
              hint: "Run rag_embed manually to refresh context",
            };
          }
        }
      } else {
        try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, reason: "rag_stale", durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
        return {
          ok: false,
          error: "RAG index is stale - notes modified since last embed",
          hint: "Run rag_embed to refresh context",
        };
      }
    }
  }

  // Phase enforcement: story must be phase: ready (or higher) to plan
  // Auto-promote draft stories that passed readiness checks above
  let autoPromoted = false;
  if (normalizedProblem && !process.env.RKS_SKIP_PHASE_CHECK) {
    try {
      const notesDir = resolveNotesDir(projectRoot);
      const storyPath = path.join(notesDir, `${normalizedProblem}.md`);
      let storyContent = fs.readFileSync(storyPath, "utf8");
      const phaseMatch = storyContent.match(/^phase:\s*["']?([\w-]+)["']?/m);
      const currentPhase = phaseMatch ? phaseMatch[1] : "draft";
      const allowedPhases = ["ready", "arch-approved", "planned", "executed"];
      if (!allowedPhases.includes(currentPhase)) {
        // Auto-promote from draft to ready if we passed readiness checks
        if (currentPhase === "draft") {
          console.error(`[rks.plan] auto-promoting story from draft to ready: ${normalizedProblem}`);
          storyContent = storyContent.replace(/^phase:\s*["']?draft["']?/m, 'phase: ready');
          fs.writeFileSync(storyPath, storyContent);
          autoPromoted = true;
        } else {
          return {
            ok: false,
            error: "Story not ready for planning",
            problemId: normalizedProblem,
            currentPhase,
            hint: "Update story phase to 'ready' before planning",
          };
        }
      }
    } catch (e) {
      console.error(`[rks.plan] phase check failed: ${e?.message}`);
    }
  }

  const analysis = readAnalysis(projectRoot, projectId);
  const sourceTask = normalizedTask || normalizedProblem || "";
  const slugSource = normalizedTask || normalizedProblem || "plan";
  const normalizedLabel = label?.trim() ? slugify(label.trim()) : null;
  const finalSlug = normalizedLabel || slugify(slugSource);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runFolder = path.join(runsRoot(projectRoot), `${timestamp}_${finalSlug}`);
  ensureDir(runFolder);
  
  // Determine plan mode for telemetry and warnings
  const planMode = normalizedProblem ? "problemId" : "task";

  // Initialize correlation tracking for telemetry
  const collector = getTelemetryCollector();
  const correlationId = collector.startCorrelation();
  const runIdValue = path.basename(runFolder);

  function toImportPath(componentPath) {
    if (!componentPath) return null;
    const normalized = componentPath.replace(/\\/g, "/");
    const rel = path.posix.relative("src/pages", normalized);
    const withoutExt = rel.replace(/\.[^/.]+$/, "");
    if (!rel || withoutExt.startsWith(".")) return withoutExt || "./About";
    return `./${withoutExt}`;
  }

  function buildAboutContent() {
    const heroPath = toImportPath(context.kg?.components?.hero_section?.path || "src/components/HeroSection.tsx");
    const ctaPath = toImportPath(context.kg?.components?.cta_section?.path || "src/components/CTASection.tsx");
    const heroImport = heroPath ? `import { HeroSection } from "${heroPath}";\n` : "";
    const ctaImport = ctaPath ? `import { CTASection } from "${ctaPath}";\n` : "";
    return `${heroImport}${ctaImport}export default function About() {
  return (
    <main className="space-y-16">
      <HeroSection />
      <section className="rounded-3xl bg-white p-10 shadow-sm">
        <h1 className="text-4xl font-semibold text-slate-900">About Our Studio</h1>
        <p className="mt-4 text-slate-600">
          Use the layout shell guardrails to narrate your studio story. Swap in stack data where needed.
        </p>
      </section>
      <CTASection />
    </main>
  );
}
`;
  }

  // Phase 2: Gather target context (extracted to planner-context.mjs)
  const targetCtx = await gatherTargetContext({
    projectRoot, projectId, normalizedProblem, normalizedTask,
    context, finalSlug, _enhancedContext,
  });
  if (targetCtx.skipped) {
    return { ok: true, skipped: true, reason: targetCtx.reason, projectId, problemId: normalizedProblem };
  }
  const {
    problemNote, planningText, planningSource, planSummary, ragContext, pkgScripts,
    frontmatterTargets, frontmatterCreateFiles, editableTargetPaths, resolvedTargets,
    enhancedEditableTargets, automatedSteps, storyMeta, targetFilesFormat,
  } = targetCtx;

  const requirementSummary = planSummary || truncateText(planningText, 240);

  // About page automation (legacy, kept inline)
  if (/about page/i.test(planningSource)) {
    automatedSteps.push({
      action: "create_file",
      path: "src/pages/About.tsx",
      content: buildAboutContent(),
    });
  }
  const plannerMode = process.env.RKS_PLANNER_MODE || "full";
  const noteDrivenSteps = buildNoteDrivenSteps(problemNote?.content || planningText, projectRoot);

  const contextualRefs = [];
  const ragCodeHits = ragContext.code?.slice(0, 5) || [];
  for (const hit of ragCodeHits) {
    const rel = normalizeRagPath(projectRoot, hit.path);
    if (!rel || rel.includes("\n")) continue;
    if (hit.text && hit.text.trim()) {
      contextualRefs.push({
        path: rel,
        note: "RAG code (read-only)",
        snippet: hit.text.split("\n").slice(0, MAX_SNIPPET_LINES).join("\n"),
      });
    }
  }
  const ragNoteHits = ragContext.notes?.slice(0, 3) || [];
  for (const hit of ragNoteHits) {
    contextualRefs.push({
      path: hit.path || hit.slug || "(note)",
      note: "RAG note (read-only)",
      snippet: truncateText(hit.text),
    });
  }
  const ragKgHits = ragContext.kg?.slice(0, 3) || [];
  for (const hit of ragKgHits) {
    if (hit.key && hit.value) {
      contextualRefs.push({
        path: `KG: ${hit.key}`,
        note: "Knowledge Graph (read-only)",
        snippet: typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value, null, 2),
      });
    } else {
      contextualRefs.push({
        path: hit.path || "(kg)",
        note: "RAG kg (read-only)",
        snippet: truncateText(hit.text || ""),
      });
    }
  }

  // Compute which op:create targets have no pre-extracted content in automatedSteps
  const automatedStepPaths = new Set((automatedSteps || []).map(s => s.path).filter(Boolean));
  const uncoveredCreatePaths = Array.from(frontmatterCreateFiles || []).filter(p => !automatedStepPaths.has(p));
  if (uncoveredCreatePaths.length) {
    console.error(`[planner] ${uncoveredCreatePaths.length} op:create path(s) have no pre-extracted content — injecting create_file instruction:`, uncoveredCreatePaths);
  }

  // Phase 2.5: Early-exit if all op:edit targets have pre-injected @@SEARCH/@@REPLACE blocks.
  //
  // When add_search_pattern has fully populated the story with anchors for every op:edit target,
  // we bypass LLM generation entirely and convert those blocks directly to search_replace steps.
  // This is the reliable path for 3+ file stories where the LLM fails to generate SEARCH blocks.
  //
  // All-or-nothing gate: if ANY op:edit target is missing blocks, fall through to the LLM.
  // Partial coverage would create a split execution model (some steps verbatim, others LLM-
  // synthesized) which is harder to reason about and debug. Full LLM fallthrough for partial
  // coverage ensures consistent, predictable behavior.
  //
  // NOTE: Intentional tactical debt. Long-term home is plan-normalizer.mjs
  // (see notes/design.arch-planner-refactor.md). This is a third implementation of the
  // search_replace/op:edit guard alongside buildPrompt's CRITICAL block and filterMustEditSteps.
  if (editableTargetPaths && editableTargetPaths.length > 0) {
    const earlyExitSteps = [];
    let allCovered = true;
    for (const targetPath of editableTargetPaths) {
      const blocks = extractSearchReplaceBlocks(planningText || '', targetPath);
      if (blocks.length === 0) {
        allCovered = false;
        console.error(`[planner] early-exit: no @@SEARCH blocks for ${targetPath} — falling through to LLM`);
        break;
      }
      earlyExitSteps.push({
        action: 'search_replace',
        path: targetPath,
        edits: blocks.map(b => ({ search: b.search, replace: b.replace })),
        source: 'search_replace_block',
      });
    }
    // op:create guard (backlog.fix.planner-drops-create-file-steps): the early-exit emits ONLY
    // search_replace steps, so taking it while op:create targets remain uncovered would silently
    // DROP those creates. Bypass the LLM only when there are zero uncovered creates; otherwise
    // fall through to LLM planning (which receives uncoveredCreatePaths below).
    if (shouldEarlyExitToSteps(allCovered, earlyExitSteps.length, uncoveredCreatePaths.length)) {
      console.error(`[planner] early-exit: all ${editableTargetPaths.length} op:edit target(s) have @@SEARCH/@@REPLACE blocks and no uncovered op:create targets — bypassing LLM`);
      // Classify by the actual steps so the deterministic early-exit gets the same
      // "executable" status the LLM path would (search_replace with edits => executable),
      // advancing arch-approved->executing instead of dead-ending at the inert 'ready'.
      const earlyExitStatus = classifyPlanStatus({ steps: earlyExitSteps });
      const earlyPlan = {
        projectId,
        task: normalizedTask,
        problemId: normalizedProblem,
        problemPath: problemNote?.path || null,
        acCoverage: null,
        ragContextSummary: {
          notesHitCount: ragContext.notes.length,
          codeHitCount: ragContext.code.length,
          kgHitCount: ragContext.kg.length,
        },
        ragContextPreview: {
          notes: ragContext.notes.slice(0, 3).map(item => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
          code: ragContext.code.slice(0, 3).map(item => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
          kg: ragContext.kg.slice(0, 3).map(item => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
        },
        planSummary,
        guardrail: null,
        slug: finalSlug,
        generatedAt: new Date().toISOString(),
        codemapPath: codemap.path,
        status: earlyExitStatus,
        steps: earlyExitSteps,
      };
      // Deterministic early-exit is a SUCCESS path (status 'executable') that bypasses the LLM and
      // therefore emits no plan.complete via orchestrateLlmPlanning — emit it here so successful
      // early-exit plans register in operations.plan. See backlog.feat.plan-exec-telemetry-lifecycle-events.
      try { getTelemetryCollector().emit("plan.complete", projectId, { problemId: normalizedProblem, slug: finalSlug, steps: earlyExitSteps, status: earlyExitStatus, durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
      return persistAndFinalize({
        plan: earlyPlan, planStatus: earlyExitStatus, projectRoot, projectId,
        normalizedProblem, normalizedTask, normalizedLabel, finalSlug,
        runFolder, planningText, storyMeta, frontmatterTargets, frontmatterCreateFiles,
        autoEmbedded, taskModeSuggestion, combinedSteps: earlyExitSteps,
      });
    }
  }

  // Phase 3: LLM planning (extracted to planner-llm.mjs)
  const llmOrchResult = await orchestrateLlmPlanning({
    planningText,
    planningSource,
    requirementSummary,
    enhancedEditableTargets,
    contextualRefs,
    frontmatterTargets,
    plannerMode,
    runFolder,
    projectRoot,
    slug: finalSlug,
    projectId,
    uncoveredCreatePaths,
  });

  // Handle early returns from LLM orchestration
  if (llmOrchResult.refinementRequired) {
    const failReason = llmOrchResult.reason || "refinement_required";
    try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, slug: finalSlug, reason: failReason, durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
    // (N2 Option 1) The create_file_complexity early-return is gone — the gate no
    // longer forces decompose on AC count, so reason is never "create_file_complexity"
    // here. Other refinement reasons (e.g. stale_edits) flow to the generic arm below.
    return {
      ok: false,
      status: "refinement_required",
      error: llmOrchResult.error,
      staleEdits: llmOrchResult.staleEdits,
      refinementRequired: true,
      hint: "Run rks_refine to update stale SEARCH patterns",
    };
  }

  const { llmActions, llmStatus, llmDebug } = llmOrchResult;

  // PART A (backlog.fix.planner-note-step-degeneracy): a create-only target the planner
  // cannot author must FAIL LOUD — NEVER a silent stub. The planner has no model-escalation
  // ladder, so stub-and-succeed would ship a placeholder file. When the LLM produced a REAL
  // create_file step for an op:create target, it passes through unchanged below (authorable
  // creates still work). When it produced NO usable content for an uncovered op:create target,
  // route IMMEDIATELY to the loud structural failure — no loop, no stub.
  //
  // backlog.fix.planner-greenfield-body-synthesis: coverage is judged by isSynthesizedBody — a
  // REAL BODY — not by "non-empty string". Prose ("create a Calculator component that...") is
  // non-empty, so the old rule counted it as covered, skipped this loud failure, and let the
  // plan fall into a soft retry loop it could never escape. The body-synthesis enricher runs
  // UPSTREAM of here (in the LLM worker), so by this point a prose body means synthesis itself
  // could not author the file — which is exactly when we want to fail loud.
  const llmCreatePaths = new Set(
    (llmActions || [])
      .filter(a => a?.action === "create_file" && isSynthesizedBody(a?.content, a?.path))
      .map(a => a.path).filter(Boolean)
  );
  const uncoveredCreatesAfterLlm = Array.from(frontmatterCreateFiles || [])
    .filter(p => !automatedStepPaths.has(p) && !llmCreatePaths.has(p));
  if (uncoveredCreatesAfterLlm.length > 0) {
    const structural = buildStructuralFailure(uncoveredCreatesAfterLlm);
    console.error(`[rks.plan] STRUCTURAL create-unauthorable: ${structural.message}`);
    // Structural telemetry, additive: reuse plan.retry.exhausted discriminator shape so the
    // operations rollup buckets it with the exhausted-degeneracy case, plus the lifecycle
    // plan.failed terminal. No retry is consumed — this is a deterministic, unrefinable fail.
    try {
      getTelemetryCollector().emit("plan.retry.exhausted", projectId, {
        attempts: _noteOnlyRetryCount || 0,
        slug: finalSlug,
        failureClass: structural.failureClass,
        uncoveredCreateTargets: structural.uncoveredCreateTargets,
      });
    } catch (e) { /* telemetry is best-effort */ }
    try { getTelemetryCollector().emit("plan.failed", projectId, { problemId: normalizedProblem, slug: finalSlug, reason: "structural_create_unauthorable", failureClass: structural.failureClass, durationMs: Date.now() - planStartMs }); } catch (e) { /* telemetry is best-effort */ }
    return {
      ok: false,
      status: "refinement_required",
      reason: "has_note_steps",
      failureClass: structural.failureClass,
      uncoveredCreateTargets: structural.uncoveredCreateTargets,
      refinable: structural.refinable,
      message: structural.message,
      noteSteps: [],
      rejectionReasons: [],
    };
  }
  // Boilerplate scaffold-note suppression stays for create stories so a story with uncovered
  // creates never trips has_note_steps into the retry loop. With the immediate structural
  // return above, this path is now defense-in-depth for the mixed/covered case.
  const suppressScaffoldNotes = uncoveredCreatesAfterLlm.length > 0;

  const refinementNotes = [];
  if ((!llmActions || llmActions.length === 0) && !suppressScaffoldNotes) {
    const needsRunCommand = /run_command|whitelist|exec/i.test(planningText || "");
    if (needsRunCommand) {
      refinementNotes.push(
        {
          title: "Clarify run_command whitelist",
          description: "List allowed commands (e.g., npm run test:unit, npm run lint, node scripts/...).",
          order: 900,
          action: "note",
        },
        {
          title: "Define run_command safety",
          description: "Confirm timeout, logging path, repo-root cwd, and --run-commands opt-in behavior.",
          order: 901,
          action: "note",
        },
        {
          title: "Add exec coverage",
          description: "Identify tests/docs for run_command flow (exec apply and failure logging).",
          order: 902,
          action: "note",
        }
      );
    } else {
      refinementNotes.push({
        title: "Specify actionable targets",
        description: "Add explicit files/commands or acceptance criteria so planner can emit code edits.",
        order: 900,
        action: "note",
      });
    }
    // Add error-specific refinement hints based on llmDebug.error
    const errorType = llmDebug?.error || "";
    if (errorType === "no_api_key") {
      refinementNotes.push({
        title: "Configure API key",
        description: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your .env file.",
        order: 901,
        action: "note",
      });
    } else if (errorType === "parse failed") {
      refinementNotes.push({
        title: "Review LLM output",
        description: "Check .rks/runs/*/llm-output.json. Consider simplifying requirements or adding explicit code snippets.",
        order: 901,
        action: "note",
      });
    } else if (errorType === "raw empty") {
      refinementNotes.push({
        title: "LLM returned empty",
        description: "Possible causes: rate limiting, context too long, model unavailable. Reduce prompt size or check provider status.",
        order: 901,
        action: "note",
      });
    } else if (errorType.includes?.("timed out")) {
      refinementNotes.push({
        title: "Request timed out",
        description: "LLM request exceeded timeout. Consider increasing RKS_LLM_TIMEOUT or reducing context size.",
        order: 901,
        action: "note",
      });
    }
  }

  const deterministicPhase2 =
    normalizedProblem === "backlog.ape-llm-implementation.phase-2"
      ? [
        {
          title: "Add LLM planner regression test",
          description: "Create planner.llm.spec.mjs to validate LLM planner outputs are structured and non-empty.",
          order: 100,
          action: "create_file",
          path: "packages/mcp-rks/__tests__/planner.llm.spec.mjs",
          content: [
            "import assert from \"node:assert\";",
            "import { runLlmPlanner } from \"../src/llm/planner.mjs\";",
            "import { buildNoteDrivenSteps } from \"../src/server.mjs\";",
            "",
            "describe(\"LLM planner\", () => {",
            "  it(\"returns null without keys\", async () => {",
            "    const res = await runLlmPlanner({ requirements: \"test\", context: \"\", targets: [], runFolder: null, useReplay: false });",
            "    assert.strictEqual(res, null);",
            "  });",
            "",
            "  it(\"keeps deterministic fallback valid\", () => {",
            "    const note = `# Requirements\\n- Parse numbered lists\\n- Add table support\\n- Add planner docs`;",
            "    const steps = buildNoteDrivenSteps(note);",
            "    assert.ok(steps.length > 0, \"expected steps\");",
            "    steps.forEach((s) => {",
            "      if (s.action === \"note\") return;",
            "      assert.ok(s.path && s.path.trim().length > 0, \"path present\");",
            "      if (s.action === \"edit_file\" || s.action === \"create_file\") {",
            "        assert.ok(s.content && s.content.trim().length > 0, \"content present\");",
            "      }",
            "    });",
            "  });",
            "});",
            "",
          ].join("\n"),
        },
        {
          title: "Document LLM planning workflow",
          description: "Add how-to.llm-planning.md describing inputs, outputs, validation, and replay.",
          order: 101,
          action: "create_file",
          path: "notes/how-to.llm-planning.md",
          content: [
            "---",
            "id: how-to.llm-planning",
            "title: LLM-Assisted Planning Workflow",
            "desc: How to run rks.plan with LLM, validation, and replay",
            "created: 2025-11-28",
            "updated: 2025-11-28",
            "tags: [how-to, llm, planner]",
            "---",
            "",
            "## Inputs",
            "- Requirements note (problemId/task)",
            "- RAG/KG/codemap context",
            "- Candidate targets (parser/tests/docs) with excerpts",
            "- Guardrails: allowed actions/paths, no TODOs/placeholders",
            "- Credentials in `.env` (provider/model/api key)",
            "",
            "## Outputs",
            "- Actions using anchored patches or full files for small targets",
            "- Non-empty content; invalid items downgraded to notes",
            "- Caching: LLM I/O stored in run folder; replay supported",
            "",
            "## Validation",
            "- Path allowlist and existence checks",
            "- Non-empty content for file actions",
            "- Downgrade unsafe/invalid to notes",
            "",
            "## Replay",
            "- Use stored `llm-output.json` to avoid re-calling LLM",
          ].join("\n"),
        },
      ]
      : [];

  // Combine steps: prioritize LLM actions, fall back to note-driven steps
  // Only add noteDrivenSteps/refinementNotes if we have NO actionable steps from any source
  const hasLlmActions = llmActions && llmActions.length > 0;
  const hasAutomatedActions = automatedSteps.some(s => s.action !== "note");

  const rawCombined = hasLlmActions
    ? [...automatedSteps, ...llmActions]
    : hasAutomatedActions
      ? [...automatedSteps] // Have automated actions, skip note-driven fallbacks entirely
      : [...automatedSteps, ...noteDrivenSteps, ...refinementNotes]; // No actions, add fallback guidance
  const rejectionReasons = [];
  let combinedSteps = rawCombined
    .map((s) => {
      if (!s) return null;
      // backlog.fix.planner-greenfield-body-synthesis: ONE shared predicate decides "is this a
      // real body?" — the same one the create-coverage gate above uses, so the two can never
      // disagree again (that divergence is what dumped greenfield plans into an unwinnable loop).
      //
      // This DELIBERATELY LOOSENS the old check, which was an unanchored substring match: a real
      // 200-line component containing one `// TODO: handle divide-by-zero` used to be downgraded
      // to a note. LLM-authored code carries TODOs routinely — that body is REAL and now stays
      // executable. A body that is ONLY a placeholder/comment is still downgraded (see
      // isSynthesizedBody's whole-body rule), so the guard is loosened, not disabled.
      if (s?.content !== undefined && s?.content !== null && !isSynthesizedBody(s.content, s.path)) {
        rejectionReasons.push({ path: s.path || "(none)", reason: "placeholder content" });
        return { ...s, action: "note" };
      }
      const allowedTargets = editableTargetPaths && editableTargetPaths.length ? resolvedTargets : null;
      const validated = validateStep(s, allowedTargets, projectRoot);
      if (validated?._invalid) {
        rejectionReasons.push({ path: s.path || "(none)", reason: validated._invalidReason || "validation failed" });
        return null;
      }
      if (validated && validated._invalidReason) {
        rejectionReasons.push({ path: s.path || "(none)", reason: validated._invalidReason });
      }
      if (!validated) {
        rejectionReasons.push({ path: s.path || "(none)", reason: "failed validation" });
      }
      return validated;
    })
    .filter(Boolean);

  // Post-generation mustEdit guard: strip stray create_file steps for op:edit / @@SEARCH targets
  const mustEditPathsForFilter = extractMustEditPaths(planningText || '');
  if (mustEditPathsForFilter.length > 0) {
    combinedSteps = filterMustEditSteps(combinedSteps, mustEditPathsForFilter);
  }

  // Op:edit safety filter — remove create_file steps targeting op:edit files to prevent destructive overwrites.
  // This happens BEFORE search-pattern validation so the plan is clean going into further checks.
  const runRes = { plan: { steps: combinedSteps } };
  const opViolations = checkOpMatch(runRes.plan.steps, resolvedTargets || []);
  if (opViolations.length > 0) {
    const violatingPaths = new Set(opViolations.map(v => v.step.path || v.step.target));
    console.error(`[rks.plan] filtering ${opViolations.length} create_file step(s) targeting op:edit files: ${[...violatingPaths].join(', ')}`);
    runRes.plan.steps = runRes.plan.steps.filter(s => !violatingPaths.has(s.path || s.target));
    combinedSteps = runRes.plan.steps;
  }
  // Paths this plan's create_file steps will produce — a search_replace targeting
  // one can't be validated on disk yet (the file is written at apply time, before
  // its edit), so exempt those paths from the on-disk anchor checks below. (N2 Option 1)
  const createdPaths = new Set(
    (runRes.plan.steps || [])
      .filter((s) => s && s.action === "create_file")
      .map((s) => s.path || s.target)
      .filter(Boolean),
  );
  // Validate search/replace patterns from planner output after the op:edit filter is applied
  validateSearchPatternsFromPlanner(runRes.plan.steps, projectRoot);

  // Full validation with auto-correction for whitespace mismatches
  let srValidationErrors = [];
  validateSearchReplacePatterns(runRes.plan, projectRoot, createdPaths);
  {
    const allErrors = runRes.plan.validationErrors || [];
    if (allErrors.length > 0) {
      const allWhitespace = allErrors.every(e => e.refinementType === "whitespace_mismatch");
      if (allWhitespace) {
        autoCorrectSearchPatterns(runRes.plan, projectRoot);
        const corrections = runRes.plan._whitespaceCorrections || [];
        for (const c of corrections) {
          console.error(`[rks.plan] autocorrected whitespace mismatch in ${c.target}`);
        }
        if (corrections.length > 0) {
          runRes.plan.validationErrors = [];
          delete runRes.plan._whitespaceCorrections;
          validateSearchReplacePatterns(runRes.plan, projectRoot, createdPaths);
        }
      }
      srValidationErrors = runRes.plan.validationErrors || [];
    }
  }

  const isHelloApply =
    normalizedProblem === "backlog.scratch.hello-note" ||
    /notes\/hello-apply\.md/i.test(planningText || "") ||
    /hello-apply|hello-note/i.test(normalizedTask || "");
  if (isHelloApply && llmStatus !== "error") {
    combinedSteps = [
      {
        id: "step-001",
        action: "create_file",
        path: "notes/hello-apply.md",
        content: "Hello from apply\n",
        title: "Create hello apply note",
        description: "Create a tiny note to verify rks.apply end-to-end.",
        order: 1,
      },
    ];
  }

  const isCodeEdit = (step) =>
    step &&
    (step.action === "edit_file" || step.action === "create_file") &&
    /\.(mjs|js|ts|tsx)$/.test(step.path || "") &&
    !step.path.startsWith("notes/") &&
    !/__tests__|\.spec\./.test(step.path || "");
  const hasTest = combinedSteps.some((s) => /\.spec\./.test(s?.path || "") || (s?.path || "").includes("__tests__/"));
  const hasDoc = combinedSteps.some((s) => (s?.path || "").startsWith("notes/"));
  combinedSteps.forEach((s) => {
    if (isCodeEdit(s) && (!hasTest || !hasDoc)) {
      rejectionReasons.push({ path: s.path || "(none)", reason: "missing paired test/doc" });
    }
  });

  const hasActionable = combinedSteps.some((s) => s.action && s.action !== "note");
  const finalSteps =
    combinedSteps.length > 0 && hasActionable
      ? combinedSteps
      : [
        {
          action: "note",
          title: "No executable actions generated",
          description:
            llmActions === null
              ? `LLM call failed: ${llmDebug?.error || "no response received"}. ${
                  llmDebug?.error === "parse failed"
                    ? "Review llm-output.json - LLM response couldn't be parsed."
                    : llmDebug?.error === "raw empty"
                    ? "LLM returned empty response. Check API key, model limits, or prompt size."
                    : llmDebug?.error === "no_api_key"
                    ? "No API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env"
                    : llmDebug?.error?.includes?.("timed out")
                    ? "Request timed out. Consider reducing context size or increasing RKS_LLM_TIMEOUT."
                    : llmDebug?.rawPreview
                    ? `Raw preview: ${llmDebug.rawPreview}`
                    : "Check API key/provider configuration."
                }`.trim()
              : rejectionReasons.length
                ? `All actions failed validation. Rejections: ${rejectionReasons
                  .map((r) => `${r.path}: ${r.reason}`)
                  .join("; ")}${llmDebug?.rawPreview ? ` | LLM raw preview: ${llmDebug.rawPreview}` : ""}`
                : `All actions failed validation (paths/content). Review llm-output.json and snippets.${llmDebug?.rawPreview ? ` Raw: ${llmDebug.rawPreview}` : ""}`,
          order: 1,
        },
      ];
  const planStatus = classifyPlanStatus({ steps: combinedSteps, llmStatus });
  const effectivePlanStatus = (srValidationErrors.length > 0 && planStatus === "executable")
    ? "needs_refinement" : planStatus;
  // Note-only retry logic: if LLM produced no executable steps, retry with enhanced prompt
  const retryCount = _noteOnlyRetryCount || 0;
  const skipLlm = process.env.RKS_SKIP_LLM === "1";
  const hasExecutableSteps = combinedSteps.some(s => s.action && s.action !== "note");
  const hasNoteSteps = combinedSteps.some(s => s?.action === "note");

  // Check targetFiles coverage - each targetFile should have an executable step
  const executablePaths = combinedSteps
    .filter(s => s.action && s.action !== "note" && s.path)
    .map(s => s.path);
  const uncoveredTargets = (enhancedEditableTargets || [])
    .filter(t => !executablePaths.some(p => p === t.path || p?.endsWith(t.path) || t.path?.endsWith(p)));
  const hasTargetCoverageGap = uncoveredTargets.length > 0;

  if (hasTargetCoverageGap) {
    console.error(`[rks.plan] WARNING: ${uncoveredTargets.length} targetFile(s) have no executable steps: ${uncoveredTargets.map(t => t.path).join(', ')}`);
  }
  if (hasNoteSteps) {
    const noteStepPaths = combinedSteps.filter(s => s?.action === "note").map(s => s.path || s.title || "unknown").join(', ');
    console.error(`[rks.plan] WARNING: Plan contains note step(s) that exec will reject: ${noteStepPaths}`);
  }

  if ((!hasExecutableSteps || hasTargetCoverageGap || hasNoteSteps) && retryCount < MAX_NOTE_ONLY_RETRIES && !skipLlm) {
    const retryReason = !hasExecutableSteps ? "note_only" : hasNoteSteps ? "has_note_steps" : "coverage_gap";
    console.error(`[rks.plan] LLM produced ${retryReason} plan, retrying (${retryCount + 1}/${MAX_NOTE_ONLY_RETRIES})`);

    // Emit telemetry for retry
    try {
      const collector = getTelemetryCollector();
      collector.emit("plan.retry", projectId, {
        reason: retryReason,
        attempt: retryCount + 1,
        maxAttempts: MAX_NOTE_ONLY_RETRIES,
        slug: finalSlug,
        uncoveredTargets: hasTargetCoverageGap ? uncoveredTargets.map(t => t.path) : undefined,
        noteSteps: hasNoteSteps ? combinedSteps.filter(s => s?.action === "note").map(s => s.path || s.title) : undefined,
      });
    } catch (e) {
      console.error(`[rks.plan] telemetry emit failed: ${e?.message}`);
    }

    // Enhance context with stronger directive
    const noteGuidance = hasNoteSteps
      ? `\nThe following steps were converted to non-executable notes: ${combinedSteps.filter(s => s?.action === "note").map(s => s.path || s.title).join(', ')}. Rewrite them as executable create_file or search_replace actions with actual code content.`
      : '';
    const coverageGuidance = hasTargetCoverageGap
      ? `\nEnsure ALL target files have executable steps: ${uncoveredTargets.map(t => t.path).join(', ')}`
      : '';
    const enhancedRetryContext = `
IMPORTANT: Previous attempt generated ${retryReason} plan. You MUST generate executable search_replace or create_file actions.
Do NOT generate note steps. Produce actual code changes with search and replace patterns.${noteGuidance}${coverageGuidance}
If you cannot produce executable actions, explain why in the error field.
`;

    return runPlanTool({
      projectId,
      task: normalizedTask ? normalizedTask + enhancedRetryContext : null,
      problemId: normalizedProblem,
      label: label || finalSlug,
      autoEmbed: false,
      _noteOnlyRetryCount: retryCount + 1,
      _enhancedContext: enhancedRetryContext,
    });
  }

  // After max retries, emit telemetry and return refinement_required instead of passing
  // a note-containing plan to exec (which would reject it with McpError anyway).
  if ((!hasExecutableSteps || hasNoteSteps) && retryCount >= MAX_NOTE_ONLY_RETRIES && !skipLlm) {
    const exhaustedReason = !hasExecutableSteps ? "note_only" : "has_note_steps";
    console.error(`[rks.plan] LLM refused to generate clean plan (${exhaustedReason}) after ${MAX_NOTE_ONLY_RETRIES} retries`);

    // PART B (backlog.fix.planner-note-step-degeneracy): when the exhausted plan is only
    // note-steps AND an op:create target remains uncovered, this is a STRUCTURAL failure —
    // refine/decompose/analyze cannot help (proven deterministic). Attach a LOUD,
    // machine-readable discriminator (failureClass:"structural") naming the uncovered create
    // target(s), ADDITIVELY on top of the still-valid pinned fields (status/reason/noteSteps/
    // rejectionReasons) so the outer refine→plan loop can short-circuit.
    const exhaustedCreateStepPaths = new Set((combinedSteps || []).filter(s => s?.action === "create_file").map(s => s.path).filter(Boolean));
    const exhaustedUncoveredCreates = Array.from(frontmatterCreateFiles || []).filter(p => !exhaustedCreateStepPaths.has(p));
    const structural = (hasNoteSteps && exhaustedUncoveredCreates.length > 0)
      ? buildStructuralFailure(exhaustedUncoveredCreates)
      : null;
    if (structural) {
      console.error(`[rks.plan] STRUCTURAL plan degeneracy: ${structural.message}`);
    }

    // Emit telemetry for max retries exhausted
    try {
      const collector = getTelemetryCollector();
      collector.emit("plan.retry.exhausted", projectId, {
        attempts: retryCount,
        slug: finalSlug,
        ...(structural ? { failureClass: structural.failureClass, uncoveredCreateTargets: structural.uncoveredCreateTargets } : {}),
      });
    } catch (e) {
      console.error(`[rks.plan] telemetry emit failed: ${e?.message}`);
    }

    // Return refinement_required — prevents plan reaching exec where it would throw McpError
    return {
      ok: false,
      status: "refinement_required",
      reason: exhaustedReason,
      noteSteps: combinedSteps.filter(s => s?.action === "note").map(s => s.path || s.title || "unknown"),
      rejectionReasons,
      ...(structural ? {
        failureClass: structural.failureClass,
        uncoveredCreateTargets: structural.uncoveredCreateTargets,
        refinable: structural.refinable,
        message: structural.message,
      } : {}),
    };
  }

  // Acceptance Criteria Matching: validate plan coverage
  let acCoverage = null;
  try {
    // Count acceptance criteria from story (- [ ] or - [x] patterns)
    const acPattern = /- \[[ x]\]/g;
    const storyContent = problemNote?.content || planningText || "";
    const acMatches = storyContent.match(acPattern) || [];
    const acCount = acMatches.length;

    // Count executable steps (non-note actions)
    const executableSteps = combinedSteps.filter(s => s.action && s.action !== "note");
    const execCount = executableSteps.length;

    // Calculate coverage ratio
    const ratio = acCount > 0 ? execCount / acCount : 1;
    const isSuspicious = acCount > 0 && ratio < 0.5;

    acCoverage = {
      acceptanceCriteriaCount: acCount,
      executableStepCount: execCount,
      ratio: Math.round(ratio * 100) / 100,
      isSuspicious,
    };

    // Emit telemetry for AC coverage
    const collector = getTelemetryCollector();
    collector.emit("plan.ac.coverage", projectId, {
      ...acCoverage,
      slug: finalSlug,
    });

    // Log warning if suspicious
    if (isSuspicious) {
      console.error(`[planner] WARNING: Low AC coverage - ${acCount} acceptance criteria but only ${execCount} executable steps (ratio: ${ratio.toFixed(2)})`);
    }
  } catch (e) {
    console.error(`[planner] AC coverage check failed: ${e?.message}`);
  }

  // Phase 4: Persist and finalize (extracted to planner-persistence.mjs)
  const guardrailPlan = enforceGuardrail("rks.plan", {
    projectRoot,
    slug: normalizedLabel || finalSlug,
  });

  // Finalize-time op:create coverage diagnostic (backlog.fix.planner-drops-create-file-steps):
  // surface any op:create target the LLM path still failed to cover. The hard re-plan trigger is
  // reviewPlan's target-coverage check in persistAndFinalize; this is the loud planner-side notice.
  const finalCreateStepPaths = new Set((finalSteps || []).filter(s => s.action === 'create_file').map(s => s.path).filter(Boolean));
  const stillUncoveredCreates = Array.from(frontmatterCreateFiles || []).filter(p => !finalCreateStepPaths.has(p));
  if (stillUncoveredCreates.length) {
    console.error(`[planner] WARNING: ${stillUncoveredCreates.length} op:create target(s) uncovered after planning — reviewPlan will block this plan:`, stillUncoveredCreates);
  }

  const plan = {
    projectId,
    task: normalizedTask,
    problemId: normalizedProblem,
    problemPath: problemNote?.path || null,
    acCoverage,
    ragContextSummary: {
      notesHitCount: ragContext.notes.length,
      codeHitCount: ragContext.code.length,
      kgHitCount: ragContext.kg.length,
    },
    ragContextPreview: {
      notes: ragContext.notes.slice(0, 3).map((item) => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
      code: ragContext.code.slice(0, 3).map((item) => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
      kg: ragContext.kg.slice(0, 3).map((item) => ({ path: item.path, title: item.title, snippet: truncateText(item.text) })),
    },
    planSummary,
    guardrail: guardrailPlan?.scenario ? { id: guardrailPlan.scenario.id } : null,
    slug: finalSlug,
    generatedAt: new Date().toISOString(),
    codemapPath: codemap.path,
    status: effectivePlanStatus,
    steps: finalSteps,
    ...(srValidationErrors.length > 0 ? { validationErrors: srValidationErrors } : {}),
  };

  const planResult = await persistAndFinalize({
    plan, planStatus: effectivePlanStatus, projectRoot, projectId, normalizedProblem, normalizedTask,
    normalizedLabel, finalSlug, runFolder, planningText, storyMeta,
    frontmatterTargets, frontmatterCreateFiles, autoEmbedded, taskModeSuggestion, combinedSteps,
  });
  try {
    const collector = getTelemetryCollector();
    if (planResult.ok) {
      collector.emit("plan.complete", projectId, { problemId: normalizedProblem, slug: finalSlug, steps: planResult.steps, durationMs: Date.now() - planStartMs });
    } else {
      collector.emit("plan.failed", projectId, { problemId: normalizedProblem, slug: finalSlug, reason: planResult.status || "quality_failed", durationMs: Date.now() - planStartMs });
    }
  } catch (e) { /* telemetry is best-effort */ }
  return planResult;
}

/**
 * Gate for the deterministic LLM-bypassing early-exit. Bypass the LLM only when every op:edit
 * target is covered by @@SEARCH blocks AND there are zero uncovered op:create targets —
 * otherwise the step-only early-exit would silently drop the creates.
 * See backlog.fix.planner-drops-create-file-steps.
 */
export function shouldEarlyExitToSteps(allCovered, earlyExitStepCount, uncoveredCreateCount) {
  return Boolean(allCovered) && earlyExitStepCount > 0 && uncoveredCreateCount === 0;
}

/**
 * Check whether a decomposed child story has complete test coverage for its scope.
 * Applies only to child stories (frontmatter has a `parent` field).
 * Non-child stories return ok: true immediately (gate is scoped to decomposed children only).
 *
 * Called after exec to detect deferred test debt before a child is shipped.
 * Reuses analyzeTestQuality from test-static-analysis.mjs — no duplicate logic.
 *
 * @param {string} projectRoot
 * @param {object} story - Parsed frontmatter of the story being checked
 * @returns {{ ok: boolean, error?: string, message?: string, deferredFiles?: string[] }}
 */
export async function checkDecomposedChildTestCoverage(projectRoot, story) {
  // Only applies to child stories
  if (!story || !story.parent) {
    return { ok: true };
  }

  const testRequirements = story.testRequirements;
  const targetFiles = Array.isArray(story.targetFiles)
    ? story.targetFiles.map(f => (typeof f === 'string' ? f : f.path)).filter(Boolean)
    : [];

  // Child story must have testRequirements defined and non-empty
  if (!Array.isArray(testRequirements) || testRequirements.length === 0) {
    return {
      ok: false,
      error: 'deferred_test_coverage',
      message: `Child story '${story.id || 'unknown'}' has no testRequirements. ` +
        `Each decomposed child must carry complete test coverage for what it implements. ` +
        `Add testRequirements before shipping — do not defer to a sibling.`,
      deferredFiles: targetFiles,
    };
  }

  // Use existing test-static-analysis on any test files in targetFiles
  const testFiles = targetFiles.filter(f => /\.(test|spec)\.(mjs|js|ts)$/.test(f));
  if (testFiles.length > 0 && !process.env.RKS_SKIP_STATIC_ANALYSIS) {
    try {
      const { analyzeTestQuality } = await import('./test-static-analysis.mjs');
      const staticResult = analyzeTestQuality(projectRoot, testFiles);
      if (!staticResult.ok) {
        return {
          ok: false,
          error: 'deferred_test_coverage',
          message: `Child story '${story.id || 'unknown'}' has test files with insufficient assertions: ` +
            staticResult.issues.map(i => i.file + ': ' + i.issue).join('; ') +
            '. Each decomposed child must ship with complete test coverage — no deferred test debt.',
          deferredFiles: testFiles,
        };
      }
    } catch { /* best-effort — don't block on import failure */ }
  }

  return { ok: true };
}

// Re-export extracted functions for backward compatibility
export {
  truncateText, extractSectionLines, detectFileMetadata,
  guessFilePath, buildContentForPath, parseListAndTables, isParserWork,
  isTestWork, isDocWork, summarizeProblemNote, readSnippet, extractSnippet,
  readSnippetForTarget, normalizeRagPath, readPackageScripts, formatScriptsForPrompt,
  getCodemapPath, getAnalysisPath, readCodemap, readAnalysis,
} from "./planner-prompts.mjs";
export { MAX_SNIPPET_LINES } from "./planner-utils.mjs";
export { classifyPlanStatus, runsRoot } from "./planner-prompts.mjs";
export { findLatestRunDir } from "../utils/git.mjs";

export {
  validateStep,
  buildNoteDrivenSteps,
  buildCodemap,
  runAnalyzeTool,
  runPlanTool,
};
