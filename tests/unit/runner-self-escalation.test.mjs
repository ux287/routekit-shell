/**
 * Running witness for backlog.feat.planner-self-escalation-signal.
 *
 * Runner-level GENERIC self-escalation: every fallback-enabled agent on its PRIMARY model gets a
 * deterministic escalate instruction appended to its system prompt; an OK result whose LLM emitted
 * `escalate: true` is re-run ONCE on the fallback (stronger) model, emitting an
 * agent.<name>.self_escalation telemetry event; the `escalate` control flag is stripped so it never
 * reaches the caller, telemetry, or (strict) output-schema validation.
 *
 * Drives runAgent via the _testClient + _testCollector seams (no live LLM), mirroring
 * tests/unit/runner-prompt-caching.test.mjs and tests/unit/agent-runner-telemetry-model.test.mjs:
 * counts client invocations, inspects each call's model, and reads the system content sent to
 * messages.create — no brittle full-prompt substring / fixed-window slice assertions.
 *
 * NOTE (test requirements deliberately covered by OTHER witnesses, not duplicated here):
 *  - PLANNER-UNCHANGED REGRESSION: loadAgentConfig('planner') still resolves Sonnet-primary — owned
 *    by tests/unit/agent-model-defaults.test.mjs (this story does NOT touch config.mjs/planner.mjs).
 *  - CACHING-TESTS REGRESSION: runner-prompt-caching / runner-conversation-caching stay green — the
 *    injection appends deterministic TEXT to the single existing system block, adding no new
 *    cache_control breakpoint (also asserted locally by "adds no extra cache_control block" below).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const NAME = "esc-test";
const MARKER = "SELF-ESCALATION"; // stable start of the injected instruction

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });

const VALID = '{"ok":true,"answer":"done"}';
const VALID_ESC = '{"ok":true,"answer":"done","escalate":true}';
const VALID_NOESC = '{"ok":true,"answer":"done","escalate":false}';
const FALLBACK_ANSWER = '{"ok":true,"answer":"stronger"}';

/** Mock client: records { model, system, rawSystem } per call, returns script(n). */
function scriptedClient(calls, script) {
  let n = 0;
  return {
    messages: {
      create: async (args) => {
        const sys = Array.isArray(args.system) ? args.system[args.system.length - 1].text : args.system;
        calls.push({ model: args.model, system: sys, systemBlocks: args.system });
        return script(++n);
      },
    },
  };
}

const makeCollector = (emits) => ({ emit: (type, projectId, payload) => emits.push({ type, projectId, payload }) });
const byType = (emits, event) => emits.filter((e) => e.type === `agent.${NAME}.${event}`);

const CONFIG = (extra = {}) => ({
  name: NAME,
  prompt: "You are a stable system prompt.",
  userMessage: "hi",
  tools: [],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  projectId: "test",
  model: HAIKU,
  ...extra,
});

