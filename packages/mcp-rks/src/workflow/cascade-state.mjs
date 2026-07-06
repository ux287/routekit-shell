/**
 * Cascade State Persistence
 *
 * Tracks phase-level progress across multi-agent cascades
 * (validate → plan → exec → ship → complete). Parallels exec-state.mjs
 * which tracks step-level progress within a single Exec phase.
 *
 * Both files coexist in the same run directory:
 *   .rks/runs/{timestamp}_{slug}/exec-state.json  (step-level)
 *   .rks/runs/{timestamp}_{slug}/cascade.json      (phase-level)
 *
 * Design principle: failed state is progress, not garbage.
 * No automatic rollback — forward recovery (retry/resume) only.
 *
 * @see backlog.agents.cascade-failure-recovery
 */

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// Cascade phase status values
export const CascadeStatus = {
  RUNNING: "running",
  COMPLETE: "complete",
  FAILED: "failed",
  NEEDS_APPROVAL: "needs_approval",
  ABORTED: "aborted",
};

// Known cascade phase names (ordered)
export const CascadePhases = [
  "validate",
  "research",
  "plan",
  "exec",
  "ship",
  "cycle_complete",
];

/**
 * Get the cascade.json path for a run directory
 */
export function getCascadeStatePath(runDir) {
  return path.join(runDir, "cascade.json");
}

/**
 * Create a new cascade run.
 * If runDir is provided, uses it. Otherwise creates a new run directory.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} storyId - Story being executed
 * @param {string} [runDir] - Optional existing run directory to reuse
 * @returns {{ runId: string, runDir: string }} Run identifiers
 */
export function createCascadeRun(projectRoot, storyId, runDir) {
  const runId = randomUUID();

  if (!runDir) {
    const slug = storyId
      ? storyId.replace(/\./g, "-")
      : "cascade";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    runDir = path.join(projectRoot, ".rks", "runs", `${timestamp}_${slug}`);
    fs.mkdirSync(runDir, { recursive: true });
  }

  const state = {
    runId,
    storyId: storyId || null,
    status: CascadeStatus.RUNNING,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phases: [],
    artifacts: {},
    retryFrom: null,
    canResume: false,
  };

  saveCascadeState(runDir, state);
  return { runId, runDir };
}

/**
 * Load cascade state from a run directory
 * @param {string} runDir - The run directory path
 * @returns {object|null} The cascade state or null if not found
 */
export function getCascadeState(runDir) {
  const statePath = getCascadeStatePath(runDir);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    console.error(`[cascade-state] Failed to load state from ${statePath}: ${e.message}`);
    return null;
  }
}

/**
 * Save cascade state to a run directory
 * @param {string} runDir - The run directory path
 * @param {object} state - The state to save
 */
export function saveCascadeState(runDir, state) {
  const statePath = getCascadeStatePath(runDir);
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error(`[cascade-state] Failed to save state to ${statePath}: ${e.message}`);
  }
}

/**
 * Record a completed or failed phase in the cascade.
 *
 * @param {string} runDir - The run directory
 * @param {string} name - Phase name (e.g. "validate", "exec", "ship")
 * @param {object} result - Phase result: { ok, ...data } or { ok: false, error }
 * @returns {object} Updated cascade state
 */
export function recordPhase(runDir, name, result) {
  const state = getCascadeState(runDir);
  if (!state) {
    throw new Error(`[cascade-state] No cascade state found in ${runDir}`);
  }

  const phase = {
    name,
    status: result.ok ? "complete" : "failed",
    startedAt: result.startedAt || new Date().toISOString(),
    completedAt: new Date().toISOString(),
    duration: result.duration || null,
  };

  if (result.ok) {
    phase.result = { ok: true, ...filterResult(result) };
  } else {
    phase.error = result.error || "Unknown error";
    phase.result = { ok: false, error: phase.error };
  }

  state.phases.push(phase);

  // Merge artifacts from successful phases
  if (result.ok && result.data) {
    mergeArtifacts(state.artifacts, result.data);
  } else if (result.ok) {
    mergeArtifacts(state.artifacts, result);
  }

  // Update cascade-level status
  if (!result.ok) {
    state.status = CascadeStatus.FAILED;
    state.retryFrom = name;
    state.canResume = true;
  }

  saveCascadeState(runDir, state);
  return state;
}

