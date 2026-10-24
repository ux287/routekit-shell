import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

/**
 * Tests for test results rendering in PR body.
 *
 * Strategy: create a real git repo so runGitPR's git checks pass,
 * then mock only `gh pr create` (which would require a real GitHub remote)
 * by intercepting child_process.spawnSync.
 */

// Capture the PR body passed to `gh pr create`
let capturedBody = null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args, opts) => {
      // Intercept `gh pr create` to capture body and return a fake PR URL
      if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
        const bodyIdx = args.indexOf("--body");
        if (bodyIdx !== -1) capturedBody = args[bodyIdx + 1];
        return { status: 0, stdout: "https://github.com/test/repo/pull/1\n", stderr: "" };
      }
      // Intercept `gh pr merge` (auto-merge) — just succeed
      if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "merge") {
        return { status: 0, stdout: "", stderr: "" };
      }
      // All other commands (git) run for real
      return actual.spawnSync(cmd, args, opts);
    },
  };
});

describe("runGitPR test results in PR body", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    capturedBody = null;
    projectRoot = makeTempDir("pr-body-test");
    // Init a git repo with a staging branch
    spawnSync("git", ["init", "-b", "staging"], { cwd: projectRoot });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: projectRoot });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "file.txt"), "init");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "init"], { cwd: projectRoot });
    // Create feature branch with a commit
    spawnSync("git", ["checkout", "-b", "rks/test-feature"], { cwd: projectRoot });
    fs.writeFileSync(path.join(projectRoot, "feature.txt"), "feature");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "add feature"], { cwd: projectRoot });
    // Create a bare repo as "origin" so git push succeeds
    const bareDir = makeTempDir("pr-body-bare");
    spawnSync("git", ["init", "--bare"], { cwd: bareDir });
    spawnSync("git", ["remote", "add", "origin", bareDir], { cwd: projectRoot });
    // Push staging so origin has it
    spawnSync("git", ["push", "-u", "origin", "staging"], { cwd: projectRoot });
    // Switch back to feature branch
    spawnSync("git", ["checkout", "rks/test-feature"], { cwd: projectRoot });
    // Create .rks dir (needed for guardrails check)
    fs.mkdirSync(path.join(projectRoot, ".rks"), { recursive: true });
  });

  it("includes test results table when testResults provided", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
      testResults: { passCount: 42, failCount: 0, duration: "5.2s", runner: "npm test", attempts: 1 },
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).toContain("## Test Results");
    expect(capturedBody).toContain("42 passed");
    expect(capturedBody).toContain("5.2s");
    expect(capturedBody).toContain("npm test");
    expect(capturedBody).toContain("✅ Passed");
  });

  it("shows failed status when failCount > 0", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
      testResults: { passCount: 38, failCount: 4, duration: "8.1s", runner: "vitest", attempts: 2 },
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).toContain("❌ Failed");
    expect(capturedBody).toContain("38 passed, 4 failed");
    expect(capturedBody).toContain("| Attempts | 2 |");
  });

  it("renders skipped tests note when testsSkipped is true", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
      testResults: { testsSkipped: true, skipReason: "paired test story" },
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).toContain("## Test Results");
    expect(capturedBody).toContain("Tests skipped");
    expect(capturedBody).toContain("paired test story");
    expect(capturedBody).not.toContain("| Metric |");
  });

  it("omits test results section when no testResults provided", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).not.toContain("## Test Results");
    expect(capturedBody).toContain("## Summary");
    expect(capturedBody).toContain("## Test Plan");
  });

  it("renders null counts as unavailable with the reason, never '0 passed' or '✅ Passed'", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
      testResults: { passCount: null, failCount: null, countsUnavailableReason: "no_summary_line", duration: "3.0s", attempts: 1 },
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).toContain("## Test Results");
    expect(capturedBody).toContain("unavailable");
    expect(capturedBody).toContain("no_summary_line");
    expect(capturedBody).not.toContain("0 passed");
    expect(capturedBody).not.toContain("✅ Passed");
  });

  it("omits test results section when testResults is null", async () => {
    const { runGitPR } = await import("../../packages/mcp-rks/src/server/git/git-workflow.mjs");
    const result = await runGitPR({
      projectRoot,
      targetBranch: "staging",
      title: "test PR",
      problemId: "backlog.feat.test",
      testResults: null,
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).not.toContain("## Test Results");
  });
});

// backlog.feat.exec-test-result-persistence (AC7): no git and no subprocess — a temp project with a
// hand-written .rks/runs/<id>/run.json.
describe("loadTestResultsFromRun keeps observed counts as observed", () => {
  const writeRun = (testVerification, extra = {}) => {
    const root = makeTempDir("load-test-results");
    const runDir = path.join(root, ".rks", "runs", "20261024-000000_story");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ attempts: 1, testsPassed: true, testsSkipped: false, testVerification, ...extra }));
    return root;
  };

  it("returns null (not 0) for null counts and passes countsUnavailableReason through", async () => {
    const { loadTestResultsFromRun } = await import("../../packages/mcp-rks/src/server/git/git-ship.mjs");
    const root = writeRun({ passed: true, passCount: null, failCount: null, countsSource: null, countsUnavailableReason: "no_summary_line", duration: 1200, attempts: 1, exitCode: 0, command: ["node", "--test"] });
    const r = loadTestResultsFromRun(root);
    expect(r.passCount).toBeNull();
    expect(r.failCount).toBeNull();
    expect(r.countsUnavailableReason).toBe("no_summary_line");
  });

  it("returns numeric counts unchanged, including an observed failCount of 0", async () => {
    const { loadTestResultsFromRun } = await import("../../packages/mcp-rks/src/server/git/git-ship.mjs");
    const root = writeRun({ passed: true, passCount: 18, failCount: 0, countsSource: "node:test", countsUnavailableReason: null, duration: 1200, attempts: 1, exitCode: 0, command: ["node", "--test"] });
    const r = loadTestResultsFromRun(root);
    expect(r.passCount).toBe(18);
    expect(r.failCount).toBe(0);
    expect(r.countsUnavailableReason).toBeNull();
  });
});
