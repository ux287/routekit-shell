/**
 * Planner Preflight Module
 *
 * Contains pre-flight checks for the planning workflow:
 * - Branch validation
 * - Sync status with origin
 * - Working tree cleanliness (with auto-commit for notes)
 * - RAG index freshness (with auto-embed)
 * - Story readiness gate
 * - Phase enforcement
 */

import fs from "fs";
import path from "path";
import { getCurrentBranch, isWorkingTreeClean, getUncommittedFiles, commitFiles, getStagingSyncStatus, isRuntimeArtifact, RKS_RUNTIME_ARTIFACT_PATTERNS } from "../utils/git.mjs";
import { isRagIndexFresh } from "./planner-utils.mjs";
import { runRagEmbed } from "../rag/tools.mjs";
import { runRefineTool } from "./refine.mjs";
import { resolveNotesDir } from "../dendron.mjs";
import { getTelemetryCollector } from "./telemetry/index.mjs";

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
 * Run pre-flight checks before planning
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {Object} options.context - Project context with projectJson
 * @param {boolean} options.autoEmbed - Whether to auto-embed if RAG is stale
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} { ok: boolean, error?: string, hint?: string, autoEmbedded?: boolean }
 */
export async function runPreflightChecks({ projectRoot, context, autoEmbed = true, projectId = null }) {
  let autoEmbedded = false;

  // Auto-commit dirty note files BEFORE branch/sync checks so planner reads latest content.
  // This runs early because branch-mismatch or sync errors should not skip note commits.
  if (!isWorkingTreeClean(projectRoot, { filterRks: false, throwOnError: false })) {
    const dirtyFiles = getUncommittedFiles(projectRoot, { filterRks: false });
    const noteFiles = dirtyFiles.filter(f => f.startsWith("notes/") && f.endsWith(".md"));
    const nonNoteFiles = dirtyFiles.filter(f => !f.startsWith("notes/") || !f.endsWith(".md"));

    // Filter out known RKS/Dendron runtime artifacts from non-note files
    const blockingFiles = nonNoteFiles.filter(f => !isRuntimeArtifact(f));
    const artifactCount = nonNoteFiles.length - blockingFiles.length;

    if (noteFiles.length > 0) {
      console.error(`[preflight] Auto-committing ${noteFiles.length} note file(s) before planning: ${noteFiles.join(", ")}`);
      if (nonNoteFiles.length > 0) {
        console.error(`[preflight] ${nonNoteFiles.length} non-note dirty file(s): ${artifactCount} runtime artifact(s) filtered, ${blockingFiles.length} blocking`);
      }
      try {
        commitFiles(projectRoot, noteFiles, "docs(backlog): update notes for planning");
        emitTelemetry("preflight.worktree.auto_commit", projectId, {
          fileCount: noteFiles.length,
          noteFiles,
          skippedNonNotes: blockingFiles.length,
          filteredArtifacts: artifactCount,
        });
        console.error("[preflight] Auto-commit completed");
      } catch (commitErr) {
        console.error(`[preflight] Auto-commit failed: ${commitErr?.message}`);
        emitTelemetry("preflight.worktree.commit_failed", projectId, {
          error: commitErr?.message,
          noteFiles,
        });
        return {
          ok: false,
          error: "Failed to auto-commit notes",
          hint: commitErr.message || "Commit notes manually",
        };
      }
    } else {
      console.error(`[preflight] No note files to auto-commit. ${dirtyFiles.length} dirty file(s) are all non-notes: ${dirtyFiles.slice(0, 5).join(", ")}${dirtyFiles.length > 5 ? " ..." : ""}`);
    }

    // Re-check: if genuine non-note, non-artifact files remain dirty, block planning
    if (blockingFiles.length > 0) {
      emitTelemetry("preflight.worktree.dirty", projectId, {
        dirtyFileCount: blockingFiles.length,
        hasNonNotes: true,
        nonNoteFiles: blockingFiles.slice(0, 10),
        filteredArtifacts: artifactCount,
      });
      return {
        ok: false,
        error: `Working tree has ${blockingFiles.length} uncommitted non-note file(s)`,
        hint: "Commit or stash changes before planning",
        dirtyFiles: blockingFiles.slice(0, 10),
      };
    }
  } else {
    console.error("[preflight] Working tree is clean — no auto-commit needed");
  }

  // Check branch
  const baseBranch = context.projectJson?.baseBranch || "staging";
  const currentBranch = getCurrentBranch(projectRoot, { throwOnError: false });
  if (currentBranch !== baseBranch) {
    emitTelemetry("preflight.branch.failed", projectId, {
      baseBranch,
      currentBranch,
    });
    return {
      ok: false,
      error: `Plan from base branch '${baseBranch}', not '${currentBranch}'`,
      hint: `git checkout ${baseBranch}`,
    };
  }

  // Check sync status with origin
  const syncStatus = getStagingSyncStatus(projectRoot);
  if (syncStatus.behindBy > 0) {
    emitTelemetry("preflight.sync.failed", projectId, {
      behindBy: syncStatus.behindBy,
      aheadBy: syncStatus.aheadBy,
      diverged: syncStatus.diverged,
    });
    return {
      ok: false,
      error: `Branch is ${syncStatus.behindBy} commit(s) behind origin`,
      hint: "Run rks_sync_staging first to sync with origin",
      behindBy: syncStatus.behindBy,
      aheadBy: syncStatus.aheadBy,
      diverged: syncStatus.diverged,
    };
  }

  // Check RAG index freshness
  const notesDir = path.join(projectRoot, "notes");
  if (!isRagIndexFresh(projectRoot, notesDir)) {
    if (autoEmbed) {
      console.error("[preflight] RAG index stale - auto-embedding notes...");
      emitTelemetry("preflight.rag.auto_embed_start", projectId, {});
      try {
        await runRagEmbed(projectRoot, { glob: "notes/**/*.md" });
        autoEmbedded = true;
        emitTelemetry("preflight.rag.auto_embed_complete", projectId, {});
        console.error("[preflight] auto-embed completed");
      } catch (embedErr) {
        console.error(`[preflight] auto-embed failed: ${embedErr?.message}`);
        emitTelemetry("preflight.rag.auto_embed_failed", projectId, {
          error: embedErr?.message,
        });
        return {
          ok: false,
          error: "RAG index is stale and auto-embed failed",
          hint: "Run rag_embed manually to refresh context",
        };
      }
    } else {
      emitTelemetry("preflight.rag.stale", projectId, {
        autoEmbed: false,
      });
      return {
        ok: false,
        error: "RAG index is stale - notes modified since last embed",
        hint: "Run rag_embed to refresh context",
      };
    }
  }

  emitTelemetry("preflight.checks.passed", projectId, { autoEmbedded });
  return { ok: true, autoEmbedded };
}

