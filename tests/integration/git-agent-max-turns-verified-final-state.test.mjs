/**
 * backlog.fix.git-agent-max-turns-verified-final-state
 *
 * On a max-turns exit the git agent reports state OBSERVED from the repository after the loop,
 * not the model's partial. Pattern follows tests/integration/git-agent-rerun-guards.test.mjs:
 * a throwaway git repo outside REPO_ROOT, createGitAgent, and runAgent with a scripted _testClient.
 * Every subprocess spawn here uses spawnSync with an explicit timeout (the child_process mock
 * below also stamps a timeout on every spawnSync the code under test makes).
 *
 * Run: npx vitest run --config vitest.config.mock.mjs tests/integration/git-agent-max-turns-verified-final-state.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPAWN_TIMEOUT_MS = 15_000;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (cmd, args = [], opts = {}) => actual.spawnSync(cmd, args, { timeout: SPAWN_TIMEOUT_MS, ...opts }),
  };
});

// Embedding is not under test; runGitCommit's real git commit still runs.
vi.mock("@routekit/rag/tools", () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
}));

const { spawnSync: realSpawn } = await vi.importActual("child_process");
const { createGitAgent, deriveMaxTurnsResult, observeGitFinalState } = await import("../../packages/mcp-rks/src/agents/git.mjs");
const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { loadAgentConfig, clearConfigCache } = await import("../../packages/mcp-rks/src/agents/config.mjs");
const { ADVISORY_CALL_BUDGET } = await import("../../packages/mcp-rks/src/agents/git-evidence.mjs");

const git = (cwd, ...args) => {
  const r = realSpawn("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
};
const head = (cwd) => git(cwd, "rev-parse", "HEAD");
const porcelain = (cwd) => git(cwd, "status", "--porcelain", "-uall");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-git-maxturns-"));
  expect(fs.realpathSync(dir).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  for (const n of ["c1", "c2"]) {
    fs.writeFileSync(path.join(dir, "a.txt"), n + "\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", n);
  }
  // runGitCommit refuses main/master.
  git(dir, "checkout", "-q", "-b", "feature/max-turns");
  // A dirty tracked file for the commit cases.
  fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  return dir;
}

const agent = (root) => createGitAgent({ projectId: "t", request: "commit a.txt", projectRoot: root });

// Scripted Anthropic client for the _testClient seam.
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
let seq = 0;
const toolUse = (name, input = {}, text) => ({
  content: [
    ...(text ? [{ type: "text", text }] : []),
    { type: "tool_use", id: `tu${++seq}`, name, input },
  ],
  stop_reason: "tool_use",
  usage,
});
function scriptedClient(log, script) {
  let n = 0;
  return { messages: { create: async (args) => {
    n += 1;
    log.push({ n, model: args.model, messageCount: args.messages.length });
    return script(n, args);
  } } };
}
const COMMIT_INPUT = { message: "max turns commit", type: "chore", files: ["a.txt"] };
// Capture the raw git_commit result. The instrumented tool records the SAME object it returns as
// the ledger record's rawResult (instrumentToolsWithLedger in git-evidence.mjs), so wrapping the
// instrumented execute observes exactly the value the max-turns hook reads from the ledger.
function captureCommits(cfg) {
  const commits = [];
  const tools = cfg.tools.map((t) => (t.name !== "git_commit" ? t : {
    ...t,
    execute: async (input) => {
      const out = await t.execute(input);
      commits.push(out);
      return out;
    },
  }));
  return { tools, commits };
}

let root;
beforeEach(() => { clearConfigCache(); root = makeRepo(); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); clearConfigCache(); });

describe("git agent budget", () => {
  it("DEFAULTS resolve git maxTurns > 7", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rks-git-defaults-"));
    try {
      clearConfigCache();
      const cfg = loadAgentConfig("git", empty);
      expect(typeof cfg.maxTurns).toBe("number");
      expect(cfg.maxTurns).toBeGreaterThan(7);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("this repo's .rks/agents.yaml git block no longer pins 7", () => {
    clearConfigCache();
    expect(loadAgentConfig("git", REPO_ROOT).maxTurns).toBeGreaterThan(7);
  });

  it("prompt advisory N (git.mjs and .rks/prompts/agent-git.md) === ADVISORY_CALL_BUDGET < maxTurns", () => {
    const re = /Maximum (\d+) tool calls per request/;
    const builtIn = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/agents/git.mjs"), "utf8").match(re);
    const project = fs.readFileSync(path.join(REPO_ROOT, ".rks/prompts/agent-git.md"), "utf8").match(re);
    expect(builtIn).not.toBeNull();
    expect(project).not.toBeNull();
    expect(Number(builtIn[1])).toBe(ADVISORY_CALL_BUDGET);
    expect(Number(project[1])).toBe(ADVISORY_CALL_BUDGET);
    clearConfigCache();
    expect(ADVISORY_CALL_BUDGET).toBeLessThan(loadAgentConfig("git", REPO_ROOT).maxTurns);
    clearConfigCache();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rks-git-defaults-"));
    try {
      expect(ADVISORY_CALL_BUDGET).toBeLessThan(loadAgentConfig("git", empty).maxTurns);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("git agent max-turns exit reports verified final state", () => {
  it("commit ok, then truncated while HEAD == fullCommitId → ok:true, no fallback call, one commit", async () => {
    const cfg = agent(root);
    expect(cfg.fallbackModel).toBeTruthy();
    expect(cfg.fallbackModel).not.toBe(cfg.model);
    const before = Number(git(root, "rev-list", "--count", "HEAD"));
    const log = [];
    // Turn 1 commits; every later turn calls git_state; the model never ends its turn.
    const script = (n) => (n === 1 ? toolUse("git_commit", COMMIT_INPUT) : toolUse("git_state"));
    const { tools, commits } = captureCommits(cfg);
    const r = await runAgent({ ...cfg, tools, _testClient: scriptedClient(log, script) });

    expect(commits).toHaveLength(1);
    const raw = commits[0];
    expect(raw?.ok).toBe(true);
    const actualHead = head(root);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.verifiedFinalState.observed).toBe(true);
    expect(r.verifiedFinalState.head).toBe(raw.fullCommitId);
    expect(r.verifiedFinalState.head).toBe(actualHead);

    // Comparand is fullCommitId: 40 chars; the 7-char commitId is a strict prefix but not the comparand.
    expect(r.verifiedFinalState.head).toHaveLength(40);
    expect(raw.commitId).toHaveLength(7);
    expect(r.verifiedFinalState.head.startsWith(raw.commitId)).toBe(true);
    expect(r.verifiedFinalState.head).not.toBe(raw.commitId);
    expect(r.verifiedFinalState.expectedHead).toBe(raw.fullCommitId);
    expect(r.verifiedFinalState.expectedHead).not.toBe(raw.commitId);

    // Subject, branch and status read from git itself.
    expect(r.verifiedFinalState.subject).toBe(git(root, "log", "-1", "--format=%s"));
    expect(r.verifiedFinalState.branch).toBe(git(root, "rev-parse", "--abbrev-ref", "HEAD"));
    expect(porcelain(root)).toBe("");
    expect(r.verifiedFinalState.clean).toBe(true);
    expect(r.verifiedFinalState.status).toEqual([]);

    // No escalation, no second commit.
    expect(log.filter((c) => c.model === cfg.fallbackModel)).toHaveLength(0);
    expect(log.length).toBe(cfg.maxTurns);
    expect(r._escalated).toBeUndefined();
    expect(Number(git(root, "rev-list", "--count", "HEAD"))).toBe(before + 1);
  });

  it("the ok derivation reads rawResult.fullCommitId, never a sha parsed from the capped resultDigest", async () => {
    const { tools, commits } = captureCommits(agent(root));
    await tools.find((t) => t.name === "git_commit").execute(COMMIT_INPUT);
    const raw = commits[0];
    const observed = observeGitFinalState(root);
    expect(observed.head).toBe(raw.fullCommitId);
    const base = { ok: false, error: "Agent exceeded max turns (3)", truncated: true, _messages: [] };
    const record = (digest, rawResult) => ({ i: 0, tool: "git_commit", input: COMMIT_INPUT, ok: true, resultDigest: digest, rawResult });
    // Digest blank or naming a different sha: the verdict follows rawResult alone.
    const blank = deriveMaxTurnsResult({ result: base, calls: [record("", raw)], observed, maxTurns: 3 });
    expect(blank.ok).toBe(true);
    const lying = deriveMaxTurnsResult({ result: base, calls: [record(JSON.stringify({ fullCommitId: "0".repeat(40) }), raw)], observed, maxTurns: 3 });
    expect(lying.ok).toBe(true);
    expect(lying.verifiedFinalState.expectedHead).toBe(raw.fullCommitId);
    // Digest carrying the real sha but no rawResult: nothing is parsed out of it, so ok is not verified.
    const digestOnly = deriveMaxTurnsResult({ result: base, calls: [record(JSON.stringify(raw), undefined)], observed, maxTurns: 3 });
    expect(digestOnly.ok).toBe(false);
    expect(digestOnly.error.startsWith("Agent exceeded max turns (3)")).toBe(true);
  });

  it("no mutating call → ok:false, truncated, error names max turns, verifiedFinalState observed", async () => {
    const cfg = agent(root);
    const log = [];
    const r = await runAgent({ ...cfg, fallbackModel: undefined, _testClient: scriptedClient(log, () => toolUse("git_state")) });
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error).toMatch(/max turns/i);
    expect(r.error.startsWith("Agent exceeded max turns")).toBe(true);
    expect(Array.isArray(r._messages)).toBe(true);
    expect(r.verifiedFinalState).toBeDefined();
    expect(r.verifiedFinalState.observed).toBe(true);
    expect(r.verifiedFinalState.head).toBe(head(root));
    expect(r.verifiedFinalState.clean).toBe(false);
    expect(r.verifiedFinalState.status).toEqual([{ status: "M", path: "a.txt" }]);
    expect(porcelain(root)).toBe("M a.txt");
    expect(r.verifiedFinalState.mutations).toEqual([]);
  });

  // Strict rule (backlog.fix.git-agent-max-turns-verified-final-state follow-up, user decision
  // 2026-10-31): with no mutating call recorded, a VALID ok:true partial does not decide ok.
  it("no mutating call with a VALID ok:true partial → still ok:false (strict), verifiedFinalState observed", async () => {
    const VALID = '{"ok":true,"summary":"read the state"}';
    // Precondition: the stubbed partial parses as ok:true, so partial-derived ok would be true.
    expect(JSON.parse(VALID).ok).toBe(true);
    expect(agent(root).outputSchema.safeParse(JSON.parse(VALID))).toMatchObject({ success: true, data: { ok: true } });
    const cfg = agent(root);
    const log = [];
    const r = await runAgent({ ...cfg, fallbackModel: undefined, _testClient: scriptedClient(log, () => toolUse("git_state", {}, VALID)) });
    expect(log.length).toBe(cfg.maxTurns);
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error.startsWith("Agent exceeded max turns (")).toBe(true);
    expect(r.error.startsWith(`Agent exceeded max turns (${cfg.maxTurns})`)).toBe(true);
    expect(Array.isArray(r._messages)).toBe(true);
    expect(r.verifiedFinalState.observed).toBe(true);
    expect(r.verifiedFinalState.head).toBe(head(root));
    expect(r.verifiedFinalState.mutations).toEqual([]);
  });

  it("deriveMaxTurnsResult: no mutating record + partial-derived ok:true → ok:false with the max-turns prefix", () => {
    const observed = observeGitFinalState(root);
    const base = { ok: true, summary: "the model says done", truncated: true, _messages: [] };
    const readOnly = { i: 0, tool: "git_state", input: {}, ok: true, resultDigest: "{}", rawResult: {} };
    for (const calls of [[], [readOnly]]) {
      const r = deriveMaxTurnsResult({ result: base, calls, observed, maxTurns: 5 });
      expect(r.ok).toBe(false);
      expect(r.error.startsWith("Agent exceeded max turns (5)")).toBe(true);
      expect(r.verifiedFinalState).toBeDefined();
      expect(r.verifiedFinalState.observed).toBe(true);
      expect(r.verifiedFinalState.head).toBe(head(root));
      expect(r.verifiedFinalState.mutations).toEqual([]);
    }
  });

  it("commit ok but HEAD moved before the loop exits → ok:false, mismatch named with both shas", async () => {
    const cfg = agent(root);
    const script = (n) => (n === 1
      ? toolUse("git_commit", COMMIT_INPUT)
      : n === 2 ? toolUse("git_reset", { mode: "soft", target: "HEAD~1" }) : toolUse("git_state"));
    const { tools, commits } = captureCommits(cfg);
    const r = await runAgent({ ...cfg, tools, fallbackModel: undefined, _testClient: scriptedClient([], script) });
    const raw = commits[0];
    expect(raw?.ok).toBe(true);
    const S = raw.fullCommitId;
    const actualHead = head(root);
    expect(actualHead).not.toBe(S);
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.verifiedFinalState.head).toBe(actualHead);
    expect(r.verifiedFinalState.head).not.toBe(S);
    expect(r.verifiedFinalState.headMatchesCommit).toBe(false);
    expect(r.error.startsWith("Agent exceeded max turns")).toBe(true);
    expect(r.error).toMatch(/mismatch/i);
    expect(r.error).toContain(S);
    expect(r.error).toContain(actualHead);
  });

  it("a ledger-recorded failed mutating call → ok:false even though HEAD is unchanged", async () => {
    const cfg = agent(root);
    const startHead = head(root);
    const script = (n) => (n === 1 ? toolUse("git_checkout", { branch: "no-such-branch-xyz" }) : toolUse("git_state"));
    const r = await runAgent({ ...cfg, fallbackModel: undefined, _testClient: scriptedClient([], script) });
    expect(head(root)).toBe(startHead);
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error.startsWith("Agent exceeded max turns")).toBe(true);
    expect(r.verifiedFinalState.head).toBe(startHead);
    expect(r.verifiedFinalState.mutations).toEqual([expect.objectContaining({ tool: "git_checkout", ok: false })]);
  });

  it("verifiedFinalState ignores a fabricated head and status in model output", async () => {
    const cfg = agent(root);
    const FAKE = "f".repeat(40);
    const fabricated = JSON.stringify({ ok: true, summary: `HEAD is ${FAKE}, working tree clean`, data: { head: FAKE, status: "clean" } });
    const script = (n) => (n === 1 ? toolUse("git_commit", COMMIT_INPUT) : toolUse("git_state", {}, fabricated));
    const r = await runAgent({ ...cfg, fallbackModel: undefined, _testClient: scriptedClient([], script) });
    const actualHead = head(root);
    expect(r.truncated).toBe(true);
    expect(r.verifiedFinalState.head).toBe(actualHead);
    expect(r.verifiedFinalState.head).not.toBe(FAKE);
    expect(JSON.stringify(r.verifiedFinalState)).not.toContain(FAKE);
  });

  it("non-git projectRoot → no throw, ok:false, truncated, state reported not observed", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "rks-git-plain-"));
    try {
      expect(fs.realpathSync(plain).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
      const cfg = agent(plain);
      const r = await runAgent({ ...cfg, fallbackModel: undefined, _testClient: scriptedClient([], () => toolUse("git_state")) });
      expect(r.ok).toBe(false);
      expect(r.truncated).toBe(true);
      expect(r.error).toMatch(/max turns/i);
      expect(r.verifiedFinalState.observed).toBe(false);
      expect(r.verifiedFinalState).not.toHaveProperty("head");
      expect(r.verifiedFinalState).not.toHaveProperty("status");
      expect(typeof r.verifiedFinalState.reason).toBe("string");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("non-git agent max-turns result is unchanged", () => {
  const nonGit = (client) => ({
    name: "test-non-git",
    prompt: "You are a test agent.",
    userMessage: "q",
    tools: [{ name: "t", description: "t", inputSchema: z.object({}), execute: async () => ({ r: 1 }) }],
    inputSchema: z.object({ q: z.string() }),
    outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
    rawInput: { q: "hello" },
    model: "claude-haiku-4-5-20251001",
    maxTurns: 1,
    projectId: "t",
    _testClient: client,
  });

  it("empty partial → ok:false, truncated:true, error 'Agent exceeded max turns (1)', no verifiedFinalState", async () => {
    const r = await runAgent(nonGit(scriptedClient([], () => toolUse("t"))));
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.error).toBe("Agent exceeded max turns (1)");
    expect(r).not.toHaveProperty("verifiedFinalState");
  });

  it("usable partial → ok:true, truncated:true, no verifiedFinalState", async () => {
    const r = await runAgent(nonGit(scriptedClient([], () => toolUse("t", {}, '{"ok":true,"summary":"partial"}'))));
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r).not.toHaveProperty("verifiedFinalState");
  });
});
