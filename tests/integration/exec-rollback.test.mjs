import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import {
  capturePartialDiff,
  cleanupWorkingTree,
} from "../../packages/mcp-rks/src/exec/backup.mjs";

describe("exec rollback — cleanupWorkingTree and capturePartialDiff", () => {
  let projectRoot;

  function initGitRepo(dir) {
    spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "file.txt"), "original content");
    fs.writeFileSync(path.join(dir, "keep.txt"), "keep this");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
  }

  beforeEach(() => {
    projectRoot = makeTempDir("exec-rollback-test");
    initGitRepo(projectRoot);
  });

  describe("cleanupWorkingTree", () => {
    it("restores deleted tracked files", () => {
      // Delete a tracked file (simulates exec leaving files deleted)
      fs.unlinkSync(path.join(projectRoot, "file.txt"));
      expect(fs.existsSync(path.join(projectRoot, "file.txt"))).toBe(false);

      const result = cleanupWorkingTree(projectRoot);
      expect(result.cleaned).toBe(true);
      expect(result.method).toBe("git-checkout+clean");

      // File should be restored
      expect(fs.existsSync(path.join(projectRoot, "file.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(projectRoot, "file.txt"), "utf8")).toBe("original content");
    });

    it("restores modified tracked files", () => {
      // Modify a tracked file
      fs.writeFileSync(path.join(projectRoot, "file.txt"), "modified by failed exec");

      const result = cleanupWorkingTree(projectRoot);
      expect(result.cleaned).toBe(true);

      // File should be restored to original
      expect(fs.readFileSync(path.join(projectRoot, "file.txt"), "utf8")).toBe("original content");
    });

    it("removes untracked files (exec artifacts)", () => {
      // Create untracked file (artifact from failed plan)
      fs.writeFileSync(path.join(projectRoot, "artifact.tmp"), "exec artifact");

      const result = cleanupWorkingTree(projectRoot);
      expect(result.cleaned).toBe(true);

      // Untracked file should be removed
      expect(fs.existsSync(path.join(projectRoot, "artifact.tmp"))).toBe(false);
      // Tracked files still present
      expect(fs.existsSync(path.join(projectRoot, "file.txt"))).toBe(true);
    });

    it("preserves .rks directory during cleanup", () => {
      // Create .rks diagnostics (should survive cleanup)
      const rksDir = path.join(projectRoot, ".rks", "diagnostics");
      fs.mkdirSync(rksDir, { recursive: true });
      fs.writeFileSync(path.join(rksDir, "log.txt"), "diagnostics data");

      // Also create an untracked artifact that should be cleaned
      fs.writeFileSync(path.join(projectRoot, "artifact.tmp"), "remove me");

      const result = cleanupWorkingTree(projectRoot);
      expect(result.cleaned).toBe(true);

      // .rks should survive
      expect(fs.existsSync(path.join(rksDir, "log.txt"))).toBe(true);
      // Artifact should be gone
      expect(fs.existsSync(path.join(projectRoot, "artifact.tmp"))).toBe(false);
    });

    it("handles already-clean working tree", () => {
      const result = cleanupWorkingTree(projectRoot);
      expect(result.cleaned).toBe(true);

      // Everything still intact
      expect(fs.readFileSync(path.join(projectRoot, "file.txt"), "utf8")).toBe("original content");
    });
  });

  describe("capturePartialDiff", () => {
    it("captures unstaged modifications to a diff file", () => {
      // Modify a file
      fs.writeFileSync(path.join(projectRoot, "file.txt"), "modified content");

      const runDir = path.join(projectRoot, ".rks", "runs", "test-run");
      fs.mkdirSync(runDir, { recursive: true });

      const result = capturePartialDiff(projectRoot, runDir);
      expect(result.captured).toBe(true);
      expect(result.diffPath).toBeTruthy();
      expect(fs.existsSync(result.diffPath)).toBe(true);

      const diffContent = fs.readFileSync(result.diffPath, "utf8");
      expect(diffContent).toContain("Partial diff captured");
      expect(diffContent).toContain("Unstaged changes");
      expect(diffContent).toContain("modified content");
    });

    it("captures file deletions in working tree status", () => {
      // Delete a tracked file
      fs.unlinkSync(path.join(projectRoot, "file.txt"));

      const runDir = path.join(projectRoot, ".rks", "runs", "test-run");
      fs.mkdirSync(runDir, { recursive: true });

      const result = capturePartialDiff(projectRoot, runDir);
      expect(result.captured).toBe(true);

      const diffContent = fs.readFileSync(result.diffPath, "utf8");
      expect(diffContent).toContain("file.txt");
    });

    it("falls back to exec-diagnostics dir when no runDir", () => {
      fs.writeFileSync(path.join(projectRoot, "file.txt"), "changed");

      const result = capturePartialDiff(projectRoot, null);
      expect(result.captured).toBe(true);
      expect(result.diffPath).toContain("exec-diagnostics");
    });

    it("captures clean state without error", () => {
      const result = capturePartialDiff(projectRoot, null);
      expect(result.captured).toBe(true);

      const diffContent = fs.readFileSync(result.diffPath, "utf8");
      expect(diffContent).toContain("(clean)");
    });
  });
});
