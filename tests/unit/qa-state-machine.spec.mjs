import { describe, it, expect } from "vitest";
import { checkStateAllowed, getNextState } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { createSession, assertToolAllowed, advanceState, endSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

describe("QA flow state machine", () => {
  it("allows dendron_update_field in QA init state", () => {
    const result = checkStateAllowed("qa", "init", "dendron_update_field");
    expect(result.allowed).toBe(true);
  });

  it("allows dendron_update_field in QA researching state", () => {
    const result = checkStateAllowed("qa", "researching", "dendron_update_field");
    expect(result.allowed).toBe(true);
  });

  it("allows dendron_read_note in QA init state", () => {
    const result = checkStateAllowed("qa", "init", "dendron_read_note");
    expect(result.allowed).toBe(true);
  });

  it("transitions from init to researching on rks_agent_research", () => {
    const next = getNextState("qa", "init", "rks_agent_research");
    expect(next).toBe("researching");
  });

  it("stays in init on dendron_update_field (no transition)", () => {
    const next = getNextState("qa", "init", "dendron_update_field");
    expect(next).toBe("init");
  });
});

describe("QA flow proto-story guard", () => {
  it("allows QA flow to set phase to ready", () => {
    const { token } = createSession({ projectId: "test", flowType: "qa" });
    const result = assertToolAllowed(token, "dendron_update_field", {
      field: "phase",
      value: "ready",
      filename: "backlog.feat.test-story",
    });
    expect(result).toBeNull();
    endSession(token);
  });

  it("allows open flow to set phase to ready", () => {
    const { token } = createSession({ projectId: "test", flowType: "open" });
    // Advance to 'writing' state where dendron_update_field is allowed
    advanceState(token, "dendron_create_note");
    const result = assertToolAllowed(token, "dendron_update_field", {
      field: "phase",
      value: "ready",
      filename: "backlog.feat.test-story",
    });
    expect(result).toBeNull();
    endSession(token);
  });

  it("blocks story flow from setting phase to ready", () => {
    const { token } = createSession({ projectId: "test", problemId: "backlog.feat.test", flowType: "story" });
    // Advance to 'refining' state where dendron_update_field is allowed in story flow
    advanceState(token, "rks_refine");
    const result = assertToolAllowed(token, "dendron_update_field", {
      field: "phase",
      value: "ready",
      filename: "backlog.feat.test-story",
    });
    expect(result).not.toBeNull();
    expect(result.error).toBe("proto_story_guard");
    endSession(token);
  });
});

describe("existing flow tests unchanged", () => {
  it("story flow init still allows rks_refine", () => {
    const result = checkStateAllowed("story", "init", "rks_refine");
    expect(result.allowed).toBe(true);
  });

  it("story flow init allows dendron_update_field (hook chain misconfig fix shipped at 89690c78 — wrapper symmetry)", () => {
    // Was previously asserted as blocked — pinned the bug, not the contract.
    // After the symmetry fix in governor-state.mjs (STORY_STATES.init now
    // permits the wrapper rks_agent_dendron AND the four underlying dendron
    // tools), this assertion flips to true. See tests/unit/governor-state.test.mjs
    // for the class-wide symmetry pin that prevents regression.
    const result = checkStateAllowed("story", "init", "dendron_update_field");
    expect(result.allowed).toBe(true);
  });

  it("open flow init still allows rks_agent_research", () => {
    const result = checkStateAllowed("open", "init", "rks_agent_research");
    expect(result.allowed).toBe(true);
  });

  it("open flow researching allows dendron_update_field", () => {
    const result = checkStateAllowed("open", "researching", "dendron_update_field");
    expect(result.allowed).toBe(true);
  });
});
