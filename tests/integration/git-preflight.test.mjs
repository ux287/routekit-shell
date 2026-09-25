import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

describe("runGitPreflight", { timeout: 30_000 }, () => {
  let projectRoot;
  let runGitPreflight;

  function initGitRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "file.txt"), "initial");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  }

  beforeEach(async () => {
    projectRoot = makeTempDir("git-preflight-test");
    initGitRepo(projectRoot);
    const mod = await import("../../packages/mcp-rks/src/tools/git-preflight.mjs");
    runGitPreflight = mod.runGitPreflight;
  });

  describe("dirty tree detection", () => {
    it("returns dirty=false when working tree is clean", () => {
      const result = runGitPreflight(projectRoot);
      expect(result.ok).toBe(true);
      expect(result.dirtyTree.dirty).toBe(false);
    });

    it("returns dirty=true with files when uncommitted changes exist", () => {
      fs.writeFileSync(path.join(projectRoot, "dirty.txt"), "dirty");
      const result = runGitPreflight(projectRoot);
      expect(result.dirtyTree.dirty).toBe(true);
      expect(result.dirtyTree.files.length).toBeGreaterThan(0);
      expect(result.dirtyTree.suggestion).toBeDefined();
    });

    it("auto-stashes when autoStash=true and tree is dirty", () => {
      fs.writeFileSync(path.join(projectRoot, "stashme.txt"), "stash");
      spawnSync("git", ["add", "stashme.txt"], { cwd: projectRoot });
      const result = runGitPreflight(projectRoot, { autoStash: true });
      expect(result.stashed).toBe(true);
      expect(result.dirtyTree.dirty).toBe(false);
      // Verify stash exists
      const stashList = spawnSync("git", ["stash", "list"], { cwd: projectRoot, encoding: "utf8" });
      expect(stashList.stdout).toContain("rks-preflight-auto-stash");
    });
  });

  describe("worktree detection", () => {
    it("returns empty orphaned when no worktrees exist", () => {
      const result = runGitPreflight(projectRoot);
      expect(result.worktrees.orphaned).toEqual([]);
      expect(result.worktrees.cleaned).toEqual([]);
    });
  });

  describe("branch verification", () => {
    it("returns matches=true when on expected branch", () => {
      const result = runGitPreflight(projectRoot, { expectedBranch: "staging" });
      expect(result.branch.currentBranch).toBe("staging");
      expect(result.branch.matches).toBe(true);
    });

    it("returns matches=false when on wrong branch", () => {
      spawnSync("git", ["checkout", "-b", "feature/test"], { cwd: projectRoot });
      const result = runGitPreflight(projectRoot, { expectedBranch: "staging" });
      expect(result.branch.currentBranch).toBe("feature/test");
      expect(result.branch.matches).toBe(false);
    });

    it("returns matches=true when no expectedBranch specified", () => {
      const result = runGitPreflight(projectRoot);
      expect(result.branch.matches).toBe(true);
    });
  });

  describe("overall ok flag", () => {
    it("ok=true when clean tree and correct branch", () => {
      const result = runGitPreflight(projectRoot, { expectedBranch: "staging" });
      expect(result.ok).toBe(true);
    });

    it("ok=false when tree is dirty", () => {
      fs.writeFileSync(path.join(projectRoot, "dirty.txt"), "dirty");
      const result = runGitPreflight(projectRoot);
      expect(result.ok).toBe(false);
    });

    it("ok=false when on wrong branch", () => {
      spawnSync("git", ["checkout", "-b", "wrong"], { cwd: projectRoot });
      const result = runGitPreflight(projectRoot, { expectedBranch: "staging" });
      expect(result.ok).toBe(false);
    });
  });
});
