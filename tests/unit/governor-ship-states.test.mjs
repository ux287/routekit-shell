import { describe, it, expect } from "vitest";
import {
  SHIP_FLOW_TOOLS, QA_FLOW_TOOLS, SHIP_STATES,
  getStates, checkStateAllowed, transitionOnResult, isTerminal,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

// ── Existing SHIP_FLOW_TOOLS / QA_FLOW_TOOLS tests ─────────────────

describe("SHIP_FLOW_TOOLS export", () => {
  it("is exported as a Set with exactly 7 members", () => {
    expect(SHIP_FLOW_TOOLS).toBeInstanceOf(Set);
    expect(SHIP_FLOW_TOOLS.size).toBe(8);
  });

  it("contains all required ship-phase tools", () => {
    const expected = [
      "rks_governor_init",
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
  it("init allows rks_git_commit, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.init.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_git_commit", "rks_project_get"]
    );
  });

  it("committed allows rks_git_push, rks_staging_pr, rks_agent_git, rks_project_get only", () => {
    expect([...SHIP_STATES.committed.allowed].sort()).toEqual(
      ["rks_agent_git", "rks_git_push", "rks_project_get", "rks_staging_pr"]
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
