/**
 * backlog.fix.planned-state-plan-contents-disclosure
 *
 * A plan could not be byte-verified before it executed. Admitting rks_exhaustive_search to
 * `planned` (its sibling story) supplies only "does the tree contain this literal" — it does
 * not supply "what does the plan SAY". Every tool reachable from `planned` failed at that:
 * rks_plan_review returned no plan contents on a PASSING review, rks_exec dryRun both
 * previewed null for search_replace steps and demoted the chain to `executing`, and
 * dendron_read_note is not admitted there at all.
 *
 * These assertions target the exported shapers rather than server.mjs source text: server.mjs
 * has no live unit harness and this project forbids source-text assertions, which is precisely
 * why the shaping logic lives in plan-quality.mjs.
 */
import { describe, it, expect } from "vitest";
import {
  resolvedPlanIdentity,
  describePlanContents,
  isStatePreservingCall,
  PLAN_DISCLOSURE_MAX_STEPS,
} from "../../packages/mcp-rks/src/server/plan-quality.mjs";

describe("resolvedPlanIdentity — which plan does this review describe", () => {
  it("carries all five identity fields", () => {
    const r = resolvedPlanIdentity({
      planPath: "/runs/abc/plan.json", runDir: "/runs/abc",
      slug: "my-slug", problemId: "backlog.fix.x", identifiedBy: "problemId",
    });
    expect(r).toEqual({
      planPath: "/runs/abc/plan.json", runDir: "/runs/abc",
      slug: "my-slug", problemId: "backlog.fix.x", identifiedBy: "problemId",
    });
  });

  it("defaults every field to null rather than omitting it", () => {
    // A missing key and an explicitly-null key read very differently to a caller trying to
    // work out whether identity was unavailable or simply not attached.
    expect(resolvedPlanIdentity()).toEqual({
      planPath: null, runDir: null, slug: null, problemId: null, identifiedBy: null,
    });
  });

  it("identifiedBy records HOW the run dir was chosen", () => {
    // Two stories wanted this object for different reasons; identifiedBy is what makes
    // cross-story bleed (a review describing a different story's plan) detectable at all.
    expect(resolvedPlanIdentity({ identifiedBy: "latest" }).identifiedBy).toBe("latest");
  });
});

describe("describePlanContents — what will this plan actually do", () => {
  const searchReplacePlan = {
    steps: [
      {
        action: "search_replace",
        path: "src/a.mjs",
        edits: [
          { search: "export function a() {", replace: "export function a(x) {" },
          { search: "const B = 1;", replace: "const B = 2;" },
        ],
      },
      { action: "create_file", path: "src/b.mjs", content: "export const b = 1;\n" },
      { action: "note", target: null },
    ],
  };

  it("exposes the search text of a search_replace step", () => {
    // THE load-bearing case. Payload lives on `edits`, so every previous content-only preview
    // returned null for exactly the step type that needs verifying before it runs.
    const d = describePlanContents(searchReplacePlan);
    expect(d.steps[0].search).toEqual([
      "export function a() {",
      "const B = 1;",
    ]);
    expect(d.steps[0].editCount).toBe(2);
  });

  it("reports an exact step count and per-step action and target", () => {
    const d = describePlanContents(searchReplacePlan);
    expect(d.stepCount).toBe(3);
    expect(d.steps.map((s) => s.action)).toEqual(["search_replace", "create_file", "note"]);
    expect(d.steps.map((s) => s.target)).toEqual(["src/a.mjs", "src/b.mjs", null]);
  });

  it("handles a step carrying a bare `search` rather than an edits array", () => {
    const d = describePlanContents({ steps: [{ action: "search_replace", path: "x", search: "abc" }] });
    expect(d.steps[0].search).toEqual(["abc"]);
  });

  it("is empty and non-throwing for a plan with no steps", () => {
    for (const input of [{}, null, undefined, { steps: "not-an-array" }]) {
      const d = describePlanContents(input);
      expect(d.stepCount).toBe(0);
      expect(d.steps).toEqual([]);
      expect(d.truncated).toBe(false);
      expect(d.omittedSteps).toBe(0);
      expect(d.truncationReason).toBeNull();
    }
  });

  it("truncates the step list but never the count", () => {
    const steps = Array.from({ length: PLAN_DISCLOSURE_MAX_STEPS + 5 }, () => ({ action: "note" }));
    const d = describePlanContents({ steps });
    expect(d.stepCount).toBe(PLAN_DISCLOSURE_MAX_STEPS + 5);
    expect(d.steps).toHaveLength(PLAN_DISCLOSURE_MAX_STEPS);
    expect(d.truncated).toBe(true);
  });

  it("says WHAT was withheld and why, not merely that something was", () => {
    // "Can I confirm I have seen all of them?" is unanswerable from a bare boolean without
    // knowing the cap, so the cap and the withheld count travel with the flag.
    const steps = Array.from({ length: PLAN_DISCLOSURE_MAX_STEPS + 5 }, () => ({ action: "note" }));
    const d = describePlanContents({ steps });
    expect(d.maxSteps).toBe(PLAN_DISCLOSURE_MAX_STEPS);
    expect(d.omittedSteps).toBe(5);
    expect(d.truncationReason).toContain(String(PLAN_DISCLOSURE_MAX_STEPS));
    expect(d.truncationReason).toContain(String(PLAN_DISCLOSURE_MAX_STEPS + 5));
  });

  it("does not report truncation when everything fits", () => {
    const d = describePlanContents({ steps: [{ action: "note" }] });
    expect(d.truncated).toBe(false);
    expect(d.omittedSteps).toBe(0);
    expect(d.truncationReason).toBeNull();
  });
});

