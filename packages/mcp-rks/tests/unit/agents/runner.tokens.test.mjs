/**
 * Tests for token capture in SDK agent runner (backlog.feat.token-capture-sdk-runner)
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "../../../src/agents/runner.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUsage({ input = 100, output = 50, cacheRead = 0, cacheCreate = 0 } = {}) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function makeTextResponse(text, usage = null) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }], usage };
}

function makeToolCallResponse(usage = null) {
  return {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "unknown_tool", input: {} }],
    usage,
  };
}

function makeTestClient(responses) {
  let call = 0;
  return {
    messages: { create: vi.fn(async () => responses[Math.min(call++, responses.length - 1)]) },
  };
}

async function runCaptured(clientResponses, extraConfig = {}) {
  const events = [];
  const result = await runAgent({
    name: "test",
    projectId: "test-project",
    userMessage: "hello",
    prompt: "You are a test agent.",
    tools: [],
    inputSchema: z.object({}),
    rawInput: {},
    _testClient: makeTestClient(clientResponses),
    _testCollector: {
      emit: (event, _pid, data) => events.push({ event, data }),
      flush: async () => {},
    },
    ...extraConfig,
  });
  return { result, events };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent.complete event token fields", () => {
  it("emits tokens.in and tokens.out equal to SDK usage input_tokens / output_tokens", async () => {
    const { events } = await runCaptured([
      makeTextResponse("hello", makeUsage({ input: 150, output: 75 })),
    ]);
    const complete = events.find(e => e.event === "agent.test.complete");
    expect(complete).toBeDefined();
    expect(complete.data.tokens.in).toBe(150);
    expect(complete.data.tokens.out).toBe(75);
  });

  it("emits tokens.cacheRead equal to cache_read_input_tokens", async () => {
    const { events } = await runCaptured([
      makeTextResponse("hello", makeUsage({ input: 100, output: 50, cacheRead: 80 })),
    ]);
    const complete = events.find(e => e.event === "agent.test.complete");
    expect(complete.data.tokens.cacheRead).toBe(80);
  });

  it("emits tokens.cacheCreate equal to cache_creation_input_tokens", async () => {
    const { events } = await runCaptured([
      makeTextResponse("hello", makeUsage({ input: 100, output: 50, cacheCreate: 40 })),
    ]);
    const complete = events.find(e => e.event === "agent.test.complete");
    expect(complete.data.tokens.cacheCreate).toBe(40);
  });

  it("defaults all token fields to 0 when SDK response omits usage", async () => {
    const { events } = await runCaptured([makeTextResponse("hello", null)]);
    const complete = events.find(e => e.event === "agent.test.complete");
    expect(complete.data.tokens).toEqual({ in: 0, out: 0, cacheRead: 0, cacheCreate: 0 });
  });

  it("retains existing non-token fields (turns, durationMs, outputSummary)", async () => {
    const { events } = await runCaptured([
      makeTextResponse("hello", makeUsage()),
    ]);
    const complete = events.find(e => e.event === "agent.test.complete");
    expect(complete.data).toHaveProperty("turns");
    expect(complete.data).toHaveProperty("durationMs");
    expect(complete.data).toHaveProperty("outputSummary");
  });
});

describe("agent.failed event token fields", () => {
  it("emits tokens on agent.failed when max_turns_exceeded, reflecting accumulated usage", async () => {
    const { events } = await runCaptured(
      [makeToolCallResponse(makeUsage({ input: 50, output: 10 }))],
      { maxTurns: 1 }
    );
    const failed = events.find(e => e.event === "agent.test.failed");
    expect(failed).toBeDefined();
    expect(failed.data.error).toBe("max_turns_exceeded");
    expect(failed.data.tokens.in).toBe(50);
    expect(failed.data.tokens.out).toBe(10);
  });

  it("defaults tokens to 0 on max_turns_exceeded when response has no usage", async () => {
    const { events } = await runCaptured(
      [makeToolCallResponse(null)],
      { maxTurns: 1 }
    );
    const failed = events.find(e => e.event === "agent.test.failed");
    expect(failed.data.tokens).toEqual({ in: 0, out: 0, cacheRead: 0, cacheCreate: 0 });
  });
});

describe("agent.started event shape", () => {
  it("agent.started does NOT include a tokens field", async () => {
    const { events } = await runCaptured([makeTextResponse("hello", makeUsage())]);
    const started = events.find(e => e.event === "agent.test.started");
    expect(started).toBeDefined();
    expect(started.data.tokens).toBeUndefined();
  });
});
