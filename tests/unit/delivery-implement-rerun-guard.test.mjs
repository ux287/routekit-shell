/**
 * backlog.feat.escalation-safe-side-effecting-agents - AC7, delivery implement repeat guard.
 * Unit tier, deterministic: runExecTool is mocked, scripted _testClient, no subprocess, no network.
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/delivery-implement-rerun-guard.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execCalls = [];
// delivery.mjs:320 imports runExecTool dynamically from ../server/exec.mjs.
vi.mock("../../packages/mcp-rks/src/server/exec.mjs", () => ({
  runExecTool: vi.fn(async (args) => { execCalls.push(args); return { ok: true, branch: "rks/t-s", commitId: "abc1234" }; }),
}));

const { createDeliveryAgent } = await import("../../packages/mcp-rks/src/agents/delivery.mjs");
const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

let root;
beforeEach(() => {
  execCalls.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-delivery-guard-"));
  fs.mkdirSync(path.join(root, "notes"));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const implement = (cfg) => cfg.tools.find((t) => t.name === "implement");

describe("implement is not re-run for a story it already executed", () => {
  it("same storyId twice on one config -> one runExecTool call, second reports already executed", async () => {
    const cfg = createDeliveryAgent({ projectId: "t", storyIds: ["backlog.t.s"], projectRoot: root });
    const first = await implement(cfg).execute({ storyId: "backlog.t.s" });
    const second = await implement(cfg).execute({ storyId: "backlog.t.s" });
    expect(execCalls).toHaveLength(1);
    // implement returns runExecTool's result as-is (delivery.mjs:320-326); the mock above returns ok true.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(first.ok);
    expect(JSON.stringify(second)).toMatch(/already/i);
  });

  it("a different storyId is not blocked", async () => {
    const cfg = createDeliveryAgent({ projectId: "t", storyIds: ["backlog.t.s", "backlog.t.u"], projectRoot: root });
    await implement(cfg).execute({ storyId: "backlog.t.s" });
    await implement(cfg).execute({ storyId: "backlog.t.u" });
    expect(execCalls).toHaveLength(2);
  });

  it("through runAgent: Haiku implements then fails, the rerun from turn 0 implements again -> runExecTool called once", async () => {
    const models = [];
    const client = { messages: { create: async (args) => {
      models.push(args.model);
      const last = args.messages[args.messages.length - 1];
      const sawToolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
      if (!sawToolResult) {
        return { content: [{ type: "tool_use", id: `tu_${models.length}`, name: "implement", input: { storyId: "backlog.t.s" } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } };
      }
      const text = args.model === SONNET ? JSON.stringify({ ok: true, summary: "implemented" }) : "not json";
      return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    } } };
    const cfg = createDeliveryAgent({ projectId: "t", storyIds: ["backlog.t.s"], projectRoot: root });
    const result = await runAgent({ ...cfg, model: HAIKU, fallbackModel: SONNET, _testClient: client, _testCollector: { emit: () => {} } });
    expect(execCalls).toHaveLength(1);
    expect(models).toContain(SONNET);
    expect(result.ok).toBe(true);
  });
});
