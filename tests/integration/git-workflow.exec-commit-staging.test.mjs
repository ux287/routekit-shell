import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

// Mock only the ONNX/Xenova embedding step, NOT commitAndEmbed itself.
// Mocking commitAndEmbed skips the real `git commit` and breaks the four
// assertions on `committedFiles()` (which shells out to `git diff --name-only
// HEAD~1 HEAD`). Mocking one layer deeper at runRagEmbed leaves real git
// semantics intact and only short-circuits the embedding pipeline.
vi.mock('@routekit/rag/tools', () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";
import { runShip } from "../../packages/mcp-rks/src/server/git/git-ship.mjs";
import { createGitAgent } from "../../packages/mcp-rks/src/agents/git.mjs";

// Every git spawn in this file carries an explicit timeout so a wedged git
// process fails the test instead of hanging the run.
const GIT_TIMEOUT_MS = 15_000;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com",
};

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-b", "feature/test"], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  fs.writeFileSync(path.join(dir, "init.txt"), "init");
  spawnSync("git", ["add", "."], { cwd: dir, timeout: GIT_TIMEOUT_MS });
  spawnSync("git", [
    "commit", "-m", "init",
    "--author", "Test <test@test.com>",
  ], {
    cwd: dir,
    timeout: GIT_TIMEOUT_MS,
    env: GIT_ENV,
  });
}

function committedFiles(dir) {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return result.stdout.trim().split("\n").filter(Boolean);
}

// Run git in the temp repo, throwing on spawn error or non-zero exit.
function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: GIT_ENV });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

// Commit tracked files p, q, r and s on top of the init commit so tests can
// delete or modify them afterwards.
function commitTrackedFixtures(dir) {
  for (const name of ["p.txt", "q.txt", "r.txt", "s.txt"]) {
    fs.writeFileSync(path.join(dir, name), `${name} v1\n`);
  }
  git(dir, ["add", "p.txt", "q.txt", "r.txt", "s.txt"]);
  git(dir, ["commit", "-m", "fixtures"]);
}

// Remove a path from both the worktree and the index (the `git rm` case).
function stageDeletion(dir, file) {
  git(dir, ["rm", "-q", file]);
}

function nameStatusOfLastCommit(dir) {
  const out = git(dir, ["diff", "--name-status", "HEAD~1", "HEAD"]);
  const map = {};
  for (const line of out.split("\n").filter(Boolean)) {
    const [status, file] = line.split("\t");
    map[file] = status;
  }
  return map;
}

function porcelainStatus(dir) {
  return git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean);
}

