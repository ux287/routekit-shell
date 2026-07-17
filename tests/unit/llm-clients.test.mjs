import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_TOKENS,
  loadEnv,
  inferProvider,
  createOpenAiClient,
  createAnthropicClient,
  callAnthropicChat,
  callAnthropicChatWithUsage,
} from "../../packages/mcp-rks/src/llm/clients.mjs";
import { getTelemetryCollector, resetTelemetryCollector } from "../../packages/mcp-rks/src/server/telemetry/collector.mjs";
import { calculateCost } from "../../packages/mcp-rks/src/server/telemetry/cost.mjs";

function makeFetchResponse({ text, usage = null, status = 200 } = {}) {
  return {
    ok: status < 400,
    status,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage }),
    text: async () => "error body",
  };
}

function makeAnthropicClient() {
  return { apiKey: "test-key", baseURL: "https://api.anthropic.com" };
}

describe("llm-clients", () => {
  describe("constants", () => {
    it("DEFAULT_LLM_TIMEOUT_MS is defined", () => {
      expect(typeof DEFAULT_LLM_TIMEOUT_MS).toBe("number");
      expect(DEFAULT_LLM_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it("DEFAULT_LLM_MAX_TOKENS is defined", () => {
      expect(typeof DEFAULT_LLM_MAX_TOKENS).toBe("number");
      expect(DEFAULT_LLM_MAX_TOKENS).toBeGreaterThan(0);
    });
  });

  describe("loadEnv", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original environment
      process.env = { ...originalEnv };
    });

    it("returns null provider when no keys are set", () => {
      delete process.env.ROUTEKIT_LLM_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const env = loadEnv();
      expect(env.provider).toBeNull();
    });

    it("infers anthropic provider from ANTHROPIC_API_KEY", () => {
      delete process.env.ROUTEKIT_LLM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key";

      const env = loadEnv();
      expect(env.provider).toBe("anthropic");
      expect(env.anthropicKey).toBe("test-key");
    });

    it("infers openai provider from OPENAI_API_KEY", () => {
      delete process.env.ROUTEKIT_LLM_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = "test-key";

      const env = loadEnv();
      expect(env.provider).toBe("openai");
      expect(env.openaiKey).toBe("test-key");
    });

    it("uses explicit provider over inferred", () => {
      process.env.ROUTEKIT_LLM_PROVIDER = "openai";
      process.env.ANTHROPIC_API_KEY = "anthropic-key";
      process.env.OPENAI_API_KEY = "openai-key";

      const env = loadEnv();
      expect(env.provider).toBe("openai");
    });

    it("reads model from ROUTEKIT_LLM_MODEL", () => {
      process.env.ROUTEKIT_LLM_MODEL = "gpt-4";

      const env = loadEnv();
      expect(env.model).toBe("gpt-4");
    });
  });

  // backlog.chore.credential-preflight-and-source-provenance-logging — loadEnv() now delegates its
  // provider inference to the shared, pure inferProvider(env) export (single source of truth reused
  // by the startup credential preflight). loadEnv's behavior is unchanged (the cases above stay
  // green); these pin inferProvider directly on an INJECTED env with no process.env reliance.
  describe("inferProvider", () => {
    it("uses explicit ROUTEKIT_LLM_PROVIDER over inferred", () => {
      expect(inferProvider({ ROUTEKIT_LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: "k" })).toBe("openai");
    });

    it("infers anthropic from ANTHROPIC_API_KEY (checked before openai)", () => {
      expect(inferProvider({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k2" })).toBe("anthropic");
    });

    it("infers openai from OPENAI_API_KEY when anthropic absent", () => {
      expect(inferProvider({ OPENAI_API_KEY: "k" })).toBe("openai");
    });

    it("returns null when neither key nor explicit provider is present", () => {
      expect(inferProvider({})).toBeNull();
    });

    it("is pure — reads only its argument and does not mutate process.env", () => {
      const before = { ...process.env };
      inferProvider({ ANTHROPIC_API_KEY: "injected-only" });
      expect(process.env).toEqual(before);
    });
  });

  describe("createOpenAiClient", () => {
    it("returns null for non-openai provider", () => {
      const env = { provider: "anthropic", openaiKey: "key" };
      expect(createOpenAiClient(env)).toBeNull();
    });

    it("returns null when openaiKey is missing", () => {
      const env = { provider: "openai", openaiKey: null };
      expect(createOpenAiClient(env)).toBeNull();
    });

    it("returns client config for openai provider", () => {
      const env = { provider: "openai", openaiKey: "test-key" };
      const client = createOpenAiClient(env);

      expect(client).not.toBeNull();
      expect(client.apiKey).toBe("test-key");
      expect(client.baseURL).toContain("openai.com");
    });
  });

  describe("createAnthropicClient", () => {
    it("returns null for non-anthropic provider", () => {
      const env = { provider: "openai", anthropicKey: "key" };
      expect(createAnthropicClient(env)).toBeNull();
    });

    it("returns null when anthropicKey is missing", () => {
      const env = { provider: "anthropic", anthropicKey: null };
      expect(createAnthropicClient(env)).toBeNull();
    });

    it("returns client config for anthropic provider", () => {
      const env = { provider: "anthropic", anthropicKey: "test-key" };
      const client = createAnthropicClient(env);

      expect(client).not.toBeNull();
      expect(client.apiKey).toBe("test-key");
      expect(client.baseURL).toContain("anthropic.com");
    });
  });
});

describe("callAnthropicChatWithUsage — shared helper returning { content, usage }", () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("returns { content, usage } shape when response includes usage", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse({
      text: "plan output",
      usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 },
    }));

    const result = await callAnthropicChatWithUsage({
      client: makeAnthropicClient(),
      model: "claude-sonnet-4-6",
      prompt: "Generate a plan",
    });

    expect(result).toHaveProperty("content", "plan output");
    expect(result.usage.input_tokens).toBe(150);
    expect(result.usage.output_tokens).toBe(75);
    expect(result.usage.cache_read_input_tokens).toBe(30);
    expect(result.usage.cache_creation_input_tokens).toBe(10);
  });

  it("returns usage: null when HTTP response omits usage field", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse({ text: "output" }));

    const result = await callAnthropicChatWithUsage({
      client: makeAnthropicClient(),
      model: "claude-sonnet-4-6",
      prompt: "prompt",
    });

    expect(result.content).toBe("output");
    expect(result.usage).toBeNull();
  });

  it("trims whitespace from content", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse({ text: "  trimmed  " }));

    const result = await callAnthropicChatWithUsage({
      client: makeAnthropicClient(), model: "m", prompt: "p",
    });

    expect(result.content).toBe("trimmed");
  });

  it("throws on non-ok HTTP response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limit" });

    await expect(
      callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" })
    ).rejects.toThrow("Anthropic error: 429");
  });

  it("is exported as a named function (single source of truth)", () => {
    expect(typeof callAnthropicChatWithUsage).toBe("function");
  });
});

