/**
 * backlog.fix.plan-review-failure-payload-names-what-failed — the plan_review failure payload
 * names what failed (uncovered targets, dropped steps, worker log) and its message matches the
 * observed reason. Spawns no subprocess.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMarkerUpdate } from "../../packages/mcp-rks/src/server/plan-marker.mjs";
import {
  classifyMarkerFailure,
  buildPlanReviewFailureResponse,
} from "../../packages/mcp-rks/src/server/failure-classification.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const NO_STEPS = "had no executable steps";
const DIAG = {
  uncoveredTargets: ["tests/unit/test_collection_guards.py"],
  droppedSteps: [{ label: "Edit foo.mjs", reason: "stale_anchor" }],
  rejectionReasons: ["anchor not found"],
  noteSteps: ["Note: verify manually"],
  uncoveredCreateTargets: ["src/new-file.mjs"],
  refinable: false,
};

describe("marker boundary carries the planner's failure diagnostics", () => {
  it("copies each diagnostic field unchanged on a failing result", () => {
    const m = buildMarkerUpdate({ ok: false, ...DIAG });
    for (const [k, v] of Object.entries(DIAG)) expect(m[k], k).toEqual(v);
  });
  it("copies none of them on a successful result", () => {
    const m = buildMarkerUpdate({ ok: true, ...DIAG });
    for (const k of Object.keys(DIAG)) expect(m).not.toHaveProperty(k);
  });
  it("never copies message onto the marker", () => {
    expect(buildMarkerUpdate({ ok: false, message: "x" })).not.toHaveProperty("message");
  });
});

describe("rks_plan_review failure payload", () => {
  const base = { done: true, ok: false, status: "refinement_required" };

  it("coverage_gap: relays and names the uncovered target, no false no-steps claim", () => {
    const r = buildPlanReviewFailureResponse({ ...base, reason: "coverage_gap", uncoveredTargets: DIAG.uncoveredTargets }, 14);
    expect(r.ok).toBe(false);
    expect(r.uncoveredTargets).toEqual(DIAG.uncoveredTargets);
    expect(r.message).toContain("tests/unit/test_collection_guards.py");
    expect(r.message).not.toContain(NO_STEPS);
  });
  it("relays droppedSteps and rejectionReasons when present, omits them when absent", () => {
    const r = buildPlanReviewFailureResponse({ ...base, reason: "dropped_work", droppedSteps: DIAG.droppedSteps, rejectionReasons: DIAG.rejectionReasons }, 1);
    expect(r.droppedSteps).toEqual(DIAG.droppedSteps);
    expect(r.rejectionReasons).toEqual(DIAG.rejectionReasons);
    const bare = buildPlanReviewFailureResponse({ ...base, reason: "coverage_gap" }, 1);
    expect(bare).not.toHaveProperty("droppedSteps");
    expect(bare).not.toHaveProperty("rejectionReasons");
  });
  it("workerLogPath is the marker's value, or null", () => {
    expect(buildPlanReviewFailureResponse({ ...base, workerLogPath: "/p/.rks/plan-logs/1.log" }, 1).workerLogPath).toBe("/p/.rks/plan-logs/1.log");
    expect(buildPlanReviewFailureResponse({ ...base }, 1).workerLogPath).toBeNull();
  });
  it("error is relayed verbatim, or null — never a fabricated default", () => {
    expect(buildPlanReviewFailureResponse({ ...base }, 1).error).toBeNull();
    expect(buildPlanReviewFailureResponse({ ...base, error: "boom" }, 1).error).toBe("boom");
  });
  it("server.mjs builds the payload through the helper and carries no default error string", () => {
    const server = read("packages/mcp-rks/src/server.mjs");
    expect(server).toContain("buildPlanReviewFailureResponse(");
    expect(server).not.toContain("Plan generation failed in worker");
  });
});

describe("output_invalid message is keyed on the observed reason", () => {
  const msg = (m) => classifyMarkerFailure({ status: "refinement_required", ...m }).message;
  it("note_only keeps the no-executable-steps guidance", () => {
    expect(msg({ reason: "note_only" })).toContain("no executable steps");
  });
  it("coverage_gap names every uncovered target and keeps the re-plan instruction", () => {
    const m = msg({ reason: "coverage_gap", uncoveredTargets: ["a/one.mjs", "b/two.py"] });
    expect(m).toContain("a/one.mjs");
    expect(m).toContain("b/two.py");
    expect(m).not.toContain(NO_STEPS);
    expect(m).toMatch(/re-plan/);
  });
  it("dropped_work names every dropped step label", () => {
    const m = msg({ reason: "dropped_work", droppedSteps: [{ label: "Step A", reason: "r1" }, { label: "Step B", reason: "r2" }] });
    expect(m).toContain("Step A");
    expect(m).toContain("Step B");
    expect(m).not.toContain(NO_STEPS);
  });
  it("absent or unknown reason does not assert no executable steps", () => {
    expect(msg({})).not.toContain(NO_STEPS);
    expect(classifyMarkerFailure({ status: "quality_failed" }).message).not.toContain(NO_STEPS);
  });
  it("a missing list points to the worker log instead of inventing entries", () => {
    const m = msg({ reason: "coverage_gap" });
    expect(m).toMatch(/worker log/i);
    expect(m).not.toContain(NO_STEPS);
  });
});

// backlog.fix.reviewer-anchor-only-targets-get-no-llm-pass — the authoring cause (llmStatus /
// llmError) crosses the marker boundary under distinct top-level keys and drives the message.
describe("authoring cause: llmStatus / llmError reach the marker and the response (TR9, TR10)", () => {
  const CAUSE = { llmStatus: "no_explicit_edits", llmError: "Story has no extractable SEARCH/REPLACE blocks" };
  const base = { done: true, ok: false, status: "refinement_required" };

  it("TR9: buildMarkerUpdate copies llmStatus and llmError unchanged on a failing result", () => {
    const m = buildMarkerUpdate({ ok: false, reason: "coverage_gap", ...CAUSE });
    expect(m.llmStatus).toBe(CAUSE.llmStatus);
    expect(m.llmError).toBe(CAUSE.llmError);
  });
  it("TR9: buildMarkerUpdate copies neither on a successful result", () => {
    const m = buildMarkerUpdate({ ok: true, ...CAUSE });
    expect(m).not.toHaveProperty("llmStatus");
    expect(m).not.toHaveProperty("llmError");
  });
  it("TR10: buildPlanReviewFailureResponse relays llmStatus and llmError when the marker carries them", () => {
    const r = buildPlanReviewFailureResponse({ ...base, reason: "coverage_gap", ...CAUSE }, 3);
    expect(r.llmStatus).toBe(CAUSE.llmStatus);
    expect(r.llmError).toBe(CAUSE.llmError);
  });
  it("TR10: buildPlanReviewFailureResponse omits both keys when the marker lacks them", () => {
    const r = buildPlanReviewFailureResponse({ ...base, reason: "coverage_gap" }, 3);
    expect(r).not.toHaveProperty("llmStatus");
    expect(r).not.toHaveProperty("llmError");
  });
  it("TR10: response.error stays marker.error ?? null and is never set from llmError", () => {
    expect(buildPlanReviewFailureResponse({ ...base, ...CAUSE }, 1).error).toBeNull();
    expect(buildPlanReviewFailureResponse({ ...base, ...CAUSE, error: "boom" }, 1).error).toBe("boom");
  });
});

describe("cause-aware coverage_gap and note_only messages (TR11, TR12)", () => {
  const msg = (m) => classifyMarkerFailure({ status: "refinement_required", ...m }).message;
  const ANCHOR_ADVICE = "Add an @@SEARCH/@@REPLACE anchor";
  const BLOCK_ADVICE = "add @@SEARCH/@@REPLACE blocks";

  it("TR11: coverage_gap with llmError names every target and the cause, without the anchor advice", () => {
    const m = msg({
      reason: "coverage_gap",
      uncoveredTargets: ["src/a.mjs", "src/b.mjs"],
      llmError: "edit-target supplement failed: boom",
    });
    expect(m).toContain("src/a.mjs");
    expect(m).toContain("src/b.mjs");
    expect(m).toContain("edit-target supplement failed: boom");
    expect(m).not.toContain(ANCHOR_ADVICE);
    expect(m).not.toContain(NO_STEPS);
  });
  it("TR11 positive control: coverage_gap without llmError keeps today's anchor advice", () => {
    const m = msg({ reason: "coverage_gap", uncoveredTargets: ["src/a.mjs", "src/b.mjs"] });
    expect(m).toContain(ANCHOR_ADVICE);
    expect(m).toBe(
      "The plan had executable steps, but 2 target file(s) got none: src/a.mjs, src/b.mjs. Add an @@SEARCH/@@REPLACE anchor or an authorable block for each, then re-plan.",
    );
  });
  it("TR11: coverage_gap with llmStatus and llmError names both", () => {
    const m = msg({ reason: "coverage_gap", uncoveredTargets: ["src/a.mjs"], llmStatus: "error", llmError: "edit-target supplement failed: boom" });
    expect(m).toContain("error");
    expect(m).toContain("edit-target supplement failed: boom");
    expect(m).not.toContain(ANCHOR_ADVICE);
  });
  it("TR12: note_only with llmError keeps 'no executable steps', names the cause, drops the block advice", () => {
    const m = msg({ reason: "note_only", llmError: "edit-target supplement returned no result" });
    expect(m).toContain("no executable steps");
    expect(m).toContain("edit-target supplement returned no result");
    expect(m).not.toContain(BLOCK_ADVICE);
  });
  it("TR12 positive control: note_only without llmError is exactly today's text", () => {
    expect(msg({ reason: "note_only" })).toBe(
      "The generated plan had no executable steps — refine the story (add @@SEARCH/@@REPLACE blocks or clearer targets) and re-plan.",
    );
  });
  it("an empty-string llmError is not a cause (today's text)", () => {
    expect(msg({ reason: "note_only", llmError: "" })).toContain(BLOCK_ADVICE);
    expect(msg({ reason: "coverage_gap", uncoveredTargets: ["src/a.mjs"], llmError: "" })).toContain(ANCHOR_ADVICE);
  });
});