function headSha(dir) {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

// The x/y fixture of backlog.fix.git-commit-broad-add-fallback: a tracked file y committed and
// then modified, plus an untracked stray x that no caller named.
function setUpStrayFixture(dir) {
  fs.writeFileSync(path.join(dir, "y.txt"), "y v1\n");
  git(dir, ["add", "y.txt"]);
  git(dir, ["commit", "-m", "track y"]);
  fs.writeFileSync(path.join(dir, "y.txt"), "y v2 (modified)\n");
  fs.writeFileSync(path.join(dir, "x.txt"), "untracked stray\n");
}

function stagedNames(dir) {
  return git(dir, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
}

// Every path that appears in any commit reachable from HEAD.
function everCommittedPaths(dir) {
  return git(dir, ["log", "--format=", "--name-only"]).split("\n").filter(Boolean);
}

function branchList(dir) {
  return git(dir, ["branch", "--list"]);
}

describe("runGitCommit — scoped staging via files parameter", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("exec-commit-staging");
    initRepo(projectRoot);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("stages only the specified files when files is a non-empty array", async () => {
    fs.writeFileSync(path.join(projectRoot, "story.mjs"), "// story");
    fs.writeFileSync(path.join(projectRoot, "other.mjs"), "// other — should not be staged");

    const result = await runGitCommit({
      projectRoot,
      message: "test",
      scope: "test",
      type: "feat",
      files: ["story.mjs"],
    });

    expect(result.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("story.mjs");
    expect(files).not.toContain("other.mjs");
  });

  // backlog.fix.git-commit-broad-add-fallback: these two tests used to pin the `git add -A`
  // fallback for an absent / empty files list. They now assert the refusal, with an untracked
  // stray x and a modified tracked y present.
  it("refuses to commit (no git add -A fallback) when files is absent", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);

    const result = await runGitCommit({
      projectRoot,
      message: "test",
      scope: "test",
      type: "feat",
      // files intentionally omitted
    });

    expect(result.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
    expect(everCommittedPaths(projectRoot)).not.toContain("x.txt");
  });

  it("refuses to commit (no git add -A fallback) when files is an empty array", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);

    const result = await runGitCommit({
      projectRoot,
      message: "test",
      scope: "test",
      type: "feat",
      files: [],
    });

    expect(result.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
    const ever = everCommittedPaths(projectRoot);
    expect(ever).not.toContain("x.txt");
    // y was committed once by the fixture; no commit after that touches it.
    expect(git(projectRoot, ["log", "--format=%H", "--", "y.txt"]).trim().split("\n")).toHaveLength(1);
  });

  it("names the files argument and the remedy in the refusal for both the omitted and the empty case", async () => {
    setUpStrayFixture(projectRoot);
    for (const extra of [{}, { files: [] }]) {
      const result = await runGitCommit({ projectRoot, message: "test", scope: "test", type: "feat", ...extra });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/\bfiles\b/);
      expect(result.error).toContain("explicit files list");
      expect(result.error).toContain("stageAll: true");
    }
  });

  it("stages and commits every change only with an explicit stageAll: true", async () => {
    setUpStrayFixture(projectRoot);

    const result = await runGitCommit({
      projectRoot, message: "all", scope: "test", type: "feat", stageAll: true,
    });

    expect(result.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("x.txt");
    expect(files).toContain("y.txt");
  });

  it("never infers stageAll from files: omitted or empty files with stageAll absent or false is refused", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);
    for (const extra of [{}, { files: [] }, { stageAll: false }, { files: [], stageAll: false }]) {
      const result = await runGitCommit({ projectRoot, message: "t", scope: "test", type: "feat", ...extra });
      expect(result.ok).toBe(false);
    }
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
  });

  it("refuses an exec-shaped commit whose commitFiles is empty (zero-applied-files exec run)", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);

    // Shaped exactly as exec.mjs calls it: scope exec, type feat, storyId set, files: commitFiles.
    const result = await runGitCommit({
      projectRoot,
      message: "backlog.fix.some-story",
      scope: "exec",
      type: "feat",
      files: [],
      storyId: "backlog.fix.some-story",
    });

    expect(result.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
  });

  it("does not stage hook deletions when files contains only story source paths", async () => {
    // Simulate guardrails-off state: hooks were tracked in initial commit,
    // then moved to hooks.bak (git sees them as deleted).
    fs.mkdirSync(path.join(projectRoot, ".routekit", "hooks", "write"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".routekit", "hooks", "write", "enforce-branch-workflow.mjs"), "// hook");
    spawnSync("git", ["add", "."], { cwd: projectRoot, timeout: GIT_TIMEOUT_MS });
    spawnSync("git", ["commit", "--allow-empty-message", "-m", "add hooks"], {
      cwd: projectRoot,
      timeout: GIT_TIMEOUT_MS,
      env: GIT_ENV,
    });

    // Move hook to .bak (simulates guardrails off)
    fs.mkdirSync(path.join(projectRoot, ".routekit", "hooks.bak", "write"), { recursive: true });
    fs.renameSync(
      path.join(projectRoot, ".routekit", "hooks", "write", "enforce-branch-workflow.mjs"),
      path.join(projectRoot, ".routekit", "hooks.bak", "write", "enforce-branch-workflow.mjs")
    );

    // Create the story file
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "story.mjs"), "// story implementation");

    const result = await runGitCommit({
      projectRoot,
      message: "exec-story",
      scope: "exec",
      type: "feat",
      files: ["src/story.mjs"],
    });

    expect(result.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("src/story.mjs");
    expect(files).not.toContain(".routekit/hooks/write/enforce-branch-workflow.mjs");
  });

  // backlog.fix.git-commit-add-fails-on-staged-deletion
  it("commits a listed path whose deletion is already staged together with a modified path", async () => {
    commitTrackedFixtures(projectRoot);
    stageDeletion(projectRoot, "p.txt");
    fs.writeFileSync(path.join(projectRoot, "q.txt"), "q.txt v2\n");

    const result = await runGitCommit({
      projectRoot, message: "staged deletion", scope: "test", type: "fix",
      files: ["p.txt", "q.txt"],
    });

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const status = nameStatusOfLastCommit(projectRoot);
    expect(status["p.txt"]).toBe("D");
    expect(status["q.txt"]).toBe("M");
  });

  it("stages and commits a listed path deleted from the worktree only", async () => {
    commitTrackedFixtures(projectRoot);
    fs.rmSync(path.join(projectRoot, "p.txt"));

    const result = await runGitCommit({
      projectRoot, message: "worktree deletion", scope: "test", type: "fix",
      files: ["p.txt"],
    });

    expect(result.ok).toBe(true);
    expect(nameStatusOfLastCommit(projectRoot)).toEqual({ "p.txt": "D" });
  });

  it("keeps an unlisted modified file out of the commit when a listed deletion is already staged", async () => {
    commitTrackedFixtures(projectRoot);
    stageDeletion(projectRoot, "p.txt");
    fs.writeFileSync(path.join(projectRoot, "q.txt"), "q.txt v2\n");
    fs.writeFileSync(path.join(projectRoot, "r.txt"), "r.txt v2 (unlisted)\n");

    const result = await runGitCommit({
      projectRoot, message: "scoped", scope: "test", type: "fix",
      files: ["p.txt", "q.txt"],
    });

    expect(result.ok).toBe(true);
    const status = nameStatusOfLastCommit(projectRoot);
    expect(Object.keys(status).sort()).toEqual(["p.txt", "q.txt"]);
    expect(status).not.toHaveProperty("r.txt");
    expect(porcelainStatus(projectRoot)).toContain(" M r.txt");
  });

  it("stages nothing repo-wide when every listed path is already a staged deletion (empty remainder)", async () => {
    commitTrackedFixtures(projectRoot);
    stageDeletion(projectRoot, "p.txt");
    fs.rmSync(path.join(projectRoot, "s.txt"));
    fs.writeFileSync(path.join(projectRoot, "u.txt"), "untracked stray\n");

    const result = await runGitCommit({
      projectRoot, message: "only staged deletion", scope: "test", type: "fix",
      files: ["p.txt"],
    });

    expect(result.ok).toBe(true);
    expect(nameStatusOfLastCommit(projectRoot)).toEqual({ "p.txt": "D" });
    const after = porcelainStatus(projectRoot);
    expect(after).toContain(" D s.txt");
    expect(after).toContain("?? u.txt");
  });

  it("fails naming a never-tracked path and leaves HEAD unchanged", async () => {
    commitTrackedFixtures(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "q.txt"), "q.txt v2\n");
    const before = headSha(projectRoot);

    const result = await runGitCommit({
      projectRoot, message: "bogus", scope: "test", type: "fix",
      files: ["q.txt", "never-existed.txt"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("never-existed.txt");
    expect(headSha(projectRoot)).toBe(before);
  });

  it("still fails naming a never-tracked path listed alongside an already-staged deletion", async () => {
    commitTrackedFixtures(projectRoot);
    stageDeletion(projectRoot, "p.txt");
    const before = headSha(projectRoot);

    const result = await runGitCommit({
      projectRoot, message: "bogus with deletion", scope: "test", type: "fix",
      files: ["p.txt", "never-existed.txt"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("never-existed.txt");
    expect(headSha(projectRoot)).toBe(before);
  });
});

// backlog.fix.git-commit-broad-add-fallback — the callers of runGitCommit. The rks_git_commit and
// rks_ship tool handlers opt in with stageAll only when files is OMITTED; files: [] is refused.
// runShip refuses before creating a branch; the git agent's git_commit never opts in.
describe("runGitCommit callers — explicit stageAll opt-in at the tool layer", { timeout: 60_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("exec-commit-staging-callers");
    initRepo(projectRoot);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Same harness as callGitCommitTool in tests/integration/exec-commit-story-trailer.test.mjs:
  // createServer over an InMemoryTransport, with ROUTEKIT_PROJECT_ROOT/ROUTEKIT_PROJECT_ID set and
  // .rks/project.json + .rks/kg.yaml written so loadContext resolves the temp repo.
  async function callTool(name, args) {
    fs.mkdirSync(path.join(projectRoot, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({ id: "test-project", kgFile: ".rks/kg.yaml" }));
    fs.writeFileSync(path.join(projectRoot, ".rks", "kg.yaml"), "{}\n");
    const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const prevId = process.env.ROUTEKIT_PROJECT_ID;
    process.env.ROUTEKIT_PROJECT_ROOT = projectRoot;
    process.env.ROUTEKIT_PROJECT_ID = "test-project";
    const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const r = await client.callTool({ name, arguments: { projectId: "test-project", ...args } });
      return JSON.parse(r.content[0].text);
    } finally {
      await client.close().catch(() => {});
      if (prevRoot === undefined) { delete process.env.ROUTEKIT_PROJECT_ROOT; } else { process.env.ROUTEKIT_PROJECT_ROOT = prevRoot; }
      if (prevId === undefined) { delete process.env.ROUTEKIT_PROJECT_ID; } else { process.env.ROUTEKIT_PROJECT_ID = prevId; }
    }
  }

  it("rks_git_commit handler with files omitted stages all changes and commits both x and y", async () => {
    setUpStrayFixture(projectRoot);

    const res = await callTool("rks_git_commit", { message: "omitted", scope: "test", type: "feat" });

    expect(res.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("x.txt");
    expect(files).toContain("y.txt");
  });

  it("rks_git_commit handler with files [] is refused, HEAD unchanged, nothing staged", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);

    const res = await callTool("rks_git_commit", { message: "empty", scope: "test", type: "feat", files: [] });

    expect(res.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
  });

  it("rks_ship handler on an rks/ branch: files omitted commits x and y; files [] is refused", async () => {
    git(projectRoot, ["checkout", "-b", "rks/ship-test"]);
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);

    // files []: refused before anything is staged or committed.
    const refused = await callTool("rks_ship", { message: "ship empty", scope: "test", type: "feat", files: [] });
    expect(refused.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);

    // files omitted: the handler opts in. The later push step fails without an origin remote,
    // so assert on git log rather than on ok.
    await callTool("rks_ship", { message: "ship omitted", scope: "test", type: "feat" });
    expect(headSha(projectRoot)).not.toBe(before);
    const files = committedFiles(projectRoot);
    expect(files).toContain("x.txt");
    expect(files).toContain("y.txt");
  });

  it("runShip with files [] and no stageAll refuses before creating any branch", async () => {
    setUpStrayFixture(projectRoot);
    // initRepo leaves the repo on feature/test, so runShip's branch-creation path is live.
    expect(git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/test");
    const before = headSha(projectRoot);
    const branchesBefore = branchList(projectRoot);

    const res = await runShip({ projectRoot, message: "ship empty", scope: "test", type: "feat", files: [] });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("stageAll: true");
    expect(headSha(projectRoot)).toBe(before);
    expect(branchList(projectRoot)).toBe(branchesBefore);
    expect(git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/test");
  });

  it("git agent git_commit tool with files omitted is refused and creates no commit", async () => {
    setUpStrayFixture(projectRoot);
    const before = headSha(projectRoot);
    const agent = createGitAgent({ projectId: "test", request: "test", projectRoot });
    const tool = agent.tools.find(t => t.name === "git_commit");
    expect(tool).toBeDefined();

    const res = await tool.execute({ message: "agent commit" });

    expect(res.ok).toBe(false);
    expect(headSha(projectRoot)).toBe(before);
    expect(stagedNames(projectRoot)).toEqual([]);
  });
});
