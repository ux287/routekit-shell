// backlog.fix.ship-flow-deterministic-no-llm (AC2, AC7, AC9): the Ship chain runs end to end on
// deterministic, tokened tools with no LLM call, for both branch topologies.
//
// Every drive goes through createServer() and a real MCP client, so each tokened call passes the
// server's checkAllowedTool (flow allowlist + ship state machine), its entry transition, the real
// handler and the handler's advanceStateOnResult. Nothing posts a result key by hand. Git runs for
// real against os.tmpdir() repos whose only remote is a LOCAL bare origin; `gh` is a stub script
// on a temp PATH entry. No network, no claude binary (the probe is stubbed through gate.mjs).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const spies = vi.hoisted(() => ({
  runAgent: null,
  assertAnthropicCredential: null,
  probeGet: null,
}));

// The probe seam: getDefaultClaudeCliGate returns a real gate built with a probe cache whose get
// resolves ready, so resolveInitCredential spawns no claude binary.
vi.mock("../../packages/mcp-rks/src/llm/claude-cli/gate.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  spies.probeGet = vi.fn(async () => ({ ready: true, authMethod: "claude.ai", version: "0.0.0-test", reason: null }));
  const gate = actual.createClaudeCliGate({
    probeCache: { get: spies.probeGet, probedAt: () => Date.now(), invalidate: () => {} },
  });
  return { ...actual, getDefaultClaudeCliGate: () => gate };
});
// LLM reachability witnesses: pass-through spies on the two entry points an LLM call must cross.
vi.mock("../../packages/mcp-rks/src/llm/credential-preflight.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  spies.assertAnthropicCredential = vi.fn((...a) => actual.assertAnthropicCredential(...a));
  return { ...actual, assertAnthropicCredential: spies.assertAnthropicCredential };
});
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  spies.runAgent = vi.fn((...a) => actual.runAgent(...a));
  return { ...actual, runAgent: spies.runAgent };
});

import { getSession, endSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { loadContext } from "../../packages/mcp-rks/src/server/project.mjs";
import { assertAnthropicCredential } from "../../packages/mcp-rks/src/llm/credential-preflight.mjs";

const GIT_TIMEOUT_MS = 15_000;
const DRIVE_TIMEOUT_MS = 90_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CHANGED = "a.txt";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const branchList = (cwd) => git(cwd, ["branch", "--list"]);
const head = (cwd) => ({ branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), sha: git(cwd, ["rev-parse", "HEAD"]) });
const repoSnapshot = () => ({
  head: git(REPO_ROOT, ["rev-parse", "HEAD"]),
  branch: git(REPO_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]),
  porcelain: git(REPO_ROOT, ["status", "--porcelain"]),
});

const roots = [];
let projectSeq = 0;

// Working repo plus a LOCAL bare origin; identity is repo-local (git config), never env. The
// initial commit carries a .gitignore of .rks/: rks_governor_init writes .rks/state/, and
// runGitMerge / runGitPR refuse a dirty porcelain.
function makeRepo({ branches, baseBranch }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-nollm-")));
  roots.push(root);
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  fs.mkdirSync(work);
  git(root, ["init", "--bare", origin]);
  git(work, ["init", "-b", branches.working]);
  git(work, ["config", "user.name", "rks-test"]);
  git(work, ["config", "user.email", "rks-test@example.invalid"]);
  git(work, ["config", "commit.gpgsign", "false"]);
  git(work, ["remote", "add", "origin", origin]);
  fs.writeFileSync(path.join(work, ".gitignore"), ".rks/\n");
  fs.writeFileSync(path.join(work, CHANGED), "v1\n");
  git(work, ["add", ".gitignore", CHANGED]);
  git(work, ["commit", "-m", "init"]);
  const projectId = `ship-nollm-${process.pid}-${++projectSeq}`;
  fs.mkdirSync(path.join(work, ".rks"), { recursive: true });
  const projectJson = { id: projectId, root: work, kgFile: ".rks/kg.yaml", branches };
  if (baseBranch) projectJson.baseBranch = baseBranch;
  fs.writeFileSync(path.join(work, ".rks", "project.json"), JSON.stringify(projectJson));
  fs.writeFileSync(path.join(work, ".rks", "kg.yaml"), "{}\n");
  vi.stubEnv("ROUTEKIT_PROJECT_ROOT", work);
  vi.stubEnv("ROUTEKIT_PROJECT_ID", projectId);
  return { root, work, origin, projectId };
}

