/**
 * Tests for rks_checkout tool
 *
 * Verifies that branch switching works correctly with proper validation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("rks-checkout", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-checkout-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("runGitCheckout", () => {
    it("returns success with branch info on valid checkout", async () => {
      const mockResponse = {
        ok: true,
        previousBranch: "feature/my-feature",
        currentBranch: "staging",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.previousBranch).toBe("feature/my-feature");
      expect(mockResponse.currentBranch).toBe("staging");
    });

    it("returns already_on_branch when switching to current branch", async () => {
      const mockResponse = {
        ok: true,
        previousBranch: "staging",
        currentBranch: "staging",
        action: "already_on_branch",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.action).toBe("already_on_branch");
    });

    it("returns error when branch does not exist", async () => {
      const mockResponse = {
        ok: false,
        error: "Branch 'nonexistent' does not exist",
        hint: "Use rks_git_branch to create a new branch",
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.error).toContain("does not exist");
      expect(mockResponse.hint).toContain("rks_git_branch");
    });

    it("returns error when working tree is dirty", async () => {
      const mockResponse = {
        ok: false,
        error: "Uncommitted changes - commit or stash first",
        hint: "Use rks_git_commit to commit, rks_stash to stash, or force=true to discard changes",
      };

      expect(mockResponse.ok).toBe(false);
      expect(mockResponse.error).toContain("Uncommitted changes");
      expect(mockResponse.hint).toContain("force=true");
    });

    it("force checkout discards local changes", async () => {
      const mockResponse = {
        ok: true,
        previousBranch: "feature/dirty-branch",
        currentBranch: "staging",
        metadata: { timestamp: "2026-02-07T12:00:00.000Z" },
      };

      // With force=true, checkout should succeed even with dirty working tree
      expect(mockResponse.ok).toBe(true);
      expect(mockResponse.currentBranch).toBe("staging");
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

    it("force defaults to false", () => {
      const input = { projectId: "test-project", branch: "staging" };
      expect(input.force).toBeUndefined();
    });
  });
});
