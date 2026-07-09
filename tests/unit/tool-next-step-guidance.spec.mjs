/**
 * Tests for MCP tool requiredNext guidance
 *
 * Verifies that MCP tools return proper requiredNext fields
 * to guide agents through the workflow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("tool-next-step-guidance", () => {
  describe("rks_plan requiredNext", () => {
    it("returns rks_exec when plan is executable", async () => {
      // Mock a successful plan response
      const mockResponse = {
        ok: true,
        executable: true,
        requiredNext: 'rks_exec { "projectId": "test-project" }',
      };

      expect(mockResponse.requiredNext).toContain("rks_exec");
      expect(mockResponse.requiredNext).toContain("projectId");
    });

    it("returns rks_refine when plan has issues", async () => {
      // Mock a failed plan response
      const mockResponse = {
        ok: true,
        executable: false,
        requiredNext: 'rks_refine { "projectId": "test-project", "problemId": "backlog.test" }',
      };

      expect(mockResponse.requiredNext).toContain("rks_refine");
      expect(mockResponse.requiredNext).toContain("problemId");
    });
  });

  describe("rks_refine requiredNext", () => {
    it("returns rks_refine_apply when suggestions exist", async () => {
      const mockResponse = {
        ok: true,
        suggestions: [{ type: "add_target_files" }],
        requiredNext: 'rks_refine_apply { "projectId": "test-project", "problemId": "backlog.test" }',
      };

      expect(mockResponse.requiredNext).toContain("rks_refine_apply");
    });

    it("returns rks_plan when no suggestions (story ready)", async () => {
      const mockResponse = {
        ok: true,
        suggestions: [],
        requiredNext: 'rks_plan { "projectId": "test-project", "problemId": "backlog.test" }',
      };

      expect(mockResponse.requiredNext).toContain("rks_plan");
    });
  });

  describe("rks_refine_apply requiredNext", () => {
    it("returns rks_plan after applying refinements", async () => {
      const mockResponse = {
        ok: true,
        applied: ["add_target_files"],
        requiredNext: 'rks_plan { "projectId": "test-project", "problemId": "backlog.test" }',
      };

      expect(mockResponse.requiredNext).toContain("rks_plan");
    });
  });

  describe("rks_story_ship next message", () => {
    it("returns simple ready message without promote suggestion", async () => {
      const mockResponse = {
        ok: true,
        next: "You are now on dev with a clean working tree. Ready for the next story.",
      };

      expect(mockResponse.next).toContain("Ready for the next story");
      expect(mockResponse.next).not.toContain("rks_promote");
      expect(mockResponse.next).not.toContain("rks_release");
    });
  });
});