/**
 * Run story readiness gate
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {string} options.problemId - Problem/story ID
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} { ok: boolean, error?: string, readinessIssues?: Array, hint?: string }
 */
export async function runReadinessGate({ projectRoot, problemId, projectId = null }) {
  try {
    const refineResult = await runRefineTool({
      projectRoot,
      problemId,
      trigger: "design",
      context: null,
      projectId,
    });

    // Block if high-priority issues found (missing targetFiles, etc.)
    const highPriority = refineResult?.suggestions?.filter(s => s.priority === "high") || [];
    if (highPriority.length > 0) {
      console.error(`[preflight] story not ready: ${problemId} - ${highPriority.length} high-priority issues`);
      emitTelemetry("preflight.readiness.failed", projectId, {
        problemId,
        issueCount: highPriority.length,
        issues: highPriority.map(i => i.type || i.message).slice(0, 5),
      });
      return {
        ok: false,
        error: "Story not ready for planning",
        problemId,
        readinessIssues: highPriority,
        hint: "Run rks_refine_apply to fix story, then retry rks.plan",
      };
    }

    emitTelemetry("preflight.readiness.passed", projectId, { problemId });
    return { ok: true };
  } catch (e) {
    console.error(`[preflight] readiness check failed: ${e?.message}`);
    emitTelemetry("preflight.readiness.error", projectId, {
      problemId,
      error: e?.message,
    });
    // Don't block on readiness check failure - let planning proceed
    return { ok: true, warning: e?.message };
  }
}

/**
 * Enforce story phase requirements
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {string} options.problemId - Problem/story ID
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} { ok: boolean, autoPromoted?: boolean, error?: string, hint?: string }
 */
