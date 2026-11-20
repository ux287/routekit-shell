import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepoCopy } from "../helpers/git-repo-template.mjs";

// Every git spawn in this file carries an explicit timeout.
const GIT_TIMEOUT = 30_000;

describe("stale branch cleanup during cycle complete", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    // Shared template: working repo (init -b staging) + sibling bare origin +
    // one commit pushed + a .rks/ dir. fs.cpSync copy, not a git rebuild.
    ({ workDir: projectRoot } = getRepoCopy("working-with-origin"));
  });

  it("auto-deletes merged rks/* branches", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    // Create two rks branches and merge them
    for (const name of ["rks/story-a", "rks/story-b"]) {
      spawnSync("git", ["checkout", "-b", name], { cwd: projectRoot, timeout: GIT_TIMEOUT });
      fs.writeFileSync(path.join(projectRoot, `${name.split("/")[1]}.txt`), name);
      spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
      spawnSync("git", ["commit", "-m", `work on ${name}`], { cwd: projectRoot, timeout: GIT_TIMEOUT });
      spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
      spawnSync("git", ["merge", name, "--no-edit"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    }
    // Push merged state to origin so reset --hard doesn't revert
    spawnSync("git", ["push", "origin", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);

    // Both should be reported as stale and deleted
    const deleted = (result.staleBranches || []).filter(b => b.deleted);
    expect(deleted.length).toBe(2);

    // Verify branches are gone
    const remaining = spawnSync("git", ["branch", "--list", "rks/*"], { cwd: projectRoot, encoding: "utf8", timeout: GIT_TIMEOUT });
    expect(remaining.stdout.trim()).toBe("");
  });

  it("does not delete unmerged rks/* branches", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    // Create an unmerged branch
    spawnSync("git", ["checkout", "-b", "rks/wip"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    fs.writeFileSync(path.join(projectRoot, "wip.txt"), "wip");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["commit", "-m", "work in progress"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);

    const unmerged = (result.staleBranches || []).filter(b => !b.merged);
    expect(unmerged.length).toBe(1);
    expect(unmerged[0].name).toBe("rks/wip");
    expect(unmerged[0].deleted).toBe(false);

    // Branch should still exist
    const remaining = spawnSync("git", ["branch", "--list", "rks/*"], { cwd: projectRoot, encoding: "utf8", timeout: GIT_TIMEOUT });
    expect(remaining.stdout).toContain("rks/wip");
  });

  it("handles mix of merged and unmerged branches", async () => {
    const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

    // Merged branch
    spawnSync("git", ["checkout", "-b", "rks/done"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    fs.writeFileSync(path.join(projectRoot, "done.txt"), "done");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["commit", "-m", "completed"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["merge", "rks/done", "--no-edit"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    // Unmerged branch
    spawnSync("git", ["checkout", "-b", "rks/pending"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    fs.writeFileSync(path.join(projectRoot, "pending.txt"), "pending");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["commit", "-m", "pending work"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    // Push merged state to origin so reset --hard doesn't revert
    spawnSync("git", ["push", "origin", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = await runCycleComplete({ projectRoot });
    expect(result.ok).toBe(true);

    const stale = result.staleBranches || [];
    expect(stale.length).toBe(2);

    const done = stale.find(b => b.name === "rks/done");
    expect(done.merged).toBe(true);
    expect(done.deleted).toBe(true);

    const pending = stale.find(b => b.name === "rks/pending");
    expect(pending.merged).toBe(false);
    expect(pending.deleted).toBe(false);
  });
});

// ── cleanupFeatureBranch unit tests ──────────────────────────────────

describe("cleanupFeatureBranch helper", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    // Shared template: working repo (init -b staging) + one commit, no remote.
    // fs.cpSync copy, not a git rebuild.
    ({ workDir: projectRoot } = getRepoCopy("working-no-origin"));
  });

  it("returns skipped when branchName is null", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");
    const result = cleanupFeatureBranch(projectRoot, null, "staging");
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns skipped when branchName is undefined", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");
    const result = cleanupFeatureBranch(projectRoot, undefined, "staging");
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("returns skipped when branchName equals baseBranch", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");
    const result = cleanupFeatureBranch(projectRoot, "staging", "staging");
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it("deletes a feature branch that exists", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");

    // Create a feature branch whose work was merged into base
    // (backlog.fix.cleanup-feature-branch-unmerged-guard: an unmerged branch is refused, not deleted).
    spawnSync("git", ["checkout", "-b", "rks/test-feature"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    fs.writeFileSync(path.join(projectRoot, "feature.txt"), "feature work");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["commit", "-m", "feature work"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["merge", "--ff-only", "rks/test-feature"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = cleanupFeatureBranch(projectRoot, "rks/test-feature", "staging");
    expect(result.ok).toBe(true);
    expect(result.checkoutOk).toBe(true);
    expect(result.branchDeleteOk).toBe(true);
    expect(result.errors).toBeUndefined();

    // Verify branch is gone
    const branches = spawnSync("git", ["branch", "--list", "rks/test-feature"], {
      cwd: projectRoot, encoding: "utf8", timeout: GIT_TIMEOUT,
    });
    expect(branches.stdout.trim()).toBe("");
  });

  it("does not throw when branch does not exist — returns branchDeleteOk: false", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");
    const result = cleanupFeatureBranch(projectRoot, "rks/nonexistent", "staging");
    // Fail closed: the unmerged-commit check cannot resolve the branch, so ok is not true.
    expect(result.ok).not.toBe(true);
    expect(result.branchDeleteOk).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("refuses a feature branch carrying a commit absent from base and keeps it", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");

    spawnSync("git", ["checkout", "-b", "rks/unmerged-feature"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    fs.writeFileSync(path.join(projectRoot, "unmerged.txt"), "unmerged work");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["commit", "-m", "unmerged work"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = cleanupFeatureBranch(projectRoot, "rks/unmerged-feature", "staging");
    expect(result.refused).toBe(true);
    expect(result.reason).toBe("unmerged_commits");
    expect(result.unmergedCount).toBe(1);
    expect(result.branchDeleteOk).toBe(false);
    expect(result.ok).not.toBe(true);

    const branches = spawnSync("git", ["branch", "--list", "rks/unmerged-feature"], {
      cwd: projectRoot, encoding: "utf8", timeout: GIT_TIMEOUT,
    });
    expect(branches.stdout.trim()).not.toBe("");
  });

  it("returns all flags true on successful cleanup", async () => {
    const { cleanupFeatureBranch } = await import("../../packages/mcp-rks/src/server/exec.mjs");

    // Create and switch back from feature branch
    spawnSync("git", ["checkout", "-b", "rks/cleanup-me"], { cwd: projectRoot, timeout: GIT_TIMEOUT });
    spawnSync("git", ["checkout", "staging"], { cwd: projectRoot, timeout: GIT_TIMEOUT });

    const result = cleanupFeatureBranch(projectRoot, "rks/cleanup-me", "staging");
    expect(result.ok).toBe(true);
    expect(result.checkoutOk).toBe(true);
    expect(result.worktreeRemoveOk).toBe(true);
    expect(result.branchDeleteOk).toBe(true);
  });
});
