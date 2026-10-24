/**
 * backlog.feat.executed-state-post-write-verification — Part A, the state table.
 *
 * After rks_exec, a Build Governor had no permitted route to verify what it had just
 * written: rks_exhaustive_search and dendron_read_note were state-blocked in `executed`,
 * Read/Grep were hook-blocked on "no provenance", and rks_agent_git truncates and says so.
 * Observed in the field — a Governor completed exec, was asked to confirm two analyzer gates
 * against the file it created, could reach it by no route, and correctly refused to report a
 * truncated scan as a pass.
 *
 * These assert through checkStateAllowed — the function the enforcement path actually calls —
 * rather than reaching into the STATE table, so a change that satisfies the table but not the
 * gate cannot pass.
 */
import { describe, it, expect } from "vitest";
import { checkStateAllowed, getNextState } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const READ_ONLY_VERIFIERS = ["rks_exhaustive_search", "dendron_read_note"];

describe("story/executed admits read-only verification", () => {
  it.each(READ_ONLY_VERIFIERS)("%s is allowed in executed", (tool) => {
    expect(checkStateAllowed("story", "executed", tool).allowed).toBe(true);
  });

  it("ANTI-VACUITY: the same tools are still denied in a state that must not admit them", () => {
    // Without this, the assertions above would pass equally against a checkStateAllowed that
    // had been broadened to allow everything.
    expect(checkStateAllowed("story", "shipping", "rks_exhaustive_search").allowed).toBe(false);
    expect(checkStateAllowed("story", "shipping", "dendron_read_note").allowed).toBe(false);
  });

  it("opens NO write path — every mutating tool stays denied in executed", () => {
    for (const tool of [
      "rks_exec",
      "rks_refine",
      "rks_refine_apply",
      "rks_plan",
      "dendron_edit_note",
      "dendron_update_field",
      "dendron_create_note",
      "rks_git_commit",
    ]) {
      expect(checkStateAllowed("story", "executed", tool).allowed, `${tool} must stay denied`).toBe(false);
    }
  });

  it("adds NO transition — executed still advances only via ship", () => {
    // A verification tool that moved the chain forward would be a second defect, not a fix.
    // Asserted against the CAPTURED state rather than a repeated string literal: a literal on
    // both sides of the comparison can be satisfied by a getNextState that ignores its input.
    const stateBefore = "executed";
    for (const tool of READ_ONLY_VERIFIERS) {
      expect(getNextState("story", stateBefore, tool)).toBe(stateBefore);
    }
    expect(getNextState("story", "executed", "rks_ship")).toBe("shipping");
    expect(getNextState("story", "executed", "rks_story_ship")).toBe("shipping");
  });

  it("leaves the SHIP flow's deliberate denial intact", () => {
    // governor-state.test.mjs pins this as policy: the ship flow's commit chain stays gated.
    // Widening executed must not leak across flows.
    expect(checkStateAllowed("ship", "committed", "rks_exhaustive_search").allowed).toBe(false);
  });
});
