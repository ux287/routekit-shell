/**
 * Auto-Phase Module
 * Automatic phase transitions after successful operations.
 * Uses state-machine.mjs for validation and dendron.mjs for updates.
 *
 * Story 1 (backlog.feat.phase-machine-foundation): with PHASE_MACHINE in place
 * and OPERATION_TRANSITIONS.<op>.from as an array (multi-source), advancePhase
 * delegates from-phase validation entirely to validateTransition(story, expected.to).
 * It does NOT read expected.from directly or duplicate the from-phase check —
 * validateTransition is the single source of truth for transition validation.
 * The integrity test suite pins this delegation by source-grep + mock-throw.
 */
import { validateTransition } from "./state-machine.mjs";
import { resolveNotesDir, updateField, parseFrontmatter } from "../dendron.mjs";
import { ensureTelemetryStorage } from "../server/telemetry/index.mjs";
import { OPERATION_TRANSITIONS, PHASE_MACHINE } from "./phases.mjs";
import fs from "fs";
import path from "path";

/**
 * Resolve a v1 legacy operation name to its v2 equivalent.
 *
 * Behavior contract:
 *   - If `operationName` is a recognized v2 op (key in OPERATION_TRANSITIONS),
 *     return it unchanged.
 *   - Else if `operationName` is in PHASE_MACHINE.legacyAcceptedOperations,
 *     return the v2 mapping.
 *   - Else return null.
 *
 * R1.3e wired this helper into `advancePhase` so any caller passing a v1 op
 * name flows through legacyAcceptedOperations. Today's legacy map values
 * (plan, exec, ship, cycle_complete) are all also OPERATION_TRANSITIONS keys
 * — pass-through is a no-op. The mapping becomes load-bearing in R1.4 when
 * the v1 transition rows are retired from PHASE_MACHINE.transitions.
 */
export function resolveOperation(operationName) {
  if (OPERATION_TRANSITIONS[operationName]) return operationName;
  const legacyMap = PHASE_MACHINE.legacyAcceptedOperations || {};
  if (legacyMap[operationName]) return legacyMap[operationName];
  return null;
}

/**
 * Advance story phase after a successful operation.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {string} problemId - Story/problem identifier
 * @param {string} operation - Operation type: 'plan' | 'exec' | 'ship'
 * @param {string} projectId - Project identifier for telemetry
 * @returns {Promise<{ok: boolean, from?: string, to?: string, error?: string}>}
 */
export async function advancePhase(projectRoot, problemId, operation, projectId = "unknown") {
  const collector = ensureTelemetryStorage(projectRoot);
  // R1.3e: route the caller-supplied op name through resolveOperation so v1 legacy
  // names get translated to their v2 equivalents via PHASE_MACHINE.legacyAcceptedOperations.
  // Today's legacy names are all also OPERATION_TRANSITIONS keys, so this is a no-op
  // pass-through until R1.4 retires the v1 rows.
  const resolvedOperation = resolveOperation(operation);
  if (!resolvedOperation) {
    return { ok: false, error: `Unknown operation: ${operation}` };
  }
  const expected = OPERATION_TRANSITIONS[resolvedOperation];

  try {
    // Load current story phase
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);

    if (!fs.existsSync(storyPath)) {
      // Story might have been moved (e.g., to z_implemented)
      // This is OK for ship operations
      if (operation === "ship") {
        return { ok: true, from: "executed", to: "integrated", note: "Story already moved" };
      }
      return { ok: false, error: `Story not found: ${problemId}` };
    }

    const content = fs.readFileSync(storyPath, "utf8");
    const { data: frontmatter } = parseFrontmatter(content);
    const currentPhase = frontmatter.phase || "draft";

    // Validate transition
    const validation = await validateTransition(
      { phase: currentPhase, ...frontmatter },
      expected.to
    );

    if (!validation.valid) {
      collector.emit("auto_phase.invalid", projectId, {
        problemId,
        operation,
        from: currentPhase,
        to: expected.to,
        error: validation.error
      });
      return {
        ok: false,
        from: currentPhase,
        to: expected.to,
        error: validation.error || `Cannot transition ${currentPhase}→${expected.to}`
      };
    }

    // Update phase
    updateField(notesDir, problemId, "phase", expected.to);

    collector.emit("auto_phase.transition", projectId, {
      problemId,
      operation,
      from: currentPhase,
      to: expected.to
    });

    return { ok: true, from: currentPhase, to: expected.to };
  } catch (error) {
    collector.emit("auto_phase.error", projectId, {
      problemId,
      operation,
      error: error.message
    });
    return { ok: false, error: error.message };
  }
}

/**
 * Reconcile a story stuck at 'executing' up to 'executed' before an on-rail ship.
 *
 * Root cause this addresses: rks_exec is supposed to fire exec_end (executing →
 * executed), but when it doesn't complete the story reaches ship still at 'executing'.
 * The ship path then attempts the single executed → integrated hop, which
 * validateTransition rejects as "Invalid transition: executing → integrated" — the
 * merge succeeds but the phase stays stuck and rks_release never sees the story as
 * releasable (releasedStories: []).
 *
 * This is a CONDITIONAL PRE-STEP: it fires ONLY when the story is at 'executing',
 * delegating the legitimate executing → executed hop to advancePhase('exec_end').
 * A story already at 'executed' (the normal happy path) is a no-op — the caller's
 * subsequent advancePhase(...,'ship') then does the single executed → integrated hop
 * exactly as before. It NEVER reads a transition's .from/expected.from — it delegates
 * entirely to advancePhase, walking only the existing legitimate gateless hops.
 *
 * Exported so the off-rail phase-reconciliation path (guardrails-audit cycle_complete)
 * can reuse the same walk.
 *
 * @returns {Promise<{ok:boolean, reconciled:boolean, from?:string, to?:string, error?:string}>}
 */
export async function reconcileExecutingBeforeShip(projectRoot, problemId, projectId = "unknown") {
  try {
    const notesDir = resolveNotesDir(projectRoot);
    const storyPath = path.join(notesDir, `${problemId}.md`);
    if (!fs.existsSync(storyPath)) {
      // Story already moved (e.g. to z_implemented) — nothing to reconcile; let ship handle it.
      return { ok: true, reconciled: false };
    }
    const content = fs.readFileSync(storyPath, "utf8");
    const { data: frontmatter } = parseFrontmatter(content);
    const currentPhase = frontmatter.phase || "draft";
    if (currentPhase !== "executing") {
      // Happy path (already 'executed') or any other phase — no pre-step needed.
      return { ok: true, reconciled: false, from: currentPhase };
    }
    // Delegate the executing → executed hop to advancePhase('exec_end').
    const result = await advancePhase(projectRoot, problemId, "exec_end", projectId);
    return { ...result, reconciled: result.ok };
  } catch (error) {
    return { ok: false, reconciled: false, error: error.message };
  }
}

/**
 * Get the expected phase transition for an operation.
 * Useful for validation and display purposes.
 */
export function getExpectedTransition(operation) {
  return OPERATION_TRANSITIONS[operation] || null;
}