// `gh` replaced by a stub that exits 0 and prints a PR URL (no network).
function stubGh(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, "#!/bin/sh\necho https://github.invalid/rks-test/repo/pull/1\nexit 0\n");
  fs.chmodSync(gh, 0o755);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  return gh;
}

async function connect() {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "ship-nollm", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
  };
  return { call, close: () => client.close().catch(() => {}) };
}

// A ship-flow token from the real rks_governor_init. The session object is captured BY REFERENCE
// before the first chained call, because getSession returns null once the session is terminal.
async function initShip(call, fx) {
  const ctx = await loadContext(fx.projectId);
  // Fail-safe: never let a drive resolve to the real repository.
  expect(ctx.record.root).toBe(fx.work);
  const init = await call("rks_governor_init", { projectId: fx.projectId, flowType: "ship" });
  expect(init.ok, JSON.stringify(init)).toBe(true);
  expect(init.credential).toBe("subscription");
  expect(init.capabilities?.ship).toBe("admitted");
  const token = init.token;
  expect(typeof token).toBe("string");
  const session = getSession(token);
  expect(session?.flowType).toBe("ship");
  expect(session.state).toBe("init");
  return { token, session };
}

// One tokened call; a refusal by checkAllowedTool fails the drive. Returns the payload and the
// observed session state after the call.
async function step(call, session, token, tool, args, observed) {
  const res = await call(tool, { ...args, _governorToken: token });
  // checkAllowedTool's refusals are { ok: false, error: 'chain_violation' | 'unauthorized' }.
  expect(["chain_violation", "unauthorized"], `${tool} refused: ${JSON.stringify(res)}`).not.toContain(res?.error);
  observed.push(session.state);
  return res;
}

let before;
beforeAll(() => {
  before = repoSnapshot();
});
afterAll(() => {
  expect(repoSnapshot(), "the real repository was touched").toEqual(before);
});

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("RKS_SUBSCRIPTION_CREDENTIAL", "1");
  vi.stubEnv("RKS_RESEARCH_BACKEND", "");
  delete process.env.RKS_SKIP_PREFLIGHT;
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

// clearMocks (vitest.config.base.mjs) clears spy history before each test, so every drive checks
// its own calls here and adds them to a file-level tally the final case asserts on.
const tally = { drives: 0, runAgent: 0, assertAnthropicCredential: 0, probeGet: 0 };
const noLlm = () => {
  expect(spies.runAgent, "runAgent mock installed").toBeTypeOf("function");
  tally.drives++;
  tally.runAgent += spies.runAgent.mock.calls.length;
  tally.assertAnthropicCredential += spies.assertAnthropicCredential.mock.calls.length;
  tally.probeGet += spies.probeGet.mock.calls.length;
  expect(spies.runAgent).toHaveBeenCalledTimes(0);
  expect(spies.assertAnthropicCredential).toHaveBeenCalledTimes(0);
};

