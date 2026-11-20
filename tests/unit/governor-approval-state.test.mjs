import { describe, it, expect } from "vitest";
import {
  getStates, checkStateAllowed, transitionOnResult, isTerminal,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

describe("approval-pending state", () => {
  const STORY_STATES = getStates("story");

  it("exists in STORY_STATES", () => {
    expect(STORY_STATES["approval-pending"]).toBeDefined();
  });

  it("allows exactly rks_approve, rks_agent_git, rks_project_get", () => {
    expect([...STORY_STATES["approval-pending"].allowed].sort()).toEqual(
      ["rks_agent_git", "rks_approve", "rks_project_get"]
    );
  });

  it("is not a terminal state", () => {
    expect(isTerminal("story", "approval-pending")).toBe(false);
  });
});

describe("approval-pending transitions", () => {
  it("approve.ok transitions approval-pending → executing", () => {
    expect(transitionOnResult("story", "approval-pending", "approve.ok")).toBe("executing");
  });

  it("approve.denied transitions approval-pending → failed", () => {
    expect(transitionOnResult("story", "approval-pending", "approve.denied")).toBe("failed");
  });
});

describe("exec.needs_approval result transition", () => {
  it("exec.needs_approval transitions executing → approval-pending", () => {
    expect(transitionOnResult("story", "executing", "exec.needs_approval")).toBe("approval-pending");
  });
});

describe("existing executing transitions unchanged", () => {
  it("exec.ok still transitions to executed", () => {
    expect(transitionOnResult("story", "executing", "exec.ok")).toBe("executed");
  });

  it("exec.failed still transitions to test-failed", () => {
    expect(transitionOnResult("story", "executing", "exec.failed")).toBe("test-failed");
  });

  it("exec.diverged still transitions to diverged", () => {
    expect(transitionOnResult("story", "executing", "exec.diverged")).toBe("diverged");
  });
});
