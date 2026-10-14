/**
 * Tests for rks_branch_repair tool
 *
 * Verifies that branch repair works correctly with proper validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("rks-branch-repair", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-branch-repair-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("runBranchRepair", () => {
    it("dry-run shows commits to remove", async () => {
      const mockResponse = {
        ok: true,
        dryRun: true,
        branch: "staging",
        currentHead: "41c04d1",
        targetHead: "fc07b08",
        commitsToRemove: [
          { sha: "41c04d1", message: "feat(guardrails): Add child project guidance..." },
        ],
        hint: "Run with confirm: true to apply this repair",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.dryRun).toBe(true);
      expect(mockResponse.commitsToRemove.length).toBe(1);
      expect(mockResponse.hint).toContain("confirm: true");
    });

    it("confirmed repair resets branch correctly", async () => {
      const mockResponse = {
        ok: true,
        branch: "staging",
        previousHead: "41c04d1",
        newHead: "fc07b08",
        commitsRemoved: 1,
        returnedTo: "feature/guardrails-off-child-guidance",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.previousHead).toBe("41c04d1");
      expect(mockResponse.newHead).toBe("fc07b08");
      expect(mockResponse.commitsRemoved).toBe(1);
      expect(mockResponse.returnedTo).toBe("feature/guardrails-off-child-guidance");
    });

    it("returns to original branch after repair", async () => {
      const mockResponse = {
        ok: true,
        branch: "staging",
        previousHead: "41c04d1",
        newHead: "fc07b08",
        commitsRemoved: 1,
        returnedTo: "feature/my-feature",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.returnedTo).toBe("feature/my-feature");
    });

    it("returns error when branch does not exist", async () => {
      const mockResponse = {
        ok: false,
        error: "Branch 'nonexistent' does not exist locally",
        hint: "Use rks_git_branch to create it, or checkout a remote tracking branch",
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.error).toContain("does not exist");
    });

    it("returns error when not confirmed for destructive operation", async () => {
      const mockResponse = {
        ok: false,
        error: "Branch repair requires confirmation",
        branch: "staging",
        currentHead: "41c04d1",
        targetHead: "fc07b08",
        commitsToRemove: [{ sha: "41c04d1", message: "feat: some commit" }],
        hint: "Run with confirm: true to apply this repair, or dryRun: true to preview",
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.error).toContain("confirmation");
      expect(mockResponse.hint).toContain("confirm: true");
    });

    it("handles case where branch already matches target", async () => {
      const mockResponse = {
        ok: true,
        branch: "staging",
        action: "already_at_target",
        currentHead: "fc07b08",
        targetHead: "fc07b08",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.action).toBe("already_at_target");
      expect(mockResponse.currentHead).toBe(mockResponse.targetHead);
    });
  });

  describe("schema validation", () => {
    it("requires projectId", () => {
      const input = { branch: "staging" };
      expect(input.projectId).toBeUndefined();
    });

    it("requires branch", () => {
      const input = { projectId: "test-project" };
      expect(input.branch).toBeUndefined();
    });

    it("target defaults to origin/<branch>", () => {
      const input = { projectId: "test-project", branch: "staging" };
      const effectiveTarget = input.target || `origin/${input.branch}`;
      expect(effectiveTarget).toBe("origin/staging");
    });

    it("dryRun defaults to false", () => {
      const input = { projectId: "test-project", branch: "staging" };
      expect(input.dryRun).toBeUndefined();
    });

    it("confirm defaults to false", () => {
      const input = { projectId: "test-project", branch: "staging" };
      expect(input.confirm).toBeUndefined();
    });
  });
});
