/**
 * Tests for exec orphaned-self-branch auto-cleanup (backlog.fix.exec-auto-cleanup-orphaned-branches).
 *
 * These tests verify the detection and cleanup logic using a real git repo,
 * importing cleanupFeatureBranch directly to confirm the interface expected by exec.mjs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { cleanupFeatureBranch } from "../../packages/mcp-rks/src/server/test-runner.mjs";

function initGitRepo(dir, baseBranch = "staging") {
  spawnSync("git", ["init", "-b", baseBranch], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "init");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

/** Mirror the detection logic from exec.mjs */
function branchExists(projectRoot, branchName) {
  const result = spawnSync("git", ["branch", "--list", branchName], { cwd: projectRoot, encoding: "utf8" });
  return result.stdout.trim() !== "";
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("exec orphaned-branch detection", () => {
  it("detects orphaned branch via git branch --list", () => {
    const projectRoot = makeTempDir("exec-orphan-detect");
    dirs.push(projectRoot);
    initGitRepo(projectRoot, "staging");

    const branchName = "rks/my-story";
    spawnSync("git", ["checkout", "-b", branchName], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });

    expect(branchExists(projectRoot, branchName)).toBe(true);
  });

  it("returns false for non-existent branch", () => {
    const projectRoot = makeTempDir("exec-orphan-noexist");
    dirs.push(projectRoot);
    initGitRepo(projectRoot, "staging");

    expect(branchExists(projectRoot, "rks/ghost-branch")).toBe(false);
  });
});

describe("cleanupFeatureBranch (imported from test-runner.mjs)", () => {
  it("is a synchronous function (not async) — no await needed in exec.mjs", () => {
    expect(typeof cleanupFeatureBranch).toBe("function");
    // constructor.name would be "AsyncFunction" if async — must be plain "Function"
    expect(cleanupFeatureBranch.constructor.name).toBe("Function");
  });

  it("returns { checkoutOk, branchDeleteOk } when cleaning up an existing branch", () => {
    const projectRoot = makeTempDir("exec-orphan-cleanup");
    dirs.push(projectRoot);
    initGitRepo(projectRoot, "staging");

    const branchName = "rks/cleanup-test";
    spawnSync("git", ["checkout", "-b", branchName], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "work.txt"), "work in progress");
    spawnSync("git", ["add", "-A"], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "wip"], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });

    const result = cleanupFeatureBranch(projectRoot, branchName, "staging");

    expect(result).toHaveProperty("checkoutOk");
    expect(result).toHaveProperty("branchDeleteOk");
    expect(result.checkoutOk).toBe(true);
    expect(result.branchDeleteOk).toBe(true);
  });

  it("branch no longer exists after cleanup", () => {
    const projectRoot = makeTempDir("exec-orphan-cleanup-gone");
    dirs.push(projectRoot);
    initGitRepo(projectRoot, "staging");

    const branchName = "rks/to-delete";
    spawnSync("git", ["checkout", "-b", branchName], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });

    cleanupFeatureBranch(projectRoot, branchName, "staging");

    expect(branchExists(projectRoot, branchName)).toBe(false);
  });

  it("exec proceeds to create fresh branch after orphaned branch is cleaned", () => {
    const projectRoot = makeTempDir("exec-orphan-retry");
    dirs.push(projectRoot);
    initGitRepo(projectRoot, "staging");

    const branchName = "rks/retry-story";

    // Simulate interrupted prior build: branch exists with commits
    spawnSync("git", ["checkout", "-b", branchName], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "partial.txt"), "partial work");
    spawnSync("git", ["add", "-A"], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "partial"], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });

    expect(branchExists(projectRoot, branchName)).toBe(true);

    // Run cleanup (mirrors exec.mjs orphaned-branch cleanup step)
    const cleanup = cleanupFeatureBranch(projectRoot, branchName, "staging");
    expect(cleanup.checkoutOk).toBe(true);
    expect(cleanup.branchDeleteOk).toBe(true);
    expect(branchExists(projectRoot, branchName)).toBe(false);

    // Now exec can create a fresh branch without error
    const createResult = spawnSync("git", ["checkout", "-b", branchName, "staging"], { cwd: projectRoot, encoding: "utf8" });
    expect(createResult.status).toBe(0);
    expect(branchExists(projectRoot, branchName)).toBe(true);
  });
});
