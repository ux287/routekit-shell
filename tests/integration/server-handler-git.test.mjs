/**
 * S6 git family: real-git, real-session evidence for the handlers moved into
 * packages/mcp-rks/src/server/handlers/git.mjs (backlog.feat.server-mjs-git-handler-family,
 * GI-TR1..GI-TR4). Moved write bodies run through createServer() over InMemoryTransport ONLY
 * against an os.tmpdir() git fixture that has no remote (asserted) and does not lie under the
 * repository, and the real repository is snapshotted before and after (S0 pattern) so a body
 * that escaped the fixture fails here. Every spawn carries an explicit timeout.
 * Argument projection and spy-level token pass-through: tests/unit/server-handler-git.test.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

import { createSession, endSession, getSession, flushPendingStashPops } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { isTerminal, transitionOnResult } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const GIT_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_ID = "s6-git-handler-fixture";
const BRANCH = "feature/s6-git-handler";
const TRACKED = "a.txt";
const DIRTY = "a (s6 uncommitted work)\n";

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const repoSnapshot = () => ({
  head: git(REPO_ROOT, ["rev-parse", "HEAD"]).trim(),
  branch: git(REPO_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  porcelain: git(REPO_ROOT, ["status", "--porcelain"]),
  stashes: git(REPO_ROOT, ["stash", "list"]),
});
const isUnder = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const readTracked = () => fs.readFileSync(path.join(fix, TRACKED), "utf8");

let fix;
let before;
const saved = {};

beforeAll(() => {
  before = repoSnapshot();
  fix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s6-git-int-")));
  fs.mkdirSync(path.join(fix, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(fix, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: fix, kgFile: ".rks/kg.yaml" }));
  fs.writeFileSync(path.join(fix, ".rks", "kg.yaml"), "{}\n");
  git(fix, ["init", "-b", BRANCH]);
  git(fix, ["config", "user.email", "s6@example.com"]);
  git(fix, ["config", "user.name", "S6"]);
  fs.writeFileSync(path.join(fix, TRACKED), "a v1\n");
  git(fix, ["add", TRACKED]);
  git(fix, ["commit", "-m", "init"]);
  saved.root = process.env.ROUTEKIT_PROJECT_ROOT;
  saved.id = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = fix;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
});

afterAll(() => {
  if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
  if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = saved.id;
  if (fix) fs.rmSync(fix, { recursive: true, force: true });
});

async function callTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "s6-git", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, raw: text };
    }
  } finally {
    await client.close().catch(() => {});
  }
}

describe("S6 moved git handlers against a remote-less temp fixture", { timeout: 30_000 }, () => {
  it("GI-TR1 the fixture has no remote and does not lie under the repository", () => {
    expect(git(fix, ["remote"]).trim()).toBe("");
    expect(isUnder(fix, REPO_ROOT)).toBe(false);
  });

  it("GI-TR2 ship token: rks_git_commit commits in the fixture (committed); rks_git_push with no remote is ok:false (failed)", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ship" });
    try {
      const headBefore = git(fix, ["rev-parse", "HEAD"]).trim();
      fs.writeFileSync(path.join(fix, TRACKED), "a v2 (s6 commit)\n");
      const commit = await callTool("rks_git_commit", { projectId: PROJECT_ID, message: "s6 moved-body commit", files: [TRACKED], _governorToken: token });
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      expect(git(fix, ["rev-parse", "HEAD"]).trim()).not.toBe(headBefore);
      expect(git(fix, ["log", "-1", "--format=%s"])).toContain("s6 moved-body commit");
      expect(getSession(token)?.state).toBe("committed");

      const push = await callTool("rks_git_push", { projectId: PROJECT_ID, _governorToken: token });
      expect(push.ok, JSON.stringify(push)).toBe(false);
      expect(push.remote).toBe("origin");
      expect(push.branch).toBe(BRANCH);
      // git_push.error moves committed -> failed; failed is terminal for the ship flow, so
      // advanceStateOnResult ends the session (governor-token.mjs isTerminal -> endSession).
      expect(transitionOnResult("ship", "committed", "git_push.error")).toBe("failed");
      expect(isTerminal("ship", "failed")).toBe(true);
      expect(getSession(token)).toBeNull();
      expect(git(fix, ["remote"]).trim()).toBe("");
    } finally {
      endSession(token);
    }
  });

  it("GI-TR3 ops token: rks_stash save arms pendingStash and stashes; pop restores and clears; endSession then pops nothing", async () => {
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ops", problemId: "s6-stash" });
    const committed = readTracked();
    try {
      fs.writeFileSync(path.join(fix, TRACKED), DIRTY);
      const save = await callTool("rks_stash", { projectId: PROJECT_ID, action: "save", message: "s6", _governorToken: token });
      expect(save.ok, JSON.stringify(save)).toBe(true);
      expect(getSession(token)?.pendingStash).toBe(true);
      expect(readTracked()).toBe(committed);
      expect(git(fix, ["stash", "list"]).trim()).not.toBe("");

      const pop = await callTool("rks_stash", { projectId: PROJECT_ID, action: "pop", _governorToken: token });
      expect(pop.ok, JSON.stringify(pop)).toBe(true);
      expect(getSession(token)?.pendingStash).toBeFalsy();
      expect(readTracked()).toBe(DIRTY);
      expect(git(fix, ["stash", "list"]).trim()).toBe("");
    } finally {
      endSession(token);
      await flushPendingStashPops();
    }
    // The arm was cleared by pop: endSession had nothing to pop, so the work is exactly as left.
    expect(git(fix, ["stash", "list"]).trim()).toBe("");
    expect(readTracked()).toBe(DIRTY);
  });

  it("GI-TR4 the real repository's HEAD, branch, status and stash list are unchanged by this file", () => {
    expect(repoSnapshot()).toEqual(before);
  });
});