/**
 * Mark the cascade as needing user approval before proceeding.
 *
 * @param {string} runDir - The run directory
 * @param {string} phase - Phase requesting approval
 * @param {object} detail - Approval context: { summary, question, options, artifacts }
 * @returns {object} Updated cascade state
 */
export function requestApproval(runDir, phase, detail) {
  const state = getCascadeState(runDir);
  if (!state) {
    throw new Error(`[cascade-state] No cascade state found in ${runDir}`);
  }

  state.status = CascadeStatus.NEEDS_APPROVAL;
  state.retryFrom = phase;
  state.canResume = true;
  state.approval = {
    phase,
    summary: detail.summary || null,
    question: detail.question || `Approve ${phase} phase?`,
    options: detail.options || ["approve", "modify", "abort"],
    requestedAt: new Date().toISOString(),
  };

  if (detail.artifacts) {
    mergeArtifacts(state.artifacts, detail.artifacts);
  }

  saveCascadeState(runDir, state);
  return state;
}

/**
 * Mark the cascade as fully complete.
 *
 * @param {string} runDir - The run directory
 * @param {object} [finalResult] - Optional final result data
 * @returns {object} Updated cascade state
 */
export function markCascadeComplete(runDir, finalResult = {}) {
  const state = getCascadeState(runDir);
  if (!state) {
    throw new Error(`[cascade-state] No cascade state found in ${runDir}`);
  }

  state.status = CascadeStatus.COMPLETE;
  state.completedAt = new Date().toISOString();
  state.canResume = false;
  state.retryFrom = null;

  if (finalResult) {
    mergeArtifacts(state.artifacts, finalResult);
  }

  saveCascadeState(runDir, state);
  return state;
}

/**
 * Find all cascade runs that didn't reach terminal status.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {Array<{ runDir: string, runId: string, state: object }>}
 */