describe("callAnthropicChat backward compat — still returns string", () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("returns a string, not an object", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse({
      text: "string result",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));

    const result = await callAnthropicChat({
      client: makeAnthropicClient(),
      model: "claude-sonnet-4-6",
      prompt: "prompt",
    });

    expect(typeof result).toBe("string");
    expect(result).toBe("string result");
  });
});

describe("_callAnthropicChatCore — llm.token_usage telemetry emit", () => {
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

  function mockFetch(usage, text = "ok") {
    global.fetch = vi.fn().mockResolvedValue(makeFetchResponse({ text, usage }));
  }

  it("emits llm.token_usage event when usage is present", async () => {
    mockFetch({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 });
    await callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" });
    const call = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage");
    expect(call).toBeDefined();
  });

  // backlog.feat.llm-prompt-caching — the stable system prefix is sent as a cache_control
  // block array so repeat calls hit the cache (~90% input savings). Billing-only.
  it("sends `system` as a cache_control:ephemeral block array (prompt caching)", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 });
    await callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(Array.isArray(body.system)).toBe(true);
    const lastBlock = body.system[body.system.length - 1];
    expect(lastBlock.type).toBe("text");
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
    // The user message history is not cache-controlled.
    expect(body.messages[0].cache_control).toBeUndefined();
  });

  it("emitted payload contains clientName and the canonical NESTED tokens shape", async () => {
    mockFetch({ input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 });
    await callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" });
    const payload = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage")[2];
    expect(payload.clientName).toBe("anthropic-http");
    // Canonical nested shape that both readers (cost-report.mjs, dashboard token-costs)
    // gate on via `payload.tokens != null` — NOT the old flat inputTokens/outputTokens.
    expect(payload.tokens).toBeDefined();
    expect(payload.tokens.in).toBe(200);
    expect(payload.tokens.out).toBe(80);
    expect(payload.tokens.cacheRead).toBe(30);
    expect(payload.tokens.cacheCreate).toBe(10);
    // The old flat fields must be gone — one canonical shape, not two.
    expect(payload.inputTokens).toBeUndefined();
    expect(payload.outputTokens).toBeUndefined();
    // backlog.fix.llm-token-usage-emit-model: the resolved model id is now tagged.
    expect(payload.model).toBe("m");
  });

  // backlog.fix.llm-token-usage-emit-model — the tagged model must be the SAME id shape
  // cost.mjs MODEL_PRICING keys on, so calculateCost(payload.model, …) resolves the real rate
  // (not the sonnet default). Isolated shape cross-check — NOT a live-report assertion (the
  // live reader cost-report.mjs does not yet price by model; that's a separate follow-up).
  it("tags the resolved model id so it resolves its MODEL_PRICING rate, not the sonnet default", async () => {
    mockFetch({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    await callAnthropicChatWithUsage({
      client: makeAnthropicClient(), model: "claude-haiku-4-5-20251001", prompt: "p",
    });
    const payload = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage")[2];
    expect(payload.model).toBe("claude-haiku-4-5-20251001");
    const cost = calculateCost(payload.model, payload.tokens.in, payload.tokens.out);
    expect(cost.totalCost).toBe(6.0); // Haiku 4.5 $1/$5 — NOT the $18 sonnet default
  });

  it("emits sessionId in payload when context.sessionId is provided", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 });
    await callAnthropicChatWithUsage({
      client: makeAnthropicClient(), model: "m", prompt: "p",
      context: { sessionId: "sess-xyz" },
    });
    const payload = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage")[2];
    expect(payload.sessionId).toBe("sess-xyz");
  });

  it("emits problemId in payload when context.problemId is provided", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 });
    await callAnthropicChatWithUsage({
      client: makeAnthropicClient(), model: "m", prompt: "p",
      context: { problemId: "backlog.feat.story-x" },
    });
    const payload = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage")[2];
    expect(payload.problemId).toBe("backlog.feat.story-x");
  });

  it("does NOT emit when data.usage is null", async () => {
    mockFetch(null);
    await callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" });
    const call = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage");
    expect(call).toBeUndefined();
  });

  it("does NOT include sessionId when context is omitted", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 });
    await callAnthropicChatWithUsage({ client: makeAnthropicClient(), model: "m", prompt: "p" });
    const payload = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage")[2];
    expect(payload.sessionId).toBeUndefined();
  });

  it("callAnthropicChat still returns string after context param added", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 }, "plan output");
    const result = await callAnthropicChat({
      client: makeAnthropicClient(), model: "m", prompt: "p",
      context: { sessionId: "s", problemId: "b" },
    });
    expect(typeof result).toBe("string");
    expect(result).toBe("plan output");
  });

  it("callAnthropicChatWithUsage still returns { content, usage } after context param added", async () => {
    mockFetch({ input_tokens: 10, output_tokens: 5 });
    const result = await callAnthropicChatWithUsage({
      client: makeAnthropicClient(), model: "m", prompt: "p",
      context: { sessionId: "s" },
    });
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("usage");
  });
});
