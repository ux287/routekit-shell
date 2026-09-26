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
