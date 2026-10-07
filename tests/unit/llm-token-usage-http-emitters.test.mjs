/**
 * Witness for backlog.fix.llm-token-usage-complete-coverage: the HTTP transports in
 * packages/mcp-rks/src/llm/clients.mjs record every billed response exactly once, with
 * attribution, including responses that then fail validation and responses whose caller
 * stopped awaiting them (a planner call that lost callOnce's withTimeout race).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  callOpenAiChat,
  callAnthropicChatWithUsage,
  awaitOutstandingLlmRequests,
} from "../../packages/mcp-rks/src/llm/clients.mjs";
import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry/collector";

const OPENAI_CLIENT = { apiKey: "test-key", baseURL: "https://api.openai.test/v1" };
const ANTHROPIC_CLIENT = { apiKey: "test-key", baseURL: "https://api.anthropic.test" };
const OK_ANTHROPIC = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
};

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
const tokenEvents = (spy) => spy.mock.calls.filter((c) => c[0] === "llm.token_usage");

let originalFetch;
let emitSpy;
beforeEach(() => {
  originalFetch = global.fetch;
  resetTelemetryCollector();
  emitSpy = vi.spyOn(getTelemetryCollector(), "emit");
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  resetTelemetryCollector();
});

describe("callOpenAiChat emits llm.token_usage", () => {
  it("emits one event with openai-http, model, nested tokens and context attribution", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 } },
    }));
    const out = await callOpenAiChat({
      client: OPENAI_CLIENT, model: "gpt-test", prompt: "p",
      context: { projectId: "proj-a", problemId: "backlog.fix.x", caller: "planner" },
    });
    expect(out).toBe("ok");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    const [, projectId, payload] = events[0];
    expect(projectId).toBe("proj-a");
    expect(payload.clientName).toBe("openai-http");
    expect(payload.model).toBe("gpt-test");
    expect(payload.tokens).toEqual({ in: 120, out: 30, cacheRead: 40, cacheCreate: 0 });
    expect(payload.problemId).toBe("backlog.fix.x");
    expect(payload.caller).toBe("planner");
  });

  it("without context still returns content and emits with a null projectId", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: "plain" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
    expect(await callOpenAiChat({ client: OPENAI_CLIENT, model: "gpt-test", prompt: "p" })).toBe("plain");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBeNull();
    expect(events[0][2].tokens).toEqual({ in: 5, out: 2, cacheRead: 0, cacheCreate: 0 });
    expect("problemId" in events[0][2]).toBe(false);
  });

  it("emits once, then still rejects, on finish_reason length with no usable content", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 900, completion_tokens: 16000, prompt_tokens_details: { cached_tokens: 12 } },
    }));
    await expect(
      callOpenAiChat({ client: OPENAI_CLIENT, model: "gpt-test", prompt: "p", context: { caller: "planner" } }),
    ).rejects.toThrow("LLM output truncated (finish_reason=length)");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][2].tokens).toEqual({ in: 900, out: 16000, cacheRead: 12, cacheCreate: 0 });
    expect(events[0][2].caller).toBe("planner");
  });

  it("emits once, then still rejects, on an empty choices array that carries usage", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 0 } }));
    await expect(
      callOpenAiChat({ client: OPENAI_CLIENT, model: "gpt-test", prompt: "p" }),
    ).rejects.toThrow("OpenAI chat payload had no choices");
    expect(tokenEvents(emitSpy)).toHaveLength(1);
  });
});

describe("_callAnthropicChatCore records a billed response before validating it", () => {
  it("emits once, then still rejects, on an empty content array", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ content: [], usage: { input_tokens: 10, output_tokens: 0 } }));
    await expect(
      callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" }),
    ).rejects.toThrow("Anthropic response had no content");
    expect(tokenEvents(emitSpy)).toHaveLength(1);
  });

  it("emits once, then still rejects, on stop_reason max_tokens with no usable text", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      content: [{ type: "text", text: "" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 500, output_tokens: 8192, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
    }));
    await expect(
      callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" }),
    ).rejects.toThrow("LLM output truncated (stop_reason=max_tokens)");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][2].tokens).toEqual({ in: 500, out: 8192, cacheRead: 7, cacheCreate: 3 });
  });

  it("a successful response still emits exactly once and copies context.caller", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(OK_ANTHROPIC));
    await callAnthropicChatWithUsage({
      client: ANTHROPIC_CLIENT, model: "m", prompt: "p",
      context: { projectId: "proj-b", caller: "reviewer" },
    });
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe("proj-b");
    expect(events[0][2].caller).toBe("reviewer");
    expect(events[0][2].clientName).toBe("anthropic-http");
  });

  it("a response without usage still emits nothing", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    await callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" });
    expect(tokenEvents(emitSpy)).toHaveLength(0);
  });
});

describe("telemetry failure never breaks the model call", () => {
  it("both transports still return their result when emit throws", async () => {
    emitSpy.mockImplementation((type) => {
      if (type === "llm.token_usage") throw new Error("collector down");
    });
    global.fetch = vi.fn().mockResolvedValue(jsonResponse(OK_ANTHROPIC));
    const anthropic = await callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" });
    expect(anthropic.content).toBe("ok");
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { content: "fine" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    expect(await callOpenAiChat({ client: OPENAI_CLIENT, model: "gpt-test", prompt: "p" })).toBe("fine");
  });
});

describe("awaitOutstandingLlmRequests", () => {
  it("awaits a request whose caller stopped awaiting it and records its usage exactly once", async () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(OK_ANTHROPIC)), 20)),
    );
    // The caller moves on without awaiting, as callOnce does after its withTimeout race rejects.
    const abandoned = callAnthropicChatWithUsage({
      client: ANTHROPIC_CLIENT, model: "m", prompt: "p",
      context: { projectId: "proj-c", problemId: "backlog.fix.y", caller: "planner" },
    });
    abandoned.catch(() => {});
    expect(tokenEvents(emitSpy)).toHaveLength(0);
    const res = await awaitOutstandingLlmRequests({ timeoutMs: 2000 });
    expect(res).toEqual({ drained: 1, abandoned: 0 });
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][2].problemId).toBe("backlog.fix.y");
  });

  it("is bounded: resolves without rejecting, reporting the request that outlived the bound", async () => {
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(OK_ANTHROPIC)), 400)),
    );
    const slow = callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" });
    slow.catch(() => {});
    const started = Date.now();
    const res = await awaitOutstandingLlmRequests({ timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(res).toEqual({ drained: 0, abandoned: 1 });
    await slow; // settle it so it cannot leak into later tests
    // Settled entries leave the registry: nothing is outstanding now.
    expect(await awaitOutstandingLlmRequests({ timeoutMs: 50 })).toEqual({ drained: 0, abandoned: 0 });
  });

  it("removes a request that settles by rejecting", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => "boom" });
    await expect(callAnthropicChatWithUsage({ client: ANTHROPIC_CLIENT, model: "m", prompt: "p" })).rejects.toThrow("Anthropic error: 500");
    await expect(callOpenAiChat({ client: OPENAI_CLIENT, model: "gpt-test", prompt: "p" })).rejects.toThrow("OpenAI error: 500");
    expect(await awaitOutstandingLlmRequests({ timeoutMs: 50 })).toEqual({ drained: 0, abandoned: 0 });
  });

  it("resolves immediately when nothing is outstanding", async () => {
    const started = Date.now();
    expect(await awaitOutstandingLlmRequests({ timeoutMs: 5000 })).toEqual({ drained: 0, abandoned: 0 });
    expect(Date.now() - started).toBeLessThan(100);
  });
});
