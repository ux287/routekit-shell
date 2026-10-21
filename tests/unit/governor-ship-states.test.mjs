import { describe, it, expect } from "vitest";
import {
  SHIP_FLOW_TOOLS, QA_FLOW_TOOLS, SHIP_STATES,
  getStates, checkStateAllowed, transitionOnResult, getNextState, isTerminal,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

// ── Existing SHIP_FLOW_TOOLS / QA_FLOW_TOOLS tests ─────────────────

describe("SHIP_FLOW_TOOLS export", () => {
  it("is exported as a Set with exactly 9 members", () => {
    expect(SHIP_FLOW_TOOLS).toBeInstanceOf(Set);
    expect(SHIP_FLOW_TOOLS.size).toBe(9);
  });

  it("contains all required ship-phase tools", () => {
    const expected = [
      "rks_governor_init",
      "rks_git_state",
      "rks_git_commit",
      "rks_git_push",
      "rks_staging_pr",
      "rks_git_merge",
      "rks_cycle_complete",
      "rks_agent_git",
      "rks_project_get",
    ];
    for (const tool of expected) {
      expect(SHIP_FLOW_TOOLS.has(tool)).toBe(true);
    }
    expect([...SHIP_FLOW_TOOLS].sort()).toEqual(expected.sort());
  });

  it("excludes Build-phase tools", () => {
    expect(SHIP_FLOW_TOOLS.has("rks_refine")).toBe(false);
    expect(SHIP_FLOW_TOOLS.has("rks_plan")).toBe(false);
    expect(SHIP_FLOW_TOOLS.has("rks_exec")).toBe(false);
  });
});

describe("QA_FLOW_TOOLS export", () => {
  it("is exported as a Set with members", () => {
    expect(QA_FLOW_TOOLS).toBeInstanceOf(Set);
    expect(QA_FLOW_TOOLS.size).toBeGreaterThan(0);
  });

  it("does not contain ship-exclusive tools", () => {
    expect(QA_FLOW_TOOLS.has("rks_git_commit")).toBe(false);
    expect(QA_FLOW_TOOLS.has("rks_staging_pr")).toBe(false);
  });
});

// ── SHIP_STATES state machine tests ─────────────────────────────────

describe("SHIP_STATES export", () => {
  it("contains exactly the expected states", () => {
    const stateNames = Object.keys(SHIP_STATES).sort();
    expect(stateNames).toEqual(["committed", "failed", "init", "merging", "pr_created", "shipped"]);
  });
});

describe("SHIP_STATES allowed tools per state", () => {
  it("init allows rks_git_commit, rks_git_state, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.init.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_git_commit", "rks_git_state", "rks_project_get"]
    );
  });

  it("committed allows rks_git_push, rks_staging_pr, rks_git_merge, rks_cycle_complete, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.committed.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_cycle_complete", "rks_git_merge", "rks_git_push", "rks_project_get", "rks_staging_pr"]
    );
  });

  it("pr_created allows rks_git_merge, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.pr_created.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_git_merge", "rks_project_get"]
    );
  });

  it("merging allows rks_cycle_complete, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.merging.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_cycle_complete", "rks_project_get"]
    );
  });
});

describe("getStates routing", () => {
  it("getStates('ship') returns SHIP_STATES", () => {
    expect(getStates("ship")).toBe(SHIP_STATES);
  });

  it("getStates('story') does not return SHIP_STATES", () => {
    expect(getStates("story")).not.toBe(SHIP_STATES);
  });

  it("getStates('open') does not return SHIP_STATES", () => {
    expect(getStates("open")).not.toBe(SHIP_STATES);
  });

  it("getStates('qa') does not return SHIP_STATES", () => {
    expect(getStates("qa")).not.toBe(SHIP_STATES);
  });
});

describe("checkStateAllowed for ship flow", () => {
  it("allows rks_git_commit in init", () => {
    expect(checkStateAllowed("ship", "init", "rks_git_commit").allowed).toBe(true);
  });

  it("blocks rks_staging_pr in init", () => {
    expect(checkStateAllowed("ship", "init", "rks_staging_pr").allowed).toBe(false);
  });

  it("allows rks_staging_pr in committed", () => {
    expect(checkStateAllowed("ship", "committed", "rks_staging_pr").allowed).toBe(true);
  });

  it("allows rks_git_merge in pr_created", () => {
    expect(checkStateAllowed("ship", "pr_created", "rks_git_merge").allowed).toBe(true);
  });

  it("allows rks_cycle_complete in merging", () => {
    expect(checkStateAllowed("ship", "merging", "rks_cycle_complete").allowed).toBe(true);
  });
});

