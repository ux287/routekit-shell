/**
 * backlog.feat.escalation-safe-side-effecting-agents - guard 1, runner side.
 * Unit tier, deterministic: scripted _testClient, recording _testCollector, no I/O.
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/runner-post-run-verification.test.mjs
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const Out = z.object({ ok: z.boolean(), summary: z.string(), data: z.object({ merged: z.boolean().optional() }).optional() });

function scriptedClient(calls, script) {
  let n = 0;
  return { messages: { create: async (args) => { calls.push({ model: args.model, messages: args.messages }); return script(++n); } } };
}
const textResp = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
const collector = (emits) => ({ emit: (type, projectId, payload) => emits.push({ type, projectId, payload }) });

function baseConfig(overrides) {
  return {
    name: "ship", projectId: "t", model: HAIKU, fallbackModel: SONNET, maxTurns: 2, timeoutMs: 5000,
    // runAgent refuses a config without a callable inputSchema.parse before any LLM call (runner.mjs:197-198, :309-310),
    // and _executeAgent reads config.prompt and parses config.rawInput (runner.mjs:388, :452).
    prompt: "s", userMessage: "u", tools: [], inputSchema: z.object({}).passthrough(), rawInput: {}, outputSchema: Out, ...overrides,
  };
}

describe("post-run verification is a failure signal", () => {
  it("an ok result whose claim the verifier refutes becomes ok:false naming the mismatch and escalates once", async () => {
    const calls = []; const emits = []; const seen = [];
    const verify = async (result, ctx) => { seen.push(ctx?.model); return { ok: false, mismatch: "merged claimed true, observed false" }; };
    const result = await runAgent(baseConfig({
      verify, _testCollector: collector(emits),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "merged", data: { merged: true } })),
    }));
    expect(calls.map((c) => c.model)).toEqual([HAIKU, SONNET]);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/merged claimed true, observed false/);
  });

  it("a verified ok result makes exactly one call", async () => {
    const calls = [];
    const result = await runAgent(baseConfig({
      verify: async () => ({ ok: true }),
      _testCollector: collector([]),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "fine" })),
    }));
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it("Haiku refuted, Sonnet verified: the caller gets the Sonnet ok result", async () => {
    const calls = []; let v = 0;
    const result = await runAgent(baseConfig({
      verify: async () => (++v === 1 ? { ok: false, mismatch: "phase" } : { ok: true }),
      _testCollector: collector([]),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "x" })),
    }));
    expect(calls.map((c) => c.model)).toEqual([HAIKU, SONNET]);
    expect(result.ok).toBe(true);
  });

  it("bounded: refuted on both models -> ok:false after exactly two calls, verifier called twice", async () => {
    const calls = []; let v = 0;
    const result = await runAgent(baseConfig({
      verify: async () => { v++; return { ok: false, mismatch: "branch claimed x, observed y" }; },
      _testCollector: collector([]),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "x" })),
    }));
    expect(calls.map((c) => c.model)).toEqual([HAIKU, SONNET]);
    expect(v).toBe(2);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/branch claimed x, observed y/);
  });

  it("no fallbackModel: a refuted result is ok:false after one call", async () => {
    const calls = [];
    const result = await runAgent(baseConfig({
      fallbackModel: undefined,
      verify: async () => ({ ok: false, mismatch: "phase" }),
      _testCollector: collector([]),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "x" })),
    }));
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/phase/);
  });

  for (const [label, verify, reason] of [
    ["reports observed:false", async () => ({ observed: false, reason: "gh pr view failed" }), "gh pr view failed"],
    ["throws", async () => { throw new Error("note unreadable"); }, "note unreadable"],
  ]) {
    it(`verifier that ${label}: ok unchanged, one call, verification.observed false, telemetry records it`, async () => {
      const calls = []; const emits = [];
      const result = await runAgent(baseConfig({
        verify, _testCollector: collector(emits),
        _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "x" })),
      }));
      expect(calls).toHaveLength(1);
      expect(result.ok).toBe(true);
      expect(result.verification?.observed).toBe(false);
      expect(String(result.verification?.reason)).toContain(reason);
      const ev = emits.find((e) => /verification/.test(e.type));
      expect(ev?.payload?.observed).toBe(false);
      expect(String(ev?.payload?.reason)).toContain(reason);
    });
  }

  it("agents without a verifier keep today's behavior (no extra calls)", async () => {
    const calls = [];
    const result = await runAgent(baseConfig({
      name: "research", _testCollector: collector([]),
      _testClient: scriptedClient(calls, () => textResp({ ok: true, summary: "x" })),
    }));
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});
