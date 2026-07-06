/**
 * Tests for auto-analyze workflow module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAutoAnalyze, shouldSkipAnalysis } from "../../../packages/mcp-rks/src/workflow/auto-analyze.mjs";

// Mock dependencies
vi.mock("../../../packages/mcp-rks/src/server/plan-ready.mjs", () => ({
  runPlanReadyTool: vi.fn()
}));

vi.mock("../../../packages/mcp-rks/src/server/telemetry/collector.mjs", () => ({
  getTelemetryCollector: () => ({
    emit: vi.fn()
  })
}));

import { runPlanReadyTool } from "../../../packages/mcp-rks/src/server/plan-ready.mjs";

describe("auto-analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runAutoAnalyze", () => {
    it("returns ready:true when plan_ready passes", async () => {
      runPlanReadyTool.mockResolvedValue({
        ready: true,
        currentPhase: "ready",
        issues: [],
        warnings: [],
        summary: "Story ready for planning"
      });

      const result = await runAutoAnalyze("test-project", "backlog.test", "/tmp/project");

      expect(result.ready).toBe(true);
      expect(result.phase).toBe("ready");
      expect(result.issues).toEqual([]);
    });

    it("returns ready:false with issues when plan_ready fails", async () => {
      runPlanReadyTool.mockResolvedValue({
        ready: false,
        currentPhase: "draft",
        issues: [
          { check: "phase_status", message: "Phase is draft", suggestion: "Set phase to ready" }
        ],
        warnings: [],
        summary: "Story not ready"
      });

      const result = await runAutoAnalyze("test-project", "backlog.test", "/tmp/project");

      expect(result.ready).toBe(false);
      expect(result.phase).toBe("draft");
      expect(result.issues.length).toBe(1);
      expect(result.issues[0].check).toBe("phase_status");
      expect(result.suggestion).toContain("Set phase to ready");
    });

    it("returns analysis_error on exception", async () => {
      runPlanReadyTool.mockRejectedValue(new Error("File not found"));

      const result = await runAutoAnalyze("test-project", "backlog.missing", "/tmp/project");

      expect(result.ready).toBe(false);
      expect(result.issues.length).toBe(1);
      expect(result.issues[0].check).toBe("analysis_error");
      expect(result.issues[0].message).toContain("File not found");
    });

    it("preserves warnings from plan_ready", async () => {
      runPlanReadyTool.mockResolvedValue({
        ready: true,
        currentPhase: "ready",
        issues: [],
        warnings: [
          { check: "acceptance_criteria", message: "No checkboxes found" }
        ],
        summary: "Ready with warnings"
      });

      const result = await runAutoAnalyze("test-project", "backlog.test", "/tmp/project");

      expect(result.ready).toBe(true);
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0].check).toBe("acceptance_criteria");
    });
  });

  describe("shouldSkipAnalysis", () => {
    it("returns false by default", () => {
      expect(shouldSkipAnalysis({})).toBe(false);
    });

    it("returns true when skipAnalysis option is set", () => {
      expect(shouldSkipAnalysis({ skipAnalysis: true })).toBe(true);
    });

    it("returns true on retry attempts", () => {
      expect(shouldSkipAnalysis({ retryAttempt: 1 })).toBe(true);
      expect(shouldSkipAnalysis({ retryAttempt: 2 })).toBe(true);
    });

    it("returns false on first attempt", () => {
      expect(shouldSkipAnalysis({ retryAttempt: 0 })).toBe(false);
    });

    it("returns true in apply-only mode", () => {
      expect(shouldSkipAnalysis({ applyOnly: true })).toBe(true);
    });
  });
});
