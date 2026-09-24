/**
 * Witness for backlog.fix.exec-rollback-strands-executing-phase — W4.
 *
 * `rks_exec_abort` is the only registered tool that can un-strand a story left at phase `executing`.
 * It was reachable from state `executing` — but NOT from `test-failed`, which is the state an exec
 * failure actually lands in (server.mjs maps every exec failure to `exec.failed` →
 * `executing.resultTransitions` → `test-failed`). So the one recovery tool was unreachable from the
 * one state that needed it.
 *
 * The permission must be a PAIR. Adding a tool to `.allowed` without a matching `.transitions` entry
 * permits the call but never moves the state — a half-wired permission, and its own kind of wedge.
 * `executing` pairs them correctly; this mirrors that.
 *
 * Driven through the REAL exported helpers. Note the helper is `checkStateAllowed` — an earlier
 * draft of this story specified `transitionOnResult`, which keys on RESULT keys ('exec.ok') rather
 * than tool names, and which `test-failed` has no map for at all: that assertion would have been
 * VACUOUSLY GREEN. `getNextState` is the tool-name helper.
 */
import { describe, it, expect } from "vitest";
import {
  checkStateAllowed,
  getNextState,
  transitionOnResult,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

describe("rks_exec_abort is reachable from test-failed (the state an exec failure lands in)", () => {
  it("ALLOWS rks_exec_abort from test-failed", () => {
    const verdict = checkStateAllowed("story", "test-failed", "rks_exec_abort");
    expect(verdict.allowed).toBe(true);
  });

  it("MOVES THE STATE — the permission is paired with a transition, not half-wired", () => {
    // Without this, the tool is permitted but the state machine never advances: allowed-but-inert,
    // which is exactly the class of bug this story exists to kill.
    expect(getNextState("story", "test-failed", "rks_exec_abort")).toBe("failed");
  });

  it("mirrors the pairing that `executing` already gets right", () => {
    expect(checkStateAllowed("story", "executing", "rks_exec_abort").allowed).toBe(true);
    expect(getNextState("story", "executing", "rks_exec_abort")).toBe("failed");
  });

  // NEGATIVE CONTROL. Without this, "the tool is allowed" would also be true of a state that allows
  // everything — the assertion above would pass for the wrong reason.
  it("NEGATIVE CONTROL: test-failed still REJECTS a tool that has no business there", () => {
    const verdict = checkStateAllowed("story", "test-failed", "rks_story_ship");
    expect(verdict.allowed).toBe(false);
    expect(verdict.error).toMatch(/not allowed in state 'test-failed'/);
  });

  it("the refine tools remain allowed from test-failed (no regression)", () => {
    expect(checkStateAllowed("story", "test-failed", "rks_refine").allowed).toBe(true);
    expect(checkStateAllowed("story", "test-failed", "rks_refine_apply").allowed).toBe(true);
    expect(getNextState("story", "test-failed", "rks_refine")).toBe("refining");
  });

  it("transitionOnResult is the WRONG helper here — it is keyed on result keys, and test-failed has no map", () => {
    // Pinned deliberately: an earlier draft of this witness asserted through transitionOnResult and
    // would have been vacuously green forever. `test-failed` defines no `resultTransitions`, so this
    // returns the current state for ANY key — it can never fail, and therefore can never witness.
    expect(transitionOnResult("story", "test-failed", "exec.failed")).toBe("test-failed");
    expect(transitionOnResult("story", "test-failed", "anything.at.all")).toBe("test-failed");
  });
});
