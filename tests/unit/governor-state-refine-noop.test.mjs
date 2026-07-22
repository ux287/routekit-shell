/**
 * Witness for backlog.fix.build-governor-self-heal — the escalation has somewhere to GO.
 *
 * When refine_apply changes nothing, the chain must leave the loop. That requires three things to
 * line up, and getting any one of them wrong just moves the wedge:
 *
 *   1. The resultKey must land on the state the session is ACTUALLY IN at result time. `advanceState`
 *      runs on tool ENTRY and moves `test-failed` → `refining`, so by the time a refine_apply RESULT
 *      arrives the session is in `refining` — NEVER `test-failed`. A resultTransitions map on
 *      `test-failed` would be dead code, and a witness driving `transitionOnResult` from there would
 *      be VACUOUSLY GREEN. (This repo already pinned that trap once, in
 *      exec-abort-allowed-in-test-failed.test.mjs.)
 *
 *   2. The destination must permit the tool the Build Governor prompt actually names. A prompt that
 *      prescribes a tool the chain guard forbids is a NEW wedge replacing the old one.
 *
 *   3. That permission must be PAIRED with a transition. A tool in `allowed` with no `transitions`
 *      entry is permitted but never moves the state — half-wired, and stuck.
 *
 * All driven through the real exported helpers.
 */
import { describe, it, expect } from "vitest";
import {
  checkStateAllowed,
  getNextState,
  transitionOnResult,
  isTerminal,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

describe("refine_apply.noop routes to `escalated`", () => {
  it("from `refining` — the state the session is REALLY in at result time", () => {
    expect(transitionOnResult("story", "refining", "refine_apply.noop")).toBe("escalated");
  });

  it("from `child_active` — a decomposed child would otherwise loop one level down", () => {
    // `child_active` permits rks_plan, so without this a child whose refine no-ops re-plans an
    // unchanged story forever — the same bug, wearing a different hat.
    expect(transitionOnResult("story", "child_active", "refine_apply.noop")).toBe("escalated");
  });

  it("the decompose result still routes as before (no regression)", () => {
    expect(transitionOnResult("story", "refining", "refine_apply.decomposed")).toBe("decomposing");
  });

  it("VACUITY PIN: `test-failed` has no resultTransitions — asserting through it proves nothing", () => {
    // Deliberately pinned. An earlier draft of this story put the resultKey on `test-failed`. The
    // session is never there at result time (entry already moved it to `refining`), so the map would
    // never be consulted — and this assertion would have been green forever, against a fix that did
    // nothing.
    expect(transitionOnResult("story", "test-failed", "refine_apply.noop")).toBe("test-failed");
  });
});

describe("`escalated` can do exactly one thing: stop", () => {
  it("PERMITS the tool the Build Governor prompt actually names (rks_exec_abort)", () => {
    expect(checkStateAllowed("story", "escalated", "rks_exec_abort").allowed).toBe(true);
  });

  it("and that permission is PAIRED with a transition (not half-wired)", () => {
    expect(getNextState("story", "escalated", "rks_exec_abort")).toBe("failed");
  });

  // THE CLAIM. Every one of these is a way back into the loop the escalation exists to break.
  it("BLOCKS every route back into the loop", () => {
    for (const tool of ["rks_plan", "rks_plan_ready", "rks_refine", "rks_refine_apply", "rks_exec"]) {
      const verdict = checkStateAllowed("story", "escalated", tool);
      expect(verdict.allowed, `${tool} must NOT be allowed from escalated`).toBe(false);
    }
  });

  it("is NOT a dead end — the Governor can still explain why it is stuck", () => {
    // If `escalated` permitted nothing, we would have replaced one wedge with another.
    for (const tool of ["rks_agent_research", "rks_project_get"]) {
      expect(checkStateAllowed("story", "escalated", tool).allowed).toBe(true);
    }
  });

  it("is NOT terminal; `failed` is", () => {
    expect(isTerminal("story", "escalated")).toBe(false);
    expect(isTerminal("story", "failed")).toBe(true);
  });
});
