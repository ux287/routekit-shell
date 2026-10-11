/**
 * Durable `arch-approved → executing` transition.
 *
 * WHY THIS IS ITS OWN MODULE. `rks_plan` runs its planner in a DETACHED worker
 * (`spawn(..., { detached: true, stdio: ['ignore','ignore','ignore'] })`), so a
 * phase write that fails there is invisible: the worker has no writable stderr and
 * the parent returns the poll result regardless. The parent therefore needs its own
 * guaranteed advance on poll-completion — and that guarantee has to be CALLABLE by a
 * test, which means it cannot live inline inside server.mjs (4,250 LOC, not a pure
 * module: `tests/integration/plan-review-poll-hint.test.mjs` and
 * `tests/unit/rks-plan-not-ready-short-circuit.test.mjs` both say so and fall back to
 * source introspection). A grep proves a symbol is mentioned; it cannot prove a phase
 * reached disk — and reaching disk is the entire question here.
 *
 * Both the worker and the parent call this. It is idempotent.
 */

import { resolveNotesDir, readNote, updateField } from "../dendron.mjs";
import { advancePhase } from "../workflow/auto-phase.mjs";

/**
 * Decide what exec_start should do from a story's CURRENT phase.
 *
 * Moved here from planner-persistence.mjs (which now re-exports it, so existing
 * importers and their tests are unaffected) because ensureExecStartPhase needs it
 * and importing it back from planner-persistence would create a cycle.
 *
 * @param {string|null|undefined} currentPhase
 * @returns {{reset: boolean, advance: boolean, reject?: boolean}}
 */
export function decideExecStartAction(currentPhase) {
  if (currentPhase == null) return { reset: false, advance: true };
  if (currentPhase === "arch-approved") return { reset: false, advance: true };
  if (["planned", "executing", "executed"].includes(currentPhase)) return { reset: true, advance: true };
  if (["released", "integrated"].includes(currentPhase)) return { reset: false, advance: false, reject: true };
  return { reset: false, advance: false };
}

/**
 * Advance a story to `executing` and VERIFY the write landed on disk.
 *
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {string} args.problemId
 * @param {string} [args.projectId]
 * @param {string} [args.notesDir]
 * @param {boolean} [args.allowNoopWhenExecuting]
 *   Parent-side net passes true: if the worker already landed the transition, a second
 *   call is a no-op success, not a re-run. The worker passes false so a BARE re-plan
 *   still resets and re-lands (P0-3 idempotency).
 * @returns {Promise<{ok: boolean, attempted: boolean, from: string|null, to: string,
 *   verified?: boolean, alreadyThere?: boolean, rejected?: boolean, skipped?: string,
 *   observed?: string|null, error?: string}>}
 */
export async function ensureExecStartPhase({
  projectRoot,
  problemId,
  projectId,
  notesDir,
  allowNoopWhenExecuting = false,
}) {
  const dir = notesDir || resolveNotesDir(projectRoot);

  let from = null;
  try {
    from = readNote(dir, problemId)?.phase ?? null;
  } catch (e) {
    // NOT swallowed. A read failure used to be logged to a stderr nobody could see,
    // after which the routing continued and reported success.
    return { ok: false, attempted: true, from: null, to: "executing", error: `phase read failed: ${e?.message || e}` };
  }

  if (allowNoopWhenExecuting && from === "executing") {
    return { ok: true, attempted: false, from, to: "executing", alreadyThere: true };
  }

  const decision = decideExecStartAction(from);

  if (decision.reject) {
    return { ok: false, attempted: false, from, to: "executing", rejected: true, error: "phase_immutable" };
  }
  if (!decision.advance) {
    // Pre-ARCH plannable phase (e.g. 'ready'). Not a failure: the plan is valid and
    // persisted; advancing would bypass the arch gate.
    return { ok: true, attempted: false, from, to: from, skipped: "pre_arch_not_advanced" };
  }

  if (decision.reset) {
    try {
      updateField(dir, problemId, "phase", "arch-approved");
    } catch (e) {
      return { ok: false, attempted: true, from, to: "executing", error: `pre-exec_start reset failed: ${e?.message || e}` };
    }
  }

  let advanceResult;
  try {
    advanceResult = await advancePhase(projectRoot, problemId, "exec_start", projectId);
  } catch (e) {
    return { ok: false, attempted: true, from, to: "executing", error: `advancePhase threw: ${e?.message || e}` };
  }
  if (!advanceResult?.ok) {
    return { ok: false, attempted: true, from, to: "executing", error: advanceResult?.error || "state_transition_failed" };
  }

  // READ BACK FROM DISK. Trusting advanceResult.ok would reproduce, inside the fix,
  // the exact bug the fix exists for: a success report with nothing written.
  let observed = null;
  try {
    observed = readNote(dir, problemId)?.phase ?? null;
  } catch (e) {
    return { ok: false, attempted: true, from, to: "executing", error: `phase read-back failed: ${e?.message || e}` };
  }
  if (observed !== "executing") {
    return { ok: false, attempted: true, from, to: "executing", observed, error: "phase_write_not_observed" };
  }

  return { ok: true, attempted: true, from, to: "executing", verified: true };
}
