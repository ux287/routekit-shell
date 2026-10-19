/**
 * Witness for backlog.feat.llm-backend-interface-anthropic: the LLMBackend seam
 * (packages/mcp-rks/src/llm/backend.mjs) and request-body parity for its first two consumers
 * (server/qa-agent.mjs, agents/visual.mjs). Deterministic: the Anthropic SDK, the clients.mjs
 * transports and fs/promises readFile are mocked. No network, no LLM, no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  createMock: vi.fn(),
  ctorMock: vi.fn(),
  chat: vi.fn(),
  chatWithUsage: vi.fn(),
  openAiChat: vi.fn(),
  loadEnv: vi.fn(),
  anthropicClientFor: vi.fn(),
  openAiClientFor: vi.fn(),
  anthropicHttpClient: { apiKey: "test-anthropic-key", baseURL: "https://anthropic.invalid" },
  openAiHttpClient: { apiKey: "test-openai-key", baseURL: "https://openai.invalid" },
}));

// Plain wrapper functions delegating to hoisted vi.fn stubs, NOT vi.fn().mockImplementation(...):
// vi.restoreAllMocks() in afterEach would drop such an implementation (see
// tests/unit/llm-token-usage-sdk-emitters.test.mjs).
vi.mock("@anthropic-ai/sdk", () => ({
  default: function Anthropic(...args) {
    h.ctorMock(...args);
    return { messages: { create: (...a) => h.createMock(...a) } };
  },
}));
vi.mock("../../packages/mcp-rks/src/llm/clients.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropicChat: (...a) => h.chat(...a),
    callAnthropicChatWithUsage: (...a) => h.chatWithUsage(...a),
    callOpenAiChat: (...a) => h.openAiChat(...a),
    loadEnv: (...a) => h.loadEnv(...a),
    createAnthropicClient: (...a) => h.anthropicClientFor(...a),
    createOpenAiClient: (...a) => h.openAiClientFor(...a),
  };
});
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: async () => Buffer.from("fake-png") };
});

import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry/collector";
import {
  createAnthropicBackend,
  createOpenAiBackend,
  resolveBackend,
  normalizeUsage,
  BackendCapabilityError,
  assertCapabilities,
} from "../../packages/mcp-rks/src/llm/backend.mjs";
import { runQaAgentReview } from "../../packages/mcp-rks/src/server/qa-agent.mjs";
import { assessScreenshot } from "../../packages/mcp-rks/src/agents/visual.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const REPLY = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 4 },
};
const IMAGE_MESSAGES = [
  { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] },
];
const stubClient = (reply) => {
  const create = vi.fn(async () => reply);
  return { client: { messages: { create } }, create };
};

const CRED_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ROUTEKIT_LLM_PROVIDER"];
let savedEnv;
let emitSpy;
beforeEach(() => {
  savedEnv = Object.fromEntries(CRED_KEYS.map((k) => [k, process.env[k]]));
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  for (const fn of [h.createMock, h.ctorMock, h.chat, h.chatWithUsage, h.openAiChat, h.loadEnv, h.anthropicClientFor, h.openAiClientFor]) {
    fn.mockReset();
  }
  // A decoy: if a backend re-loaded the env instead of using the bound one, this would show up.
  h.loadEnv.mockImplementation(() => ({ provider: "anthropic", model: null, anthropicKey: "decoy-key", openaiKey: null }));
  h.anthropicClientFor.mockImplementation(() => h.anthropicHttpClient);
  h.openAiClientFor.mockImplementation(() => h.openAiHttpClient);
  resetTelemetryCollector();
  emitSpy = vi.spyOn(getTelemetryCollector(), "emit");
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  resetTelemetryCollector();
});

describe("backend.mjs exports", () => {
  it("exports the seam surface", () => {
    for (const fn of [createAnthropicBackend, createOpenAiBackend, resolveBackend, normalizeUsage]) {
      expect(typeof fn).toBe("function");
    }
    const err = new BackendCapabilityError("openai", "tool use");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BackendCapabilityError");
    expect(err.backendId).toBe("openai");
    expect(err.capability).toBe("tool use");
  });
});

describe("normalizeUsage", () => {
  it("maps Anthropic usage fields", () => {
    expect(
      normalizeUsage({ input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 7, cache_creation_input_tokens: 6 })
    ).toStrictEqual({ in: 9, out: 8, cacheRead: 7, cacheCreate: 6 });
  });
  it("defaults missing fields to 0", () => {
    expect(normalizeUsage({ input_tokens: 5 })).toStrictEqual({ in: 5, out: 0, cacheRead: 0, cacheCreate: 0 });
  });
  it("returns null for null and undefined", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage(undefined)).toBeNull();
  });
});

describe("Anthropic backend: SDK transport", () => {
  it("createMessage passes exactly the caller-supplied keys", async () => {
    const { client, create } = stubClient(REPLY);
    const messages = [{ role: "user", content: "q" }];
    const out = await createAnthropicBackend({ sdkClient: client }).createMessage({ model: "m", maxTokens: 10, messages });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toStrictEqual({ model: "m", max_tokens: 10, messages });
    expect(create.mock.calls[0][1]).toBeUndefined();
    expect(out.content).toBe(REPLY.content);
    expect(out.stopReason).toBe("end_turn");
    expect(out.usage).toStrictEqual({ in: 3, out: 4, cacheRead: 0, cacheCreate: 0 });
    expect(out.model).toBe("m");
    expect(out.raw).toBe(REPLY);
  });

  it("createMessage forwards system, tools and signal when supplied", async () => {
    const { client, create } = stubClient(REPLY);
    const ac = new AbortController();
    const messages = [{ role: "user", content: "q" }];
    const tools = [{ name: "t", input_schema: { type: "object" } }];
    await createAnthropicBackend({ sdkClient: client }).createMessage({
      model: "m", maxTokens: 10, messages, system: "S", tools, signal: ac.signal,
    });
    expect(create.mock.calls[0][0]).toStrictEqual({ model: "m", max_tokens: 10, messages, system: "S", tools });
    expect(create.mock.calls[0][1]).toStrictEqual({ signal: ac.signal });
  });

  it("createMessage reports usage null when the response has none", async () => {
    const { client } = stubClient({ content: [], stop_reason: "end_turn" });
    const out = await createAnthropicBackend({ sdkClient: client }).createMessage({ model: "m", maxTokens: 1, messages: [] });
    expect(out.usage).toBeNull();
  });

  it("complete({ transport: sdk }) sends one plain-string user message and reports usageEmitted false", async () => {
    const { client, create } = stubClient(REPLY);
    const res = await createAnthropicBackend({ sdkClient: client }).complete({
      transport: "sdk", model: "m", prompt: "P", maxTokens: 1024,
    });
    expect(create.mock.calls[0][0]).toStrictEqual({ model: "m", max_tokens: 1024, messages: [{ role: "user", content: "P" }] });
    expect(res.content).toBe("hi");
    expect(res.usage).toBe(REPLY.usage);
    expect(res.usageEmitted).toBe(false);
  });

  it("guards the credential before constructing the lazily imported SDK", async () => {
    for (const k of CRED_KEYS) delete process.env[k];
    await expect(createAnthropicBackend().createMessage({ model: "m", maxTokens: 1, messages: [] })).rejects.toThrow(
      /ANTHROPIC_API_KEY/
    );
    expect(h.ctorMock).not.toHaveBeenCalled();
  });

  it("resolves the lazy import to the vi.mock of @anthropic-ai/sdk", async () => {
    h.createMock.mockResolvedValue(REPLY);
    await createAnthropicBackend().createMessage({ model: "m", maxTokens: 1, messages: [] });
    expect(h.ctorMock).toHaveBeenCalledTimes(1);
    expect(h.createMock).toHaveBeenCalledTimes(1);
  });
});

describe("Anthropic backend: HTTP transport", () => {
  const ENV = { provider: "anthropic" };

  it("delegates to callAnthropicChatWithUsage with the unchanged argument object", async () => {
    h.chatWithUsage.mockResolvedValue({ content: "C", usage: { in: 1 } });
    const ac = new AbortController();
    const context = { projectId: "p", caller: "planner" };
    const res = await createAnthropicBackend().complete({
      transport: "http", env: ENV, model: "m", prompt: "P", systemPrompt: "S", signal: ac.signal, context,
    });
    expect(h.chatWithUsage).toHaveBeenCalledTimes(1);
    expect(h.chatWithUsage.mock.calls[0][0]).toStrictEqual({
      client: h.anthropicHttpClient, model: "m", prompt: "P", signal: ac.signal, systemPrompt: "S", context,
    });
    expect(h.chat).not.toHaveBeenCalled();
    expect(res).toStrictEqual({ content: "C", usage: { in: 1 }, usageEmitted: true });
  });

  it("withUsage false delegates to callAnthropicChat instead", async () => {
    h.chat.mockResolvedValue("C2");
    const res = await createAnthropicBackend().complete({
      transport: "http", withUsage: false, env: ENV, model: "m", prompt: "P", context: {},
    });
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.chat.mock.calls[0][0]).toStrictEqual({
      client: h.anthropicHttpClient, model: "m", prompt: "P", signal: undefined, systemPrompt: null, context: {},
    });
    expect(h.chatWithUsage).not.toHaveBeenCalled();
    expect(res.content).toBe("C2");
    expect(res.usageEmitted).toBe(true);
  });

  it("resolveBackend binds its env, so complete() without a per-call env never calls loadEnv", async () => {
    h.chatWithUsage.mockResolvedValue({ content: "C", usage: null });
    h.openAiChat.mockResolvedValue("O");
    await resolveBackend({ env: { provider: "anthropic", model: "m" } }).complete({ transport: "http", model: "m", prompt: "P", context: {} });
    await resolveBackend({ env: { provider: "openai", model: "m" } }).complete({ model: "m", prompt: "P", context: {} });
    expect(h.loadEnv).not.toHaveBeenCalled();
    expect(h.chatWithUsage).toHaveBeenCalledTimes(1);
    expect(h.openAiChat).toHaveBeenCalledTimes(1);
    expect(h.anthropicClientFor.mock.calls[0][0]).toMatchObject({ provider: "anthropic", model: "m" });
    expect(h.openAiClientFor.mock.calls[0][0]).toMatchObject({ provider: "openai", model: "m" });
  });

  it("a null HTTP client keeps the planner's pre-migration error text and calls no transport", async () => {
    h.anthropicClientFor.mockImplementation(() => null);
    h.openAiClientFor.mockImplementation(() => null);
    const anthropic = createAnthropicBackend({ env: { provider: "anthropic" } });
    await expect(anthropic.complete({ transport: "http", model: "m", prompt: "P" })).rejects.toThrow(
      new Error("Anthropic client not configured")
    );
    await expect(anthropic.complete({ transport: "http", withUsage: false, model: "m", prompt: "P" })).rejects.toThrow(
      new Error("Anthropic client not configured")
    );
    await expect(createOpenAiBackend({ env: { provider: "openai" } }).complete({ model: "m", prompt: "P" })).rejects.toThrow(
      new Error("OpenAI client not configured")
    );
    expect(h.chatWithUsage).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.openAiChat).not.toHaveBeenCalled();
  });
});

describe("OpenAI backend and capability errors", () => {
  it("reports no tool use or vision and refuses createMessage", async () => {
    const b = createOpenAiBackend();
    expect(b.id).toBe("openai");
    expect(b.capabilities.toolUse).toBe(false);
    expect(b.capabilities.vision).toBe(false);
    await expect(
      b.createMessage({ model: "m", maxTokens: 1, messages: [], tools: [{ name: "t" }] })
    ).rejects.toBeInstanceOf(BackendCapabilityError);
    await expect(b.createMessage({ model: "m", maxTokens: 1, messages: IMAGE_MESSAGES })).rejects.toBeInstanceOf(
      BackendCapabilityError
    );
  });

  it("complete delegates to callOpenAiChat", async () => {
    h.openAiChat.mockResolvedValue("O");
    const res = await createOpenAiBackend().complete({
      env: { provider: "openai" }, model: "m", prompt: "P", systemPrompt: "S", context: {},
    });
    expect(h.openAiChat).toHaveBeenCalledTimes(1);
    expect(h.openAiChat.mock.calls[0][0]).toStrictEqual({
      client: h.openAiHttpClient, model: "m", prompt: "P", signal: undefined, systemPrompt: "S", context: {},
    });
    expect(res.content).toBe("O");
    expect(res.usageEmitted).toBe(true);
  });

  it("assertCapabilities throws for tools or images on a backend that lacks them", () => {
    const openai = createOpenAiBackend();
    const anthropic = createAnthropicBackend({ sdkClient: stubClient(REPLY).client });
    expect(() => assertCapabilities(openai, { tools: [{ name: "t" }] })).toThrow(BackendCapabilityError);
    expect(() => assertCapabilities(openai, { messages: IMAGE_MESSAGES })).toThrow(BackendCapabilityError);
    expect(() => assertCapabilities(anthropic, { tools: [{ name: "t" }], messages: IMAGE_MESSAGES })).not.toThrow();
  });
});

describe("resolveBackend", () => {
  it("selects by provider, honours pinProvider, rejects unknown providers", () => {
    expect(resolveBackend({ env: { provider: "anthropic" } }).id).toBe("anthropic");
    expect(resolveBackend({ env: { provider: "openai" } }).id).toBe("openai");
    expect(resolveBackend({ env: { provider: "openai" }, pinProvider: "anthropic" }).id).toBe("anthropic");
    expect(() => resolveBackend({ env: { provider: "google" } })).toThrow(new Error("Unsupported provider: google"));
  });
});

describe("backend.mjs emits no telemetry", () => {
  it("createMessage, complete sdk and complete http produce zero collector emits", async () => {
    const { client } = stubClient(REPLY);
    const backend = createAnthropicBackend({ sdkClient: client });
    h.chatWithUsage.mockResolvedValue({ content: "C", usage: { in: 1 } });
    await backend.createMessage({ model: "m", maxTokens: 1, messages: [{ role: "user", content: "q" }] });
    await backend.complete({ transport: "sdk", model: "m", prompt: "P", maxTokens: 1 });
    await backend.complete({ transport: "http", env: { provider: "anthropic" }, model: "m", prompt: "P", context: {} });
    expect(emitSpy).not.toHaveBeenCalled();
  });
});

describe("request-body parity for the migrated callers", () => {
  it("qa-agent sends the pre-migration request body", async () => {
    h.createMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ verdict: "pass", exploitableGaps: [] }) }],
    });
    const res = await runQaAgentReview({
      plan: { steps: [] }, tddApplicable: "strong", testCode: "TEST_CODE_MARKER", implementationCode: "IMPL_CODE_MARKER", projectId: "proj-parity",
    });
    expect(res.ok).toBe(true);
    expect(h.createMock).toHaveBeenCalledTimes(1);
    const [body, opts] = h.createMock.mock.calls[0];
    expect(body).toStrictEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: expect.any(String) }],
    });
    expect(body.messages[0].content).toContain("STORY CLASSIFICATION: strong");
    expect(body.messages[0].content).toContain("TEST_CODE_MARKER");
    expect(body.messages[0].content).toContain("IMPL_CODE_MARKER");
    expect(opts?.signal).toBeUndefined();
  });

  it("visual sends the pre-migration request body with the image block unchanged", async () => {
    h.createMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ passed: true, observation: "ok" }) }],
    });
    const check = { url: "http://localhost:3000/parity", criteria: "PARITY_CRITERIA_MARKER" };
    const out = await assessScreenshot("/virtual/shot.png", check, { projectId: "proj-vis" });
    expect(out.passed).toBe(true);
    expect(h.createMock).toHaveBeenCalledTimes(1);
    const [body, opts] = h.createMock.mock.calls[0];
    expect(body).toStrictEqual({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("fake-png").toString("base64") } },
            { type: "text", text: expect.any(String) },
          ],
        },
      ],
    });
    expect(body.messages[0].content[1].text).toContain(check.url);
    expect(body.messages[0].content[1].text).toContain(check.criteria);
    expect(opts?.signal).toBeUndefined();
  });

  it("qa-agent and visual no longer construct the SDK directly", () => {
    for (const rel of ["packages/mcp-rks/src/server/qa-agent.mjs", "packages/mcp-rks/src/agents/visual.mjs"]) {
      const src = readSrc(rel);
      expect(src).not.toMatch(/^import Anthropic from/m);
      expect(src).not.toContain("new Anthropic(");
      expect(src).toContain("assertAnthropicCredential()");
    }
  });
});
