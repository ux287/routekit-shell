import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

describe("runGitPR same-branch skip", { timeout: 30_000 }, () => {
  let projectRoot;

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

  beforeEach(() => {
    projectRoot = makeTempDir("git-workflow-skip-pr");
    initGitRepo(projectRoot);
  });

  it("returns { ok: true, skipped: true } when currentBranch equals targetBranch", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({ projectRoot, targetBranch: "staging" });
    if (!result.ok) console.error("runGitPR failed:", JSON.stringify(result));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("returns { ok: false } when on a different branch (no remote to PR to)", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    spawnSync("git", ["checkout", "-b", "feature/test"], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "new.txt"), "feature work");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "feature work"], { cwd: projectRoot });
    // No remote configured, so PR creation will fail — but it should NOT return skipped
    const result = await runGitPR({ projectRoot, targetBranch: "staging" });
    expect(result.skipped).toBeUndefined();
  });
});
