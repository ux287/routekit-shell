/**
 * Story lifecycle state machine.
 * Centralizes phase transitions and gate validation.
 *
 * Story 1 (backlog.feat.phase-machine-foundation): GATES are now DERIVED from
 * PHASE_MACHINE.transitions — hand-authored entries removed. canTransition and
 * validateTransition signatures preserved; downstream callers unchanged.
 */
import { TRANSITION_GRAPH, PHASE_MACHINE } from "./phases.mjs";

// Re-export as VALID_TRANSITIONS for backward compatibility
export const VALID_TRANSITIONS = TRANSITION_GRAPH;

/**
 * Derive { 'from→to': [gate, ...] | [] } from PHASE_MACHINE.transitions.
 * Manual transitions are EXCLUDED (they have no operation and no gate context).
 * Every non-manual transition must declare either `gates: [...]` or
 * `gateless: true` — the integrity test suite asserts this invariant. If a
 * transition declares neither, this function throws at module load time so the
 * malformed PHASE_MACHINE cannot ship past tests.
 */
export function deriveGates(machine) {
  const gates = {};
  for (const t of machine.transitions) {
    if (t.manual) continue;
    const hasGates = Array.isArray(t.gates) && t.gates.length > 0;
    const isGateless = t.gateless === true;
    if (!hasGates && !isGateless) {
      throw new Error(
        `phase-machine: transition '${t.name}' (${t.from.join(",")}→${t.to}) ` +
        `must declare either gates:[...] or gateless:true`
      );
    }
    const entries = hasGates ? t.gates : [];
    for (const from of t.from) {
      gates[`${from}→${t.to}`] = entries;
    }
  }
  return gates;
}

// Derived gate map keyed by 'from→to'.
export const GATES = deriveGates(PHASE_MACHINE);

/**
 * Check if a transition is valid (ignoring gates).
 */
export function canTransition(fromPhase, toPhase) {
  return VALID_TRANSITIONS[fromPhase]?.includes(toPhase) ?? false;
}

/**
 * Validate a transition including all gates.
 * @returns {{ valid: boolean, failures?: string[], hints?: string[] }}
 */
export async function validateTransition(story, toPhase, context = {}) {
  const fromPhase = story.phase || "draft";

  if (!canTransition(fromPhase, toPhase)) {
    return {
      valid: false,
      error: `Invalid transition: ${fromPhase} → ${toPhase}`,
      validTransitions: VALID_TRANSITIONS[fromPhase] || [],
    };
  }

  const gateKey = `${fromPhase}→${toPhase}`;
  const gates = GATES[gateKey] || [];
  const failures = [];
  const hints = [];

  for (const gate of gates) {
    const passed = typeof gate.check === "function"
      ? await gate.check(story, context)
      : true;
    if (!passed) {
      failures.push(gate.id);
      hints.push(gate.message);
    }
  }

  return failures.length === 0
    ? { valid: true, transition: `${fromPhase}→${toPhase}` }
    : { valid: false, failures, hints };
}

/**
 * Get valid next phases from current phase.
 */
export function getValidNextPhases(currentPhase) {
  return VALID_TRANSITIONS[currentPhase] || [];
}
