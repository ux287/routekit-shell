/**
 * backlog.fix.project-agent-run-structured-refusal
 *
 * A project-local agent (.rks/agents/*.json) is registered through discoverProjectAgents +
 * registerProjectAgents but carries no executable contract (no prompt, inputSchema, rawInput).
 * runAgent must return a structured refusal instead of throwing / returning the
 * "Cannot read properties of undefined (reading 'parse')" TypeError, and must never enter
 * _executeAgent (observable: no agent.<name>.started telemetry, no client call).
 * Lives in tests/unit/ (CI tier). No subprocesses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";
import {
  discoverProjectAgents,
  registerProjectAgents,
} from "../../packages/mcp-rks/src/agents/discovery.mjs";

const usage = { input_tokens: 1, output_tokens: 1 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });

function failingClient(calls) {
  return {
    messages: {
      create: async (args) => {
        calls.push(args);
        throw new Error("LLM client must not be called for a project agent");
      },
    },
  };
}

function makeCollector(emits) {
  return { emit: (event, projectId, data) => emits.push({ event, projectId, data }), flush: async () => {} };
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-project-agent-run-"));
  fs.mkdirSync(path.join(tmpRoot, ".rks", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, ".rks", "agents", "trading-ops.json"),
    JSON.stringify({ name: "trading-ops", description: "Sandbox trading operations" }),
    "utf8",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function registeredProjectConfig() {
  const registry = {};
  const { registered } = registerProjectAgents(registry, discoverProjectAgents(tmpRoot));
  expect(registered).toEqual(["trading-ops"]); // positive control: the agent really registered
  return registry["trading-ops"].factory({
    projectId: "traders",
    projectRoot: tmpRoot,
    request: "run scripts/sandbox_trade.py manage once (sandbox)",
  });
}

describe("runAgent on a project-local agent returns a structured refusal", () => {
  it("returns ok:false with reason project_agent_not_executable and the agent name, without throwing", async () => {
    const calls = [];
    const emits = [];
    const config = registeredProjectConfig();
    const r = await runAgent({ ...config, _testClient: failingClient(calls), _testCollector: makeCollector(emits) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("project_agent_not_executable");
    expect(r.agent).toBe("trading-ops");
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
    expect(typeof r.hint).toBe("string");
    expect(r.hint.length).toBeGreaterThan(0);
  });

  it("the returned error is not the TypeError text", async () => {
    const r = await runAgent({ ...registeredProjectConfig(), _testClient: failingClient([]), _testCollector: makeCollector([]) });
    expect(r.error).not.toContain("Cannot read properties of undefined");
    expect(r.error).not.toContain("reading 'parse'");
  });

  it("never enters _executeAgent: no started telemetry, no client call, no retry or escalation", async () => {
    const calls = [];
    const emits = [];
    const config = registeredProjectConfig();
    const r = await runAgent({
      ...config,
      model: "claude-haiku-4-5-20251001",
      fallbackModel: "claude-sonnet-4-6",
      _testClient: failingClient(calls),
      _testCollector: makeCollector(emits),
    });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(emits.filter((e) => e.event === "agent.trading-ops.started")).toHaveLength(0);
    expect(emits.filter((e) => e.event.endsWith(".escalation") || e.event.endsWith(".self_escalation"))).toHaveLength(0);
    expect(r._escalated).toBeUndefined();
  });

  it("a config with no callable inputSchema.parse is refused without the TypeError", async () => {
    const calls = [];
    const r = await runAgent({
      name: "no-contract",
      projectId: "test",
      userMessage: "hi",
      _testClient: failingClient(calls),
      _testCollector: makeCollector([]),
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).not.toContain("Cannot read properties of undefined");
    expect(calls).toHaveLength(0);
  });

  it("positive control: a built-in-shaped config with a real zod inputSchema still reaches the client", async () => {
    const calls = [];
    const client = {
      messages: {
        create: async (args) => {
          calls.push(args);
          return textResp('{"ok":true,"answer":"x"}');
        },
      },
    };
    const r = await runAgent({
      name: "builtin-shaped",
      prompt: "system",
      userMessage: "hi",
      tools: [],
      inputSchema: z.object({ q: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
      rawInput: { q: "hi" },
      projectId: "test",
      _testClient: client,
      _testCollector: makeCollector([]),
    });
    expect(calls.length).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });
});

describe("discovery.mjs no longer claims project agents are runnable", () => {
  it("drops the generic-input comment and the runAgent-compatible JSDoc", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../packages/mcp-rks/src/agents/discovery.mjs"),
      "utf8",
    );
    expect(src).not.toContain("Project agents use generic input");
    expect(src).not.toContain("compatible with runAgent()");
  });
});
