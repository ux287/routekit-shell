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

describe("a FIRST refine_apply.noop self-loops; the REPEAT escalates", () => {
  // backlog.fix.refine-noop-escalation-false-positive — EXPECTATION DELIBERATELY CHANGED.
  //
  // These two assertions previously required `escalated` on the FIRST no-op. That was too eager:
  // three separate mechanisms produced no-ops that were never real (a zod-stripped payload, a
  // silently-dropped refinement, and a detector that disagreed with its own applier), and each one
  // terminated a healthy build on the first occurrence.
  //
  // The anti-loop guarantee that motivated backlog.fix.build-governor-self-heal is NOT abandoned —
  // it moved to a distinct result key. `advanceStateOnResult` counts consecutive no-ops on the
  // session and substitutes `refine_apply.noop_repeated` once the streak trips, which still routes
  // to `escalated` (pinned below). What changed is WHEN, not WHETHER.
  //
  // The self-loop targets are forced, not chosen: the destination must permit rks_refine,
  // rks_refine_apply AND rks_plan together so the Governor can act on the now-populated
  // `escalation.skipped` ledger, and `refining` / `child_active` are the only states that do.

  it("from `refining` — first no-op stays put, keeping the refine tools reachable", () => {
    expect(transitionOnResult("story", "refining", "refine_apply.noop")).toBe("refining");
  });

  it("from `child_active` — same, one level down", () => {
    expect(transitionOnResult("story", "child_active", "refine_apply.noop")).toBe("child_active");
  });

  it("the self-loop destination permits the recovery tools (that is WHY it is the destination)", () => {
    for (const tool of ["rks_refine", "rks_refine_apply", "rks_plan"]) {
      expect(checkStateAllowed("story", "refining", tool).allowed).toBe(true);
    }
  });

  it("REPEAT escalates from `refining` — the anti-loop guarantee survives", () => {
    expect(transitionOnResult("story", "refining", "refine_apply.noop_repeated")).toBe("escalated");
  });

  it("REPEAT escalates from `child_active` too — fixing only the parent leaves the child looping", () => {
    // `child_active` permits rks_plan, so without this a child whose refine no-ops re-plans an
    // unchanged story forever — the same bug, wearing a different hat.
    expect(transitionOnResult("story", "child_active", "refine_apply.noop_repeated")).toBe("escalated");
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
