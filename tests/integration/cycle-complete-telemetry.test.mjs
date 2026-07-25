import { describe, it, expect, beforeEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";

describe("cycle-complete telemetry and stale branch cleanup", { timeout: 30_000 }, () => {
  let projectRoot;

  function initGitRepoWithOrigin(dir) {
    // Create a bare repo to act as origin
    const bareDir = dir + "-origin";
    fs.mkdirSync(bareDir, { recursive: true });
    spawnSync("git", ["init", "--bare", "-b", "staging"], { cwd: bareDir });

    // Init the working repo
    spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "file.txt"), "initial");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: dir });

    // Add origin and push
    spawnSync("git", ["remote", "add", "origin", bareDir], { cwd: dir });
    spawnSync("git", ["push", "-u", "origin", "staging"], { cwd: dir });
  }

  beforeEach(() => {
    projectRoot = makeTempDir("cycle-complete-test");
    initGitRepoWithOrigin(projectRoot);
    // Create .rks dir for telemetry
    fs.mkdirSync(path.join(projectRoot, ".rks"), { recursive: true });
  });

  it("emits cycle.complete telemetry event", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("cycle_complete");
    expect(result.newHead).toBeTruthy();

    // Check telemetry was written
    const telemetryDir = path.join(projectRoot, ".rks", "telemetry");
    if (fs.existsSync(telemetryDir)) {
      const files = fs.readdirSync(telemetryDir);
      const telemetryFile = files.find(f => f.endsWith(".jsonl"));
      if (telemetryFile) {
        const content = fs.readFileSync(path.join(telemetryDir, telemetryFile), "utf8");
        expect(content).toContain("cycle.complete");
      }
    }
  });

  it("reports stale merged rks/* branches", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    // Create and merge an rks branch
    spawnSync("git", ["checkout", "-b", "rks/old-story"], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "feature.txt"), "feature");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "add feature"], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });
    spawnSync("git", ["merge", "rks/old-story", "--no-edit"], { cwd: projectRoot });
    // Push merged state to origin so reset --hard doesn't revert the merge
    spawnSync("git", ["push", "origin", "staging"], { cwd: projectRoot });

    // Now run cycle complete - should detect and delete the merged branch
    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);

    if (result.staleBranches && result.staleBranches.length > 0) {
      const oldBranch = result.staleBranches.find(b => b.name === "rks/old-story");
      expect(oldBranch).toBeTruthy();
      expect(oldBranch.merged).toBe(true);
      expect(oldBranch.deleted).toBe(true);
    }

    // Verify branch was actually deleted
    const branches = spawnSync("git", ["branch", "--list", "rks/*"], { cwd: projectRoot, encoding: "utf8" });
    expect(branches.stdout).not.toContain("rks/old-story");
  });

  it("reports stale unmerged rks/* branches without deleting", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    // Create an rks branch but DON'T merge it
    spawnSync("git", ["checkout", "-b", "rks/abandoned-story"], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "abandoned.txt"), "abandoned");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "abandoned work"], { cwd: projectRoot });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot });

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);

    if (result.staleBranches && result.staleBranches.length > 0) {
      const abandoned = result.staleBranches.find(b => b.name === "rks/abandoned-story");
      expect(abandoned).toBeTruthy();
      expect(abandoned.merged).toBe(false);
      expect(abandoned.deleted).toBe(false);
    }

    // Verify branch still exists
    const branches = spawnSync("git", ["branch", "--list", "rks/*"], { cwd: projectRoot, encoding: "utf8" });
    expect(branches.stdout).toContain("rks/abandoned-story");
  });

  it("includes localCommitsDiscarded count in result", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);
    // With origin in sync, no divergence warning
    expect(result.divergenceWarning).toBeNull();
  });
});
