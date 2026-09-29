/**
 * Exec State Persistence
 *
 * Persists exec workflow state to enable:
 * - Detection of failed/incomplete runs
 * - Resume from last successful step
 * - Clean abort with proper cleanup
 */

import fs from "fs";
import path from "path";

// Exec state phases
export const ExecPhase = {
  IDLE: "idle",
  CREATING_BRANCH: "creatingBranch",
  APPLYING_STEPS: "applyingSteps",
  RUNNING_TESTS: "runningTests",
  COMMITTING: "committing",
  COMPLETE: "complete",
  FAILED: "failed",
};

/**
 * Get the exec-state.json path for a run
 */
export function getExecStatePath(runDir) {
  return path.join(runDir, "exec-state.json");
}

/**
 * Load exec state from a run directory
 * @param {string} runDir - The run directory path
 * @returns {object|null} The exec state or null if not found
 */
export function loadExecState(runDir) {
  const statePath = getExecStatePath(runDir);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (e) {
    console.error(`[exec-state] Failed to load state from ${statePath}: ${e.message}`);
    return null;
  }
}

/**
 * Save exec state to a run directory
 * @param {string} runDir - The run directory path
 * @param {object} state - The state to save
 */
export function saveExecState(runDir, state) {
  const statePath = getExecStatePath(runDir);
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error(`[exec-state] Failed to save state to ${statePath}: ${e.message}`);
  }
}

/**
 * Initialize exec state for a new run
 * @param {object} options - Run options
 * @returns {object} Initial exec state
 */
