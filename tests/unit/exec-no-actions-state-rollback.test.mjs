import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSession,
  validateToken,
  advanceState,
  advanceStateOnResult,
  getSession,
  endSession,
  setPendingStash,
  clearPendingStash,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { transitionOnResult } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

// We need setProjectRoot to avoid persistence errors
import { setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { assertToolAllowed } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

// Stub project root so no disk writes happen
const TEST_ROOT = "/tmp/rks-test-governor";

let token;

beforeEach(() => {
  setProjectRoot(TEST_ROOT);
  const session = createSession({ flowType: "story", problemId: "test.story" });
  token = session.token;
  // Drive: init → refining → planning → planned → executing
  advanceState(token, "rks_agent_research"); // init → refining
  advanceState(token, "rks_plan");           // refining → planning
  advanceStateOnResult(token, "plan.ok");    // planning → planned
  advanceState(token, "rks_exec");           // planned → executing
});

afterEach(() => {
  // Clean up session if still alive
  const session = getSession(token);
  if (session) endSession(token);
});

describe("governor-state — exec.no_actions and exec.error rollback", () => {
  it("transitionOnResult('story', 'executing', 'exec.no_actions') returns 'planned'", () => {
    expect(transitionOnResult("story", "executing", "exec.no_actions")).toBe("planned");
  });

  it("transitionOnResult('story', 'executing', 'exec.error') returns 'planned'", () => {
    expect(transitionOnResult("story", "executing", "exec.error")).toBe("planned");
  });

  it("advanceStateOnResult with exec.no_actions transitions executing → planned", () => {
    const result = advanceStateOnResult(token, "exec.no_actions");
    expect(result?.transitioned).toBe(true);
    expect(result?.previousState).toBe("executing");
    expect(result?.newState).toBe("planned");
  });

  it("after exec.no_actions rollback, session state is planned", () => {
    advanceStateOnResult(token, "exec.no_actions");
    const session = getSession(token);
    expect(session?.state).toBe("planned");
  });

  it("after exec.no_actions rollback, rks_refine is allowed (regression: was blocked)", () => {
    advanceStateOnResult(token, "exec.no_actions");
    const check = assertToolAllowed(token, "rks_refine");
    expect(check).toBeNull(); // null = allowed
  });

  it("after exec.no_actions rollback, rks_plan is allowed", () => {
    advanceStateOnResult(token, "exec.no_actions");
    const check = assertToolAllowed(token, "rks_plan");
    expect(check).toBeNull();
  });

  it("after exec.no_actions rollback, rks_agent_research is allowed", () => {
    advanceStateOnResult(token, "exec.no_actions");
    const check = assertToolAllowed(token, "rks_agent_research");
    expect(check).toBeNull();
  });

  // Regression: existing transitions must be unchanged
  it("transitionOnResult('story', 'executing', 'exec.ok') still returns 'executed'", () => {
    expect(transitionOnResult("story", "executing", "exec.ok")).toBe("executed");
  });

  it("transitionOnResult('story', 'executing', 'exec.failed') still returns 'test-failed'", () => {
    expect(transitionOnResult("story", "executing", "exec.failed")).toBe("test-failed");
  });

  it("advanceStateOnResult with exec.ok still transitions executing → executed (regression)", () => {
    const result = advanceStateOnResult(token, "exec.ok");
    expect(result?.newState).toBe("executed");
  });

  it("advanceStateOnResult with exec.failed still transitions executing → test-failed (regression)", () => {
    const result = advanceStateOnResult(token, "exec.failed");
    expect(result?.newState).toBe("test-failed");
  });
});

describe("governor-token — stash tracking", () => {
  it("setPendingStash records session.pendingStash on the session", () => {
    const noop = async () => {};
    setPendingStash(token, noop);
    const session = getSession(token);
    expect(session?.pendingStash).toBe(true);
  });

  it("clearPendingStash unsets session.pendingStash", () => {
    const noop = async () => {};
    setPendingStash(token, noop);
    clearPendingStash(token);
    const session = getSession(token);
    expect(session?.pendingStash).toBe(false);
  });

  it("registered cleanup function is called on session end in terminal state", async () => {
    const popFn = vi.fn().mockResolvedValue({ ok: true });
    setPendingStash(token, popFn);

    // Drive: executing → exec.ok → executed → rks_ship → shipping → ship.ok → shipped (terminal)
    advanceStateOnResult(token, "exec.ok");   // executing → executed
    advanceState(token, "rks_ship");          // executed → shipping
    advanceStateOnResult(token, "ship.ok");   // shipping → shipped (terminal, endSession fires)
    // Give microtask queue a tick for Promise.resolve to settle
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(popFn).toHaveBeenCalledOnce();
  });

  it("cleanup NOT called if clearPendingStash was called before session ends", async () => {
    const popFn = vi.fn().mockResolvedValue({ ok: true });
    setPendingStash(token, popFn);
    clearPendingStash(token); // simulate successful manual pop

    // Drive to terminal
    advanceStateOnResult(token, "exec.ok");
    advanceState(token, "rks_ship");
    advanceStateOnResult(token, "ship.ok");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(popFn).not.toHaveBeenCalled();
  });
});
