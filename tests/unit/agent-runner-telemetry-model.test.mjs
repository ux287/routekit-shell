/**
 * Running witness for backlog.fix.agent-telemetry-tag-model.
 *
 * SDK-path agent telemetry (agent.<name>.complete/failed/started) must tag the model actually
 * used — including the FALLBACK model on an escalated run — so the haiku model-mix flip and
 * per-model cost are verifiable from telemetry (previously only the HTTP-path llm.token_usage
 * carried model). Drives runAgent via the _testClient + _testCollector seams (tests/unit, CI).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const NAME = "tel-test";
const usage = { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
const VALID = '{"ok":true,"answer":"done"}';

const makeCollector = (emits) => ({ emit: (type, projectId, payload) => emits.push({ type, payload }) });
const scriptedClient = (script) => { let n = 0; return { messages: { create: async () => script(++n) } }; };

const CONFIG = () => ({
  name: NAME,
  prompt: "system",
  userMessage: "hi",
  tools: [],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  projectId: "test",
});

const byType = (emits, event) => emits.filter((e) => e.type === `agent.${NAME}.${event}`);

describe("SDK-path agent telemetry tags model", () => {
  it("agent.<name>.complete carries the model used", async () => {
    const emits = [];
    await runAgent({ ...CONFIG(), model: HAIKU, _testClient: scriptedClient(() => textResp(VALID)), _testCollector: makeCollector(emits) });
    expect(byType(emits, "complete")[0].payload.model).toBe(HAIKU);
  });

  it("complete preserves cacheRead/cacheCreate in the tokens payload (regression)", async () => {
    const emits = [];
    await runAgent({ ...CONFIG(), model: HAIKU, _testClient: scriptedClient(() => textResp(VALID)), _testCollector: makeCollector(emits) });
    const p = byType(emits, "complete")[0].payload;
    expect(p.tokens.cacheRead).toBe(7);
    expect(p.tokens.cacheCreate).toBe(2);
  });

  it("agent.<name>.started still carries model (regression — unchanged)", async () => {
    const emits = [];
    await runAgent({ ...CONFIG(), model: HAIKU, _testClient: scriptedClient(() => textResp(VALID)), _testCollector: makeCollector(emits) });
    expect(byType(emits, "started")[0].payload.model).toBe(HAIKU);
  });

  it("agent.<name>.failed carries model", async () => {
    const emits = [];
    // invalid_json on every call, no fallbackModel → primary fails (+ one same-model retry).
    await runAgent({ ...CONFIG(), model: HAIKU, _testClient: scriptedClient(() => textResp("NOT JSON")), _testCollector: makeCollector(emits) });
    expect(byType(emits, "failed")[0].payload.model).toBe(HAIKU);
  });

  it("ESCALATED run: the successful complete carries the FALLBACK model, not the primary", async () => {
    const emits = [];
    // [PRIMARY invalid, same-model-retry invalid, FALLBACK valid] — the complete comes from
    // the escalated (fallback) invocation, so it must be tagged SONNET.
    let n = 0;
    const client = { messages: { create: async () => (++n <= 2 ? textResp("NOT JSON") : textResp(VALID)) } };
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: client, _testCollector: makeCollector(emits) });

    const completes = byType(emits, "complete");
    expect(completes.length).toBe(1);
    expect(completes[0].payload.model).toBe(SONNET); // actual model used, not the configured primary
    // and the primary-invocation failures were tagged HAIKU
    expect(byType(emits, "failed").every((e) => e.payload.model === HAIKU)).toBe(true);
  });
});