export function findIncompleteCascades(projectRoot) {
  const runsDir = path.join(projectRoot, ".rks", "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const incomplete = [];
  try {
    const dirs = fs.readdirSync(runsDir).filter((d) => {
      const fullPath = path.join(runsDir, d);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const dir of dirs) {
      const runDir = path.join(runsDir, dir);
      const state = getCascadeState(runDir);

      if (
        state &&
        state.status !== CascadeStatus.COMPLETE &&
        state.status !== CascadeStatus.ABORTED
      ) {
        incomplete.push({
          runDir,
          runId: state.runId || dir,
          state,
        });
      }
    }
  } catch (e) {
    console.error(`[cascade-state] Failed to scan runs directory: ${e.message}`);
  }

  // Most recent first
  incomplete.sort((a, b) => {
    const aTime = new Date(a.state.updatedAt || a.state.startedAt || 0).getTime();
    const bTime = new Date(b.state.updatedAt || b.state.startedAt || 0).getTime();
    return bTime - aTime;
  });

  return incomplete;
}

/**
 * Compute resume information from a cascade state.
 *
 * @param {object} state - The cascade state
 * @returns {object} Resume info with completedPhases, retryFrom, artifacts
 */
export function getResumeInfo(state) {
  if (!state) {
    return { canResume: false, reason: "No cascade state found" };
  }

  if (state.status === CascadeStatus.COMPLETE) {
    return { canResume: false, reason: "Cascade already complete" };
  }

  if (state.status === CascadeStatus.ABORTED) {
    return { canResume: false, reason: "Cascade was aborted" };
  }

  const completedPhases = state.phases
    .filter((p) => p.status === "complete")
    .map((p) => p.name);

  if (completedPhases.length === 0 && state.status !== CascadeStatus.NEEDS_APPROVAL) {
    return { canResume: false, reason: "No completed phases to resume from" };
  }

  return {
    canResume: true,
    status: state.status,
    completedPhases,
    retryFrom: state.retryFrom,
    artifacts: state.artifacts,
    storyId: state.storyId,
    approval: state.approval || null,
  };
}

/**
 * Build a structured failure response for the Dispatcher.
 * This is the format the Dispatcher reads to present failures/approvals to the user.
 *
 * @param {object} state - The cascade state
 * @returns {object} Structured response
 */
export function buildDispatcherResponse(state) {
  if (!state) {
    return { ok: false, error: "No cascade state found" };
  }

  const completedPhases = state.phases
    .filter((p) => p.status === "complete")
    .map((p) => p.name);

  const failedPhase = state.phases.find((p) => p.status === "failed");

  if (state.status === CascadeStatus.COMPLETE) {
    return {
      ok: true,
      status: "complete",
      completedPhases,
      artifacts: state.artifacts,
    };
  }

  if (state.status === CascadeStatus.NEEDS_APPROVAL) {
    return {
      ok: true,
      status: "needs_approval",
      phase: state.retryFrom,
      completedPhases,
      artifacts: state.artifacts,
      summary: state.approval?.summary,
      question: state.approval?.question,
      options: state.approval?.options,
    };
  }

  // Failed
  return {
    ok: false,
    status: "failed",
    phase: failedPhase?.name || state.retryFrom,
    completedPhases,
    artifacts: state.artifacts,
    error: failedPhase?.error || "Unknown failure",
    recoverable: state.canResume,
    retryFrom: state.retryFrom,
    hint: buildHint(failedPhase, state),
  };
}

// --- Internal helpers ---

/**
 * Extract artifact-worthy fields from a result, excluding meta fields.
 */
function filterResult(result) {
  const exclude = new Set(["ok", "error", "duration", "startedAt", "telemetryId", "summary"]);
  const filtered = {};
  for (const [k, v] of Object.entries(result)) {
    if (!exclude.has(k) && v !== undefined && v !== null) {
      filtered[k] = v;
    }
  }
  return filtered;
}

/**
 * Merge artifact fields into the cascade artifacts object.
 * Known artifact keys: branch, commitId, prNumber, prUrl, filesChanged, planFile
 */
function mergeArtifacts(artifacts, source) {
  const artifactKeys = [
    "branch", "commitId", "prNumber", "prUrl",
    "filesChanged", "planFile", "merged", "stagingSynced",
  ];
  for (const key of artifactKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      artifacts[key] = source[key];
    }
  }
  // Also merge from nested data object
  if (source.data) {
    for (const key of artifactKeys) {
      if (source.data[key] !== undefined && source.data[key] !== null) {
        artifacts[key] = source.data[key];
      }
    }
  }
}

/**
 * Generate a human-readable hint for failure recovery.
 */
function buildHint(failedPhase, state) {
  if (!failedPhase) return null;

  const phase = failedPhase.name;
  const error = failedPhase.error || "";

  if (phase === "ship" && error.includes("behind")) {
    return "Sync staging with main first, then retry shipping.";
  }
  if (phase === "ship" && error.includes("timeout")) {
    return "Transient network error. Retry shipping — the branch and code are safe.";
  }
  if (phase === "ship" && error.includes("CI")) {
    return "CI checks failed. Review test output, fix issues, then retry.";
  }
  if (phase === "exec") {
    return "Execution failed. Check exec-state.json for step-level checkpoint — may be resumable.";
  }
  if (phase === "validate") {
    return "Story validation failed. Review acceptance criteria and retry.";
  }

  return `${phase} phase failed. Review the error and retry from this phase.`;
}
