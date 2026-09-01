/**
 * Phase Machine Integrity Test Suite
 *
 * Pins the structural invariants of the PHASE_MACHINE source-of-truth and
 * verifies the four derived structures (VALID_PHASES, TRANSITION_GRAPH,
 * OPERATION_TRANSITIONS, GATES) are content-consistent.
 *
 * Story 1 (backlog.feat.phase-machine-foundation) introduces this suite as
 * the gate against future drift. See notes/canon.phase-state-machine.md
 * section 9 for the full invariant set.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  PHASE_MACHINE,
  VALID_PHASES,
  TRANSITION_GRAPH,
  OPERATION_TRANSITIONS,
  PLANNABLE_PHASES,
  PHASE_GATE_GUARDRAIL,
  PHASE_GATE_EXEC,
} from "../../packages/mcp-rks/src/workflow/phases.mjs";
import {
  GATES,
  canTransition,
  validateTransition,
  getValidNextPhases,
  VALID_TRANSITIONS,
} from "../../packages/mcp-rks/src/workflow/state-machine.mjs";
import { advancePhase } from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const PHASES_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "packages/mcp-rks/src/workflow/phases.mjs"),
  "utf8",
);
const STATE_MACHINE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "packages/mcp-rks/src/workflow/state-machine.mjs"),
  "utf8",
);
const AUTO_PHASE_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "packages/mcp-rks/src/workflow/auto-phase.mjs"),
  "utf8",
);

describe("PHASE_MACHINE — shape", () => {
  it("exposes { states, start, terminal, transitions }", () => {
    expect(PHASE_MACHINE).toEqual(expect.objectContaining({
      states: expect.any(Array),
      start: expect.any(String),
      terminal: expect.any(Array),
      transitions: expect.any(Array),
    }));
  });

  // R1.4 STATES_EXACT_R1_4_SET — replaces R1.2's 10-phase pin. `implemented`
  // is retired (paper §7 Option A; R8 backfilled in-flight stories first).
  // This assertion is the explicit gate that blocks future stories from sneaking
  // in new phases or removing v1 phases without going through PO/QA/ARCH.
  it("states is exactly the 10-phase set (Set equality + length pin; `decomposed` terminal added)", () => {
    const expected = new Set([
      "draft", "ready", "arch-approved", "executing", "planned",
      "executed", "committed", "integrated", "released", "decomposed",
    ]);
    expect(new Set(PHASE_MACHINE.states)).toEqual(expected);
    expect(PHASE_MACHINE.states).toHaveLength(10);
    expect(PHASE_MACHINE.states).not.toContain("implemented");
  });

  it("R1.2 presence: `committed` IS in states (was R1.1's forbid-guard, now inverted)", () => {
    expect(PHASE_MACHINE.states).toContain("committed");
  });

  it("R1.2 presence: commit/promote/guardrails_* operations all declared (was R1.1's forbid-guard, now inverted)", () => {
    const opNames = PHASE_MACHINE.transitions.filter((t) => !t.manual).map((t) => t.name);
    expect(opNames).toContain("commit");
    expect(opNames).toContain("promote");
    expect(opNames).toContain("guardrails_off");
    expect(opNames).toContain("guardrails_on.commit");
    expect(opNames).toContain("guardrails_on.merge");
  });

  it("R1.3f: legacyAcceptedOperations declares the v1→v2 mapping (3 entries; cycle_complete dropped as dead code)", () => {
    expect(PHASE_MACHINE.legacyAcceptedOperations).toEqual({
      plan: "exec_start",
      exec: "exec_end",
      ship: "guardrails_on.merge",
    });
  });

  it("R1.4 scope guard preserved: no legacyAcceptedPhases field (R1.4 introduces it after R8 migration)", () => {
    expect(PHASE_MACHINE.legacyAcceptedPhases).toBeUndefined();
  });

  it("start is 'draft'", () => {
    expect(PHASE_MACHINE.start).toBe("draft");
  });

  it("terminal is exactly ['released', 'decomposed']", () => {
    expect(PHASE_MACHINE.terminal).toEqual(["released", "decomposed"]);
  });
});

describe("PHASE_MACHINE — every state has incoming/outgoing or is start/terminal", () => {
  for (const state of PHASE_MACHINE.states) {
    it(`'${state}' has incoming edge OR is start`, () => {
      const hasIncoming = PHASE_MACHINE.transitions.some((t) => t.to === state);
      const isStart = state === PHASE_MACHINE.start;
      expect(hasIncoming || isStart).toBe(true);
    });

    it(`'${state}' has outgoing edge OR is terminal`, () => {
      const hasOutgoing = PHASE_MACHINE.transitions.some((t) => t.from.includes(state));
      const isTerminal = PHASE_MACHINE.terminal.includes(state);
      expect(hasOutgoing || isTerminal).toBe(true);
    });
  }
});

describe("PHASE_MACHINE — gates-or-gateless invariant (non-manual only)", () => {
  const nonManual = PHASE_MACHINE.transitions.filter((t) => t.manual !== true);

  for (const t of nonManual) {
    it(`'${t.name}' has exactly one of gates:[...] or gateless:true`, () => {
      const hasGates = Array.isArray(t.gates) && t.gates.length > 0;
      const isGateless = t.gateless === true;
      // XOR — exactly one true
      expect(hasGates).not.toBe(isGateless);
    });
  }

  it("manual transitions have neither gates nor gateless (excluded by design)", () => {
    const manualTransitions = PHASE_MACHINE.transitions.filter((t) => t.manual === true);
    expect(manualTransitions.length).toBeGreaterThan(0);
    for (const t of manualTransitions) {
      expect(t.gates).toBeUndefined();
      expect(t.gateless).toBeUndefined();
    }
  });
});

describe("PHASE_MACHINE — operation/edge consistency", () => {
  for (const t of PHASE_MACHINE.transitions.filter((x) => !x.manual)) {
    it(`operation '${t.name}' produces graph edges for every from-phase`, () => {
      for (const from of t.from) {
        expect(TRANSITION_GRAPH[from]).toContain(t.to);
      }
    });
  }

  it("OPERATION_TRANSITIONS keys are unique", () => {
    const opNames = PHASE_MACHINE.transitions
      .filter((t) => !t.manual)
      .map((t) => t.name);
    expect(opNames).toEqual([...new Set(opNames)]);
  });

  it("Set(VALID_PHASES) === Set(PHASE_MACHINE.states)", () => {
    expect(new Set(VALID_PHASES)).toEqual(new Set(PHASE_MACHINE.states));
    expect(VALID_PHASES.length).toBe(PHASE_MACHINE.states.length);
  });
});

describe("canTransition — agrees with TRANSITION_GRAPH for all 64 pairs", () => {
  for (const from of PHASE_MACHINE.states) {
    for (const to of PHASE_MACHINE.states) {
      it(`(${from}, ${to})`, () => {
        const inGraph = (TRANSITION_GRAPH[from] || []).includes(to);
        expect(canTransition(from, to)).toBe(inGraph);
      });
    }
  }
});

describe("validateTransition — multi-source plan.from honored", () => {
  it("succeeds for each of the 4 plannable phases when target is 'planned'", async () => {
    for (const phase of ["ready", "arch-approved", "planned", "executed"]) {
      const result = await validateTransition({ phase, targetFiles: [{ path: "x" }] }, "planned");
      expect(result.valid).toBe(true);
    }
  });

  it("fails for 'draft' invoking transition to 'planned'", async () => {
    const result = await validateTransition({ phase: "draft" }, "planned");
    expect(result.valid).toBe(false);
  });
});

describe("Derived TRANSITION_GRAPH — preserves every existing edge", () => {
  const expectedEdges = [
    ["draft", "ready"],
    ["ready", "planned"],
    ["ready", "draft"],
    ["arch-approved", "planned"],
    ["arch-approved", "ready"],
    ["planned", "executed"],
    ["planned", "ready"],
    ["executed", "integrated"],
    ["executed", "ready"],
  ];

  for (const [from, to] of expectedEdges) {
    it(`preserves ${from}→${to}`, () => {
      expect(TRANSITION_GRAPH[from]).toContain(to);
    });
  }
});

describe("Derived TRANSITION_GRAPH — new edges", () => {
  it("adds ready→arch-approved", () => {
    expect(TRANSITION_GRAPH.ready).toContain("arch-approved");
    expect(canTransition("ready", "arch-approved")).toBe(true);
  });

  it("R1.4: integrated→released is the only outgoing edge from integrated (cycle_complete retired)", () => {
    expect(TRANSITION_GRAPH.integrated).toEqual(["released"]);
    expect(canTransition("integrated", "released")).toBe(true);
    // implemented is no longer in PHASE_MACHINE.states; no derived edges exist for it.
    expect(TRANSITION_GRAPH.implemented).toBeUndefined();
  });

  it("planned→planned (re-plan self-loop) is supported by plan.from", () => {
    expect(TRANSITION_GRAPH.planned).toContain("planned");
  });

  it("executed→planned (re-plan from executed) is supported by plan.from", () => {
    expect(TRANSITION_GRAPH.executed).toContain("planned");
  });
});

describe("R1.1 additions — `executing` phase + exec_start/exec_end operations", () => {
  it("R1.1: PHASE_MACHINE.transitions contains the exec_start entry", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "exec_start" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["arch-approved"]);
    expect(t.to).toBe("executing");
    expect(t.gateless).toBe(true);
  });

  it("R1.1: PHASE_MACHINE.transitions contains the exec_end entry", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "exec_end" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["executing"]);
    expect(t.to).toBe("executed");
    expect(t.gateless).toBe(true);
  });

  it("R1.1: TRANSITION_GRAPH adds arch-approved→executing edge", () => {
    expect(TRANSITION_GRAPH["arch-approved"]).toContain("executing");
    expect(canTransition("arch-approved", "executing")).toBe(true);
  });

  it("R1.1: TRANSITION_GRAPH adds executing→executed edge", () => {
    expect(TRANSITION_GRAPH.executing).toContain("executed");
    expect(canTransition("executing", "executed")).toBe(true);
  });

  it("R1.1 preservation: every v1 OPERATION_TRANSITIONS entry still exists", () => {
    // AC3 v1 preservation pin — none of the v1 operations were removed.
    expect(OPERATION_TRANSITIONS.qa).toBeDefined();
    expect(OPERATION_TRANSITIONS.arch).toBeDefined();
    expect(OPERATION_TRANSITIONS.plan).toBeDefined();
    expect(OPERATION_TRANSITIONS.exec).toBeDefined();
    expect(OPERATION_TRANSITIONS.ship).toBeDefined();
    // R1.4: cycle_complete retired; no longer in OPERATION_TRANSITIONS.
    expect(OPERATION_TRANSITIONS.cycle_complete).toBeUndefined();
    expect(OPERATION_TRANSITIONS.release).toBeDefined();
  });

  it("R1.1 preservation: plan.from remains multi-source [ready, arch-approved, planned, executed]", () => {
    // Critical preservation pin per AC3 — R1.1 must NOT touch plan's multi-source from-array.
    expect(OPERATION_TRANSITIONS.plan.from).toEqual(
      expect.arrayContaining(["ready", "arch-approved", "planned", "executed"])
    );
    expect(OPERATION_TRANSITIONS.plan.from).toHaveLength(4);
    expect(OPERATION_TRANSITIONS.plan.to).toBe("planned");
  });

  it("R1.2 source-grep: phases.mjs DOES contain the `'committed'` or `\"committed\"` string literal (R1.2 added it)", () => {
    // Inverted from R1.1's scope guard. R1.2 expects `committed` in source.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "../../packages/mcp-rks/src/workflow/phases.mjs"),
      "utf8",
    );
    // String-literal form a phase name would take in PHASE_MACHINE.states.
    const hasCommittedLiteral = src.includes('"committed"') || src.includes("'committed'");
    expect(hasCommittedLiteral).toBe(true);
  });

  it("R1.2 Decision D Option 3: each shared edge has exactly 2 transition rows (NOT a single union)", () => {
    // Per paper §3.4 Decision D Option 3: 3-branch and 2-branch are SEPARATE
    // transition rows even when they share the same from→to edge. The collision
    // is harmless because all involved transitions are gateless: true.
    const sharedEdges = [
      { from: "arch-approved", to: "executing", expected: ["exec_start", "guardrails_off"] },
      { from: "executing", to: "executed", expected: ["exec_end", "guardrails_on.commit"] },
      { from: "executed", to: "integrated", expected: ["ship", "guardrails_on.merge"] },
    ];
    for (const edge of sharedEdges) {
      const rows = PHASE_MACHINE.transitions.filter(
        (t) => !t.manual && t.from.includes(edge.from) && t.to === edge.to,
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.name))).toEqual(new Set(edge.expected));
    }
  });
});

describe("Derived OPERATION_TRANSITIONS", () => {
  it("plan.from is length 4 with all plannable phases", () => {
    expect(Array.isArray(OPERATION_TRANSITIONS.plan.from)).toBe(true);
    expect(OPERATION_TRANSITIONS.plan.from).toHaveLength(4);
    expect(new Set(OPERATION_TRANSITIONS.plan.from)).toEqual(
      new Set(["ready", "arch-approved", "planned", "executed"]),
    );
  });

  it("plan.to === 'planned'", () => {
    expect(OPERATION_TRANSITIONS.plan.to).toBe("planned");
  });

  it("exec.from includes 'planned' and exec.to === 'executed'", () => {
    expect(OPERATION_TRANSITIONS.exec.from).toContain("planned");
    expect(OPERATION_TRANSITIONS.exec.to).toBe("executed");
  });

  it("ship.from includes 'executed' and ship.to === 'integrated'", () => {
    expect(OPERATION_TRANSITIONS.ship.from).toContain("executed");
    expect(OPERATION_TRANSITIONS.ship.to).toBe("integrated");
  });

  it("includes new operations: arch, cycle_complete, release, qa", () => {
    expect(OPERATION_TRANSITIONS.arch).toEqual({ from: ["ready"], to: "arch-approved" });
    // R1.4: cycle_complete retired.
    expect(OPERATION_TRANSITIONS.cycle_complete).toBeUndefined();
    expect(OPERATION_TRANSITIONS.release).toEqual({ from: ["integrated"], to: "released" });
    expect(OPERATION_TRANSITIONS.qa).toEqual({ from: ["draft"], to: "ready" });
  });

  it("manual transitions (reset_to_draft, reset_to_ready) are NOT in OPERATION_TRANSITIONS", () => {
    expect(OPERATION_TRANSITIONS.reset_to_draft).toBeUndefined();
    expect(OPERATION_TRANSITIONS.reset_to_ready).toBeUndefined();
  });
});

describe("Backward-compat exports", () => {
  it("phases.mjs still exports VALID_PHASES, TRANSITION_GRAPH, OPERATION_TRANSITIONS, PLANNABLE_PHASES, PHASE_GATE_GUARDRAIL, PHASE_GATE_EXEC", () => {
    expect(PHASES_SRC).toMatch(/export\s+const\s+VALID_PHASES\b/);
    expect(PHASES_SRC).toMatch(/export\s+const\s+TRANSITION_GRAPH\b/);
    expect(PHASES_SRC).toMatch(/export\s+const\s+OPERATION_TRANSITIONS\b/);
    expect(PHASES_SRC).toMatch(/export\s+const\s+PLANNABLE_PHASES\b/);
    expect(PHASES_SRC).toMatch(/export\s+const\s+PHASE_GATE_GUARDRAIL\b/);
    expect(PHASES_SRC).toMatch(/export\s+const\s+PHASE_GATE_EXEC\b/);
  });

  it("state-machine.mjs still exports GATES, canTransition, validateTransition, getValidNextPhases, VALID_TRANSITIONS", () => {
    expect(STATE_MACHINE_SRC).toMatch(/export\s+const\s+GATES\b/);
    expect(STATE_MACHINE_SRC).toMatch(/export\s+function\s+canTransition\b/);
    expect(STATE_MACHINE_SRC).toMatch(/export\s+async\s+function\s+validateTransition\b/);
    expect(STATE_MACHINE_SRC).toMatch(/export\s+function\s+getValidNextPhases\b/);
    expect(STATE_MACHINE_SRC).toMatch(/export\s+const\s+VALID_TRANSITIONS\b/);
  });

  it("runtime imports resolve to defined values", () => {
    expect(VALID_PHASES).toBeDefined();
    expect(TRANSITION_GRAPH).toBeDefined();
    expect(OPERATION_TRANSITIONS).toBeDefined();
    expect(PLANNABLE_PHASES).toBeDefined();
    expect(GATES).toBeDefined();
    expect(VALID_TRANSITIONS).toBeDefined();
    expect(typeof canTransition).toBe("function");
    expect(typeof validateTransition).toBe("function");
    expect(typeof getValidNextPhases).toBe("function");
    expect(PHASE_GATE_GUARDRAIL).toBe("arch-approved");
    // R1.3e v2: rks_exec gates on the phase the plan writer now sets (executing),
    // not the v1 "planned". See backlog.fix.exec-gate-phase-mismatch-v2.
    expect(PHASE_GATE_EXEC).toBe("executing");
  });

  it("PLANNABLE_PHASES === OPERATION_TRANSITIONS.plan.from (derived alias)", () => {
    expect(PLANNABLE_PHASES).toBe(OPERATION_TRANSITIONS.plan.from);
  });
});

describe("Derived GATES", () => {
  it("draft→ready has the has_target_files gate", () => {
    const gates = GATES["draft→ready"];
    expect(gates).toHaveLength(1);
    expect(gates[0].id).toBe("has_target_files");
    expect(typeof gates[0].check).toBe("function");
  });

  it("ready→planned has the renamed phase_is_plannable gate (NOT phase_is_ready)", () => {
    const gates = GATES["ready→planned"];
    expect(gates).toHaveLength(1);
    expect(gates[0].id).toBe("phase_is_plannable");
    expect(gates[0].id).not.toBe("phase_is_ready");
  });

  it("planned→executed has the phase_is_planned gate", () => {
    const gates = GATES["planned→executed"];
    expect(gates).toHaveLength(1);
    expect(gates[0].id).toBe("phase_is_planned");
  });

  it("ready→arch-approved is gateless ([])", () => {
    expect(GATES["ready→arch-approved"]).toEqual([]);
  });

  it("integrated→implemented is gateless ([])", () => {
    // R1.4: cycle_complete transition retired; this edge no longer exists.
    expect(GATES["integrated→implemented"]).toBeUndefined();
  });

  it("R1.3-followup: integrated→released is gateless ([]) (release.from migrated)", () => {
    expect(GATES["integrated→released"]).toEqual([]);
  });

  it("planned→planned and executed→planned share the phase_is_plannable gate", () => {
    expect(GATES["planned→planned"]).toHaveLength(1);
    expect(GATES["planned→planned"][0].id).toBe("phase_is_plannable");
    expect(GATES["executed→planned"]).toHaveLength(1);
    expect(GATES["executed→planned"][0].id).toBe("phase_is_plannable");
  });

  it("every gate has { id: string, message: string, check: function } shape", () => {
    for (const [key, gates] of Object.entries(GATES)) {
      for (const g of gates) {
        expect(typeof g.id, `${key} gate.id`).toBe("string");
        expect(g.id.length).toBeGreaterThan(0);
        expect(typeof g.message, `${key} gate.message`).toBe("string");
        expect(g.message.length).toBeGreaterThan(0);
        expect(typeof g.check, `${key} gate.check`).toBe("function");
      }
    }
  });
});

describe("advancePhase — multi-source + delegation", () => {
  let tmpRoot;

  function makeStoryFixture(phase, problemId = "test-story") {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase-machine-test-"));
    const notesDir = path.join(tmp, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    const storyPath = path.join(notesDir, `${problemId}.md`);
    fs.writeFileSync(
      storyPath,
      `---\nid: "${problemId}"\nphase: "${phase}"\ntargetFiles:\n  - path: "x"\n    op: edit\n    desc: "y"\n---\n# Test\n`,
    );
    tmpRoot = tmp;
    return { tmp, problemId };
  }

  afterEach(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  // R1.3e: rks_plan now writes phase via advancePhase("exec_start") which has
  // from: ["arch-approved"] only. The tests below pin the v2 contract. The v1
  // 'plan' op transition still exists in PHASE_MACHINE.transitions (preserved
  // until R1.4) and is asserted at the data level above; runtime coverage of
  // the v1 op is intentionally not duplicated here.

  it("AC4.d v2: exec_start rejects story at phase 'ready' (must go through ARCH first)", async () => {
    const { tmp, problemId } = makeStoryFixture("ready");
    const result = await advancePhase(tmp, problemId, "exec_start");
    expect(result.ok).toBe(false);
  });

  it("AC4.a v2: exec_start advances story at phase 'arch-approved' → 'executing'", async () => {
    const { tmp, problemId } = makeStoryFixture("arch-approved");
    const result = await advancePhase(tmp, problemId, "exec_start");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("executing");
  });

  it("AC4.c scenario: planned → refine_apply (companion: phase=arch-approved) → exec_start → executing", async () => {
    // Depends on backlog.feat.refine-apply-resets-phase-to-arch-approved having shipped.
    // Exercises the Build Governor refine→re-plan flow under the v2 model.
    const { tmp, problemId } = makeStoryFixture("planned");

    const applyResult = await runRefineApplyTool({
      projectRoot: tmp,
      problemId,
      refinements: [{ type: "clarify_ac", data: { criteria: ["clarified after refine"] } }],
    });
    expect(applyResult.ok).toBe(true);
    expect(applyResult.decomposed).toBeFalsy();

    const fmAfterRefine = yaml.load(
      fs.readFileSync(path.join(tmp, "notes", `${problemId}.md`), "utf8").match(/^---\n([\s\S]*?)\n---/)[1],
    );
    expect(fmAfterRefine.phase).toBe("arch-approved");

    const result = await advancePhase(tmp, problemId, "exec_start");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("executing");
  });

  // AC4.b: the assertion that previously pinned `executed → planned` via the v1
  // 'plan' op is removed per research.2026.06.12.re-plan-workflow-audit.md §2.b.
  // The audit confirmed no producer in the codebase invokes rks_plan from a story
  // at phase=executed. The v1 'plan' transition row stays in PHASE_MACHINE.transitions
  // (preserved by AC5), but the runtime assertion exercised no real flow.

  it("plan rejects story at phase 'draft'", async () => {
    const { tmp, problemId } = makeStoryFixture("draft");
    const result = await advancePhase(tmp, problemId, "plan");
    expect(result.ok).toBe(false);
  });

  it("arch transitions ready → arch-approved (new edge)", async () => {
    const { tmp, problemId } = makeStoryFixture("ready");
    const result = await advancePhase(tmp, problemId, "arch");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("arch-approved");
  });

  it("R1.4: cycle_complete operation is retired; advancePhase rejects it", async () => {
    const { tmp, problemId } = makeStoryFixture("integrated");
    const result = await advancePhase(tmp, problemId, "cycle_complete");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown operation/);
  });

  it("R1.3-followup: release transitions integrated → released (release.from migrated)", async () => {
    const { tmp, problemId } = makeStoryFixture("integrated");
    const result = await advancePhase(tmp, problemId, "release");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("released");
  });

  it("advancePhase signature is (projectRoot, problemId, operation, projectId)", () => {
    // function.length excludes args with default values; last arg has a default.
    expect(advancePhase.length).toBe(3);
  });

  it("auto-phase.mjs source does NOT read expected.from directly (delegation pinned)", () => {
    // Strip comments so doc-comment mentions of "expected.from" (e.g. the module
    // header explaining the delegation pattern) don't false-positive. We require
    // a real code-level reference (followed by ;, ., (, [, !, or assignment).
    const stripped = AUTO_PHASE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, "")  // block comments
      .replace(/^[ \t]*\/\/.*$/gm, "")     // line comments
    ;
    expect(stripped).not.toMatch(/expected\.from\s*[.[(!=;]/);
  });
});

describe("Backward-compat: existing phases.spec.mjs re-plan-scenarios preserved", () => {
  // The existing tests/unit/workflow/phases.spec.mjs pins re-plan from
  // planned and executed via PLANNABLE_PHASES. The derived alias preserves
  // those exact phases, so this assertion is a structural mirror.
  it("PLANNABLE_PHASES still contains 'planned' (re-plan source)", () => {
    expect(PLANNABLE_PHASES).toContain("planned");
  });

  it("PLANNABLE_PHASES still contains 'executed' (re-plan source)", () => {
    expect(PLANNABLE_PHASES).toContain("executed");
  });

  it("PLANNABLE_PHASES does NOT contain 'draft'", () => {
    expect(PLANNABLE_PHASES).not.toContain("draft");
  });
});

describe("R1.2 additions — `committed` phase + commit/promote/guardrails_* operations", () => {
  it("R1.2: PHASE_MACHINE.transitions contains the commit entry (3-branch local-dev merge)", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "commit" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["executed"]);
    expect(t.to).toBe("committed");
    expect(t.gateless).toBe(true);
  });

  it("R1.2: PHASE_MACHINE.transitions contains the promote entry (3-branch staging push)", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "promote" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["committed"]);
    expect(t.to).toBe("integrated");
    expect(t.gateless).toBe(true);
  });

  it("R1.2: PHASE_MACHINE.transitions contains the guardrails_off entry (2-branch session-open)", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "guardrails_off" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["arch-approved"]);
    expect(t.to).toBe("executing");
    expect(t.gateless).toBe(true);
  });

  it("R1.2: PHASE_MACHINE.transitions contains the guardrails_on.commit entry (2-branch crash-checkpoint)", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "guardrails_on.commit" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["executing"]);
    expect(t.to).toBe("executed");
    expect(t.gateless).toBe(true);
  });

  it("R1.2: PHASE_MACHINE.transitions contains the guardrails_on.merge entry (2-branch atomic-completion)", () => {
    const t = PHASE_MACHINE.transitions.find((x) => x.name === "guardrails_on.merge" && !x.manual);
    expect(t).toBeDefined();
    expect(t.from).toEqual(["executed"]);
    expect(t.to).toBe("integrated");
    expect(t.gateless).toBe(true);
  });

  it("R1.2: TRANSITION_GRAPH adds executed→committed edge", () => {
    expect(TRANSITION_GRAPH.executed).toContain("committed");
    expect(canTransition("executed", "committed")).toBe(true);
  });

  it("R1.2: TRANSITION_GRAPH adds committed→integrated edge", () => {
    expect(TRANSITION_GRAPH.committed).toContain("integrated");
    expect(canTransition("committed", "integrated")).toBe(true);
  });

  it("R1.2 preservation: all R1.0+R1.1 OPERATION_TRANSITIONS entries still exist", () => {
    // AC3 v1+R1.1 preservation pin.
    expect(OPERATION_TRANSITIONS.qa).toBeDefined();
    expect(OPERATION_TRANSITIONS.arch).toBeDefined();
    expect(OPERATION_TRANSITIONS.plan).toBeDefined();
    expect(OPERATION_TRANSITIONS.exec).toBeDefined();
    expect(OPERATION_TRANSITIONS.ship).toBeDefined();
    // R1.4: cycle_complete retired.
    expect(OPERATION_TRANSITIONS.cycle_complete).toBeUndefined();
    expect(OPERATION_TRANSITIONS.release).toBeDefined();
    expect(OPERATION_TRANSITIONS.exec_start).toBeDefined();
    expect(OPERATION_TRANSITIONS.exec_end).toBeDefined();
  });

  it("R1.2 dot-notation: OPERATION_TRANSITIONS uses string keys for `guardrails_on.commit` and `guardrails_on.merge`", () => {
    expect(OPERATION_TRANSITIONS["guardrails_on.commit"]).toBeDefined();
    expect(OPERATION_TRANSITIONS["guardrails_on.merge"]).toBeDefined();
  });

  it("R1.2 Decision D collision harmless: all colliding rows are gateless so GATES collapses to []", () => {
    // The 3 shared edges all have gateless: true on both rows, so deriveGates
    // writes the same value (an empty array) under the same key regardless of
    // iteration order. Verify the empty-gate result.
    expect(GATES["arch-approved→executing"]).toEqual([]);
    expect(GATES["executing→executed"]).toEqual([]);
    expect(GATES["executed→integrated"]).toEqual([]);
  });
});

describe("R1.3 additions — legacyAcceptedOperations + resolveOperation helper", () => {
  it("R1.3f: PHASE_MACHINE.legacyAcceptedOperations maps v1 ops to v2 equivalents (3 entries — cycle_complete dropped)", () => {
    expect(PHASE_MACHINE.legacyAcceptedOperations).toEqual({
      plan: "exec_start",
      exec: "exec_end",
      ship: "guardrails_on.merge",
    });
  });

  it("R1.3: every v2 target in legacyAcceptedOperations exists in OPERATION_TRANSITIONS", () => {
    for (const v2Name of Object.values(PHASE_MACHINE.legacyAcceptedOperations)) {
      expect(OPERATION_TRANSITIONS[v2Name]).toBeDefined();
    }
  });

  it("R1.3e: resolveOperation is exported from auto-phase.mjs AND wired into advancePhase", () => {
    // Source-grep AC3 verification (R1.3e inversion): advancePhase function body
    // MUST call resolveOperation before the OPERATION_TRANSITIONS lookup.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "../../packages/mcp-rks/src/workflow/auto-phase.mjs"),
      "utf8",
    );
    expect(src).toMatch(/export\s+function\s+resolveOperation/);
    const advanceStart = src.indexOf("export async function advancePhase");
    expect(advanceStart).toBeGreaterThan(-1);
    const afterAdvance = src.slice(advanceStart);
    const nextExportIdx = afterAdvance.slice(1).indexOf("\nexport ");
    const advanceBody = nextExportIdx === -1 ? afterAdvance : afterAdvance.slice(0, nextExportIdx + 1);
    // resolveOperation MUST be called inside advancePhase (R1.3e wired it in).
    expect(advanceBody).toMatch(/\bresolveOperation\s*\(/);
  });
});
