/**
 * Tests for auto-phase workflow module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { advancePhase, getExpectedTransition } from "../../../packages/mcp-rks/src/workflow/auto-phase.mjs";

// Mock dependencies
vi.mock("../../../packages/mcp-rks/src/workflow/state-machine.mjs", () => ({
  validateTransition: vi.fn()
}));

vi.mock("../../../packages/mcp-rks/src/dendron.mjs", () => ({
  resolveNotesDir: vi.fn(() => "/tmp/project/notes"),
  updateField: vi.fn(),
  parseFrontmatter: vi.fn()
}));

vi.mock("../../../packages/mcp-rks/src/server/telemetry/collector.mjs", () => ({
  getTelemetryCollector: () => ({
    emit: vi.fn(),
    storage: null,
    setStorage: vi.fn()
  })
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn()
  }
}));

import { validateTransition } from "../../../packages/mcp-rks/src/workflow/state-machine.mjs";
import { updateField, parseFrontmatter } from "../../../packages/mcp-rks/src/dendron.mjs";
import fs from "fs";

describe("auto-phase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("advancePhase", () => {
    it("advances ready→planned on plan operation", async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("---\nphase: ready\n---\nContent");
      parseFrontmatter.mockReturnValue({ data: { phase: "ready" }, content: "Content" });
      validateTransition.mockResolvedValue({ valid: true });

      const result = await advancePhase("/tmp/project", "backlog.test", "plan");

      expect(result.ok).toBe(true);
      expect(result.from).toBe("ready");
      expect(result.to).toBe("planned");
      expect(updateField).toHaveBeenCalledWith("/tmp/project/notes", "backlog.test", "phase", "planned");
    });

    it("advances planned→executed on exec operation", async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("---\nphase: planned\n---\nContent");
      parseFrontmatter.mockReturnValue({ data: { phase: "planned" }, content: "Content" });
      validateTransition.mockResolvedValue({ valid: true });

      const result = await advancePhase("/tmp/project", "backlog.test", "exec");

      expect(result.ok).toBe(true);
      expect(result.from).toBe("planned");
      expect(result.to).toBe("executed");
      expect(updateField).toHaveBeenCalledWith("/tmp/project/notes", "backlog.test", "phase", "executed");
    });

    it("rejects invalid transitions", async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue("---\nphase: draft\n---\nContent");
      parseFrontmatter.mockReturnValue({ data: { phase: "draft" }, content: "Content" });
      validateTransition.mockResolvedValue({
        valid: false,
        error: "Invalid transition: draft → planned"
      });

      const result = await advancePhase("/tmp/project", "backlog.test", "plan");

      expect(result.ok).toBe(false);
      expect(result.from).toBe("draft");
      expect(result.to).toBe("planned");
      expect(result.error).toContain("draft");
      expect(updateField).not.toHaveBeenCalled();
    });

    it("returns error for unknown operation", async () => {
      const result = await advancePhase("/tmp/project", "backlog.test", "unknown");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown operation");
    });

    it("returns error when story not found", async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await advancePhase("/tmp/project", "backlog.missing", "plan");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Story not found");
    });

    it("handles ship operation gracefully when story moved", async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await advancePhase("/tmp/project", "backlog.test", "ship");

      expect(result.ok).toBe(true);
      expect(result.note).toBe("Story already moved");
    });
  });

  describe("getExpectedTransition", () => {
    // Story 1 (backlog.feat.phase-machine-foundation): OPERATION_TRANSITIONS.<op>.from
    // is now a string[] (multi-source support) instead of a single string.
    // See Behavior Preservation change #1 in the story body.
    it("returns correct transition for plan (multi-source from-array)", () => {
      const t = getExpectedTransition("plan");
      expect(t.to).toBe("planned");
      expect(Array.isArray(t.from)).toBe(true);
      expect(t.from).toEqual(expect.arrayContaining(["ready", "arch-approved", "planned", "executed"]));
    });

    it("returns correct transition for exec (single-source as one-element array)", () => {
      expect(getExpectedTransition("exec")).toEqual({ from: ["planned"], to: "executed" });
    });

    it("returns correct transition for ship (single-source as one-element array)", () => {
      expect(getExpectedTransition("ship")).toEqual({ from: ["executed"], to: "integrated" });
    });

    it("returns null for unknown operation", () => {
      expect(getExpectedTransition("unknown")).toBeNull();
    });
  });
});
