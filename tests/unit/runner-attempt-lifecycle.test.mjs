/**
 * backlog.feat.runner-attempt-lifecycle - runAgent calls config.attemptState.beginAttempt(ctx)
 * exactly once before every attempt it makes. Drives runAgent through the _testClient seam
 * (mirrors tests/unit/agent-runner-escalation.test.mjs) and the _backendDispatcher seam
 * (mirrors tests/unit/agents/runner-backend-selection.test.mjs). No LLM, no subprocess.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "../../packages/mcp-rks/src/agents/runner.mjs";
import { clearConfigCache } from "../../packages/mcp-rks/src/agents/config.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-20250514";
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textResp = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
const toolResp = () => ({ content: [{ type: "tool_use", id: "t1", name: "tool_a", input: { x: 1 } }], stop_reason: "tool_use", usage });
const VALID = '{"ok":true,"answer":"done"}';
const VALID_ESC = '{"ok":true,"answer":"done","escalate":true}';

const CONFIG = () => ({
  name: "attempt-test",
  prompt: "system",
  userMessage: "hi",
  tools: [{ name: "tool_a", description: "A", inputSchema: z.object({ x: z.number() }), execute: async () => ({ r: 1 }) }],
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), answer: z.string() }),
  rawInput: { q: "hi" },
  projectId: "test",
});

function scriptedClient(log, script) {
  let n = 0;
  return { messages: { create: async (args) => {
    log.push({ type: "call", model: args.model, messageCount: args.messages.length });
    return script(++n);
  } } };
}

function recordingState(log) {
  const ctxs = [];
  return { ctxs, beginAttempt: (ctx) => { ctxs.push({ ...ctx }); log.push({ type: "begin", kind: ctx.kind }); } };
}

const calls = (log) => log.filter((e) => e.type === "call");

const roots = [];
afterEach(() => clearConfigCache());
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe("runAgent - attempt lifecycle", () => {
  it("primary success: one beginAttempt with index 0, kind primary, the primary model, resumed false", async () => {
    const log = [];
    const st = recordingState(log);
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, attemptState: st, _testClient: scriptedClient(log, () => textResp(VALID)) });
    expect(r.ok).toBe(true);
    expect(st.ctxs).toEqual([{ index: 0, kind: "primary", model: HAIKU, resumed: false }]);
  });

  it("invalid_json twice: primary, same_model_retry, escalation with indices 0, 1, 2", async () => {
    const log = [];
    const st = recordingState(log);
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, attemptState: st, _testClient: scriptedClient(log, (n) => (n <= 2 ? textResp("NOT JSON") : textResp(VALID))) });
    expect(st.ctxs).toEqual([
      { index: 0, kind: "primary", model: HAIKU, resumed: false },
      { index: 1, kind: "same_model_retry", model: HAIKU, resumed: false },
      { index: 2, kind: "escalation", model: SONNET, resumed: false },
    ]);
  });

  it("beginAttempt runs BEFORE each attempt's first LLM call", async () => {
    const log = [];
    const st = recordingState(log);
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, attemptState: st, _testClient: scriptedClient(log, (n) => (n <= 2 ? textResp("NOT JSON") : textResp(VALID))) });
    expect(log.map((e) => (e.type === "begin" ? `begin:${e.kind}` : `call:${e.model}`))).toEqual([
      "begin:primary", `call:${HAIKU}`,
      "begin:same_model_retry", `call:${HAIKU}`,
      "begin:escalation", `call:${SONNET}`,
    ]);
  });

  it("max_turns escalation is resumed: resumed true, and the fallback run starts from the carried transcript", async () => {
    const log = [];
    const st = recordingState(log);
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, maxTurns: 1, attemptState: st, _testClient: scriptedClient(log, () => toolResp()) });
    expect(st.ctxs).toEqual([
      { index: 0, kind: "primary", model: HAIKU, resumed: false },
      { index: 1, kind: "escalation", model: SONNET, resumed: true },
    ]);
    const firstSonnet = calls(log).find((c) => c.model === SONNET);
    expect(firstSonnet.messageCount).toBeGreaterThan(1);
  });

  it("timeout escalation is a restart: kind escalation, index 1, resumed false", async () => {
    const log = [];
    const st = recordingState(log);
    let n = 0;
    const client = { messages: { create: async (args) => {
      log.push({ type: "call", model: args.model, messageCount: args.messages.length });
      if (++n === 1) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      return textResp(VALID);
    } } };
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, attemptState: st, _testClient: client });
    expect(st.ctxs).toEqual([
      { index: 0, kind: "primary", model: HAIKU, resumed: false },
      { index: 1, kind: "escalation", model: SONNET, resumed: false },
    ]);
  });

  it("self-escalation: primary, then self_escalation on the fallback model, resumed false", async () => {
    const log = [];
    const st = recordingState(log);
    await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, attemptState: st, _testClient: scriptedClient(log, (n) => (n === 1 ? textResp(VALID_ESC) : textResp(VALID))) });
    expect(st.ctxs).toEqual([
      { index: 0, kind: "primary", model: HAIKU, resumed: false },
      { index: 1, kind: "self_escalation", model: SONNET, resumed: false },
    ]);
  });

  it("a config without attemptState runs the same attempt sequence and does not throw", async () => {
    const log = [];
    const r = await runAgent({ ...CONFIG(), model: HAIKU, fallbackModel: SONNET, _testClient: scriptedClient(log, (n) => (n <= 2 ? textResp("NOT JSON") : textResp(VALID))) });
    expect(r.ok).toBe(true);
    expect(calls(log).map((c) => c.model)).toEqual([HAIKU, HAIKU, SONNET]);
  });

  it("the backend API fallback inside one attempt does not begin a new attempt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-attempt-lifecycle-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "agents.yaml"), ["agents:", "  attempt-test:", `    model: ${HAIKU}`, "    backend: claude-cli", ""].join("\n"), "utf8");
    const log = [];
    const st = recordingState(log);
    const client = scriptedClient(log, () => textResp(VALID));
    const dispatcher = {
      execute: (config, opts) => opts.executeApi({ ...config, _backendFallback: { from: "claude-cli", reason: "test" }, _testClient: client }),
    };
    const r = await runAgent({ ...CONFIG(), projectRoot: root, model: HAIKU, attemptState: st, _backendDispatcher: dispatcher });
    expect(r.ok).toBe(true);
    expect(calls(log)).toHaveLength(1);
    expect(st.ctxs).toEqual([{ index: 0, kind: "primary", model: HAIKU, resumed: false }]);
  });
});