describe("runAgent — self-escalation signal", () => {
  // ---- INJECTION GATE -----------------------------------------------------
  it("INJECTION GATE positive: fallback-enabled primary run gets the escalate instruction appended", async () => {
    const calls = [];
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: scriptedClient(calls, () => textResp(VALID)) });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].system).toContain(MARKER);
    expect(calls[0].system.startsWith("You are a stable system prompt.")).toBe(true); // appended at a FIXED position (end)
  });

  it("INJECTION GATE negative: no fallbackModel → instruction NOT appended", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: scriptedClient(calls, () => textResp(VALID)) });
    expect(calls[0].system).toBe("You are a stable system prompt.");
    expect(calls[0].system).not.toContain(MARKER);
  });

  it("INJECTION GATE negative: model === fallbackModel → instruction NOT appended", async () => {
    const calls = [];
    await runAgent({ ...CONFIG({ fallbackModel: HAIKU }), _testClient: scriptedClient(calls, () => textResp(VALID)) });
    expect(calls[0].system).toBe("You are a stable system prompt.");
  });

  it("INJECTION GATE negative: the escalated run (_isEscalation) does NOT get the instruction", async () => {
    const calls = [];
    // Directly invoke as an escalated run: fallbackModel set but _isEscalation gates injection off.
    await runAgent({ ...CONFIG({ fallbackModel: SONNET, _isEscalation: true }), _testClient: scriptedClient(calls, () => textResp(VALID)) });
    expect(calls[0].system).toBe("You are a stable system prompt.");
    expect(calls[0].system).not.toContain(MARKER);
  });

  it("BYTE-STABILITY: the injected system text is byte-identical across two runs (cache-safe)", async () => {
    const a = [], b = [];
    await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: scriptedClient(a, () => textResp(VALID)) });
    await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: scriptedClient(b, () => textResp(VALID)) });
    expect(a[0].system).toBe(b[0].system);
    expect(JSON.stringify(a[0].systemBlocks)).toBe(JSON.stringify(b[0].systemBlocks));
  });

  it("CACHING: injection appends TEXT only — still a single system block with one cache_control", async () => {
    const calls = [];
    await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: scriptedClient(calls, () => textResp(VALID)) });
    expect(Array.isArray(calls[0].systemBlocks)).toBe(true);
    expect(calls[0].systemBlocks.length).toBe(1);
    expect(calls[0].systemBlocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // ---- SELF-ESCALATION POSITIVE + TELEMETRY -------------------------------
  it("SELF-ESCALATION positive: escalate:true on an ok result re-runs ONCE on fallbackModel", async () => {
    const calls = [];
    const emits = [];
    // primary emits escalate:true; fallback emits the stronger answer (no escalate).
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp(VALID_ESC) : textResp(FALLBACK_ANSWER)));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client, _testCollector: makeCollector(emits) });
    expect(calls.length).toBe(2); // exactly one re-run
    expect(calls[0].model).toBe(HAIKU);
    expect(calls[1].model).toBe(SONNET); // 2nd call uses the fallback model
    expect(r.ok).toBe(true);
  });

  it("SELF-ESCALATION telemetry: agent.<name>.self_escalation { from, to, reason:'self_signal' }", async () => {
    const calls = [];
    const emits = [];
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp(VALID_ESC) : textResp(FALLBACK_ANSWER)));
    await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client, _testCollector: makeCollector(emits) });
    const ev = byType(emits, "self_escalation");
    expect(ev.length).toBe(1);
    expect(ev[0].payload).toMatchObject({ from: HAIKU, to: SONNET, reason: "self_signal" });
    // Distinct from the FAILURE escalation event — none emitted on the self-signal path.
    expect(byType(emits, "escalation").length).toBe(0);
  });

  // ---- STRIP (both paths) + strict schema ---------------------------------
  it("STRIP (escalated path): escalate absent from the result; strict schema intact", async () => {
    const calls = [];
    const strict = z.object({ ok: z.boolean(), answer: z.string() }).strict();
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp(VALID_ESC) : textResp(FALLBACK_ANSWER)));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET, outputSchema: strict }), _testClient: client });
    expect(r.ok).toBe(true); // strict schema did NOT reject → escalate was deleted before parse
    expect("escalate" in r).toBe(false);
    expect("_selfEscalate" in r).toBe(false); // internal marker stripped before return
    expect(r.answer).toBe("stronger"); // caller sees the fallback run's payload
  });

  it("STRIP (non-escalated path): escalate:false stripped, strict schema intact, single call", async () => {
    const calls = [];
    const strict = z.object({ ok: z.boolean(), answer: z.string() }).strict();
    const client = scriptedClient(calls, () => textResp(VALID_NOESC));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET, outputSchema: strict }), _testClient: client });
    expect(calls.length).toBe(1);
    expect(r.ok).toBe(true);
    expect("escalate" in r).toBe(false);
    expect("_selfEscalate" in r).toBe(false);
  });

  // ---- NO-ESCALATE --------------------------------------------------------
  it("NO-ESCALATE: an ok result without the flag does not escalate (single call)", async () => {
    const calls = [];
    const emits = [];
    const client = scriptedClient(calls, () => textResp(VALID));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client, _testCollector: makeCollector(emits) });
    expect(calls.length).toBe(1);
    expect(r.ok).toBe(true);
    expect(r._escalated).toBeUndefined();
    expect(byType(emits, "self_escalation").length).toBe(0);
  });

  // ---- LOOP GUARD ---------------------------------------------------------
  it("LOOP GUARD: the escalated run re-emitting escalate:true does NOT trigger a 3rd call", async () => {
    const calls = [];
    const emits = [];
    // BOTH primary and fallback emit escalate:true — the fallback run carries _isEscalation so it
    // must not re-escalate.
    const client = scriptedClient(calls, () => textResp(VALID_ESC));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client, _testCollector: makeCollector(emits) });
    expect(calls.length).toBe(2); // primary + one escalation, no 3rd
    expect(byType(emits, "self_escalation").length).toBe(1); // honored at most once
    expect("escalate" in r).toBe(false);
    expect("_selfEscalate" in r).toBe(false);
  });

  // ---- NO FALLBACK --------------------------------------------------------
  it("NO FALLBACK: escalate:true with no fallbackModel does not escalate or throw; flag stripped", async () => {
    const calls = [];
    const emits = [];
    const client = scriptedClient(calls, () => textResp(VALID_ESC));
    const r = await runAgent({ ...CONFIG(), _testClient: client, _testCollector: makeCollector(emits) });
    expect(calls.length).toBe(1);
    expect(r.ok).toBe(true);
    expect("escalate" in r).toBe(false);
    expect("_selfEscalate" in r).toBe(false);
    expect(byType(emits, "self_escalation").length).toBe(0);
  });

  it("NO FALLBACK: escalate:true with model === fallbackModel does not escalate; flag stripped", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => textResp(VALID_ESC));
    const r = await runAgent({ ...CONFIG({ fallbackModel: HAIKU }), _testClient: client });
    expect(calls.length).toBe(1);
    expect(r.ok).toBe(true);
    expect("escalate" in r).toBe(false);
  });

  // ---- FAILURE-ESCALATION REGRESSION --------------------------------------
  it("FAILURE-ESCALATION regression: a failure still escalates (primary, same-model retry, fallback)", async () => {
    const calls = [];
    const emits = [];
    // invalid JSON on primary + same-model retry, valid on the fallback → existing ladder unchanged.
    const client = scriptedClient(calls, (n) => (n <= 2 ? textResp("NOT JSON") : textResp(VALID)));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client, _testCollector: makeCollector(emits) });
    expect(calls.map((c) => c.model)).toEqual([HAIKU, HAIKU, SONNET]);
    expect(r.ok).toBe(true);
    expect(r._escalated).toEqual(expect.objectContaining({ from: HAIKU, to: SONNET }));
    // Failure path did NOT emit the self-signal event.
    expect(byType(emits, "self_escalation").length).toBe(0);
    expect("_selfEscalate" in r).toBe(false);
  });

  // ---- OUTPUT INVARIANCE --------------------------------------------------
  it("OUTPUT INVARIANCE (non-escalated): caller payload = mock output minus the escalate flag", async () => {
    const calls = [];
    const client = scriptedClient(calls, () => textResp(VALID_NOESC));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("done");
    expect("escalate" in r).toBe(false);
  });

  it("OUTPUT INVARIANCE (escalated): caller sees the fallback run's payload, escalate stripped", async () => {
    const calls = [];
    const client = scriptedClient(calls, (n) => (n === 1 ? textResp(VALID_ESC) : textResp(FALLBACK_ANSWER)));
    const r = await runAgent({ ...CONFIG({ fallbackModel: SONNET }), _testClient: client });
    expect(r.answer).toBe("stronger"); // stronger model's answer, not the primary's
    expect("escalate" in r).toBe(false);
  });
});
