/**
 * backlog.fix.cross-delegation-budget-per-attempt - delegation budgets are fresh on a restart
 * attempt and carried on a max-turns resume; recovery's side-effect budget stays invocation-wide.
 *
 * The runAgent that cross-delegate.mjs imports (the DELEGATE) is mocked, so no target agent runs.
 * The OUTER runAgent is the real runner (vi.importActual), driven through the _testClient seam
 * (runner.mjs: an injected _testClient forces the in-process API path). Depends on
 * backlog.feat.runner-attempt-lifecycle (config.attemptState.beginAttempt(ctx)).
 * No LLM, no filesystem beyond a temp root, no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const delegateRunAgent = vi.hoisted(() => vi.fn());
vi.mock("../../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: delegateRunAgent };
});

const { runAgent } = await vi.importActual("../../../packages/mcp-rks/src/agents/runner.mjs");
const { clearConfigCache } = await import("../../../packages/mcp-rks/src/agents/config.mjs");
const { createDelegationCounter } = await import("../../../packages/mcp-rks/src/agents/cross-delegate.mjs");
const { createProductOwnerAgent } = await import("../../../packages/mcp-rks/src/agents/product-owner.mjs");
const { createPlannerAgent } = await import("../../../packages/mcp-rks/src/agents/planner.mjs");
const { createResearchAgent } = await import("../../../packages/mcp-rks/src/agents/research.mjs");
const { createRecoveryAgent } = await import("../../../packages/mcp-rks/src/agents/recovery.mjs");

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-20250514";
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
let toolSeq = 0;
const toolUse = (name, input) => ({ content: [{ type: "tool_use", id: `tu${++toolSeq}`, name, input }], stop_reason: "tool_use", usage });

/** Scripted client: records model, transcript length and delegate calls so far, per LLM call. */
function scriptedClient(log, script) {
  let n = 0;
  return { messages: { create: async (args) => {
    n += 1;
    log.push({ n, model: args.model, messageCount: args.messages.length, delegatedSoFar: delegateRunAgent.mock.calls.length });
    return script(n, args);
  } } };
}

const restart = (index, kind) => ({ index, kind, model: index === 0 || kind === "same_model_retry" ? HAIKU : SONNET, resumed: false });
const resume = (index) => ({ index, kind: "escalation", model: SONNET, resumed: true });
const LIMIT = /limit reached|budget exhausted/;
const refusedText = (r) => String(r?.error ?? "");

const AGENTS = {
  "product-owner": {
    build: (root) => createProductOwnerAgent({ projectId: "t", problemId: "backlog.t.x", projectRoot: root }),
    tool: "research_codebase",
    input: { query: "q" },
  },
  planner: {
    build: (root) => createPlannerAgent({ projectId: "t", storyId: "backlog.t.x", projectRoot: root }),
    tool: "research_architecture",
    input: { query: "q" },
  },
  research: {
    build: (root) => createResearchAgent({ projectId: "t", query: "q", projectRoot: root }),
    tool: "read_git",
    input: { tool: "git_log", args: { count: 1 } },
  },
};

const toolOf = (config, name) => {
  const t = config.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
};

