import { describe, it, expect } from "vitest";
import {
  VALID_PHASES,
  TRANSITION_GRAPH,
  PLANNABLE_PHASES,
  OPERATION_TRANSITIONS,
  PHASE_GATE_GUARDRAIL,
  PHASE_GATE_EXEC,
  PHASE_MACHINE,
} from "../../../packages/mcp-rks/src/workflow/phases.mjs";

describe("phases.mjs — single source of truth", () => {
  describe("VALID_PHASES", () => {
    // R1.1 added `executing` between `arch-approved` and `planned`. All v1
    // phases preserved per AC3 (no removals). v2 model continues to extend
    // additively in R1.2 (committed).
    it("contains all expected lifecycle phases in order (10 phases — `decomposed` terminal added)", () => {
      expect(VALID_PHASES).toEqual([
        "draft",
        "ready",
        "arch-approved",
        "executing",
        "planned",
        "executed",
        "committed",
        "integrated",
        "released",
        "decomposed",
      ]);
    });
  });

  describe("TRANSITION_GRAPH", () => {
    it("draft can only go to ready", () => {
      expect(TRANSITION_GRAPH.draft).toEqual(["ready"]);
    });

    it("ready can go to planned or back to draft", () => {
      expect(TRANSITION_GRAPH.ready).toContain("planned");
      expect(TRANSITION_GRAPH.ready).toContain("draft");
    });

    it("arch-approved can go to planned, ready, OR executing (R1.1 additive)", () => {
      expect(TRANSITION_GRAPH["arch-approved"]).toContain("planned");
      expect(TRANSITION_GRAPH["arch-approved"]).toContain("ready");
      expect(TRANSITION_GRAPH["arch-approved"]).toContain("executing");
    });

    it("R1.1: executing → executed (new v2 transition)", () => {
      expect(TRANSITION_GRAPH.executing).toContain("executed");
    });

    it("planned can go to executed or back to ready", () => {
      expect(TRANSITION_GRAPH.planned).toContain("executed");
      expect(TRANSITION_GRAPH.planned).toContain("ready");
    });

    it("executed can go to integrated or back to ready", () => {
      expect(TRANSITION_GRAPH.executed).toContain("integrated");
      expect(TRANSITION_GRAPH.executed).toContain("ready");
    });

    it("R1.4: integrated transitions to released only (cycle_complete retired)", () => {
      expect(TRANSITION_GRAPH.integrated).toEqual(["released"]);
    });

    it("ready can transition to arch-approved (new derived edge)", () => {
      expect(TRANSITION_GRAPH.ready).toContain("arch-approved");
    });

    it("R1.4: implemented is no longer in PHASE_MACHINE.states; no derived graph entry", () => {
      expect(TRANSITION_GRAPH.implemented).toBeUndefined();
    });
  });

  describe("PLANNABLE_PHASES", () => {
    it("includes ready and arch-approved", () => {
      expect(PLANNABLE_PHASES).toContain("ready");
      expect(PLANNABLE_PHASES).toContain("arch-approved");
    });

    it("includes planned and executed for re-plan scenarios", () => {
      expect(PLANNABLE_PHASES).toContain("planned");
      expect(PLANNABLE_PHASES).toContain("executed");
    });

    it("does not include draft", () => {
      expect(PLANNABLE_PHASES).not.toContain("draft");
    });
  });

  describe("OPERATION_TRANSITIONS", () => {
    it("plan advances any plannable phase → planned (multi-source from-array)", () => {
      expect(Array.isArray(OPERATION_TRANSITIONS.plan.from)).toBe(true);
      expect(OPERATION_TRANSITIONS.plan.from).toEqual(
        expect.arrayContaining(["ready", "arch-approved", "planned", "executed"])
      );
      expect(OPERATION_TRANSITIONS.plan.from).toHaveLength(4);
      expect(OPERATION_TRANSITIONS.plan.to).toBe("planned");
    });

    it("exec advances planned → executed (from-array shape)", () => {
      expect(OPERATION_TRANSITIONS.exec.from).toEqual(["planned"]);
      expect(OPERATION_TRANSITIONS.exec.to).toBe("executed");
    });

    it("ship advances executed → integrated (not implemented; from-array shape)", () => {
      expect(OPERATION_TRANSITIONS.ship.from).toEqual(["executed"]);
      expect(OPERATION_TRANSITIONS.ship.to).toBe("integrated");
    });

    it("PLANNABLE_PHASES is the derived alias of OPERATION_TRANSITIONS.plan.from", () => {
      expect(PLANNABLE_PHASES).toBe(OPERATION_TRANSITIONS.plan.from);
    });

    // R1.1 additive v2 operations — coexist with v1 plan/exec.
    it("R1.1: exec_start advances arch-approved → executing (gateless v2 entry)", () => {
      expect(OPERATION_TRANSITIONS.exec_start.from).toEqual(["arch-approved"]);
      expect(OPERATION_TRANSITIONS.exec_start.to).toBe("executing");
    });

    it("R1.1: exec_end advances executing → executed (gateless v2 exit)", () => {
      expect(OPERATION_TRANSITIONS.exec_end.from).toEqual(["executing"]);
      expect(OPERATION_TRANSITIONS.exec_end.to).toBe("executed");
    });

    // R1.2 additive v2 operations — 3-branch + 2-branch completion of the graph.
    it("R1.2: commit advances executed → committed (3-branch local-dev merge)", () => {
      expect(OPERATION_TRANSITIONS.commit.from).toEqual(["executed"]);
      expect(OPERATION_TRANSITIONS.commit.to).toBe("committed");
    });

    it("R1.2: promote advances committed → integrated (3-branch staging push)", () => {
      expect(OPERATION_TRANSITIONS.promote.from).toEqual(["committed"]);
      expect(OPERATION_TRANSITIONS.promote.to).toBe("integrated");
    });

    it("R1.2: guardrails_off advances arch-approved → executing (2-branch session-open; Decision D shared edge with exec_start)", () => {
      expect(OPERATION_TRANSITIONS.guardrails_off.from).toEqual(["arch-approved"]);
      expect(OPERATION_TRANSITIONS.guardrails_off.to).toBe("executing");
    });

    it("R1.2: guardrails_on.commit advances executing → executed (2-branch crash-checkpoint)", () => {
      // Dot-notation key requires bracket access.
      expect(OPERATION_TRANSITIONS["guardrails_on.commit"].from).toEqual(["executing"]);
      expect(OPERATION_TRANSITIONS["guardrails_on.commit"].to).toBe("executed");
    });

    it("R1.2: guardrails_on.merge advances executed → integrated (2-branch atomic-completion)", () => {
      expect(OPERATION_TRANSITIONS["guardrails_on.merge"].from).toEqual(["executed"]);
      expect(OPERATION_TRANSITIONS["guardrails_on.merge"].to).toBe("integrated");
    });
  });

  describe("R1.3 — legacyAcceptedOperations map (forward v1→v2 alias)", () => {
    it("PHASE_MACHINE.legacyAcceptedOperations exists with v1→v2 mapping (R1.3f: 3 entries; cycle_complete dropped)", () => {
      expect(PHASE_MACHINE.legacyAcceptedOperations).toEqual({
        plan: "exec_start",
        exec: "exec_end",
        ship: "guardrails_on.merge",
      });
    });

    it("every v2 mapping target is a valid OPERATION_TRANSITIONS key", () => {
      for (const v2Name of Object.values(PHASE_MACHINE.legacyAcceptedOperations)) {
        expect(OPERATION_TRANSITIONS[v2Name]).toBeDefined();
      }
    });
  });

  describe("phase gate constants", () => {
    it("PHASE_GATE_GUARDRAIL is arch-approved", () => {
      expect(PHASE_GATE_GUARDRAIL).toBe("arch-approved");
    });

    it("PHASE_GATE_EXEC is executing", () => {
      // R1.3e v2: a successful plan advances the story to "executing" (exec_start),
      // so rks_exec gates on "executing", not the v1 "planned".
      // See backlog.fix.exec-gate-phase-mismatch-v2.
      expect(PHASE_GATE_EXEC).toBe("executing");
    });
  });
});
