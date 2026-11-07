import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStates } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

/**
 * backlog.fix.refine-inapplicable-status — the CONSUMER side.
 *
 * A new status the Build prompt has no branch for is worse than no new status: the
 * Governor matches nothing and its behaviour is undefined, and the cases that used
 * to fall under the refine_noop STOP rule would silently stop being handled at all.
 * These pins are the consumer half of the contract.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = fs.readFileSync(
  path.join(__dirname, "../..", ".rks/prompts/governor-build.md"),
  "utf8",
);

describe("governor-build.md carries a distinct refine_inapplicable branch", () => {
  it("names the status", () => {
    expect(PROMPT).toContain("refine_inapplicable");
  });

  it("states it is NOT a stuck story and NOT a no-op", () => {
    expect(PROMPT).toMatch(/NOT a stuck story/);
    expect(PROMPT).toMatch(/NOT a no-op/);
  });

  it("forbids reporting it as reason: 'refine_noop'", () => {
    expect(PROMPT).toMatch(/do NOT report it as reason: 'refine_noop'/i);
  });

  it("tells the Governor not to abort on this result alone", () => {
    expect(PROMPT).toMatch(/Do NOT abort on this result alone/i);
  });

  it("keeps the refine_noop STOP rule scoped to refine_noop", () => {
    // The original rule must survive unchanged — this story adds a branch, it does
    // not soften the existing one.
    expect(PROMPT).toContain("## refine_noop — refine changed nothing. STOP. Do not re-plan.");
    expect(PROMPT).toMatch(/\{ status: 'failed', reason: 'refine_noop'/);
  });

  it("is additive — the forbidden replan phrase is still absent", () => {
    // governor-build-refinement-replan.test.mjs pins this absence; the new branch
    // must not reintroduce it by paraphrase.
    expect(PROMPT).not.toContain("Re-run rks_plan to retry");
  });

  it("introduces no duplicate numbered step marker", () => {
    // Each `N. **` marker within a section must be unique; a repeated one makes the
    // chain ambiguous to a Governor following it literally.
    const markers = PROMPT.split("\n").filter((l) => /^\d+\. \*\*/.test(l));
    expect(new Set(markers).size).toBe(markers.length);
  });
});

describe("the state machine admits the new result key", () => {
  // Asserted by DIRECT own-property inspection of the transition tables. Routing
  // this through transitionOnResult would be vacuous: an unmapped key and a mapped
  // self-loop both return currentState, so the assertion would pass before the edit
  // as well as after (the VACUITY PIN named in governor-state-refine-noop.test.mjs).
  const storyStates = getStates("story");

  it.each([
    ["refining", "refining"],
    ["child_active", "child_active"],
  ])("%s carries refine_apply.inapplicable as a self-loop", (stateName, expected) => {
    const table = storyStates[stateName].resultTransitions;
    expect(Object.prototype.hasOwnProperty.call(table, "refine_apply.inapplicable")).toBe(true);
    expect(table["refine_apply.inapplicable"]).toBe(expected);
  });

  it("leaves the existing no-op keys untouched", () => {
    expect(storyStates.refining.resultTransitions["refine_apply.noop"]).toBe("refining");
    expect(storyStates.refining.resultTransitions["refine_apply.noop_repeated"]).toBe("escalated");
    expect(storyStates.child_active.resultTransitions["refine_apply.noop"]).toBe("child_active");
    expect(storyStates.child_active.resultTransitions["refine_apply.noop_repeated"]).toBe("escalated");
  });
});
