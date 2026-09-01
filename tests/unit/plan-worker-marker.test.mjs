/**
 * backlog.fix.plan-exec-start-phase-write-durability — plan-worker completion marker.
 *
 * MIGRATED from packages/mcp-rks/src/server/__tests__/plan-worker-marker.test.mjs, which
 * NO vitest tier collected (all configs include only `tests/**`) and which used node:test
 * rather than vitest — it had never run. Worse, it asserted against a local SIMULATION of
 * the marker write rather than the real code, and that simulation had already drifted: its
 * own header cited "plan-worker.mjs lines 105-118" for code that had moved to :122-137.
 *
 * This imports the REAL buildMarkerUpdate that bin/plan-worker.mjs calls, so it cannot
 * pass while the shipped path is broken.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMarkerUpdate } from "../../packages/mcp-rks/src/server/plan-marker.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("buildMarkerUpdate", () => {
  it("marks a successful run done and ok", () => {
    const m = buildMarkerUpdate({ ok: true, problemId: "backlog.x" }, { now: 111 });
    expect(m).toMatchObject({ done: true, ok: true, completedAt: 111, problemId: "backlog.x" });
  });

  it("preserves structured failure context so plan_review can relay it", () => {
    const m = buildMarkerUpdate({
      ok: false,
      error: "boom",
      errors: ["e1"],
      issues: [{ check: "x" }],
      warnings: [{ check: "w" }],
      hint: "try refine",
      workflow: "plan",
      status: "refinement_required",
      reason: "has_note_steps",
      suggestions: [{ type: "s" }],
    });

    expect(m.ok).toBe(false);
    for (const k of ["error", "errors", "issues", "warnings", "hint", "workflow", "status", "reason", "suggestions"]) {
      expect(m, `failure field ${k} lost at the async boundary`).toHaveProperty(k);
    }
  });

  it("does not smuggle failure fields onto a successful run", () => {
    const m = buildMarkerUpdate({ ok: true, error: "should not appear", status: "nope" });
    expect(m.error).toBeUndefined();
    expect(m.status).toBeUndefined();
  });

  it("carries phaseWrite on the SUCCESS path — the parent net keys on it", () => {
    // The parent-side durability net needs to know whether the detached worker's
    // arch-approved → executing write actually landed. If phaseWrite only rode the
    // failure path it would never reach the parent on the run that matters.
    const m = buildMarkerUpdate({
      ok: true,
      problemId: "backlog.x",
      phaseWrite: { attempted: true, ok: true, from: "arch-approved", to: "executing", verified: true },
    });
    expect(m.phaseWrite).toEqual({
      attempted: true, ok: true, from: "arch-approved", to: "executing", verified: true,
    });
  });

  it("carries phaseWrite on the failure path too", () => {
    const m = buildMarkerUpdate({
      ok: false, status: "phase_write_failed",
      phaseWrite: { attempted: true, from: "arch-approved", to: "executing", error: "phase_write_not_observed" },
    });
    expect(m.phaseWrite.error).toBe("phase_write_not_observed");
    expect(m.status).toBe("phase_write_failed");
  });
});

describe("the worker actually uses the shared helper", () => {
  it("bin/plan-worker.mjs calls buildMarkerUpdate rather than rebuilding the shape", () => {
    // Anti-vacuity guard. Without this the helper could be perfect and unused, which is
    // precisely the state the migrated simulation was in.
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/bin/plan-worker.mjs"), "utf8");
    expect(src).toContain("buildMarkerUpdate");
    expect(src).toContain("plan-marker.mjs");
    // The inlined re-implementation must be gone, not merely bypassed.
    expect(src).not.toContain("if (res.suggestions) markerUpdate.suggestions");
  });

  it("the dead colocated spec that no tier collected is gone", () => {
    const dead = path.join(ROOT, "packages/mcp-rks/src/server/__tests__/plan-worker-marker.test.mjs");
    expect(fs.existsSync(dead), "the uncollected duplicate must not survive alongside this file").toBe(false);
  });
});
