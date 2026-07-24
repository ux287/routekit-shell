/**
 * CI-tier witness for backlog.fix.conversation-prefix-caching.
 *
 * Conversation-prefix caching: _executeAgent marks the last content block of the most-recently-
 * appended turn with cache_control:{type:'ephemeral'} each round, sliding a window of at most the
 * 2 most-recent conversation breakpoints so the total (system + last-tool + conversation) never
 * exceeds Anthropic's hard limit of 4. The initial string user message is converted to block form
 * IDEMPOTENTLY (no double-wrap on the _resumeMessages escalation path).
 *
 * Drives runAgent via the _testClient seam and inspects the captured messages.create requests.
 * Lives in tests/unit because CI sweeps the tests/unit tree and tests root only, NOT the
 * per-package __tests__ node:test dirs.
 *
 * NOTE: the production loop mutates ONE messages array in place across turns, so each captured
 * request is deep-cloned at call time — a live reference would reflect only the final state.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";
const VALID = '{"ok":true,"answer":"done"}';
const USER_MSG = "the original user question";

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: USAGE });
const toolResp = (id = "tu") => ({ content: [{ type: "tool_use", id, name: "probe", input: { x: 1 } }], stop_reason: "tool_use", usage: USAGE });

// Deep-clone the request at capture time (in-place mutation across turns would otherwise clobber
// earlier snapshots). Request payload is plain JSON-serializable data.
const snap = (args) => JSON.parse(JSON.stringify(args));

// script(n) → response for the n-th (1-based) create call. Captures per-turn request snapshots.
const scriptedClient = (script, calls) => {
  let n = 0;
  return { messages: { create: async (args) => { calls.push(snap(args)); return script(++n); } } };
};

const CONFIG = (over = {}) => ({
  name: "conv-cache",
  prompt: "You are a stable system prompt for conversation-cache testing.",
  userMessage: USER_MSG,
  tools: [{ name: "probe", description: "P", inputSchema: z.object({ x: z.number() }), execute: async () => ({ ok: true }) }],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  model: HAIKU,
  maxTurns: 10,
  projectId: "test",
  ...over,
});

const convBreakpoints = (req) =>
  (req.messages || []).reduce((acc, m) =>
    acc + (Array.isArray(m.content) ? m.content.filter((b) => b && typeof b === "object" && b.cache_control).length : 0), 0);

const totalBreakpoints = (req) => {
  const sys = Array.isArray(req.system) ? req.system.filter((b) => b && b.cache_control).length : 0;
  const tools = Array.isArray(req.tools) ? req.tools.filter((t) => t && t.cache_control).length : 0;
  return sys + tools + convBreakpoints(req);
};

const lastMsg = (req) => req.messages[req.messages.length - 1];
const lastBlock = (msg) => (Array.isArray(msg.content) ? msg.content[msg.content.length - 1] : undefined);

describe("conversation-prefix caching (runner.mjs _executeAgent)", () => {
  it("POSITIVE (multi-turn): turn-2 request marks the last block of the last message", async () => {
    const calls = [];
    const r = await runAgent({ ...CONFIG(), _testClient: scriptedClient((n) => (n === 1 ? toolResp() : textResp(VALID)), calls) });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(2);
    const lb = lastBlock(lastMsg(calls[1]));
    expect(lb).toBeDefined();
    expect(lb.cache_control).toEqual({ type: "ephemeral" });
  });

  it("BREAKPOINT CAP: no request ever exceeds 4 cache_control breakpoints", async () => {
    const calls = [];
    // 4 tool-use turns, then end_turn on the 5th.
    await runAgent({ ...CONFIG(), _testClient: scriptedClient((n) => (n <= 4 ? toolResp("tu" + n) : textResp(VALID)), calls) });
    expect(calls.length).toBe(5);
    for (const req of calls) expect(totalBreakpoints(req)).toBeLessThanOrEqual(4);
  });

  it("SLIDING WINDOW: after 3+ turns, conversation breakpoints in the latest request <= 2", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: scriptedClient((n) => (n <= 4 ? toolResp("tu" + n) : textResp(VALID)), calls) });
    const latest = calls[calls.length - 1];
    expect(convBreakpoints(latest)).toBeLessThanOrEqual(2);
    // ...and the window is genuinely used on a deep transcript (>= 1 conversation marker).
    expect(convBreakpoints(latest)).toBeGreaterThanOrEqual(1);
  });

  it("STRING->BLOCK: the initial user message is converted to block form with verbatim text", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: scriptedClient(() => textResp(VALID), calls) });
    const first = calls[0].messages[0];
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content.length).toBe(1);
    expect(first.content[0].type).toBe("text");
    expect(first.content[0].text).toBe(USER_MSG);
  });

  it("REGRESSION (static prefix retained): system block + last tool still carry cache_control on every request", async () => {
    const calls = [];
    await runAgent({ ...CONFIG(), _testClient: scriptedClient((n) => (n === 1 ? toolResp() : textResp(VALID)), calls) });
    for (const req of calls) {
      expect(req.system[req.system.length - 1].cache_control).toEqual({ type: "ephemeral" });
      expect(req.tools[req.tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("NON-REGRESSION (single-turn): end_turn on the first response returns ok with unchanged output", async () => {
    const calls = [];
    const r = await runAgent({ ...CONFIG(), _testClient: scriptedClient(() => textResp(VALID), calls) });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("done");
    expect(calls.length).toBe(1);
    // Did not throw on the string->block conversion of the one-message conversation.
    expect(Array.isArray(calls[0].messages[0].content)).toBe(true);
  });

  it("ESCALATION + RESUME: resumed messages[0] is a single {type:'text'} block (not double-wrapped), text verbatim", async () => {
    const calls = [];
    let escModel = null;
    const client = {
      messages: {
        create: async (args) => {
          calls.push(snap(args));
          if (calls.length === 1) return toolResp(); // primary (HAIKU) exhausts maxTurns=1
          escModel = args.model;
          return textResp(VALID); // fallback (SONNET) resumes
        },
      },
    };
    const r = await runAgent({ ...CONFIG({ maxTurns: 1, fallbackModel: SONNET }), _testClient: client });
    expect(r.ok).toBe(true);
    expect(r._escalated?.to).toBe(SONNET);
    expect(escModel).toBe(SONNET);
    expect(calls.length).toBe(2);
    // The resumed request's initial message must NOT be double-wrapped.
    const first = calls[1].messages[0];
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content.length).toBe(1);
    expect(first.content[0].type).toBe("text");
    // text is a plain string (verbatim) — double-wrapping would make it an array/object.
    expect(typeof first.content[0].text).toBe("string");
    expect(first.content[0].text).toBe(USER_MSG);
  });

  it("OUTPUT INVARIANCE: parsed result matches the scripted mock output across turns (billing-only change)", async () => {
    const calls = [];
    const r = await runAgent({ ...CONFIG(), _testClient: scriptedClient((n) => (n === 1 ? toolResp() : textResp(VALID)), calls) });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe("done");
  });
});
