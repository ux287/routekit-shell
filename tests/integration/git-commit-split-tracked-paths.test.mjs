/**
 * Tests for backlog.fix.git-commit-split-tracked-paths-misclassifies-dirs-and-dotdot.
 *
 * runGitCommit's explicit-files split must classify a path by what git reports the pathspec
 * MATCHES: a directory (with or without a trailing slash) or a non-normalized path (`../`,
 * `./` interior segments) that covers tracked content under an ignored directory is staged
 * with `add -u`, never with a plain `git add` that git refuses. An untracked ignored file is
 * never force-added: named explicitly it is refused; inside a named directory it stays
 * untracked on disk.
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
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, env: GIT_ENV });
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

const A = "cfg/a.yaml";       // tracked (force-added), under ignored cfg/
const NEW = "cfg/new.yaml";   // untracked, under ignored cfg/
const SRC_A = "src/a.mjs";    // tracked, NOT ignored
const SRC_B = "src/b.mjs";    // untracked, NOT ignored

function makeRepo() {
  const dir = tmp("rks-split-tracked-");
  git(dir, ["init", "-q", "-b", "feature/test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  write(dir, ".gitignore", "cfg/\n");
  write(dir, "README.md", "init\n");
  write(dir, A, "v1\n");
  write(dir, SRC_A, "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  // The fixture's premise: a tracked file under an ignored directory.
  git(dir, ["add", "-f", "--", A]);
  git(dir, ["commit", "-q", "-m", "init"]);
  expect(tracked(dir, A)).toBe(A);
  expect(tracked(dir, SRC_A)).toBe(SRC_A);
  return dir;
}

async function commitWith(dir, files) {
  return runGitCommit({ projectRoot: dir, message: "edit", type: "chore", files });
}

describe("runGitCommit: tracked content under an ignored directory, named by non-exact paths", () => {
  it("AC1 directory: files ['cfg'] commits the modified tracked cfg/a.yaml", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    const res = await commitWith(dir, ["cfg"]);
    expect(res.ok, String(res.error)).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(A);
  });

  it("AC1 trailing slash: files ['cfg/'] commits the modified tracked cfg/a.yaml", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    const res = await commitWith(dir, ["cfg/"]);
    expect(res.ok, String(res.error)).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(A);
  });

  it("AC2 dot-dot: files ['other/../cfg/a.yaml'] commits cfg/a.yaml", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    const res = await commitWith(dir, ["other/../cfg/a.yaml"]);
    expect(res.ok, String(res.error)).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(A);
  });

  it("interior dot segment: files ['cfg/./a.yaml'] commits cfg/a.yaml", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    const res = await commitWith(dir, ["cfg/./a.yaml"]);
    expect(res.ok, String(res.error)).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(A);
  });

  it("absolute path regression: files [<abs>/cfg/a.yaml] commits cfg/a.yaml", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    const res = await commitWith(dir, [path.join(dir, A)]);
    expect(res.ok, String(res.error)).toBe(true);
    expect(commitFiles(dir, "HEAD")).toContain(A);
  });
});

describe("runGitCommit: directory holding tracked and untracked content", () => {
  it("AC3 mixed directory: files ['src'] stages the modified src/a.mjs and the new src/b.mjs", async () => {
    const dir = makeRepo();
    write(dir, SRC_A, "export const a = 2;\n");
    write(dir, SRC_B, "export const b = 1;\n");
    const res = await commitWith(dir, ["src"]);
    expect(res.ok, String(res.error)).toBe(true);
    const files = commitFiles(dir, "HEAD");
    expect(files).toContain(SRC_A);
    expect(files).toContain(SRC_B);
  });

  it("directory with an ignored untracked file: files ['cfg'] commits cfg/a.yaml only; cfg/new.yaml stays untracked on disk", async () => {
    const dir = makeRepo();
    write(dir, A, "v2\n");
    write(dir, NEW, "new\n");
    const res = await commitWith(dir, ["cfg"]);
    expect(res.ok, String(res.error)).toBe(true);
    const files = commitFiles(dir, "HEAD");
    expect(files).toContain(A);
    expect(files).not.toContain(NEW);
    expect(tracked(dir, NEW)).toBe("");
    expect(fs.readFileSync(path.join(dir, NEW), "utf8")).toBe("new\n");
  });
});

describe("runGitCommit: ignored-untracked guard unchanged", () => {
  it("AC4: an explicitly named untracked cfg/new.yaml is refused, named, and nothing is committed or tracked", async () => {
    const dir = makeRepo();
    const before = headSha(dir);
    write(dir, NEW, "new\n");
    const res = await commitWith(dir, [NEW]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(NEW);
    expect(headSha(dir)).toBe(before);
    expect(tracked(dir, NEW)).toBe("");
  });
});