describe("isStatePreservingCall — a dry run must not move the chain", () => {
  it("treats rks_exec with dryRun as state-preserving", () => {
    expect(isStatePreservingCall("rks_exec", { dryRun: true })).toBe(true);
  });

  it("does NOT treat a real rks_exec as state-preserving", () => {
    // If this ever returns true, exec stops advancing to `executing` and the chain stalls —
    // a far worse failure than the one being fixed.
    expect(isStatePreservingCall("rks_exec", { dryRun: false })).toBe(false);
    expect(isStatePreservingCall("rks_exec", {})).toBe(false);
    expect(isStatePreservingCall("rks_exec")).toBe(false);
  });

  it("is scoped to rks_exec — dryRun on another tool does not exempt it", () => {
    expect(isStatePreservingCall("rks_plan", { dryRun: true })).toBe(false);
    expect(isStatePreservingCall("rks_refine", { dryRun: true })).toBe(false);
  });

  it("gives the same verdict for the entry and result call sites", () => {
    // The first version of this fix guarded only the entry transition. A dry run returns
    // ok:true, so the result path computed 'exec.ok' and advanced the chain exactly as if the
    // plan had been applied — leaving the entry guard doing nothing observable.
    //
    // An earlier version of this test asserted f(x) === f(x), which is a tautology and proved
    // nothing; it was flagged in review and replaced. What is actually assertable at unit
    // level is that ONE predicate decides both sites, so they cannot drift apart — the two
    // sites pass different variable names for the same values, so the meaningful check is
    // that the predicate is a pure function of (tool, args) and both spellings agree.
    const entryArgs = { dryRun: true, projectId: "p", slug: "s" };
    const resultArgs = { dryRun: true, projectId: "p", slug: "s", extra: "ignored" };
    expect(isStatePreservingCall("rks_exec", entryArgs)).toBe(true);
    expect(isStatePreservingCall("rks_exec", resultArgs)).toBe(true);
    // And the negative case agrees at both sites too, which is the direction that would
    // silently stall the chain if it ever diverged.
    expect(isStatePreservingCall("rks_exec", { ...entryArgs, dryRun: false })).toBe(false);
    expect(isStatePreservingCall("rks_exec", { ...resultArgs, dryRun: false })).toBe(false);
  });

  it("treats a truthy non-boolean dryRun as a dry run", () => {
    // MCP args arrive as JSON; a caller sending "true" must not silently get a real exec.
    expect(isStatePreservingCall("rks_exec", { dryRun: "true" })).toBe(true);
  });
});

describe("describePlanContents — edge shapes", () => {
  it("returns an empty search list and zero editCount for an empty edits array", () => {
    const d = describePlanContents({ steps: [{ action: "search_replace", path: "x", edits: [] }] });
    expect(d.steps[0].search).toEqual([]);
    expect(d.steps[0].editCount).toBe(0);
  });

  it("returns an empty search list when neither edits nor search is present", () => {
    const d = describePlanContents({ steps: [{ action: "create_file", path: "x", content: "y" }] });
    expect(d.steps[0].search).toEqual([]);
  });

  it("drops non-string search values rather than emitting nulls into the list", () => {
    const d = describePlanContents({ steps: [{ action: "search_replace", edits: [{ search: 5 }, { search: "ok" }] }] });
    expect(d.steps[0].search).toEqual(["ok"]);
  });
});
