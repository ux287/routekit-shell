/**
 * Story: backlog.feat.build-governor-rks-analyze-recovery
 *
 * Asserts the Build Governor prompt (.rks/prompts/governor-build.md) documents
 * the analyze-required recovery clause at step 4 and narrows the rks_analyze
 * prohibition in the Rules section — so when rks_plan/rks_plan_review surfaces
 * "Run rks.analyze before planning", the Build Governor self-heals (call
 * rks_analyze once → retry rks_plan once) instead of dead-ending into an Ops
 * Governor detour.
 *
 * These are prompt-content assertions (the fix is a prompt edit). They also
 * guard that the rest of the build chain (steps 1-3, 5-7) is structurally intact.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT = path.resolve(__dirname, "../../.rks/prompts/governor-build.md");

let text = "";
/** Slice of the prompt belonging to step 4 (between the "4." line and the "5." line). */
let step4 = "";
/** The Rules section (from "## Rules" to EOF). */
let rules = "";

beforeAll(() => {
  text = fs.readFileSync(PROMPT, "utf8");
  const s4 = text.indexOf("\n4. mcp__rks__rks_plan(");
  const s5 = text.indexOf("\n5. POLL rks_plan_review");
  expect(s4, "step 4 marker present").toBeGreaterThan(-1);
  expect(s5, "step 5 marker present").toBeGreaterThan(s4);
  step4 = text.slice(s4, s5);
  const r = text.indexOf("## Rules");
  expect(r, "Rules section present").toBeGreaterThan(-1);
  rules = text.slice(r);
});

describe("governor-build.md — analyze-required recovery clause (step 4)", () => {
  it("step 4 fires on the analyze-required signal", () => {
    expect(step4).toMatch(/Run rks\.analyze before planning/);
    expect(step4.toLowerCase()).toContain("analyze-required recovery");
  });

  it("calls rks_analyze exactly once with projectId, problemId, and _governorToken", () => {
    expect(step4).toMatch(/rks_analyze\(\{[^}]*projectId[^}]*problemId[^}]*_governorToken[^}]*\}\)/);
    expect(step4).toMatch(/exactly once/);
  });

  it("retries rks_plan exactly once after analyze", () => {
    expect(step4).toMatch(/Retry rks_plan[^\n]*exactly once/i);
  });

  it("stops with plan_generation_failed if the retry still fails — no second analyze, no loop", () => {
    expect(step4).toMatch(/STOP and return \{ status: 'failed', reason: 'plan_generation_failed' \}/);
    expect(step4).toMatch(/Do NOT call rks_analyze a second time/i);
  });
});

describe("governor-build.md — Rules section narrows the rks_analyze prohibition", () => {
  it("permits rks_analyze SOLELY as the step-4 recovery action", () => {
    expect(rules).toMatch(/rks_analyze` is permitted SOLELY as the step-4 analyze-required recovery action/);
  });

  it("still states rks_analyze is forbidden in every other context", () => {
    expect(rules).toMatch(/remains FORBIDDEN in every other context/);
  });

  it("removed rks_analyze from the blanket 'Do NOT call' tool list", () => {
    const doNotCall = rules.match(/Do NOT call dendron_read_note[^\n]*/);
    expect(doNotCall, "the blanket Do NOT call line is present").not.toBeNull();
    expect(doNotCall[0]).not.toContain("rks_analyze");
  });
});

describe("governor-build.md — rest of the build chain is structurally intact", () => {
  it("steps 1-3 unchanged markers present", () => {
    expect(text).toMatch(/\n1\. mcp__rks__rks_refine\(/);
    expect(text).toMatch(/\n2\. mcp__rks__rks_agent_research\(/);
    expect(text).toMatch(/\n3\. mcp__rks__rks_refine\(/);
  });

  it("steps 5-7 unchanged markers present", () => {
    expect(text).toMatch(/\n5\. POLL rks_plan_review/);
    expect(text).toMatch(/\n6\. mcp__rks__rks_exec\(/);
    expect(text).toMatch(/\n7\. mcp__rks__rks_story_ship\(/);
  });
});