async function spend(tool, input, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await tool.execute(input));
  return out;
}

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-xdeleg-attempt-"));
  delegateRunAgent.mockReset();
  delegateRunAgent.mockResolvedValue({ ok: true, data: { answer: "stub" } });
});
afterEach(() => {
  clearConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("createDelegationCounter without attemptState is unchanged", () => {
  it("returns a plain { count: 0, max } counter", () => {
    expect(createDelegationCounter(3)).toEqual({ count: 0, max: 3 });
  });
});

for (const [agentName, spec] of Object.entries(AGENTS)) {
  describe(`${agentName} - attempt-scoped delegation budget`, { timeout: 30_000 }, () => {
    it("the factory config carries an attemptState with at least one registered item", () => {
      const config = spec.build(root);
      expect(typeof config.attemptState?.beginAttempt).toBe("function");
      expect(config.attemptState.snapshot().items.length).toBeGreaterThanOrEqual(1);
    });

    for (const kind of ["same_model_retry", "escalation", "self_escalation"]) {
      it(`a restart attempt (${kind}) gets a fresh budget after the primary spent 3/3`, async () => {
        const config = spec.build(root);
        const tool = toolOf(config, spec.tool);
        config.attemptState.beginAttempt(restart(0, "primary"));
        await spend(tool, spec.input, 3);
        expect(delegateRunAgent).toHaveBeenCalledTimes(3);
        expect(refusedText(await tool.execute(spec.input))).toMatch(LIMIT);
        expect(delegateRunAgent).toHaveBeenCalledTimes(3);

        config.attemptState.beginAttempt(restart(1, kind));
        const first = await tool.execute(spec.input);
        expect(refusedText(first)).not.toMatch(LIMIT);
        expect(delegateRunAgent).toHaveBeenCalledTimes(4);
      });
    }

    it("a resumed attempt (max-turns escalation) carries the count: the 4th call is refused", async () => {
      const config = spec.build(root);
      const tool = toolOf(config, spec.tool);
      config.attemptState.beginAttempt(restart(0, "primary"));
      await spend(tool, spec.input, 3);
      config.attemptState.beginAttempt(resume(1));
      expect(refusedText(await tool.execute(spec.input))).toMatch(LIMIT);
      expect(delegateRunAgent).toHaveBeenCalledTimes(3);
    });
  });
}

describe("planner - research_architecture and check_story_readiness share one attempt-scoped budget", { timeout: 30_000 }, () => {
  it("shared 3/3 is refused on either tool, and both delegate again after a restart", async () => {
    const config = AGENTS.planner.build(root);
    const arch = toolOf(config, "research_architecture");
    const ready = toolOf(config, "check_story_readiness");
    config.attemptState.beginAttempt(restart(0, "primary"));
    await spend(arch, { query: "q" }, 2);
    await ready.execute({ problemId: "backlog.t.x" });
    expect(refusedText(await arch.execute({ query: "q" }))).toMatch(LIMIT);
    expect(refusedText(await ready.execute({ problemId: "backlog.t.x" }))).toMatch(LIMIT);
    expect(delegateRunAgent).toHaveBeenCalledTimes(3);

    config.attemptState.beginAttempt(restart(1, "same_model_retry"));
    expect(refusedText(await arch.execute({ query: "q" }))).not.toMatch(LIMIT);
    expect(refusedText(await ready.execute({ problemId: "backlog.t.x" }))).not.toMatch(LIMIT);
    expect(delegateRunAgent).toHaveBeenCalledTimes(5);
  });
});

describe("product-owner through the real runAgent", { timeout: 30_000 }, () => {
  it("after the primary spends 3/3 and fails with invalid JSON, the same-model retry's first research_codebase call delegates", async () => {
    const log = [];
    const config = AGENTS["product-owner"].build(root);
    // 1-3 primary tool turns, 4 primary invalid JSON, 5 retry tool turn, 6 retry invalid JSON, 7 escalation invalid JSON
    const script = (n) => (n <= 3 || n === 5 ? toolUse("research_codebase", { query: `q${n}` }) : textResp("NOT JSON"));
    await runAgent({ ...config, model: HAIKU, fallbackModel: SONNET, maxTurns: 10, _testClient: scriptedClient(log, script) });
    expect(log.map((c) => c.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU, HAIKU, HAIKU, SONNET]);
    expect(delegateRunAgent).toHaveBeenCalledTimes(4);
  });

  it("on max-turns escalation with _resumeMessages the count carries: the resumed run's call is refused", async () => {
    const log = [];
    const config = AGENTS["product-owner"].build(root);
    let sonnetCalls = 0;
    const script = (n, args) => {
      if (args.model === SONNET && ++sonnetCalls > 1) return textResp("NOT JSON");
      return toolUse("research_codebase", { query: `q${n}` });
    };
    await runAgent({ ...config, model: HAIKU, fallbackModel: SONNET, maxTurns: 5, _testClient: scriptedClient(log, script) });
    const firstSonnet = log.find((c) => c.model === SONNET);
    expect(firstSonnet).toBeDefined();
    expect(firstSonnet.messageCount).toBeGreaterThan(1);
    expect(firstSonnet.delegatedSoFar).toBe(3);
    expect(delegateRunAgent).toHaveBeenCalledTimes(3);
  });
});

describe("recovery - side-effect budget stays invocation-wide", { timeout: 30_000 }, () => {
  it("recovery is not registered with an attempt state, so its fix_git + fix_dendron budget is one per invocation", async () => {
    const config = createRecoveryAgent({ projectId: "t", projectRoot: root });
    expect(config.attemptState).toBeUndefined();
    const fixDendron = toolOf(config, "fix_dendron");
    const fixGit = toolOf(config, "fix_git");
    await spend(fixDendron, { request: "repair frontmatter" }, 2);
    await fixGit.execute({ request: "show status" });
    expect(refusedText(await fixDendron.execute({ request: "repair frontmatter" }))).toMatch(LIMIT);
    expect(delegateRunAgent).toHaveBeenCalledTimes(3);
  });

  it("through the real runAgent a Sonnet escalation cannot exceed 3 total fix_git + fix_dendron delegations", async () => {
    const log = [];
    const config = createRecoveryAgent({ projectId: "t", projectRoot: root });
    // 1-3 primary repairs, 4 invalid JSON, 5 retry repair, 6 invalid JSON, 7 Sonnet repair, 8 invalid JSON
    const script = (n) => {
      if (n === 2) return toolUse("fix_git", { request: "show status" });
      if (n <= 3 || n === 5 || n === 7) return toolUse("fix_dendron", { request: "repair frontmatter" });
      return textResp("NOT JSON");
    };
    await runAgent({ ...config, model: HAIKU, fallbackModel: SONNET, maxTurns: 10, _testClient: scriptedClient(log, script) });
    expect(log.map((c) => c.model)).toEqual([HAIKU, HAIKU, HAIKU, HAIKU, HAIKU, HAIKU, SONNET, SONNET]);
    expect(delegateRunAgent).toHaveBeenCalledTimes(3);
  });
});
