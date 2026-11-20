/**
 * Tests for backlog.fix.ship-path-commits-tracked-files-under-ignored-dirs.
 *
 * A modified, TRACKED file under a gitignored directory must be stageable by the
 * off-rail ship scope (guardrails-audit.mjs) and by runGitCommit explicit files
 * (git-workflow.mjs). An UNTRACKED file under the same ignored directory must
 * still never be force-added. The split is decided by `git ls-files`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { guardrailsOff, guardrailsOn } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/** Every subprocess spawn in this file carries an explicit timeout. */
function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 120_000, env: GIT_ENV });
}

const dirs = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

const write = (root, rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const tracked = (root, rel) => git(root, ["ls-files", "--", rel]).stdout.trim();
const headSha = (root) => git(root, ["rev-parse", "HEAD"]).stdout.trim();
const commitFiles = (root, sha) =>
  git(root, ["show", "--name-only", "--format=", sha]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Off-rail ship scope (guardrails-audit.mjs)
// ---------------------------------------------------------------------------
const STORY_ID = "backlog.fix.fixture";
const IN_SCOPE = "packages/mcp-rks/src/example.mjs";
const TRACKED_IGNORED = ".rks/prompts/x.md";      // tracked, under ignored .rks/
const UNTRACKED_IGNORED = ".rks/prompts/new.md";   // untracked, under ignored .rks/
const OOS_TRACKED_IGNORED = ".rks/prompts/y.md";   // tracked, under ignored .rks/, NOT in scope

function storyNote(targetFiles) {
  const lines = ["---", `id: "${STORY_ID}"`, 'phase: "arch-approved"', "targetFiles:"];
  for (const t of targetFiles) lines.push(`  - path: "${t}"`, '    op: "edit"');
  lines.push("---", "", "## Problem", "");
  return lines.join("\n");
}

function makeShipRepo() {
  const dir = tmp("rks-ignored-ship-");
  const bare = tmp("rks-ignored-ship-origin-");
  git(bare, ["init", "--bare", "-q"]);
  for (const tier of ["write", "read", "system"]) {
    write(dir, `.routekit/hooks/${tier}/${tier[0]}.mjs`, "export default {};\n");
  }
  write(dir, ".routekit/hooks-manifest.json", JSON.stringify({
    hooks: [{ name: "w", tier: "write" }, { name: "r", tier: "read" }, { name: "s", tier: "system" }],
  }, null, 2));
  write(dir, ".gitignore", [".rks/", ".routekit/hooks.bak/", ""].join("\n"));
  write(dir, ".rks/review-policy.yaml", "enabled: false\n");
  write(dir, IN_SCOPE, "export const v = 1;\n");
  write(dir, TRACKED_IGNORED, "v1\n");
  write(dir, OOS_TRACKED_IGNORED, "v1\n");
  write(dir, `notes/${STORY_ID}.md`, storyNote([IN_SCOPE, TRACKED_IGNORED, UNTRACKED_IGNORED]));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["checkout", "-q", "-b", "staging"]);
  git(dir, ["add", "-A"]);
  // The fixture's premise: tracked files under an ignored directory.
  git(dir, ["add", "-f", "--", TRACKED_IGNORED, OOS_TRACKED_IGNORED]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
  git(dir, ["remote", "add", "origin", bare]);
  git(dir, ["push", "-q", "-u", "origin", "staging"]);
  expect(tracked(dir, TRACKED_IGNORED)).toBe(TRACKED_IGNORED);
  return { dir, bare };
}

describe("off-rail ship scope: tracked file under an ignored directory", () => {
  it("stages and commits a modified tracked file under an ignored directory", async () => {
    const { dir } = makeShipRepo();
    expect((await guardrailsOff(dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(dir, TRACKED_IGNORED, "v2\n");
    const res = await guardrailsOn(dir, {}, "test-project");
    expect({ shipOutcome: res.shipOutcome, shipError: res.shipError })
      .toEqual({ shipOutcome: "shipped", shipError: undefined });
    expect(res.commitId).toBeTruthy();
    expect(commitFiles(dir, res.commitId)).toContain(TRACKED_IGNORED);
  });

  it("never commits an untracked file under the same ignored directory, and leaves it on disk", async () => {
    const { dir } = makeShipRepo();
    expect((await guardrailsOff(dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(dir, TRACKED_IGNORED, "v2\n");
    write(dir, UNTRACKED_IGNORED, "new\n");
    const res = await guardrailsOn(dir, {}, "test-project");
    expect(res.shipError).toBeUndefined();
    expect(commitFiles(dir, res.commitId)).not.toContain(UNTRACKED_IGNORED);
    expect(tracked(dir, UNTRACKED_IGNORED)).toBe("");
    expect(fs.readFileSync(path.join(dir, UNTRACKED_IGNORED), "utf8")).toBe("new\n");
  });

  it("does not widen scope: an out-of-scope tracked file under the ignored directory stays unstaged and enumerated", async () => {
    const { dir } = makeShipRepo();
    expect((await guardrailsOff(dir, "t", "all", STORY_ID, "test-project")).ok).toBe(true);
    write(dir, TRACKED_IGNORED, "v2\n");
    write(dir, OOS_TRACKED_IGNORED, "v2\n");
    const res = await guardrailsOn(dir, {}, "test-project");
    expect(res.shipError).toBeUndefined();
    expect(commitFiles(dir, res.commitId)).not.toContain(OOS_TRACKED_IGNORED);
    expect(res.unstagedOutOfScope).toContain(OOS_TRACKED_IGNORED);
    expect(fs.readFileSync(path.join(dir, OOS_TRACKED_IGNORED), "utf8")).toBe("v2\n");
  });
});

// ---------------------------------------------------------------------------
// runGitCommit explicit files (git-workflow.mjs)
// ---------------------------------------------------------------------------
const X = ".rks/x.yaml";
const NEW = ".rks/new.yaml";

function makeCommitRepo({ ignoreVia = "gitignore" } = {}) {
  const dir = tmp("rks-ignored-commit-");
  git(dir, ["init", "-q", "-b", "feature/test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  if (ignoreVia === "gitignore") write(dir, ".gitignore", ".rks/\n");
  else write(dir, ".git/info/exclude", ".rks/\n");
  write(dir, "README.md", "init\n");
  write(dir, X, "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["add", "-f", "--", X]);
  git(dir, ["commit", "-q", "-m", "init"]);
  expect(tracked(dir, X)).toBe(X);
  return dir;
}

describe("runGitCommit: tracked file under an ignored directory", () => {
  it("structured mode commits a modified tracked file under an ignored directory", async () => {
    const dir = makeCommitRepo();
    write(dir, X, "v2\n");
    const res = await runGitCommit({ projectRoot: dir, message: "edit x", type: "chore", files: [X] });
    expect(res.ok).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(X);
  });

  it("verbatim mode commits it too, and committedPaths names it", async () => {
    const dir = makeCommitRepo();
    write(dir, X, "v2\n");
    const res = await runGitCommit({ projectRoot: dir, rawMessage: "chore: edit x\n", files: [X] });
    expect(res.ok).toBe(true);
    expect(res.committedPaths).toContain(X);
  });

  it("refuses an untracked file under the ignored directory, names it, and creates no commit", async () => {
    const dir = makeCommitRepo();
    const before = headSha(dir);
    write(dir, X, "v2\n");
    write(dir, NEW, "new\n");
    const res = await runGitCommit({ projectRoot: dir, message: "edit x", type: "chore", files: [X, NEW] });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(NEW);
    expect(headSha(dir)).toBe(before);
    expect(tracked(dir, NEW)).toBe("");
  });

  it("split is decided by git ls-files: an ignore from .git/info/exclude (no .gitignore) behaves the same", async () => {
    const dir = makeCommitRepo({ ignoreVia: "exclude" });
    write(dir, X, "v2\n");
    const ok = await runGitCommit({ projectRoot: dir, message: "edit x", type: "chore", files: [X] });
    expect(ok.ok).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(X);
    const before = headSha(dir);
    write(dir, NEW, "new\n");
    const refused = await runGitCommit({ projectRoot: dir, message: "add new", type: "chore", files: [NEW] });
    expect(refused.ok).toBe(false);
    expect(headSha(dir)).toBe(before);
    expect(tracked(dir, NEW)).toBe("");
  });
});

// guardrails-audit.mjs already contains `ls-files` elsewhere (QA exhaustive search
// @8f0262fe2), so a source pin there would be vacuous. git-workflow.mjs contains none
// today, so this pin is a real red-before-green witness for the runGitCommit split.
describe("source: runGitCommit consults git ls-files", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  it("git-workflow.mjs invokes ls-files", () => {
    const src = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/git/git-workflow.mjs"), "utf8");
    expect(src).toContain("ls-files");
  });
});