export function enforcePhase({ projectRoot, problemId, projectId = null }) {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);

    if (!fs.existsSync(storyPath)) {
      // Story file doesn't exist - let planning proceed (might be a task, not a story)
      return { ok: true };
    }

    let storyContent = fs.readFileSync(storyPath, "utf8");
    const phaseMatch = storyContent.match(/^phase:\s*["']?(\w+)["']?/m);
    const currentPhase = phaseMatch ? phaseMatch[1] : "draft";
    const allowedPhases = ["ready", "planned", "executed"];

    if (!allowedPhases.includes(currentPhase)) {
      // Auto-promote from draft to ready if we passed readiness checks
      if (currentPhase === "draft") {
        console.error(`[preflight] auto-promoting story from draft to ready: ${problemId}`);
        storyContent = storyContent.replace(/^phase:\s*["']?draft["']?/m, "phase: ready");
        fs.writeFileSync(storyPath, storyContent);
        emitTelemetry("preflight.phase.promoted", projectId, {
          problemId,
          from: "draft",
          to: "ready",
        });
        return { ok: true, autoPromoted: true };
      } else {
        emitTelemetry("preflight.phase.blocked", projectId, {
          problemId,
          currentPhase,
        });
        return {
          ok: false,
          error: "Story not ready for planning",
          problemId,
          currentPhase,
          hint: "Update story phase to 'ready' before planning",
        };
      }
    }

    emitTelemetry("preflight.phase.passed", projectId, {
      problemId,
      currentPhase,
    });
    return { ok: true, currentPhase };
  } catch (e) {
    console.error(`[preflight] phase check failed: ${e?.message}`);
    emitTelemetry("preflight.phase.error", projectId, {
      problemId,
      error: e?.message,
    });
    // Don't block on phase check failure
    return { ok: true, warning: e?.message };
  }
}

/**
 * Validate that the project's .gitignore contains essential RKS/Dendron entries.
 * Non-blocking — returns a warning with missing entries, never fails.
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {string} options.projectId - Project ID for telemetry
 * @returns {Object} { ok: true, missingEntries?: string[], warning?: string }
 */
export function validateGitignore({ projectRoot, projectId = null }) {
  try {
    const gitignorePath = path.join(projectRoot, ".gitignore");
    let content = "";
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, "utf8");
    }

    // Check which essential patterns are missing
    const missing = RKS_RUNTIME_ARTIFACT_PATTERNS.filter(pattern => {
      // Normalize: strip trailing slash for directory patterns
      const normalized = pattern.replace(/\/$/, "");
      // Check if any line in .gitignore covers this pattern
      return !content.split("\n").some(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return false;
        const normalizedLine = trimmed.replace(/\/$/, "");
        return normalizedLine === normalized || normalizedLine === pattern
          || pattern.startsWith(normalizedLine + "/");
      });
    });

    if (missing.length > 0) {
      const warning = `Project .gitignore is missing ${missing.length} RKS/Dendron entries: ${missing.join(", ")}. ` +
        `Add these to prevent runtime artifacts from blocking planning.`;
      console.error(`[preflight] WARNING: ${warning}`);
      emitTelemetry("preflight.gitignore.missing_entries", projectId, {
        missingCount: missing.length,
        missingEntries: missing,
      });
      return { ok: true, missingEntries: missing, warning };
    }

    return { ok: true };
  } catch (e) {
    // Never block on gitignore check failure
    return { ok: true, warning: e?.message };
  }
}

/**
 * Run all preflight checks for a planning operation
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {Object} options.context - Project context
 * @param {string} options.problemId - Problem/story ID (optional)
 * @param {string} options.projectId - Project ID for telemetry
 * @param {boolean} options.autoEmbed - Whether to auto-embed
 * @param {boolean} options.skipPreflight - Skip basic preflight checks
 * @param {boolean} options.skipReadiness - Skip readiness gate
 * @param {boolean} options.skipPhaseCheck - Skip phase enforcement
 * @returns {Object} Combined result of all checks
 */
export async function runAllPreflightChecks({
  projectRoot,
  context,
  problemId,
  projectId = null,
  autoEmbed = true,
  skipPreflight = false,
  skipReadiness = false,
  skipPhaseCheck = false,
}) {
  let autoEmbedded = false;
  let autoPromoted = false;

  emitTelemetry("preflight.all.start", projectId, {
    problemId,
    skipPreflight,
    skipReadiness,
    skipPhaseCheck,
  });

  // Basic preflight checks
  if (!skipPreflight) {
    const preflightResult = await runPreflightChecks({ projectRoot, context, autoEmbed, projectId });
    if (!preflightResult.ok) {
      emitTelemetry("preflight.all.failed", projectId, {
        stage: "preflight",
        error: preflightResult.error,
      });
      return preflightResult;
    }
    autoEmbedded = preflightResult.autoEmbedded || false;
  }

  // Readiness gate
  if (problemId && !skipReadiness) {
    const readinessResult = await runReadinessGate({ projectRoot, problemId, projectId });
    if (!readinessResult.ok) {
      emitTelemetry("preflight.all.failed", projectId, {
        stage: "readiness",
        error: readinessResult.error,
      });
      return readinessResult;
    }
  }

  // Phase enforcement
  if (problemId && !skipPhaseCheck) {
    const phaseResult = enforcePhase({ projectRoot, problemId, projectId });
    if (!phaseResult.ok) {
      emitTelemetry("preflight.all.failed", projectId, {
        stage: "phase",
        error: phaseResult.error,
      });
      return phaseResult;
    }
    autoPromoted = phaseResult.autoPromoted || false;
  }

  // .gitignore validation (non-blocking warning)
  const gitignoreResult = validateGitignore({ projectRoot, projectId });
  const gitignoreWarning = gitignoreResult.warning || null;

  emitTelemetry("preflight.all.passed", projectId, {
    autoEmbedded,
    autoPromoted,
    gitignoreWarning: !!gitignoreWarning,
  });
  return { ok: true, autoEmbedded, autoPromoted, gitignoreWarning };
}

export default {
  runPreflightChecks,
  runReadinessGate,
  enforcePhase,
  validateGitignore,
  runAllPreflightChecks,
};
