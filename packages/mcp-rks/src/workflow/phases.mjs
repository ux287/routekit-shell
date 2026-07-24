/**
 * Single source of truth for story phase definitions.
 *
 * Story 1 (backlog.feat.phase-machine-foundation) introduces the PHASE_MACHINE
 * declarative source. VALID_PHASES, TRANSITION_GRAPH, OPERATION_TRANSITIONS,
 * and PLANNABLE_PHASES are now DERIVED from PHASE_MACHINE — no hand-authored
 * duplicates. Future production-writer migrations follow in Stories 2-9.
 *
 * See notes/canon.phase-state-machine.md for the lifecycle contract.
 */

/**
 * The declarative source-of-truth for the rks phase state machine.
 *
 * Adding a transition? Add an entry to `transitions`. Every non-manual
 * transition MUST declare either a non-empty `gates: [...]` array or
 * `gateless: true`. Manual transitions (`manual: true`) are reverse-edge
 * recovery paths — they contribute edges to the graph but are excluded
 * from operations and gate validation.
 */
export const PHASE_MACHINE = {
  // Order intentionally matches today's VALID_PHASES so the existing
  // order-sensitive phases.spec.mjs assertion at line ~14 continues to pass.
  // R1.1 (backlog.feat.phase-machine-add-executing-phase) inserted `executing`
  // between `arch-approved` and `planned` as the first additive step toward
  // the v2 model per notes/research.2026.06.10.phase-machine-redesign.md §6.5.
  // `executing` represents "work-in-flight": code is being actively written
  // (an off-rail session is open, or a feature branch is being edited).
  // No v1 phases were removed — `planned` and `implemented` remain.
  // R1.2 (backlog.feat.phase-machine-add-committed-phase-and-2branch-ops)
  // inserted `committed` between `executed` and `implemented`. `committed` is
  // the 3-branch state where code has been merged into the local dev trunk
  // (feature branch retired) but is not yet on remote staging. v1 phases
  // `planned` and `implemented` remain — R1.4 retires them after R8 migrates
  // in-flight stories. Per paper v1.3 §6.5.
  // R1.4 (backlog.feat.phase-machine-r1-4-retire-implemented-phase): removed
  // `implemented` from the v2 state set. The v1 implemented phase was a
  // redundant archival flag (the filename prefix backlog.z_implemented.* is
  // the actual archival marker per paper §3). R8 backfilled all in-flight
  // stories before this retirement.
  states: [
    "draft",
    "ready",
    "arch-approved",
    "executing",
    "planned",
    "executed",
    "committed",
    "integrated",
    "released",
    // Terminal retirement phase for a parent story decomposed into children. The planner gate
    // (planner.mjs) excludes it from plan/build (story_decomposed). The decompose handler writes
    // this phase, so it must be in VALID_PHASES or the updateField guard rejects it
    // (was: mcp.tool.failed "Invalid phase 'decomposed'"). See backlog.fix.decompose-invalid-phase-decomposed.
    "decomposed",
  ],
  start: "draft",
  terminal: ["released", "decomposed"],
  transitions: [
    {
      name: "qa",
      from: ["draft"],
      to: "ready",
      gates: [{
        id: "has_target_files",
        message: "Story must have targetFiles defined",
        check: (story) => Array.isArray(story.targetFiles) && story.targetFiles.length > 0,
      }],
    },
    {
      name: "arch",
      from: ["ready"],
      to: "arch-approved",
      gateless: true, // GAP-7 follow-up: gate definition deferred to Story 6
    },
    {
      // Decompose retires a parent into the terminal `decomposed` phase (its children carry the
      // work). gateless:true is REQUIRED — deriveGates throws at module load for any row lacking
      // gates/gateless. See backlog.fix.decompose-invalid-phase-decomposed.
      name: "decompose",
      from: ["ready", "arch-approved"],
      to: "decomposed",
      gateless: true,
    },
    // R1.1 additive: v2 work-in-flight transitions. exec_start enters the
    // `executing` phase (off-rail session opened, or feature branch active);
    // exec_end exits to `executed` (code committed somewhere recoverable).
    // These coexist with v1's plan/exec operations — R1.3 migrates the
    // production writers later. See research.2026.06.10.phase-machine-redesign §6.5.
    {
      name: "exec_start",
      from: ["arch-approved"],
      to: "executing",
      gateless: true, // R1.1: gate definition deferred to a later story
    },
    {
      name: "exec_end",
      from: ["executing"],
      to: "executed",
      gateless: true, // R1.1: gate definition deferred to a later story
    },
    // R1.2 additive: complete the v2 operation graph. 3-branch flow uses
    // commit (local-dev merge) + promote (push to staging). 2-branch flow
    // uses guardrails_off (open session) + guardrails_on.commit (off-rail
    // commit checkpoint) + guardrails_on.merge (staging push). Decision D
    // Option 3 per paper §3.4: 3-branch and 2-branch are SEPARATE transition
    // rows even when they share the same from→to edge (arch-approved→executing,
    // executing→executed, executed→integrated). All gateless, so the GATES
    // map collisions collapse to the same [] value (harmless).
    {
      name: "commit",
      from: ["executed"],
      to: "committed",
      gateless: true, // R1.2: 3-branch local-dev merge; gate deferred
    },
    {
      name: "promote",
      from: ["committed"],
      to: "integrated",
      gateless: true, // R1.2: 3-branch staging push; gate deferred
    },
    {
      name: "guardrails_off",
      from: ["arch-approved"],
      to: "executing",
      gateless: true, // R1.2: 2-branch session-open; Decision D shared edge with exec_start
    },
    {
      name: "guardrails_on.commit",
      from: ["executing"],
      to: "executed",
      gateless: true, // R1.2: 2-branch atomic-shipping commit checkpoint
    },
    {
      name: "guardrails_on.merge",
      from: ["executed"],
      to: "integrated",
      gateless: true, // R1.2: 2-branch atomic-shipping staging push
    },
    {
      // plan.from preserves today's PLANNABLE_PHASES (4 phases supporting re-plan
      // from planned/executed) PLUS the new arch-approved entry per canon design.
      // PLANNABLE_PHASES is preserved as a derived alias of this array below.
      name: "plan",
      from: ["ready", "arch-approved", "planned", "executed"],
      to: "planned",
      gates: [{
        id: "phase_is_plannable",
        message: 'Story phase must be plannable (ready, arch-approved, planned, or executed)',
        check: (story) => ["ready", "arch-approved", "planned", "executed"].includes(story.phase),
      }],
    },
    {
      name: "exec",
      from: ["planned"],
      to: "executed",
      gates: [{
        id: "phase_is_planned",
        message: 'Story phase must be "planned"',
        check: (story) => story.phase === "planned",
      }],
    },
    {
      name: "ship",
      from: ["executed"],
      to: "integrated",
      gateless: true, // GAP-8 follow-up: gate definition deferred to Story 6
    },
    // R1.4: cycle_complete transition row removed. The v1 operation wrote
    // integrated → implemented; in the v2 model `implemented` no longer exists,
    // so the transition row has no target. The cycle-complete agent's status
    // field write (status: "implemented") is preserved (it's a workflow flag,
    // not a phase machine concern). The MCP tool rks_cycle_complete continues
    // to exist as a pure git-cleanup operation (no phase write).
    {
      // R1.3-followup: release.from migrated to ["integrated"]. The v2 model
      // collapses implemented into integrated; see paper §6 Option A.
      // R1.4 removed the now-unreachable implemented state.
      name: "release",
      from: ["integrated"],
      to: "released",
      gateless: true, // GAP-8 follow-up: gate definition deferred to Story 6
    },
    // Reverse edges — manual recovery, no operation. Documented in Story 9 (GAP-10).
    { name: "reset_to_draft", from: ["ready"], to: "draft", manual: true },
    { name: "reset_to_ready", from: ["arch-approved", "planned", "executed"], to: "ready", manual: true },
    // R1.4: reset_to_integrated manual edge removed. It existed only to provide
    // the R8 backfill path for in-flight stories at phase=implemented; with R8
    // shipped and `implemented` retired from states, the edge has no purpose.
  ],

  // R1.3 (backlog.feat.phase-machine-add-legacy-op-aliases-and-migrate-safe-writers):
  // forward alias map from v1 operation names to v2 equivalents. Used by the
  // EXPORTED `resolveOperation` helper in auto-phase.mjs. NOT wired into
  // advancePhase yet — advancePhase continues to look up operation directly in
  // OPERATION_TRANSITIONS, which still has all v1 op names. R1.3e wires
  // resolveOperation in (and migrates rks_plan, which is the cascade-risky one).
  //
  // Each entry maps a v1 op name to its closest v2 equivalent that preserves
  // the v1 phase outcome:
  //   plan           → exec_start          (legacy: planned   | v2: executing)
  //   exec           → exec_end            (legacy: executed  | v2: executed   — IDENTICAL)
  //   ship           → guardrails_on.merge (legacy: integrated| v2: integrated — IDENTICAL)
  //   cycle_complete → guardrails_on.merge (legacy: implemented| v2: integrated)
  //
  // The plan and cycle_complete entries DO change phase outcomes when wired in;
  // R1.3e and R1.3f are the stories that take that step. Until then, the map
  // is passive data — resolveOperation is exported for future use only.
  // R1.3f: dropped `cycle_complete: "guardrails_on.merge"` (Option A from
  // research.2026.06.13.integrated-implemented-released-arc.md §4). The entry
  // was dead code — `cycle_complete` is also an OPERATION_TRANSITIONS key, so
  // resolveOperation always returned it unchanged via the v2 lookup. The map
  // shape went from incoherent (cycle_complete v1: integrated→implemented;
  // v2: executed→integrated) to clean (plan, exec, ship only).
  legacyAcceptedOperations: {
    plan: "exec_start",
    exec: "exec_end",
    ship: "guardrails_on.merge",
  },
};