describe("ship flow happy-path transitions", () => {
  it("git_commit.ok transitions init → committed", () => {
    expect(transitionOnResult("ship", "init", "git_commit.ok")).toBe("committed");
  });

  it("staging_pr.ok transitions committed → pr_created", () => {
    expect(transitionOnResult("ship", "committed", "staging_pr.ok")).toBe("pr_created");
  });

  it("git_merge.ok transitions pr_created → merging", () => {
    expect(transitionOnResult("ship", "pr_created", "git_merge.ok")).toBe("merging");
  });

  it("cycle_complete.ok transitions merging → shipped", () => {
    expect(transitionOnResult("ship", "merging", "cycle_complete.ok")).toBe("shipped");
  });
});

describe("ship flow error transitions", () => {
  it("git_commit.error transitions init → failed", () => {
    expect(transitionOnResult("ship", "init", "git_commit.error")).toBe("failed");
  });

  it("staging_pr.error transitions committed → failed", () => {
    expect(transitionOnResult("ship", "committed", "staging_pr.error")).toBe("failed");
  });

  it("git_merge.error transitions pr_created → failed", () => {
    expect(transitionOnResult("ship", "pr_created", "git_merge.error")).toBe("failed");
  });

  it("cycle_complete.error transitions merging → failed", () => {
    expect(transitionOnResult("ship", "merging", "cycle_complete.error")).toBe("failed");
  });
});

describe("ship flow terminal states", () => {
  it("shipped is terminal", () => {
    expect(isTerminal("ship", "shipped")).toBe(true);
  });

  it("failed is terminal", () => {
    expect(isTerminal("ship", "failed")).toBe(true);
  });

  it("init is not terminal", () => {
    expect(isTerminal("ship", "init")).toBe(false);
  });

  it("committed is not terminal", () => {
    expect(isTerminal("ship", "committed")).toBe(false);
  });
});

// ── backlog.fix.ship-flow-deterministic-no-llm (AC3, AC9 option A) ──

describe("ship flow deterministic transitions (AC3, AC9)", () => {
  it("committed: git_merge.ok -> merging, git_merge.error -> failed (3-branch local merge)", () => {
    expect(transitionOnResult("ship", "committed", "git_merge.ok")).toBe("merging");
    expect(transitionOnResult("ship", "committed", "git_merge.error")).toBe("failed");
  });

  it("committed: cycle_complete.ok -> shipped, cycle_complete.error -> failed (working-branch ship)", () => {
    expect(transitionOnResult("ship", "committed", "cycle_complete.ok")).toBe("shipped");
    expect(transitionOnResult("ship", "committed", "cycle_complete.error")).toBe("failed");
  });

  it("calling a tool never moves the state on its own: committed+rks_git_merge, committed+rks_cycle_complete, init+rks_git_state", () => {
    expect(getNextState("ship", "committed", "rks_git_merge")).toBe("committed");
    expect(getNextState("ship", "committed", "rks_cycle_complete")).toBe("committed");
    expect(getNextState("ship", "init", "rks_git_state")).toBe("init");
  });

  it("the 2-branch transitions are unchanged", () => {
    expect(transitionOnResult("ship", "committed", "staging_pr.ok")).toBe("pr_created");
    expect(transitionOnResult("ship", "pr_created", "git_merge.ok")).toBe("merging");
    expect(transitionOnResult("ship", "merging", "cycle_complete.ok")).toBe("shipped");
  });

  it("superset: every tool admitted in each ship state before the fix is still admitted", () => {
    const PRE_FIX = {
      init: ["rks_git_commit", "rks_agent_git", "rks_project_get"],
      committed: ["rks_git_push", "rks_staging_pr", "rks_agent_git", "rks_project_get"],
      pr_created: ["rks_git_merge", "rks_agent_git", "rks_project_get"],
      merging: ["rks_cycle_complete", "rks_agent_git", "rks_project_get"],
      shipped: ["rks_project_get"],
      failed: ["rks_project_get"],
    };
    expect(Object.keys(PRE_FIX).sort()).toEqual(Object.keys(SHIP_STATES).sort());
    for (const [state, tools] of Object.entries(PRE_FIX)) {
      for (const tool of tools) expect(checkStateAllowed("ship", state, tool).allowed, `${state}/${tool}`).toBe(true);
    }
  });

  it("pr_created and merging allowed sets are unchanged", () => {
    expect([...SHIP_STATES.pr_created.allowed].sort()).toEqual(["rks_agent_git", "rks_git_merge", "rks_project_get"]);
    expect([...SHIP_STATES.merging.allowed].sort()).toEqual(["rks_agent_git", "rks_cycle_complete", "rks_project_get"]);
  });
});
