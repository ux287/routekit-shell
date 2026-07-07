/**
 * Running witness for backlog.feat.llm-prompt-caching (SDK/agent-runner path).
 *
 * Lives in tests/unit/ so the CI unit tier runs it — the sibling coverage in
 * packages/mcp-rks/__tests__/agent-runner.spec.mjs is node:test and is NOT swept by CI.
 * Drives runAgent via the _testClient injection seam and inspects the messages.create args
 * for cache_control on the stable system + tools prefix (Anthropic prompt caching).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

function makeMock(capture) {
  return {
    messages: {
      create: async (args) => {
        capture.push(args);
        return {
          content: [{ type: "text", text: '{"ok":true,"answer":"done"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      },
    },
  };
}

const CONFIG = () => ({
  name: "cache-test",
  prompt: "You are a stable system prompt used for cache-hit testing.",
  userMessage: "hello",
  tools: [
    { name: "tool_a", description: "A", inputSchema: z.object({ x: z.number() }), execute: async () => ({}) },
    { name: "tool_b", description: "B", inputSchema: z.object({ y: z.string() }), execute: async () => ({}) },
  ],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hello" },
  model: "claude-haiku-4-5-20251001",
  maxTurns: 1,
  projectId: "test",
});

describe("runner prompt caching — cache_control on the stable prefix", () => {
  it("marks the system block with cache_control:ephemeral, output unchanged", async () => {
    const calls = [];
    const r = await runAgent({ ...CONFIG(), _testClient: makeMock(calls) });
    // Output is unchanged — caching is billing-only.
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("done");
    // system is now a content-block array with a cache_control marker on the (last) block.
    const req = calls[0];
    expect(Array.isArray(req.system)).toBe(true);
    const lastBlock = req.system[req.system.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.text).toContain("stable system prompt");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
  });

  it("marks the LAST tool (only) with cache_control:ephemeral", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: makeMock(calls) });
    const req = calls[0];
    expect(Array.isArray(req.tools)).toBe(true);
    const lastTool = req.tools[req.tools.length - 1];
    expect(lastTool.cache_control).toEqual({ type: "ephemeral" });
    // Single breakpoint at the end of the stable prefix — earlier tools are not marked.
    expect(req.tools[0].cache_control).toBeUndefined();
  });

  it("message history is NOT cache-controlled (only the stable prefix is cached)", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: makeMock(calls) });
    const req = calls[0];
    for (const m of req.messages) {
      expect(m.cache_control).toBeUndefined();
    }
  });

  it("BYTE-STABILITY: the cached system+tools prefix is identical across successive same-agent calls", async () => {
    const a = [], b = [];
    await runAgent({ ...CONFIG(), _testClient: makeMock(a) });
    await runAgent({ ...CONFIG(), _testClient: makeMock(b) });
    // Deterministic marker placement → identical prefix → the cache actually hits.
    expect(JSON.stringify(a[0].system)).toBe(JSON.stringify(b[0].system));
    expect(JSON.stringify(a[0].tools)).toBe(JSON.stringify(b[0].tools));
  });
});
