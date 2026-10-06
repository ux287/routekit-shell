import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../helpers/tmp.mjs";

// backlog.feat.governed-adhoc-commit-verbatim-message AC1-AC5, AC8: runGitCommit's verbatim
// mode (rawMessage + files) in a temp repo, the rks_git_commit handler over InMemoryTransport,
// ship-flow chain admission without a problemId, and the advertised tool schema/description.
// Every git spawn carries an explicit timeout (GIT_TIMEOUT_MS).

// Mock only the embedding step, not commitAndEmbed: real git semantics stay intact.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { runGitCommit } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";
import { createSession, checkAllowedTool, advanceStateOnResult, endSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

const GIT_TIMEOUT_MS = 15_000;

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "feature/test"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  for (const n of ["a.txt", "b.txt", "gone.txt"]) fs.writeFileSync(path.join(dir, n), `${n} v1\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

const headSha = (d) => git(d, ["rev-parse", "HEAD"]).trim();
const staged = (d) => git(d, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
const lastCommitPaths = (d) => git(d, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean).sort();

const MSG = "chore(sync): upgrade rks config\n\nBody paragraph line one.\n# not a comment under verbatim cleanup\n\nCo-Authored-By: Someone <someone@example.com>\nStory: backlog.x.y";

describe("runGitCommit verbatim mode", { timeout: 30_000 }, () => {
  let dir;
  beforeEach(() => { dir = makeTempDir("git-commit-verbatim"); initRepo(dir); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("AC1 commits the message byte-for-byte with no prefix and no added trailer", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"] });
    expect(res.ok).toBe(true);
    expect(git(dir, ["log", "-1", "--format=%B"]).replace(/\n$/, "")).toBe(MSG);
  });

  it("AC2 leaves an unlisted staged path staged and out of the commit; returns committedPaths from git", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "b v2\n");
    git(dir, ["add", "b.txt"]);
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"] });
    expect(res.ok).toBe(true);
    expect(lastCommitPaths(dir)).toEqual(["a.txt"]);
    expect(staged(dir)).toContain("b.txt");
    expect([...res.committedPaths].sort()).toEqual(lastCommitPaths(dir));
    // ARCH Item 10: report fields come from the commit, not the whole index or a default.
    expect(res.filesChanged).toBe(res.committedPaths.length);
    expect(res.filesChanged).toBe(1);
    expect(res.type).toBeNull();
    expect(res.scope).toBeNull();
  });

  it("AC2 commits an already-staged deletion", async () => {
    git(dir, ["rm", "-q", "gone.txt"]);
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["gone.txt"] });
    expect(res.ok).toBe(true);
    expect(git(dir, ["diff", "--name-status", "HEAD~1", "HEAD"])).toMatch(/^D\tgone\.txt$/m);
  });

  it("AC2 refuses when the named paths are unchanged even though another path is staged", async () => {
    fs.writeFileSync(path.join(dir, "b.txt"), "b v2\n");
    git(dir, ["add", "b.txt"]);
    const before = headSha(dir);
    const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"] });
    expect(res.ok).toBe(false);
    expect(headSha(dir)).toBe(before);
    expect(staged(dir)).toContain("b.txt");
  });

  for (const extra of [{ type: "fix" }, { scope: "x" }, { message: "m" }, { storyId: "backlog.x" }, { coAuthor: "A <a@example.com>" }]) {
    it(`AC3 rejects rawMessage combined with ${Object.keys(extra)[0]}`, async () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
      const before = headSha(dir);
      const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, files: ["a.txt"], ...extra });
      expect(res.ok).toBe(false);
      expect(res.error).toContain(Object.keys(extra)[0]);
      expect(headSha(dir)).toBe(before);
      expect(staged(dir)).toEqual([]); // guard runs before any staging
    });
  }

  for (const [label, args] of [
    ["files absent", {}],
    ["files empty", { files: [] }],
    ["files absent with stageAll", { stageAll: true }],
    ["empty message", { files: ["a.txt"], rawMessage: "" }],
    ["whitespace message", { files: ["a.txt"], rawMessage: "  \n\t " }],
  ]) {
    it(`AC3 rejects ${label}`, async () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
      const before = headSha(dir);
      const res = await runGitCommit({ projectRoot: dir, rawMessage: MSG, ...args });
      expect(res.ok).toBe(false);
      expect(headSha(dir)).toBe(before);
      expect(staged(dir)).toEqual([]);
    });
  }

  it("AC3 refuses a call with neither message nor rawMessage", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const before = headSha(dir);
    const res = await runGitCommit({ projectRoot: dir, files: ["a.txt"] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/message/);
    expect(res.error).toMatch(/rawMessage/);
    expect(headSha(dir)).toBe(before);
  });

  it("AC4 structured mode without type still prefixes feat (default applied inside runGitCommit)", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const res = await runGitCommit({ projectRoot: dir, message: "m", files: ["a.txt"] });
    expect(res.ok).toBe(true);
    expect(git(dir, ["log", "-1", "--format=%B"]).trimEnd()).toBe("feat: m");
  });
});

describe("AC5 ship flow admits commit then push without a problemId", () => {
  it("rks_git_commit at init, rks_git_push after git_commit.ok", () => {
    const { token } = createSession({ projectId: "proj-1", flowType: "ship" });
    try {
      expect(checkAllowedTool(token, "rks_git_commit")).toBeNull();
      advanceStateOnResult(token, "git_commit.ok");
      expect(checkAllowedTool(token, "rks_git_push")).toBeNull();
    } finally {
      endSession(token);
    }
  });
});

// Handler-level cases: the same createServer + InMemoryTransport harness as
// tests/integration/exec-commit-story-trailer.test.mjs (callGitCommitTool).
describe("rks_git_commit handler (AC3 handler, AC5 handler, AC8)", { timeout: 30_000 }, () => {
  let dir;
  beforeEach(() => {
    dir = makeTempDir("git-commit-verbatim-handler");
    initRepo(dir);
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".rks", "project.json"), JSON.stringify({ id: "test-project", kgFile: ".rks/kg.yaml" }));
    fs.writeFileSync(path.join(dir, ".rks", "kg.yaml"), "{}\n");
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  async function withClient(fn) {
    const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
    const prevId = process.env.ROUTEKIT_PROJECT_ID;
    process.env.ROUTEKIT_PROJECT_ROOT = dir;
    process.env.ROUTEKIT_PROJECT_ID = "test-project";
    const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
      if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
      if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
    }
  }

  async function commitTool(client, args) {
    const r = await client.callTool({ name: "rks_git_commit", arguments: { projectId: "test-project", ...args } });
    const text = r.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
  }

  it("AC3 rawMessage + files with no message and no type commits verbatim", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const res = await withClient((c) => commitTool(c, { rawMessage: MSG, files: ["a.txt"] }));
    expect(res.ok).toBe(true);
    expect(git(dir, ["log", "-1", "--format=%B"]).replace(/\n$/, "")).toBe(MSG);
  });

  for (const [label, args] of [
    ["rawMessage with an explicit type", { rawMessage: MSG, files: ["a.txt"], type: "fix" }],
    ["rawMessage with files omitted (handler sends stageAll true)", { rawMessage: MSG }],
    ["a structured call with no message", { files: ["a.txt"] }],
  ]) {
    it(`AC3 handler refuses ${label} and creates no commit`, async () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
      const before = headSha(dir);
      const res = await withClient((c) => commitTool(c, args));
      expect(res.ok).toBe(false);
      expect(headSha(dir)).toBe(before);
    });
  }

  it("AC5 a ship-flow token with no problemId commits verbatim, then rks_git_push is admitted", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "a v2\n");
    const { token } = createSession({ projectId: "test-project", flowType: "ship" });
    try {
      const res = await withClient((c) => commitTool(c, { rawMessage: MSG, files: ["a.txt"], _governorToken: token }));
      expect(res.ok).toBe(true);
      expect(checkAllowedTool(token, "rks_git_push")).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it("AC8 listTools advertises rawMessage, required [projectId], and describes the verbatim mode", async () => {
    const tool = await withClient(async (c) => (await c.listTools()).tools.find((t) => t.name === "rks_git_commit"));
    expect(tool.description).not.toContain("Auto-appends");
    expect(tool.description).toMatch(/rawMessage/);
    expect(tool.description).toMatch(/verbatim|byte-for-byte/i);
    expect(tool.description).toMatch(/\bfiles\b/);
    expect(tool.description).toMatch(/rename/i);
    expect(tool.inputSchema.properties).toHaveProperty("rawMessage");
    expect(tool.inputSchema.required).toEqual(["projectId"]);
  });
});