export function initExecState({ runId, storyId, totalSteps, branchName }) {
  return {
    runId,
    storyId: storyId || null,
    currentPhase: ExecPhase.IDLE,
    stepIndex: 0,
    totalSteps: totalSteps || 0,
    completedSteps: [],
    failedAt: null,
    branchName: branchName || null,
    canResume: false,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update exec state to a new phase
 * @param {string} runDir - The run directory
 * @param {string} phase - The new phase
 * @param {object} extra - Additional fields to update
 */
export function updateExecPhase(runDir, phase, extra = {}) {
  const state = loadExecState(runDir) || {};
  state.currentPhase = phase;
  Object.assign(state, extra);

  // Set canResume based on phase
  state.canResume = phase === ExecPhase.APPLYING_STEPS && state.completedSteps?.length > 0;

  saveExecState(runDir, state);
  return state;
}

/**
 * Mark a step as completed
 * @param {string} runDir - The run directory
 * @param {number} stepIndex - The step index (0-based)
 * @param {string} stepId - Identifier for the step
 */
export function markStepCompleted(runDir, stepIndex, stepId) {
  const state = loadExecState(runDir) || {};
  state.completedSteps = state.completedSteps || [];
  if (!state.completedSteps.includes(stepId)) {
    state.completedSteps.push(stepId);
  }
  state.stepIndex = stepIndex + 1;
  state.canResume = true;
  saveExecState(runDir, state);
  return state;
}

/**
 * Mark exec as failed
 * @param {string} runDir - The run directory
 * @param {string} stepId - The step that failed (if applicable)
 * @param {string} error - Error message
 */
export function markExecFailed(runDir, stepId, error) {
  const state = loadExecState(runDir) || {};
  state.currentPhase = ExecPhase.FAILED;
  state.failedAt = {
    step: stepId || null,
    error: error || "Unknown error",
    timestamp: new Date().toISOString(),
  };
  state.canResume = state.completedSteps?.length > 0;
  saveExecState(runDir, state);
  return state;
}

/**
 * Mark exec as complete
 * @param {string} runDir - The run directory
 * @param {object} result - Final result info
 */
export function markExecComplete(runDir, result = {}) {
  const state = loadExecState(runDir) || {};
  state.currentPhase = ExecPhase.COMPLETE;
  state.canResume = false;
  state.completedAt = new Date().toISOString();
  if (result.commitId) state.commitId = result.commitId;
  if (result.testsPassed !== undefined) state.testsPassed = result.testsPassed;
  saveExecState(runDir, state);
  return state;
}

/**
 * Find incomplete exec runs in a project
 * @param {string} projectRoot - Project root directory
 * @returns {Array<object>} List of incomplete runs with their state
 */
export function findIncompleteRuns(projectRoot) {
  const runsDir = path.join(projectRoot, ".rks", "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const incomplete = [];
  try {
    const dirs = fs.readdirSync(runsDir).filter(d => {
      const fullPath = path.join(runsDir, d);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const dir of dirs) {
      const runDir = path.join(runsDir, dir);
      const state = loadExecState(runDir);

      if (state && state.currentPhase !== ExecPhase.COMPLETE && state.currentPhase !== ExecPhase.IDLE && state.currentPhase !== ExecPhase.FAILED && state.currentPhase !== "aborted") {
        incomplete.push({
          runDir,
          runId: dir,
          state,
        });
      }
    }
  } catch (e) {
    console.error(`[exec-state] Failed to scan runs directory: ${e.message}`);
  }

  // Sort by most recent first
  incomplete.sort((a, b) => {
    const aTime = new Date(a.state.updatedAt || a.state.startedAt || 0).getTime();
    const bTime = new Date(b.state.updatedAt || b.state.startedAt || 0).getTime();
    return bTime - aTime;
  });

  return incomplete;
}

/**
 * Get the most recent incomplete run
 * @param {string} projectRoot - Project root directory
 * @returns {object|null} The most recent incomplete run or null
 */
export function getMostRecentIncompleteRun(projectRoot) {
  const incomplete = findIncompleteRuns(projectRoot);
  return incomplete.length > 0 ? incomplete[0] : null;
}

/**
 * Clean up an exec run (for abort)
 * @param {string} runDir - The run directory
 * @param {string} projectRoot - Project root directory
 * @returns {object} Cleanup result
 */
export function cleanupExecRun(runDir, projectRoot) {
  const state = loadExecState(runDir);
  if (!state) {
    return { ok: false, error: "No exec state found" };
  }

  const result = {
    ok: true,
    runId: state.runId,
    branchCleaned: false,
    stateCleaned: false,
  };

  // Clean up branch if one was created
  if (state.branchName) {
    try {
      const { spawnSync } = require("child_process");
      // Check if branch exists
      const checkResult = spawnSync("git", ["branch", "--list", state.branchName], {
        cwd: projectRoot,
        encoding: "utf8",
      });

      if (checkResult.stdout.trim()) {
        // Switch to base branch first
        spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, encoding: "utf8" });
        // Delete the feature branch
        const deleteResult = spawnSync("git", ["branch", "-D", state.branchName], {
          cwd: projectRoot,
          encoding: "utf8",
        });
        result.branchCleaned = deleteResult.status === 0;
        if (!result.branchCleaned) {
          result.branchError = deleteResult.stderr?.trim();
        }
      }
    } catch (e) {
      result.branchError = e.message;
    }
  }

  // Mark state as aborted
  state.currentPhase = "aborted";
  state.abortedAt = new Date().toISOString();
  state.canResume = false;
  saveExecState(runDir, state);
  result.stateCleaned = true;

  return result;
}

/**
 * Check if an exec can be resumed
 * @param {object} state - The exec state
 * @returns {object} Resume info
 */
export function getResumeInfo(state) {
  if (!state) {
    return { canResume: false, reason: "No state found" };
  }

  if (state.currentPhase === ExecPhase.COMPLETE) {
    return { canResume: false, reason: "Run already complete" };
  }

  if (state.currentPhase === "aborted") {
    return { canResume: false, reason: "Run was aborted" };
  }

  if (!state.completedSteps || state.completedSteps.length === 0) {
    return { canResume: false, reason: "No completed steps to resume from" };
  }

  return {
    canResume: true,
    phase: state.currentPhase,
    completedSteps: state.completedSteps.length,
    totalSteps: state.totalSteps,
    nextStepIndex: state.stepIndex,
    branchName: state.branchName,
  };
}
