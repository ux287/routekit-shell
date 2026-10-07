/**
 * Witness for backlog.fix.llm-token-usage-complete-coverage: a runner agent whose later turn
 * throws still reports the tokens already spent, never reports them twice, and agent events
 * carry problemId when the invocation supplies one (plumbing only: no production runAgent caller
 * supplies problemId in this story, so it is exercised through the config seam). Drives runAgent
 * through the _testClient and _testCollector seams.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const NAME = "tok-fail";
const MODEL = "claude-haiku-4-5-20251001";
const U1 = { input_tokens: 11, output_tokens: 5, cache_read_input_tokens: 70, cache_creation_input_tokens: 30 };
const U2 = { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 4 };
const toolTurn = (usage, id) => ({
  content: [{ type: "tool_use", id, name: "no_such_tool", input: {} }],
  stop_reason: "tool_use",
  usage,
});
const textTurn = (usage) => ({
  content: [{ type: "text", text: '{"ok":true,"answer":"done"}' }],
  stop_reason: "end_turn",
  usage,
});
const scripted = (script) => {
  let n = 0;
  return { messages: { create: async () => script(++n) } };
};
const collect = (emits) => ({ emit: (type, projectId, payload) => emits.push({ type, payload }) });
const CONFIG = (extra = {}) => ({
  name: NAME,
  prompt: "system",
  userMessage: "hi",
  tools: [],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  projectId: "test",
  model: MODEL,
  maxTurns: 6,
  ...extra,
});
const byType = (emits, event) => emits.filter((e) => e.type === `agent.${NAME}.${event}`);

describe("runner outer catch keeps accumulated tokens", () => {
  it("turn 1 completes, turn 2 throws: failed carries turn-1 usage, no complete", async () => {
    const emits = [];
    const client = scripted((n) => {
      if (n === 1) return toolTurn(U1, "t1");
      throw new Error("429 rate limited");
    });
    await Promise.resolve(runAgent({ ...CONFIG(), _testClient: client, _testCollector: collect(emits) })).catch(() => {});
    const failed = byType(emits, "failed");
    expect(failed).toHaveLength(1);
    expect(String(failed[0].payload.error)).toContain("429");
    expect(failed[0].payload.tokens).toEqual({ in: 11, out: 5, cacheRead: 70, cacheCreate: 30 });
    expect(byType(emits, "complete")).toHaveLength(0);
  });

  it("two completed turns then a throw: failed tokens are the sum over both turns", async () => {
    const emits = [];
    const client = scripted((n) => {
      if (n === 1) return toolTurn(U1, "t1");
      if (n === 2) return toolTurn(U2, "t2");
      throw new Error("network reset");
    });
    await Promise.resolve(runAgent({ ...CONFIG(), _testClient: client, _testCollector: collect(emits) })).catch(() => {});
    const failed = byType(emits, "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.tokens).toEqual({ in: 13, out: 14, cacheRead: 170, cacheCreate: 34 });
  });
});

// An error whose `message` getter throws. finalizeResult's validation catch reads err.message
// while building its failed payload, so throwing this from outputSchema.parse (or from a getter
// the result spread touches) makes finalizeResult itself throw into runAgent's outer catch.
const poisoned = () => ({
  get message() {
    throw new Error("poisoned message");
  },
});
const tokenBearing = (emits) => emits.filter((e) => e.payload.tokens != null);

describe("runner outer catch never repeats tokens already reported", () => {
  it("max turns (:572) emits tokens, then finalizeResult throws: the outer-catch failed has no tokens", async () => {
    const emits = [];
    const client = scripted(() => ({
      content: [
        { type: "text", text: '{"ok":true,"answer":"partial"}' },
        { type: "tool_use", id: "t1", name: "no_such_tool", input: {} },
      ],
      stop_reason: "tool_use",
      usage: U1,
    }));
    const schema = { parse: () => { throw poisoned(); } };
    await Promise.resolve(
      runAgent({ ...CONFIG({ maxTurns: 1, outputSchema: schema }), _testClient: client, _testCollector: collect(emits) }),
    ).catch(() => {});
    const failed = byType(emits, "failed");
    expect(failed.map((f) => f.payload.error)).toEqual(["max_turns_exceeded", "poisoned message"]);
    expect("tokens" in failed[1].payload).toBe(false);
    const withTokens = tokenBearing(emits);
    expect(withTokens).toHaveLength(1);
    expect(withTokens[0].payload.tokens).toEqual({ in: 11, out: 5, cacheRead: 70, cacheCreate: 30 });
  });

  it("finalizeResult emits complete with tokens, then throws: the outer-catch failed has no tokens", async () => {
    const emits = [];
    const schema = {
      parse: (v) =>
        Object.defineProperty({ ...v }, "boom", {
          enumerable: true,
          get() {
            throw poisoned();
          },
        }),
    };
    await Promise.resolve(
      runAgent({ ...CONFIG({ outputSchema: schema }), _testClient: scripted(() => textTurn(U1)), _testCollector: collect(emits) }),
    ).catch(() => {});
    expect(byType(emits, "complete")).toHaveLength(1);
    const failed = byType(emits, "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.error).toBe("poisoned message");
    expect("tokens" in failed[0].payload).toBe(false);
    expect(tokenBearing(emits)).toHaveLength(1);
  });
});

describe("runner agent events carry problemId", () => {
  it("started and complete carry problemId when the config supplies one", async () => {
    const emits = [];
    await runAgent({
      ...CONFIG({ problemId: "backlog.fix.example" }),
      _testClient: scripted(() => textTurn(U1)),
      _testCollector: collect(emits),
    });
    expect(byType(emits, "started")[0].payload.problemId).toBe("backlog.fix.example");
    expect(byType(emits, "complete")[0].payload.problemId).toBe("backlog.fix.example");
  });

  it("failed carries problemId too", async () => {
    const emits = [];
    const client = scripted(() => {
      throw new Error("boom");
    });
    await Promise.resolve(
      runAgent({ ...CONFIG({ problemId: "backlog.fix.example" }), _testClient: client, _testCollector: collect(emits) }),
    ).catch(() => {});
    expect(byType(emits, "failed")[0].payload.problemId).toBe("backlog.fix.example");
  });

  it("no problemId key when the config supplies none", async () => {
    const emits = [];
    await runAgent({ ...CONFIG(), _testClient: scripted(() => textTurn(U1)), _testCollector: collect(emits) });
    for (const e of emits) expect("problemId" in e.payload).toBe(false);
  });
});
