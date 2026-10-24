/**
 * S9a agent/bootstrap handler family - integration tier (backlog.feat.server-mjs-agent-bootstrap-handler-family).
 * Pattern: tests/integration/server-handler-planner.test.mjs. createServer() + InMemoryTransport against
 * a remote-less os.tmpdir git fixture bound through ROUTEKIT_PROJECT_ROOT / ROUTEKIT_PROJECT_ID.
 * No case sets RKS_SKIP_PREFLIGHT: none of the six has a preflight.mjs table entry (preflight.mjs:67-73).
 * Untokened calls reach the registry because _skipTokenValidation is true under NODE_ENV test
 * (server.mjs:2463-2465); no case exercises the protected-tool refusal.
 * No quoted telemetry-package specifier appears in this file (telemetry-global-mock-triage).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const h = vi.hoisted(() => ({
  runInitTool: vi.fn(), runProjectInit: vi.fn(), runExternalResearch: vi.fn(), runOnboarder: vi.fn(),
  runAgent: vi.fn(), factory: vi.fn(), agentName: { value: null },
}));
vi.mock("../../packages/mcp-rks/src/server/init.mjs", async (io) => ({ ...(await io()), runInitTool: h.runInitTool }));
vi.mock("../../packages/mcp-rks/src/project-init.mjs", async (io) => ({ ...(await io()), runProjectInit: h.runProjectInit }));
vi.mock("../../packages/mcp-rks/src/agents/external-research.mjs", async (io) => ({ ...(await io()), runExternalResearch: h.runExternalResearch }));
vi.mock("../../packages/mcp-rks/src/server/onboarder.mjs", async (io) => ({ ...(await io()), runOnboarder: h.runOnboarder }));
vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (io) => ({ ...(await io()), runAgent: h.runAgent }));
vi.mock("../../packages/mcp-rks/src/agents/registry.mjs", async (io) => {
  const real = await io();
  // Only the chosen agent's factory is replaced; parseAgentInput and listAgents stay real.
  return { ...real, getAgent: (name) => (name === h.agentName.value ? h.factory : real.getAgent(name)) };
});

import { loadContext } from "../../packages/mcp-rks/src/server/project.mjs";
import { setProjectRoot } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { listAgents, parseAgentInput } from "../../packages/mcp-rks/src/agents/registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF_ABS = fileURLToPath(import.meta.url);
const PROJECT_ID = "s9a-agent-bootstrap-int";
const DECLARED_BASE = "s9a-base";
const FEATURE = "feature/s9a-off-base";
const GIT_TIMEOUT_MS = 15_000;

// Fixture git helper: every spawnSync carries timeout (AI-TR9).
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
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

// Expected bytes: same committed build-base literals as the unit file. Captured from the PRE-MOVE
// build-base server.mjs at commit 67523a45ad4bf2ea551eda26f3b1fec3f6b6719b (git show
// <sha>:packages/mcp-rks/src/server.mjs, lines 2666 and 2623-2624), pasted verbatim.
const DEPRECATION_WARNING_AT_BASE = "⚠️ `rks_interview` is deprecated and will be removed in v0.21.0. Use `/rks-onboard` instead. Forwarding you to the new onboarding experience now.\n\n";
const INSTRUCTIONS_AT_BASE = (root) => [
  "Use rks_templates_list to discover stack ids before init.",
  `Run npm install inside ${root} once scaffolding completes.`,
];

let fix;
let before;
let BASE;
const saved = {};

beforeAll(async () => {
  expect(process.env.NODE_ENV).toBe("test");
  before = repoSnapshot();
  fix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-s9a-ab-int-")));
  fs.mkdirSync(path.join(fix, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(fix, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: fix, kgFile: ".rks/kg.yaml", baseBranch: DECLARED_BASE }));
  fs.writeFileSync(path.join(fix, ".rks", "kg.yaml"), "{}\n");
  // Ignore everything but the two tracked files: telemetry or state writes made during the run
  // never dirty the fixture worktree.
  fs.writeFileSync(path.join(fix, ".gitignore"), "*\n!.gitignore\n!a.txt\n");
  saved.root = process.env.ROUTEKIT_PROJECT_ROOT;
  saved.id = process.env.ROUTEKIT_PROJECT_ID;
  process.env.ROUTEKIT_PROJECT_ROOT = fix;
  process.env.ROUTEKIT_PROJECT_ID = PROJECT_ID;
  // Base branch exactly as the moved rks_project_init body resolves it.
  const ctx = await loadContext(PROJECT_ID);
  BASE = ctx.projectJson?.baseBranch || "staging";
  git(fix, ["init", "-b", BASE]);
  git(fix, ["config", "user.email", "s9a@example.com"]);
  git(fix, ["config", "user.name", "S9a"]);
  fs.writeFileSync(path.join(fix, "a.txt"), "a v1\n");
  git(fix, ["add", ".gitignore", "a.txt"]);
  git(fix, ["commit", "-m", "init"]);
  // Session persistence goes to the fixture, never to the real repository's .rks/.
  setProjectRoot(fix);
});

afterAll(() => {
  if (saved.root === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = saved.root;
  if (saved.id === undefined) delete process.env.ROUTEKIT_PROJECT_ID;
  else process.env.ROUTEKIT_PROJECT_ID = saved.id;
  if (fix) fs.rmSync(fix, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ["runInitTool", "runProjectInit", "runExternalResearch", "runOnboarder", "runAgent", "factory"]) h[name].mockReset();
  h.agentName.value = null;
});

async function rawCallTool(name, args) {
  const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer();
  const client = new Client({ name: "s9a-agent-bootstrap", version: "0.0.0" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}
async function callTool(name, args) {
  const r = await rawCallTool(name, args);
  const text = r.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, raw: text };
  }
}
const fixtureBranch = () => git(fix, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

describe("S9a agent/bootstrap through createServer", { timeout: 30_000 }, () => {
  it("AI-TR1 fixture is remote-less, outside the repo, and the before snapshot is captured", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(git(fix, ["remote"]).trim()).toBe("");
    expect(isUnder(fs.realpathSync(fix), REPO_ROOT)).toBe(false);
    expect(BASE).toBe(DECLARED_BASE);
    expect(fixtureBranch()).toBe(BASE);
    expect(before.head).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof before.porcelain).toBe("string");
    expect(typeof before.stashes).toBe("string");
    // Never set by this file: none of the six has a preflight.mjs table entry.
    expect(fs.readFileSync(SELF_ABS, "utf8")).not.toMatch(new RegExp("process\\.env\\.RKS_SKIP_" + "PREFLIGHT\\s*="));
  });

  it("AI-TR2 rks_init projection and onboarder gating", async () => {
    const NEW_PATH = path.join(fix, "s9a-returned-path");
    const onboarded = { ok: true, stage: "welcome", display: "s9a init onboarder" };
    h.runInitTool.mockResolvedValueOnce({ success: true, path: NEW_PATH });
    h.runOnboarder.mockResolvedValueOnce(onboarded);
    const ok = await callTool("rks_init", { projectName: "s9a-int-proj" });
    expect(h.runInitTool).toHaveBeenCalledTimes(1);
    expect(h.runInitTool.mock.calls[0][0]).toStrictEqual({ projectName: "s9a-int-proj", parentDir: "..", dev: false, branchModel: "3-branch" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({ projectId: "s9a-int-proj", projectRoot: NEW_PATH, stage: "welcome" });
    expect(ok).toEqual({ success: true, path: NEW_PATH, onboarder: onboarded });

    h.runInitTool.mockResolvedValueOnce({ success: false, error: "s9a failed" });
    const failed = await callTool("rks_init", { projectName: "s9a-int-proj" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(failed).toEqual({ success: false, error: "s9a failed" });

    h.runInitTool.mockResolvedValueOnce({ success: true, path: NEW_PATH });
    h.runOnboarder.mockRejectedValueOnce(new Error("s9a onboarder boom"));
    const thrown = await callTool("rks_init", { projectName: "s9a-int-proj" });
    expect(thrown.nextStep).toEqual({ command: "/rks-onboard", reason: "first-run" });
    expect(thrown).not.toHaveProperty("onboarder");
  });

  it("AI-TR3 rks_project_init branch gate, register-without-apply and instructions", async () => {
    const args = { projectId: PROJECT_ID, id: "s9a-new", stack: "base", path: path.join(fix, "s9a-target") };
    git(fix, ["checkout", "-b", FEATURE]);
    try {
      expect(fixtureBranch()).toBe(FEATURE);
      const err = await callTool("rks_project_init", args).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("rks.project_init: expected to run from base branch");
      expect(err.message).toContain(`"${BASE}"`);
      expect(err.message).toContain(`"${FEATURE}"`);
      expect(h.runProjectInit).not.toHaveBeenCalled();
    } finally {
      git(fix, ["checkout", BASE]);
      git(fix, ["branch", "-D", FEATURE]);
    }
    expect(fixtureBranch()).toBe(BASE);

    const regErr = await callTool("rks_project_init", { ...args, register: true }).catch((e) => e);
    expect(regErr).toBeInstanceOf(Error);
    expect(regErr.message).toContain("rks.project_init: apply must be true when register is requested.");
    expect(h.runProjectInit).not.toHaveBeenCalled();

    const NEW_ROOT = path.join(fix, "s9a-scaffolded");
    h.runProjectInit.mockResolvedValueOnce({ applied: false, project: { id: "s9a-new", root: NEW_ROOT }, registryRecord: null, message: "s9a dry run" });
    const p = await callTool("rks_project_init", args);
    expect(h.runProjectInit).toHaveBeenCalledTimes(1);
    expect(h.runProjectInit.mock.calls[0][0]).toStrictEqual({
      shellRoot: fix, id: "s9a-new", stackId: "base", targetPath: args.path, apply: false, register: false,
    });
    expect(p).toEqual({
      ok: true,
      applied: false,
      project: { id: "s9a-new", root: NEW_ROOT },
      registryRecord: null,
      message: "s9a dry run",
      instructions: INSTRUCTIONS_AT_BASE(NEW_ROOT),
    });
    expect(fixtureBranch()).toBe(BASE);
    expect(git(fix, ["status", "--porcelain"])).toBe("");
  });

  it("AI-TR4 rks_agent_external_research passes the call arguments through", async () => {
    const verbatim = { ok: true, s9a: "external", sources: [{ url: "https://example.invalid/s9a" }] };
    h.runExternalResearch.mockResolvedValueOnce(verbatim);
    const args = { projectId: PROJECT_ID, query: "s9a external question" };
    expect(await callTool("rks_agent_external_research", args)).toEqual(verbatim);
    expect(h.runExternalResearch).toHaveBeenCalledTimes(1);
    expect(h.runExternalResearch.mock.calls[0][0]).toStrictEqual(args);
  });

  it("AI-TR5 rks_onboarder projects flags with the fixture root", async () => {
    h.runOnboarder.mockResolvedValueOnce({ ok: true, s9a: "onboarder" });
    expect(await callTool("rks_onboarder", { projectId: PROJECT_ID })).toEqual({ ok: true, s9a: "onboarder" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({
      projectId: PROJECT_ID, projectRoot: fix, stage: undefined, responses: {},
      skipTour: false, skipStage: false, bounce: false, resume: false, reset: false,
    });
  });

  it("AI-TR6 rks_interview display equals the build-base warning plus the onboarder display", async () => {
    h.runOnboarder.mockResolvedValueOnce({ ok: true, stage: "welcome", display: "s9a interview display" });
    const p = await callTool("rks_interview", { projectId: PROJECT_ID });
    expect(p.display).toBe(DEPRECATION_WARNING_AT_BASE + "s9a interview display");
    expect(p).toEqual({ ok: true, stage: "welcome", display: DEPRECATION_WARNING_AT_BASE + "s9a interview display" });
    expect(h.runOnboarder).toHaveBeenCalledTimes(1);
    expect(h.runOnboarder.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT_ID, projectRoot: fix, stage: "welcome" });
  });

  it("AI-TR7 rks_agent_run unknown agent, real strict-input rejection and a mocked run", async () => {
    const agents = listAgents();
    expect(agents).toContain("delivery");
    const N = "delivery";
    h.agentName.value = N;

    // Unknown agent.
    const unknown = await callTool("rks_agent_run", { agent: "s9a-no-such-agent", input: { projectId: PROJECT_ID } });
    expect(unknown.ok).toBe(false);
    expect(unknown.error.startsWith("Unknown agent:")).toBe(true);
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();

    // Unknown input key: the real parseAgentInput error payload.
    const badInput = { projectId: PROJECT_ID, s9aBogusKey: 1 };
    const realBad = parseAgentInput(N, badInput);
    expect(realBad.ok).toBe(false);
    const rejected = await callTool("rks_agent_run", { agent: N, input: badInput });
    expect(rejected).toEqual(JSON.parse(JSON.stringify(realBad.error)));
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.runAgent).not.toHaveBeenCalled();

    // Accepted input: the spied factory gets the fixture root; runAgent is the mock.
    const goodInput = { projectId: PROJECT_ID };
    const realGood = parseAgentInput(N, goodInput);
    expect(realGood.ok).toBe(true);
    const config = { s9a: "agent-config" };
    h.factory.mockReturnValueOnce(config);
    const result = { ok: true, s9a: "mocked-run" };
    h.runAgent.mockResolvedValueOnce(result);
    expect(await callTool("rks_agent_run", { agent: N, input: goodInput })).toEqual(result);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.factory.mock.calls[0][0]).toStrictEqual({ ...realGood.data, projectRoot: fix });
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.runAgent.mock.calls[0][0]).toBe(config);
  });

  it("AI-TR9 every subprocess spawn in this file carries an explicit timeout", () => {
    const src = fs.readFileSync(SELF_ABS, "utf8");
    const lines = src
      .split("\n")
      .map((l) => l.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g, '""'))
      .map((l) => { const i = l.indexOf("//"); return i === -1 ? l : l.slice(0, i); });
    const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork|execa)\s*\(/g;
    let calls = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(SPAWN_FAMILY_RE)) {
        if (/function\s+$/.test(lines[i].slice(0, m.index))) continue;
        calls++;
        // Collect the call text until its parentheses balance.
        let depth = 0;
        let text = "";
        outer: for (let j = i; j < lines.length; j++) {
          const seg = j === i ? lines[j].slice(m.index) : lines[j];
          for (const ch of seg) {
            text += ch;
            if (ch === "(") depth++;
            else if (ch === ")" && --depth === 0) break outer;
          }
          text += "\n";
        }
        expect(text, `line ${i + 1}`).toMatch(/\btimeout\s*:/);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("AI-TR8 repository snapshot unchanged, entry points were only mocks, fixture removed", async () => {
    expect(repoSnapshot()).toEqual(before);
    expect(git(fix, ["remote"]).trim()).toBe("");
    for (const name of ["runInitTool", "runProjectInit", "runExternalResearch", "runAgent", "runOnboarder", "factory"]) {
      expect(vi.isMockFunction(h[name]), name).toBe(true);
    }
    // The module bindings the moved bodies resolve are the mocks, not the real entry points.
    expect((await import("../../packages/mcp-rks/src/server/init.mjs")).runInitTool).toBe(h.runInitTool);
    expect((await import("../../packages/mcp-rks/src/project-init.mjs")).runProjectInit).toBe(h.runProjectInit);
    expect((await import("../../packages/mcp-rks/src/agents/external-research.mjs")).runExternalResearch).toBe(h.runExternalResearch);
    expect((await import("../../packages/mcp-rks/src/agents/runner.mjs")).runAgent).toBe(h.runAgent);
    fs.rmSync(fix, { recursive: true, force: true });
    expect(fs.existsSync(fix)).toBe(false);
  });
});
