/**
 * Hook chain misconfig fix: dendron-tool allowlist symmetry in governor-state.mjs.
 *
 * Pins:
 *  - AC1/AC2: wherever rks_agent_dendron is allowed in any STORY_STATES or
 *    OPEN_STATES state, dendron_update_field is also allowed.
 *  - AC3: same symmetry for dendron_create_note, dendron_edit_note, dendron_read_note.
 *  - AC4: OPEN_STATES['test-file-scanning'] explicitly allows the wrapper + all
 *    four underlying dendron tools (previously denied both).
 *  - AC5: runtime regression via checkStateAllowed — story-flow init state
 *    permits dendron_update_field instead of returning chain_violation.
 *  - AC9: state graph (transitions) for the edited states is unchanged — this
 *    fix is purely additive at the allowlist layer.
 *
 * See notes/backlog.fix.hook-chain-dendron-update-field-blocked-in-init-state
 * and yesterday's session diagnostics (3 separate workarounds + 1 PO retry).
 */
import { describe, it, expect } from "vitest";
import {
  getStates,
  checkStateAllowed,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const WRAPPER = "rks_agent_dendron";
const UNDERLYING = ["dendron_create_note", "dendron_edit_note", "dendron_read_note", "dendron_update_field"];

describe("governor-state.mjs — dendron-tool allowlist symmetry (hook chain misconfig fix)", () => {
  describe("AC1 — STORY_STATES symmetry", () => {
    const states = getStates("story");

    it("every story-flow state that allows rks_agent_dendron also allows all four dendron underlying tools", () => {
      const violations = [];
      for (const [stateName, stateDef] of Object.entries(states)) {
        if (!stateDef.allowed?.has(WRAPPER)) continue;
        for (const tool of UNDERLYING) {
          if (!stateDef.allowed.has(tool)) {
            violations.push(`STORY_STATES['${stateName}'].allowed lacks ${tool}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe("AC2 / AC4 — OPEN_STATES symmetry (incl. test-file-scanning)", () => {
    const states = getStates("open");

    it("every open-flow state that allows rks_agent_dendron also allows all four dendron underlying tools", () => {
      const violations = [];
      for (const [stateName, stateDef] of Object.entries(states)) {
        if (!stateDef.allowed?.has(WRAPPER)) continue;
        for (const tool of UNDERLYING) {
          if (!stateDef.allowed.has(tool)) {
            violations.push(`OPEN_STATES['${stateName}'].allowed lacks ${tool}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it("AC4: test-file-scanning state explicitly allows the wrapper + all four underlying dendron tools", () => {
      const scanState = states["test-file-scanning"];
      expect(scanState).toBeDefined();
      expect(scanState.allowed.has(WRAPPER)).toBe(true);
      for (const tool of UNDERLYING) {
        expect(scanState.allowed.has(tool), `test-file-scanning must allow ${tool}`).toBe(true);
      }
    });
  });

  describe("AC5 — runtime regression via checkStateAllowed", () => {
    it("story-flow init state: dendron_update_field is allowed (was chain_violation pre-fix)", () => {
      const result = checkStateAllowed("story", "init", "dendron_update_field");
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("open-flow init state: dendron_update_field is allowed (lone underlying tool missing pre-fix)", () => {
      const result = checkStateAllowed("open", "init", "dendron_update_field");
      expect(result.allowed).toBe(true);
    });

    it("open-flow test-file-scanning state: dendron_create_note is allowed (was a dead end pre-fix)", () => {
      const result = checkStateAllowed("open", "test-file-scanning", "dendron_create_note");
      expect(result.allowed).toBe(true);
    });

    it("story-flow init state: each dendron underlying tool is permitted", () => {
      for (const tool of UNDERLYING) {
        const result = checkStateAllowed("story", "init", tool);
        expect(result.allowed, `${tool} should be allowed in story init: ${result.error || ""}`).toBe(true);
      }
    });
  });

  describe("AC9 — state graph immutability (transitions unchanged on edited states)", () => {
    const storyStates = getStates("story");
    const openStates = getStates("open");

    it("STORY_STATES.init transitions preserved (refining via refine/research)", () => {
      expect(storyStates.init.transitions).toEqual({
        rks_refine: "refining",
        rks_agent_research: "refining",
        rks_agent_external_research: "refining",
      });
    });

    it("OPEN_STATES.init transitions preserved (researching + writing edges)", () => {
      expect(openStates.init.transitions).toEqual({
        rks_agent_research: "researching",
        rks_agent_external_research: "researching",
        dendron_create_note: "writing",
        dendron_edit_note: "writing",
      });
    });

    it("OPEN_STATES.test-file-scanning forward edge to writing is preserved", () => {
      expect(openStates["test-file-scanning"].transitions).toEqual({
        rks_agent_research: "writing",
        rks_agent_external_research: "test-file-scanning",
      });
    });
  });

  describe("AC6 — peer-test contract preservation", () => {
    // tests/unit/governor-test-failed-state.test.mjs asserts the story-flow
    // 'test-failed' state. That state does NOT allow rks_agent_dendron, so
    // this fix does not touch it. Pin that the symmetry rule didn't drift
    // into modifying states outside the wrapper-allowed set.
    const states = getStates("story");

    it("story-flow test-failed state is untouched (rks_agent_dendron remains absent)", () => {
      expect(states["test-failed"].allowed.has(WRAPPER)).toBe(false);
      for (const tool of UNDERLYING) {
        expect(states["test-failed"].allowed.has(tool), `test-failed should NOT allow ${tool} (symmetry rule preserves the wrapper-absent state)`).toBe(false);
      }
    });
  });
});

describe("governor-state.mjs — QA researching state allows dendron_edit_note (backlog.feat.qa-flow-edit-note-in-researching)", () => {
  // The QA 'researching' state could create/read/update notes but NOT edit a
  // note BODY, so a QA Governor reconciling prose ACs while still researching
  // chain-violated (eval finding M4). dendron_edit_note is already a QA_FLOW
  // tool and already allowed in qa_assessing/qa_reporting — this lets QA use it
  // one state earlier. Additive to one state's allowed Set; no transitions edit.
  it("checkStateAllowed('qa','researching','dendron_edit_note') is allowed", () => {
    const r = checkStateAllowed("qa", "researching", "dendron_edit_note");
    expect(r.allowed).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("does NOT blanket-open researching — a non-allowed tool still chain-violates", () => {
    const r = checkStateAllowed("qa", "researching", "rks_refine");
    expect(r.allowed).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("preserves the prior researching permissions (create/read/update/research still allowed)", () => {
    for (const tool of [
      "dendron_create_note",
      "dendron_read_note",
      "dendron_update_field",
      "rks_agent_research",
      "rks_agent_run",
    ]) {
      expect(checkStateAllowed("qa", "researching", tool).allowed, tool).toBe(true);
    }
  });

  it("keeps the cross-state invariant: qa_assessing/qa_reporting allow it, qa_testing does not", () => {
    expect(checkStateAllowed("qa", "qa_assessing", "dendron_edit_note").allowed).toBe(true);
    expect(checkStateAllowed("qa", "qa_reporting", "dendron_edit_note").allowed).toBe(true);
    expect(checkStateAllowed("qa", "qa_testing", "dendron_edit_note").allowed).toBe(false);
  });

  it("does not alter the researching transition graph (purely additive at the allowlist layer)", () => {
    const researching = getStates("qa").researching;
    expect(researching.transitions).toEqual({
      rks_agent_research: "researching",
      rks_agent_external_research: "researching",
      rks_agent_run: "qa_testing",
    });
  });
});

describe("governor-state.mjs — exhaustive_search + recovery chain-gate reachability", () => {
  it("rks_exhaustive_search (read-only) is allowed across the OPEN research/scan states", () => {
    for (const state of ["init", "researching", "concern-separating", "test-file-scanning", "writing"]) {
      expect(checkStateAllowed("open", state, "rks_exhaustive_search").allowed, `open/${state}`).toBe(true);
    }
  });

  it("rks_exhaustive_search is allowed in QA researching, STORY init/refining/child_active, OPS init/executing", () => {
    expect(checkStateAllowed("qa", "researching", "rks_exhaustive_search").allowed).toBe(true);
    for (const state of ["init", "refining", "child_active"]) {
      expect(checkStateAllowed("story", state, "rks_exhaustive_search").allowed, `story/${state}`).toBe(true);
    }
    for (const state of ["init", "executing"]) {
      expect(checkStateAllowed("ops", state, "rks_exhaustive_search").allowed, `ops/${state}`).toBe(true);
    }
  });

  it("rks_agent_recovery (mutating) is allowed ONLY in ops/init and open/init", () => {
    expect(checkStateAllowed("ops", "init", "rks_agent_recovery").allowed).toBe(true);
    expect(checkStateAllowed("open", "init", "rks_agent_recovery").allowed).toBe(true);
  });

  it("rks_agent_recovery is DENIED outside recovery-entry states (ops/executing, open non-init, every QA state)", () => {
    expect(checkStateAllowed("ops", "executing", "rks_agent_recovery").allowed).toBe(false);
    expect(checkStateAllowed("open", "researching", "rks_agent_recovery").allowed).toBe(false);
    expect(checkStateAllowed("open", "writing", "rks_agent_recovery").allowed).toBe(false);
    for (const state of Object.keys(getStates("qa"))) {
      expect(checkStateAllowed("qa", state, "rks_agent_recovery").allowed, `qa/${state}`).toBe(false);
    }
  });

  it("adds NEITHER tool to Ship-flow states (deterministic commit chain stays gated)", () => {
    for (const state of Object.keys(getStates("ship"))) {
      expect(checkStateAllowed("ship", state, "rks_agent_recovery").allowed, `ship/${state}`).toBe(false);
      expect(checkStateAllowed("ship", state, "rks_exhaustive_search").allowed, `ship/${state}`).toBe(false);
    }
  });
});