describe("rks_git_state upstream field (AC2)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("reports upstream origin/<branch> when tracking and null when not; the key set is the old seven plus upstream", async () => {
    const fx = makeRepo({ branches: { working: "develop", integration: "develop", production: "main" }, baseBranch: "develop" });
    git(fx.work, ["push", "-u", "origin", "develop"]);
    fs.writeFileSync(path.join(fx.work, CHANGED), "v2\n");
    git(fx.work, ["commit", "-am", "local ahead"]);
    const { call, close } = await connect();
    try {
      const tracked = await call("rks_git_state", { projectId: fx.projectId });
      expect(Object.keys(tracked).sort()).toEqual(
        ["aheadBy", "behindBy", "currentBranch", "diverged", "isClean", "recommendations", "uncommittedFiles", "upstream"],
      );
      expect(tracked.upstream).toBe("origin/develop");
      const observedAhead = Number(git(fx.work, ["rev-list", "--count", "origin/develop..develop"]));
      expect(observedAhead).toBe(1);
      expect(tracked.aheadBy).toBe(observedAhead);
      expect(tracked.currentBranch).toBe("develop");
      expect(tracked.isClean).toBe(true);
      expect(typeof tracked.behindBy).toBe("number");
      expect(typeof tracked.diverged).toBe("boolean");
      expect(Array.isArray(tracked.uncommittedFiles)).toBe(true);
      expect(Array.isArray(tracked.recommendations)).toBe(true);

      git(fx.work, ["checkout", "-b", "feature/no-upstream"]);
      const untracked = await call("rks_git_state", { projectId: fx.projectId });
      expect(untracked.upstream).toBeNull();
      expect(untracked.aheadBy).toBe(0);
      expect(untracked.currentBranch).toBe("feature/no-upstream");
    } finally {
      await close();
    }
    noLlm();
  });
});

describe("3-branch ship chain, deterministic tools only (AC7)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("rks_git_state -> rks_project_get -> rks_git_commit -> rks_git_merge -> rks_cycle_complete reaches shipped", async () => {
    const fx = makeRepo({ branches: { working: "dev", integration: "staging", production: "main" } });
    const FEATURE = "feature/ship-nollm-3b";
    git(fx.work, ["checkout", "-b", FEATURE]);
    fs.writeFileSync(path.join(fx.work, CHANGED), "feature change\n");
    const { call, close } = await connect();
    const observed = [];
    let token;
    try {
      const s = await initShip(call, fx);
      token = s.token;
      const state = await step(call, s.session, token, "rks_git_state", { projectId: fx.projectId }, observed);
      expect(state.currentBranch).toBe(FEATURE);
      expect(state.upstream).toBeNull();
      const proj = await step(call, s.session, token, "rks_project_get", { id: fx.projectId }, observed);
      expect(proj.branches.working).toBe("dev");
      expect(proj.branches.integration).toBe("staging");
      const commit = await step(call, s.session, token, "rks_git_commit", { projectId: fx.projectId, message: "ship nollm 3-branch", files: [CHANGED] }, observed);
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      const featureCommit = commit.fullCommitId;
      const merge = await step(call, s.session, token, "rks_git_merge", { projectId: fx.projectId, targetBranch: "dev", deleteBranch: true }, observed);
      expect(merge.ok, JSON.stringify(merge)).toBe(true);
      // AC9 feature-branch ordering: cycle complete only after the observed merge.
      expect(s.session.state).toBe("merging");
      const done = await step(call, s.session, token, "rks_cycle_complete", { projectId: fx.projectId }, observed);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(observed).toEqual(["init", "init", "committed", "merging", "shipped"]);
      expect(getSession(token)).toBeNull();
      // Git observations: the feature commit is on dev and the feature branch is gone.
      git(fx.work, ["merge-base", "--is-ancestor", featureCommit, "dev"]);
      expect(git(fx.work, ["branch", "--list", FEATURE])).toBe("");
      expect(head(fx.work).branch).toBe("dev");
    } finally {
      if (token) endSession(token);
      await close();
    }
    noLlm();
  });
});