/**
 * Derive { from: [to, ...] } graph from PHASE_MACHINE.transitions.
 * Manual transitions ARE included — they contribute reverse edges.
 * Terminal states map to [] unless a transition explicitly adds an outgoing edge.
 */
export function deriveTransitionGraph(machine) {
  const graph = Object.fromEntries(machine.states.map((s) => [s, []]));
  for (const t of machine.transitions) {
    for (const from of t.from) {
      if (!graph[from].includes(t.to)) {
        graph[from].push(t.to);
      }
    }
  }
  return graph;
}

/**
 * Derive { operationName: { from: [...], to } } from PHASE_MACHINE.transitions.
 * Manual transitions are EXCLUDED — they have no operation.
 */
export function deriveOperationTransitions(machine) {
  const ops = {};
  for (const t of machine.transitions) {
    if (t.manual) continue;
    ops[t.name] = { from: [...t.from], to: t.to };
  }
  return ops;
}

// ── Derived exports — every existing export name preserved ────────────
export const VALID_PHASES = PHASE_MACHINE.states;
export const TRANSITION_GRAPH = deriveTransitionGraph(PHASE_MACHINE);
export const OPERATION_TRANSITIONS = deriveOperationTransitions(PHASE_MACHINE);

// PLANNABLE_PHASES preserved as a derived backward-compat alias.
// plan-ready.mjs (and any other consumer) continues to import this name and
// receive today's 4-phase set: ["ready", "arch-approved", "planned", "executed"].
// Future Story 2/3 may migrate consumers to read OPERATION_TRANSITIONS.plan.from
// directly and drop this alias.
export const PLANNABLE_PHASES = OPERATION_TRANSITIONS.plan.from;

// Phase required for guardrails-off authorization (unchanged)
export const PHASE_GATE_GUARDRAIL = "arch-approved";

// Phase required for rks_exec to run. R1.3e v2: the plan writer now advances a
// successful plan arch-approved→executing (exec_start), so rks_exec gates on
// "executing" — not the v1 "planned". See backlog.fix.exec-gate-phase-mismatch-v2.
export const PHASE_GATE_EXEC = "executing";
