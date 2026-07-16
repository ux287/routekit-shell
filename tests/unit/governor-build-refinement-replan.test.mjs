/**
 * Tests for the bounded refine->replan recovery loop in .rks/prompts/governor-build.md.
 *
 * Story: backlog.fix.build-governor-refinement-required-replan-loop (UAT finding F4)
 *
 * Prompt-content assertions (the prompt is the deliverable): on a plan that returns
 * refinement_required, the Build Governor must run a bounded refine->replan loop
 * (not hard-STOP), distinct from the analyze-required recovery clause and from
 * decompose-STOP, grounded in the refining-state transition.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.resolve(__dirname, "../../.rks/prompts/governor-build.md");
const prompt = fs.readFileSync(promptPath, "utf8");

describe("governor-build.md — bounded refine->replan recovery loop (F4)", () => {
  it("has a refinement-required recovery clause", () => {
    expect(prompt).toContain("Refinement-required recovery");
    expect(prompt).toContain("refinement_required");
  });

  it("is a bounded loop with an explicit max iteration cap (not infinite)", () => {
    expect(prompt).toMatch(/max 2 iterations/);
    expect(prompt).toMatch(/After 2 refinement_required iterations/);
  });

  it("loops back to re-run rks_plan and resumes the poll on planning", () => {
    expect(prompt).toMatch(/Re-run rks_plan \(this step\)/);
    expect(prompt).toMatch(/returns status: "planning", resume the normal step 5 poll/);
  });

  it("has a terminal STOP (refinement_loop_exhausted) with a no-further-loop directive", () => {
    expect(prompt).toContain("refinement_loop_exhausted");
    expect(prompt).toMatch(/Do NOT loop further/);
  });

  it("applies refine_apply conditionally (only when refinements present — no no-op apply)", () => {
    expect(prompt).toMatch(/only when refinements are actually present/);
  });

  it("preserves decompose-STOP and keeps decompose OUT of the loop", () => {
    expect(prompt).toMatch(/decompose NEVER enters or continues this loop/);
    expect(prompt).toContain("STOP per decompose rule");
  });

  it("keeps the refinement loop DISTINCT from the analyze-required recovery clause (both present)", () => {
    expect(prompt).toContain("Refinement-required recovery");
    expect(prompt).toContain("Analyze-required recovery");
  });

  it("grounds the loop in the refining-state transition", () => {
    expect(prompt).toContain("'plan.failed': 'refining'");
    expect(prompt).toMatch(/refining` state/);
  });

  it("scopes the planning-only constraint so it does not forbid the refining-state recovery", () => {
    expect(prompt).toMatch(/blocks everything else in the `planning` state/);
    expect(prompt).toMatch(/A `refinement_required` result is NOT `planning`/);
  });

  it("does not retain a bare 'Re-run rks_plan to retry' remedy for refinement_required", () => {
    // F3 owns the server-side worker_crashed message; this prompt routes refinement_required
    // into the bounded loop, not a standalone re-run instruction.
    expect(prompt).not.toContain("Re-run rks_plan to retry");
  });
});