describe("2-branch ship chain, deterministic tools only (AC7)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("rks_git_state -> rks_project_get -> rks_git_commit -> rks_git_push -> rks_staging_pr -> rks_git_merge -> rks_cycle_complete reaches shipped", async () => {
    const fx = makeRepo({ branches: { working: "develop", integration: "develop", production: "main" }, baseBranch: "develop" });
    stubGh(fx.root);
    const FEATURE = "feature/ship-nollm-2b";
    git(fx.work, ["checkout", "-b", FEATURE]);
    fs.writeFileSync(path.join(fx.work, CHANGED), "feature change 2b\n");
    const { call, close } = await connect();
    const observed = [];
    let token;
    try {
      const s = await initShip(call, fx);
      token = s.token;
      await step(call, s.session, token, "rks_git_state", { projectId: fx.projectId }, observed);
      const proj = await step(call, s.session, token, "rks_project_get", { id: fx.projectId }, observed);
      expect(proj.branches.working).toBe(proj.branches.integration);
      const commit = await step(call, s.session, token, "rks_git_commit", { projectId: fx.projectId, message: "ship nollm 2-branch", files: [CHANGED] }, observed);
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      const push = await step(call, s.session, token, "rks_git_push", { projectId: fx.projectId }, observed);
      expect(push.ok, JSON.stringify(push)).toBe(true);
      expect(push.branch).toBe(FEATURE);
      const pr = await step(call, s.session, token, "rks_staging_pr", { projectId: fx.projectId, title: "ship nollm", reason: "infrastructure" }, observed);
      expect(pr.ok, JSON.stringify(pr)).toBe(true);
      expect(pr.url).toBe("https://github.invalid/rks-test/repo/pull/1");
      // Only the feature branch is on origin, so runCycleComplete takes the local-only path.
      expect(git(fx.work, ["ls-remote", "--heads", "origin", "develop"])).toBe("");
      const merge = await step(call, s.session, token, "rks_git_merge", { projectId: fx.projectId }, observed);
      expect(merge.ok, JSON.stringify(merge)).toBe(true);
      expect(merge.targetBranch).toBe("develop");
      expect(s.session.state).toBe("merging");
      const done = await step(call, s.session, token, "rks_cycle_complete", { projectId: fx.projectId }, observed);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(observed).toEqual(["init", "init", "committed", "committed", "pr_created", "merging", "shipped"]);
      git(fx.work, ["merge-base", "--is-ancestor", commit.fullCommitId, "develop"]);
    } finally {
      if (token) endSession(token);
      await close();
    }
    noLlm();
  });
});

describe("3-branch working-branch ship from dev completes (AC9)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("rks_git_state -> rks_project_get -> rks_git_commit -> rks_cycle_complete from committed, no call refused, no branch deleted", async () => {
    const fx = makeRepo({ branches: { working: "dev", integration: "staging", production: "main" } });
    fs.writeFileSync(path.join(fx.work, CHANGED), "dev change\n");
    const branchesBefore = branchList(fx.work);
    const { call, close } = await connect();
    const observed = [];
    let token;
    try {
      const s = await initShip(call, fx);
      token = s.token;
      const state = await step(call, s.session, token, "rks_git_state", { projectId: fx.projectId }, observed);
      expect(state.currentBranch).toBe("dev");
      await step(call, s.session, token, "rks_project_get", { id: fx.projectId }, observed);
      const commit = await step(call, s.session, token, "rks_git_commit", { projectId: fx.projectId, message: "ship nollm dev", files: [CHANGED] }, observed);
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      const done = await step(call, s.session, token, "rks_cycle_complete", { projectId: fx.projectId }, observed);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(observed).toEqual(["init", "init", "committed", "shipped"]);
      expect(head(fx.work)).toEqual({ branch: "dev", sha: commit.fullCommitId });
      expect(branchList(fx.work)).toBe(branchesBefore);
    } finally {
      if (token) endSession(token);
      await close();
    }
    noLlm();
  });
});

