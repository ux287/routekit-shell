import { describe, it, expect } from "vitest";
import { runGitPR, runStagingMerge } from "../../packages/mcp-rks/src/server/git-tools.mjs";

describe("problemId/reason required on ship", () => {
  // Note: These tests validate the input validation logic without hitting git/GitHub.
  // They use a fake projectRoot that doesn't exist, which triggers an error AFTER
  // the validation passes, but we're testing the validation gate itself.

  const fakeRoot = "/tmp/nonexistent-project-root-for-test";

  describe("rks_staging_pr (runGitPR)", () => {
    it("rejects when neither problemId nor reason is provided", async () => {
      const result = await runGitPR({ projectRoot: fakeRoot });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Either problemId or reason is required");
      expect(result.hint).toContain("hotfix");
    });

    it("rejects invalid reason value", async () => {
      const result = await runGitPR({ projectRoot: fakeRoot, reason: "yolo" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid reason");
      expect(result.error).toContain("yolo");
    });

    it("accepts valid reason without problemId", async () => {
      // This will fail later (no git repo), but should pass the validation gate
      const result = await runGitPR({ projectRoot: fakeRoot, reason: "hotfix" });
      // Should not be the "Either problemId or reason" error
      expect(result.error).not.toContain("Either problemId or reason is required");
    });

    it("accepts problemId without reason", async () => {
      const result = await runGitPR({ projectRoot: fakeRoot, problemId: "backlog.test.story" });
      expect(result.error).not.toContain("Either problemId or reason is required");
    });

    it("accepts all valid reason values", async () => {
      for (const reason of ["hotfix", "docs-only", "infrastructure", "off-rail"]) {
        const result = await runGitPR({ projectRoot: fakeRoot, reason });
        expect(result.error).not.toContain("Either problemId or reason is required");
        expect(result.error).not.toContain("Invalid reason");
      }
    });
  });

  describe("rks_staging_merge (runStagingMerge)", () => {
    it("rejects when neither problemId nor reason is provided", async () => {
      const result = await runStagingMerge({ projectRoot: fakeRoot });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Either problemId or reason is required");
    });

    it("rejects invalid reason value", async () => {
      const result = await runStagingMerge({ projectRoot: fakeRoot, reason: "because" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid reason");
    });

    it("accepts valid reason without problemId", async () => {
      const result = await runStagingMerge({ projectRoot: fakeRoot, reason: "infrastructure" });
      expect(result.error).not.toContain("Either problemId or reason is required");
    });

    it("accepts problemId without reason", async () => {
      const result = await runStagingMerge({ projectRoot: fakeRoot, problemId: "backlog.test.story" });
      expect(result.error).not.toContain("Either problemId or reason is required");
    });
  });
});
