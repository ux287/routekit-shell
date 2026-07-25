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
vi.mock('../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-b", "feature/test"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "init.txt"), "init");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", [
    "commit", "-m", "init",
    "--author", "Test <test@test.com>",
  ], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" },
  });
}

function committedFiles(dir) {
  const result = spawnSync("git", ["diff", "--name-only", "HEAD~1", "HEAD"], { cwd: dir, encoding: "utf8" });
  return result.stdout.trim().split("\n").filter(Boolean);
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

  it("falls back to staging all changes (git add -A equivalent) when files is absent", async () => {
    fs.writeFileSync(path.join(projectRoot, "a.mjs"), "// a");
    fs.writeFileSync(path.join(projectRoot, "b.mjs"), "// b");

    const result = await runGitCommit({
      projectRoot,
      message: "test",
      scope: "test",
      type: "feat",
      // files intentionally omitted
    });

    expect(result.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("a.mjs");
    expect(files).toContain("b.mjs");
  });

  it("falls back to staging all changes when files is an empty array", async () => {
    fs.writeFileSync(path.join(projectRoot, "c.mjs"), "// c");

    const result = await runGitCommit({
      projectRoot,
      message: "test",
      scope: "test",
      type: "feat",
      files: [],
    });

    expect(result.ok).toBe(true);
    const files = committedFiles(projectRoot);
    expect(files).toContain("c.mjs");
  });

  it("does not stage hook deletions when files contains only story source paths", async () => {
    // Simulate guardrails-off state: hooks were tracked in initial commit,
    // then moved to hooks.bak (git sees them as deleted).
    fs.mkdirSync(path.join(projectRoot, ".routekit", "hooks", "write"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".routekit", "hooks", "write", "enforce-branch-workflow.mjs"), "// hook");
    spawnSync("git", ["add", "."], { cwd: projectRoot });
    spawnSync("git", ["commit", "--allow-empty-message", "-m", "add hooks"], {
      cwd: projectRoot,
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" },
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
});
