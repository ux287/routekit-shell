/**
 * backlog.fix.git-commit-autoroute-rewrites-commit-message — end-to-end.
 *
 *   1. An UNTOKENED rks_git_commit is refused (unauthorizedResponse) rather than diverted to the
 *      LLM git agent, whose prose request dropped type/scope/rawMessage and folded the file list
 *      into the message text. Both structured and verbatim (rawMessage) modes are covered.
 *   2. A TOKENED rks_git_commit commits a subject of exactly `fix(x): m`, and the file list never
 *      enters the message.
 *
 * Asserted on the repository (HEAD, index, git log), not on a spy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROJECT_ID = "routekit-shell-core";
const SPAWN_MS = 3000;
const prevRoot = process.env.ROUTEKIT_PROJECT_ROOT;
const prevId = process.env.ROUTEKIT_PROJECT_ID;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-commit-autoroute-"));
process.env.ROUTEKIT_PROJECT_ROOT = repo;
process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;

const { createServer, TOOL_TO_AGENT_MAP } = await import("../../packages/mcp-rks/src/server.mjs");
const { createSession, endSession, setToken } =
  await import("../../packages/mcp-rks/src/shared/governor-token.mjs");

const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: SPAWN_MS });
const head = () => git("rev-parse", "HEAD").stdout.trim();
const staged = () => git("diff", "--cached", "--name-only").stdout.trim();

async function callTool(name, args) {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSkip = process.env.RKS_SKIP_PREFLIGHT;
  process.env.NODE_ENV = "production";
  delete process.env.RKS_SKIP_PREFLIGHT;
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSkip === undefined) delete process.env.RKS_SKIP_PREFLIGHT; else process.env.RKS_SKIP_PREFLIGHT = prevSkip;
    await client.close().catch(() => {});
  }
}

const textOf = (r) => r?.content?.[0]?.text ?? "";

beforeAll(() => {
  fs.mkdirSync(path.join(repo, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "routekit"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".rks", "project.json"),
    JSON.stringify({ id: PROJECT_ID, root: repo, kgFile: "routekit/kg.yaml" }, null, 2));
  fs.writeFileSync(path.join(repo, "routekit", "kg.yaml"), "project: fixture\n");
  // Non-protected branch: runGitCommit refuses main/master/production/staging
  // (assertNotOnProtectedBranch, server/branch-protection.mjs getProtectedBranches).
  spawnSync("git", ["init", "-b", "feature/test", repo], { timeout: SPAWN_MS });
  git("config", "user.email", "t@t.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "initial\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "initial\n");
  git("add", ".");
  git("commit", "-m", "initial");
  expect(git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("feature/test");
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT; else process.env.ROUTEKIT_PROJECT_ROOT = prevRoot;
  if (prevId === undefined) delete process.env.ROUTEKIT_PROJECT_ID; else process.env.ROUTEKIT_PROJECT_ID = prevId;
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("auto-route map", () => {
  it("rks_git_commit has no TOOL_TO_AGENT_MAP entry", () => {
    expect(TOOL_TO_AGENT_MAP.rks_git_commit).toBeUndefined();
  });
});

describe("an untokened rks_git_commit is refused, never diverted to the agent", () => {
  it.each([
    ["structured", { type: "fix", scope: "x", message: "m", files: ["a.txt"] }],
    ["verbatim", { rawMessage: "fix(x): m\n\nbody", files: ["a.txt"] }],
  ])("%s mode: unauthorized refusal, HEAD and index unchanged", async (label, args) => {
    fs.writeFileSync(path.join(repo, "a.txt"), `untokened ${label}\n`);
    const before = head();
    const body = textOf(await callTool("rks_git_commit", { projectId: PROJECT_ID, ...args }));
    expect(body).toMatch(/"ok":\s*false/);
    expect(body).toMatch(/unauthorized/i);
    expect(body).toContain("rks_git_commit");
    expect(body).toContain("rks_governor_init");
    // _autoRouted is the marker the auto-route path stamps on a substituted response.
    expect(body, "an untokened commit was handed to the LLM git agent").not.toContain("_autoRouted");
    expect(head()).toBe(before);
    expect(staged()).toBe("");
  });
});

describe("a tokened rks_git_commit commits the message exactly as supplied", () => {
  it("subject is exactly fix(x): m and the file list never enters the message", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "tokened\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "tokened\n");
    const before = head();
    const { token } = createSession({ projectId: PROJECT_ID, flowType: "ship" });
    setToken(token);
    let body;
    try {
      body = textOf(await callTool("rks_git_commit", {
        projectId: PROJECT_ID, type: "fix", scope: "x", message: "m", files: ["a.txt", "b.txt"], _governorToken: token,
      }));
    } finally {
      endSession(token);
    }
    expect(body, body).not.toMatch(/unauthorized/i);
    expect(body).not.toContain("_autoRouted");
    expect(head(), `no commit was made: ${body}`).not.toBe(before);
    expect(git("log", "-1", "--format=%s").stdout.trim()).toBe("fix(x): m");
    const full = git("log", "-1", "--format=%B").stdout;
    expect(full).not.toContain(" files: ");
    expect(full).not.toContain("a.txt");
    expect(full).not.toContain("b.txt");
  });
});