describe("2-branch working-branch ship from develop completes (AC9)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("rks_git_state -> rks_project_get -> rks_git_commit -> rks_git_push -> rks_cycle_complete from committed, no call refused, no branch deleted", async () => {
    const fx = makeRepo({ branches: { working: "develop", integration: "develop", production: "main" }, baseBranch: "develop" });
    fs.writeFileSync(path.join(fx.work, CHANGED), "develop change\n");
    const branchesBefore = branchList(fx.work);
    const { call, close } = await connect();
    const observed = [];
    let token;
    try {
      const s = await initShip(call, fx);
      token = s.token;
      await step(call, s.session, token, "rks_git_state", { projectId: fx.projectId }, observed);
      await step(call, s.session, token, "rks_project_get", { id: fx.projectId }, observed);
      const commit = await step(call, s.session, token, "rks_git_commit", { projectId: fx.projectId, message: "ship nollm develop", files: [CHANGED] }, observed);
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      const push = await step(call, s.session, token, "rks_git_push", { projectId: fx.projectId }, observed);
      expect(push.ok, JSON.stringify(push)).toBe(true);
      expect(git(fx.work, ["rev-parse", "origin/develop"])).toBe(commit.fullCommitId);
      const done = await step(call, s.session, token, "rks_cycle_complete", { projectId: fx.projectId }, observed);
      expect(done.ok, JSON.stringify(done)).toBe(true);
      expect(observed).toEqual(["init", "init", "committed", "committed", "shipped"]);
      expect(head(fx.work)).toEqual({ branch: "develop", sha: commit.fullCommitId });
      expect(branchList(fx.work)).toBe(branchesBefore);
    } finally {
      if (token) endSession(token);
      await close();
    }
    noLlm();
  });
});

describe("unmerged feature branch cannot be cycle-completed from committed (AC9)", { timeout: DRIVE_TIMEOUT_MS }, () => {
  it("rks_cycle_complete after git_commit.ok without git_merge.ok refuses not_on_working_branch, goes failed, and the feature branch survives", async () => {
    const fx = makeRepo({ branches: { working: "dev", integration: "staging", production: "main" } });
    const FEATURE = "feature/ship-nollm-unmerged";
    git(fx.work, ["checkout", "-b", FEATURE]);
    fs.writeFileSync(path.join(fx.work, CHANGED), "unmerged change\n");
    const { call, close } = await connect();
    const observed = [];
    let token;
    try {
      const s = await initShip(call, fx);
      token = s.token;
      await step(call, s.session, token, "rks_git_state", { projectId: fx.projectId }, observed);
      await step(call, s.session, token, "rks_project_get", { id: fx.projectId }, observed);
      const commit = await step(call, s.session, token, "rks_git_commit", { projectId: fx.projectId, message: "unmerged", files: [CHANGED] }, observed);
      expect(commit.ok, JSON.stringify(commit)).toBe(true);
      expect(s.session.state).toBe("committed");
      const headBefore = head(fx.work);
      const refused = await step(call, s.session, token, "rks_cycle_complete", { projectId: fx.projectId }, observed);
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe("not_on_working_branch");
      expect(refused.currentBranch).toBe(FEATURE);
      expect(refused.working).toBe("dev");
      expect(typeof refused.error).toBe("string");
      expect(observed).toEqual(["init", "init", "committed", "failed"]);
      expect(git(fx.work, ["branch", "--list", FEATURE])).toContain(FEATURE);
      git(fx.work, ["merge-base", "--is-ancestor", commit.fullCommitId, FEATURE]);
      expect(head(fx.work)).toEqual(headBefore);
    } finally {
      if (token) endSession(token);
      await close();
    }
    noLlm();
  });
});

describe("no LLM is reached with no API key and the opt-in on (AC7)", () => {
  it("assertAnthropicCredential and runAgent were called 0 times across every chain; the probe was stubbed", () => {
    // AC2 + two AC7 feature-branch drives + two AC9 working-branch drives + the AC9 guard.
    expect(tally.drives).toBe(6);
    expect(tally.runAgent).toBe(0);
    expect(tally.assertAnthropicCredential).toBe(0);
    // Every chain's rks_governor_init probed through the stubbed cache (the AC2 case runs no init).
    expect(tally.probeGet).toBeGreaterThanOrEqual(5);
  });

  it("positive control: calling the mocked assertAnthropicCredential directly increments the same spy", () => {
    const n = spies.assertAnthropicCredential.mock.calls.length;
    try { assertAnthropicCredential({}); } catch { /* no key: the real check throws, which is fine */ }
    expect(spies.assertAnthropicCredential).toHaveBeenCalledTimes(n + 1);
  });
});
