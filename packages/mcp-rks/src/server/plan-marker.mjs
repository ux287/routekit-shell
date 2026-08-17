/**
 * Plan-worker completion marker.
 *
 * EXTRACTED ON PURPOSE. `bin/plan-worker.mjs` cannot be imported by a test — it runs
 * argv-driven code at module top level and calls process.exit(). The only prior coverage
 * was a hand-written SIMULATION in a spec file that no vitest tier collects, and that
 * simulation had already drifted from the code it claimed to mirror (its own header cited
 * "plan-worker.mjs lines 105-118" for code that had moved to :122-137). A re-implementation
 * that drifts silently is worse than no test: it stays green while the real path breaks.
 *
 * The worker now calls THIS, and the test imports THIS.
 */

/** Fields copied from a structured failure so plan_review can relay them to the Governor. */
const FAILURE_FIELDS = [
  "error",
  "errors",
  "issues",
  "warnings",
  "hint",
  "workflow",
  "status",
  "reason",
  "suggestions",
];

/**
 * Build the marker update the worker writes when a plan run finishes.
 *
 * @param {object} res result from runPlanTool
 * @param {{now?: number}} [opts]
 * @returns {object} marker update
 */
export function buildMarkerUpdate(res, opts = {}) {
  const markerUpdate = {
    done: true,
    ok: res?.ok !== false,
    completedAt: opts.now ?? Date.now(),
  };

  if (res?.ok === false) {
    for (const field of FAILURE_FIELDS) {
      if (res[field] !== undefined && res[field] !== null) markerUpdate[field] = res[field];
    }
  }

  // Carried on BOTH the success and failure paths. The parent's durability net keys on
  // it to decide whether it still has to land `arch-approved → executing` itself, so it
  // must survive even when the plan itself succeeded.
  if (res?.phaseWrite) markerUpdate.phaseWrite = res.phaseWrite;
  if (res?.problemId) markerUpdate.problemId = res.problemId;

  return markerUpdate;
}
