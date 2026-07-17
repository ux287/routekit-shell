/**
 * Running witness for backlog.feat.escalation-same-model-retry.
 *
 * A transient invalid_json / output_validation_failed is retried ONCE on the SAME (cheaper)
 * model before escalating to the fallback model — avoiding the "jump to Sonnet then still
 * fail" double-spend. Timeouts and max_turns still escalate directly. DEFAULT_MAX_TOKENS is
 * 8192 so large-but-valid output stops truncating into an escalation.
 *
 * Drives runAgent via the _testClient seam (mirrors tests/unit/runner-prompt-caching.test.mjs)
 * and counts messages.create calls + the model per call. Lives in tests/unit/ (CI tier).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-20250514";

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
const toolResp = () => ({ content: [{ type: "tool_use", id: "t1", name: "tool_a", input: { x: 1 } }], stop_reason: "tool_use", usage });
const VALID = '{"ok":true,"answer":"done"}';

const CONFIG = () => ({
  name: "esc-test",
  prompt: "system",
  userMessage: "hi",
  tools: [{ name: "tool_a", description: "A", inputSchema: z.object({ x: z.number() }), execute: async () => ({ r: 1 }) }],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  projectId: "test",
});

/** Mock client whose create() returns per-call from `script(n)`, recording each model. */
function scriptedClient(calls, script) {
  let n = 0;
  return { messages: { create: async (args) => { calls.push({ model: args.model, max_tokens: args.max_tokens }); return script(++n); } } };
}

describe("runAgent — same-model retry before escalation", () => {
  it("invalid_json: retries ONCE on the same model, then succeeds (no fallback)", async () => {
    const calls = [];
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp("NOT JSON") : textResp(VALID)));
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0].model).toBe(HAIKU);
    expect(calls[1].model).toBe(HAIKU); // SAME model, not the fallback
    expect(r._escalated).toBeUndefined(); // no real escalation happened
  });

  it("output_validation_failed: same-model retry then success", async () => {
    const calls = [];
    // First a schema-invalid JSON (missing `answer`), then valid.
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp('{"ok":true}') : textResp(VALID)));
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1].model).toBe(HAIKU);
  });

  it("escalates to the fallback model only AFTER the same-model retry also fails", async () => {
    const calls = [];
    const client = scriptedClient(calls, (n) => (n <= 2 ? textResp("STILL NOT JSON") : textResp(VALID)));
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(calls.map((c) => c.model)).toEqual([HAIKU, HAIKU, SONNET]); // primary, same-model retry, escalation
    expect(r.ok).toBe(true);
    expect(r._escalated).toEqual(expect.objectContaining({ from: HAIKU, to: SONNET }));
  });

  it("BOUNDEDNESS: a persistently-invalid agent makes exactly 3 calls (primary, retry, fallback)", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => textResp("NEVER JSON"));
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(calls.length).toBe(3); // no infinite loop
    expect(calls.filter((c) => c.model === HAIKU).length).toBe(2); // primary + one same-model retry
    expect(calls.filter((c) => c.model === SONNET).length).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("max_turns escalates DIRECTLY — no same-model retry inserted", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => toolResp()); // always tool_use → exhausts maxTurns
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, maxTurns: 1, _testClient: client });
    expect(calls.filter((c) => c.model === HAIKU).length).toBe(1); // primary only — NO same-model retry
    expect(calls.some((c) => c.model === SONNET)).toBe(true); // escalated
  });

  it("timeout escalates directly — no same-model retry", async () => {
    const calls = [];
    let n = 0;
    const client = { messages: { create: async (args) => {
      calls.push({ model: args.model });
      if (++n === 1) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      return textResp(VALID);
    } } };
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(calls.map((c) => c.model)).toEqual([HAIKU, SONNET]); // no same-model retry between them
  });

  it("success on the first attempt makes exactly one call (no spurious retry)", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => textResp(VALID));
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
  });

  it("uses DEFAULT_MAX_TOKENS = 8192 (raised to stop truncation→escalation)", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => textResp(VALID));
    await runAgent({ ...CONFIG(), model: HAIKU, _testClient: client });
    expect(calls[0].max_tokens).toBe(8192);
  });
});
