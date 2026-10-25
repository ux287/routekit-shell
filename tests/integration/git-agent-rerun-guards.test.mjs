/**
 * backlog.feat.git-agent-haiku-first-fallback - rerun guards for git's side-effecting tools and
 * per-attempt evidence on git's real fallback config.
 *
 * Mock tier: real git in os.tmpdir() repos on a feature branch (runGitCommit refuses main/master),
 * gh faked through a child_process mock, embedding short-circuited at runRagEmbed. Every real
 * spawn carries a timeout. No network, no LLM (runAgent is driven through the _testClient seam).
 * Runner-level cases read the expected models from the createGitAgent config, never from literals.
 *
 * Run: npx vitest run --config vitest.config.mock.mjs tests/integration/git-agent-rerun-guards.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Used only for the attemptState ctx `model` field, which the guards ignore.
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const SPAWN_TIMEOUT_MS = 15_000;

const ghCalls = [];
let pr = {};
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => {
      if (cmd === "gh") {
        ghCalls.push(args);
        if (args[0] === "pr" && args[1] === "view" && pr.viewFails) return { status: 1, stdout: "", stderr: "gh: auth required" };
        if (args[0] === "pr" && args[1] === "merge") { pr = { ...pr, state: "MERGED" }; return { status: 0, stdout: "", stderr: "" }; }
        return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
      }
      return actual.spawnSync(cmd, args, { timeout: SPAWN_TIMEOUT_MS, ...opts });
    },
  };
});

// Embedding is not under test; runGitCommit's real git commit still runs.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const { createGitAgent } = await import("../../packages/mcp-rks/src/agents/git.mjs");
const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { clearConfigCache } = await import("../../packages/mcp-rks/src/agents/config.mjs");

const git = (cwd, ...args) => {
  const r = realSpawn("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
};
const mergeCalls = () => ghCalls.filter((a) => a[0] === "pr" && a[1] === "merge");
const tool = (config, name) => {
  const t = config.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};
const head = (cwd) => git(cwd, "rev-parse", "HEAD");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-git-rerun-"));
  expect(fs.realpathSync(dir).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  for (const n of ["c1", "c2", "c3"]) {
    fs.writeFileSync(path.join(dir, "a.txt"), n + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", n);
  }
  git(dir, "checkout", "-q", "-b", "feature/rerun-guard");
  return dir;
}

const agent = (root) => createGitAgent({ projectId: "t", request: "r", projectRoot: root });

// Scripted Anthropic client for the _testClient seam.
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
let seq = 0;
const toolUse = (name, input = {}, text) => ({
  content: [
    ...(text ? [{ type: "text", text }] : []),
    { type: "tool_use", id: `tu${++seq}`, name, input },
  ],
  stop_reason: "tool_use",
  usage,
});
const GIT_VALID = '{"ok":true,"summary":"done"}';
function scriptedClient(log, script) {
  let n = 0;
  return { messages: { create: async (args) => {
    n += 1;
    log.push({ n, model: args.model, messageCount: args.messages.length });
    return script(n, args);
  } } };
}
// Tool turns already made in the current attempt: a fresh attempt starts with one user message and
// every tool turn appends an assistant message and a tool_result message.
const turnsSoFar = (args) => Math.floor((args.messages.length - 1) / 2);

let root;
beforeEach(() => { ghCalls.length = 0; pr = {}; clearConfigCache(); root = makeRepo(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); clearConfigCache(); });

describe("gh_pr_merge rerun guard", () => {
  it("OPEN PR merges once; an identical second call does not invoke gh pr merge again", async () => {
    pr = { number: 7, state: "OPEN" };
    const a = agent(root);
    const first = await tool(a, "gh_pr_merge").execute({ prNumber: 7 });
    const second = await tool(a, "gh_pr_merge").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(1);
    expect(first.merged).toBe(true);
    expect(second.merged).toBe(true);
    expect(JSON.stringify(second)).toMatch(/already/i);
  });

  it("already-MERGED PR: no gh pr merge, reports already merged", async () => {
    pr = { number: 7, state: "MERGED" };
    const res = await tool(agent(root), "gh_pr_merge").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(0);
    expect(res.merged).toBe(true);
    expect(JSON.stringify(res)).toMatch(/already/i);
  });

  it("unreadable PR state: refuses, invokes no gh pr merge, merged is not true", async () => {
    pr = { number: 7, state: "OPEN", viewFails: true };
    const res = await tool(agent(root), "gh_pr_merge").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(0);
    expect(res.merged).not.toBe(true);
    expect(JSON.stringify(res)).toMatch(/could not read PR state/i);
  });
});

describe("git_commit rerun guard", () => {
  it("identical second commit creates no commit and reports nothing to commit", async () => {
    const a = agent(root);
    const before = head(root);
    const beforeCount = Number(git(root, "rev-list", "--count", "HEAD"));
    fs.writeFileSync(path.join(root, "a.txt"), "c4\n");
    const first = await tool(a, "git_commit").execute({ message: "m", type: "chore", files: ["a.txt"] });
    // A refusal (protected branch, hook integrity) must fail here, not pass the rerun assertions.
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const after = head(root);
    const count = Number(git(root, "rev-list", "--count", "HEAD"));
    expect(after).not.toBe(before);
    expect(count).toBe(beforeCount + 1);
    const second = await tool(a, "git_commit").execute({ message: "m", type: "chore", files: ["a.txt"] });
    expect(head(root)).toBe(after);
    expect(Number(git(root, "rev-list", "--count", "HEAD"))).toBe(count);
    expect(JSON.stringify(second)).toMatch(/nothing to commit|no changes to commit/i);
  });
});

describe("git_reset rerun guard", () => {
  it("relative soft reset repeated on one config moves HEAD back once only", async () => {
    const a = agent(root);
    const c2 = git(root, "rev-parse", "HEAD~1");
    const first = await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(first.ok).toBe(true);
    const second = await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(head(root)).toBe(c2);
    expect(second.ok).toBe(true);
    expect(JSON.stringify(second)).toMatch(/already/i);
  });

  it("repeated hard reset does not destroy work produced after the first call", async () => {
    const a = agent(root);
    const first = await tool(a, "git_reset").execute({ mode: "hard", target: "HEAD", confirm: true });
    expect(first.ok).toBe(true);
    fs.writeFileSync(path.join(root, "a.txt"), "later work\n");
    await tool(a, "git_reset").execute({ mode: "hard", target: "HEAD", confirm: true });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("later work\n");
  });

  it("a different reset request, and the same request on a fresh config, still execute", async () => {
    const a = agent(root);
    const c2 = git(root, "rev-parse", "HEAD~1");
    const c1 = git(root, "rev-parse", "HEAD~2");
    await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(head(root)).toBe(c2);
    // Different key on the same config executes.
    await tool(a, "git_reset").execute({ mode: "mixed", target: "HEAD" });
    expect(head(root)).toBe(c2);
    // Same request on a fresh config executes: guard state is per invocation, not global.
    await tool(agent(root), "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(head(root)).toBe(c1);
  });

  it("a repeat after HEAD moved since the recorded reset runs normally", async () => {
    const a = agent(root);
    const c1 = git(root, "rev-parse", "HEAD~2");
    await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    git(root, "reset", "-q", "--soft", "HEAD~1"); // HEAD moved outside the guarded request
    expect(head(root)).toBe(c1);
    fs.writeFileSync(path.join(root, "a.txt"), "c2b\n");
    git(root, "commit", "-q", "-am", "c2b");
    const c2b = head(root);
    const res = await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(res.alreadyReset).toBeUndefined();
    expect(head(root)).toBe(c1);
    expect(head(root)).not.toBe(c2b);
  });
});

describe("guard state is not reset by a restart attempt", () => {
  it("after a restart beginAttempt, a repeated gh_pr_merge still does not merge twice", async () => {
    pr = { number: 7, state: "OPEN" };
    const a = agent(root);
    a.attemptState.beginAttempt({ index: 0, kind: "primary", model: HAIKU, resumed: false });
    await tool(a, "gh_pr_merge").execute({ prNumber: 7 });
    a.attemptState.beginAttempt({ index: 1, kind: "escalation", model: SONNET, resumed: false });
    await tool(a, "gh_pr_merge").execute({ prNumber: 7 });
    expect(mergeCalls()).toHaveLength(1);
  });

  it("after a restart beginAttempt, a repeated identical git_reset does not move HEAD again", async () => {
    const a = agent(root);
    const c2 = git(root, "rev-parse", "HEAD~1");
    a.attemptState.beginAttempt({ index: 0, kind: "primary", model: HAIKU, resumed: false });
    await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    a.attemptState.beginAttempt({ index: 1, kind: "escalation", model: SONNET, resumed: false });
    const second = await tool(a, "git_reset").execute({ mode: "soft", target: "HEAD~1" });
    expect(head(root)).toBe(c2);
    expect(JSON.stringify(second)).toMatch(/already/i);
  });
});

describe("git agent through the real runAgent on its real fallback config", { timeout: 60_000 }, () => {
  it("config resolves a fallbackModel distinct from its model (precondition)", () => {
    const cfg = agent(root);
    expect(cfg.fallbackModel).toBeDefined();
    expect(cfg.fallbackModel).not.toBe(cfg.model);
  });

  it("restart escalation: abandoned primary-model calls are not presented as evidence", async () => {
    const cfg = agent(root);
    const log = [];
    const script = (n, args) => {
      const t = turnsSoFar(args);
      if (args.model === cfg.model) return t < 2 ? toolUse("git_state") : textResp("NOT JSON");
      return t < 1 ? toolUse("git_state") : textResp(GIT_VALID);
    };
    const r = await runAgent({ ...cfg, _testClient: scriptedClient(log, script) });
    const firstFallback = log.findIndex((c) => c.model === cfg.fallbackModel);
    const lastPrimary = log.map((c) => c.model).lastIndexOf(cfg.model);
    expect(firstFallback).toBeGreaterThan(-1);
    expect(firstFallback).toBeGreaterThan(lastPrimary);
    expect(r.ok).toBe(true);
    expect(r.evidence.callCount).toBe(1);
    expect(r.evidence.calls.map((c) => c.i)).toEqual([0]);
  });

  it("max-turns resume on the fallback model carries the ledger", async () => {
    const cfg = agent(root);
    const log = [];
    // maxTurns 1: the primary model's one turn is a git_state tool_use, so it hits max turns. The
    // fallback-model resume (also one turn) issues one more git_state call alongside its final JSON
    // text; the runner executes the call, then the max-turns partial path parses that text.
    const script = (n, args) => (args.model === cfg.model
      ? toolUse("git_state")
      : toolUse("git_state", {}, GIT_VALID));
    const r = await runAgent({ ...cfg, maxTurns: 1, _testClient: scriptedClient(log, script) });
    const fallbackCalls = log.filter((c) => c.model === cfg.fallbackModel);
    expect(fallbackCalls.length).toBeGreaterThanOrEqual(1);
    expect(fallbackCalls[0].messageCount).toBeGreaterThan(1);
    expect(r.ok).toBe(true);
    const indices = r.evidence.calls.map((c) => c.i);
    expect(indices).toEqual([...Array(r.evidence.callCount).keys()]);
    expect(indices).toContain(0);
    expect(r.evidence.callCount).toBe(2);
  });

  it("gh_pr_merge rerun by an escalation merges exactly once across the invocation", async () => {
    pr = { number: 7, state: "OPEN" };
    const cfg = agent(root);
    const log = [];
    const script = (n, args) => (turnsSoFar(args) < 1
      ? toolUse("gh_pr_merge", { prNumber: 7 })
      : args.model === cfg.model ? textResp("NOT JSON") : textResp(GIT_VALID));
    const r = await runAgent({ ...cfg, _testClient: scriptedClient(log, script) });
    expect(log.some((c) => c.model === cfg.fallbackModel)).toBe(true);
    expect(mergeCalls()).toHaveLength(1);
    expect(r.ok).toBe(true);
  });
});

describe("KNOWN COUPLING comment", () => {
  const SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/agents/git-evidence.mjs"), "utf8");
  it("is kept and no longer says git has no fallbackModel", () => {
    expect(SRC).toContain("KNOWN COUPLING");
    expect(SRC).not.toContain("declares no fallbackModel");
    expect(SRC).not.toContain("zero occurrences in git.mjs");
  });
  it.each(["TOOL_CALL_CAP", "tool_call_cap_reached", "conclusionsUnsupported", "supported"])("%s still absent", (t) => {
    expect(SRC).not.toContain(t);
  });
});
