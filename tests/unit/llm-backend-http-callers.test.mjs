/**
 * Witness for backlog.refactor.llm-backend-migrate-http-path: the planner (raw-code generation
 * and plan generation) and external research reach the clients.mjs HTTP transports through
 * resolveBackend(...).complete() with request, attribution, error-text and llm.token_usage
 * parity. Every behavioral assertion also holds on the pre-migration source; only the
 * "source shape" block is new-state-only.
 * Deterministic: global fetch is stubbed before every call, and the clients.mjs transport
 * exports are wrapped (recorded, then delegated to the real implementation). No network,
 * no LLM, no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const h = vi.hoisted(() => ({
  actual: null,
  loadEnv: vi.fn(),
  withUsage: vi.fn(),
  chat: vi.fn(),
  openAi: vi.fn(),
}));

// Plain wrapper functions that record into hoisted vi.fn stubs (reset in beforeEach) and then
// delegate to the real transport, so vi.restoreAllMocks() cannot drop an implementation.
vi.mock("../../packages/mcp-rks/src/llm/clients.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  h.actual = actual;
  return {
    ...actual,
    loadEnv: (...a) => h.loadEnv(...a),
    callAnthropicChatWithUsage: (args) => {
      h.withUsage(args);
      return actual.callAnthropicChatWithUsage(args);
    },
    callAnthropicChat: (args) => {
      h.chat(args);
      return actual.callAnthropicChat(args);
    },
    callOpenAiChat: (args) => {
      h.openAi(args);
      return actual.callOpenAiChat(args);
    },
  };
});

import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry/collector";
import { enrichCreateFileContent, runLlmPlanner } from "../../packages/mcp-rks/src/llm/planner.mjs";
import { runExternalResearch } from "../../packages/mcp-rks/src/agents/external-research.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const TSX = "src/components/Calculator.tsx";
const REAL_BODY = "export function Calculator() {\n  return null;\n}";
const PROSE_STEP = () => [{ action: "create_file", path: TSX, content: "Create a Calculator." }];
const LLM_CONTEXT = { projectId: "proj-parity", problemId: "backlog.refactor.example" };
const PLANNER_CONTEXT = { ...LLM_CONTEXT, caller: "planner" };
const ANTHROPIC_ENV = { provider: "anthropic", model: "claude-parity", anthropicKey: "anthropic-planner-key", openaiKey: null };
const OPENAI_ENV = { provider: "openai", model: "gpt-parity", anthropicKey: null, openaiKey: "openai-planner-key" };
// What loadEnv returns unless a test says otherwise. The raw-code path receives its env as an
// argument; if the backend re-loaded it, this decoy's provider, model and keys would show up.
const LOADENV_DECOY = { provider: "anthropic", model: "decoy-model", anthropicKey: "decoy-key", openaiKey: "decoy-key" };
const ANTHROPIC_USAGE = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
const NOTE_PLAN = JSON.stringify({ planSummary: "parity", steps: [{ id: "n1", action: "note", content: "parity note" }] });
const TRANSPORT_KEYS = ["client", "context", "model", "prompt", "signal", "systemPrompt"];
const PLAN_INPUT = {
  requirements: "Record a parity note.",
  context: "",
  editableTargets: [],
  runFolder: undefined,
  useReplay: false,
  llmContext: LLM_CONTEXT,
};

const anthropicReply = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: ANTHROPIC_USAGE });
const openAiReply = (text) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 13, completion_tokens: 5 },
});
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const stubFetch = (body) => {
  const f = vi.fn(async () => jsonResponse(body));
  global.fetch = f;
  return f;
};
const fetchShape = ([url, init]) => ({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
const tokenEvents = (spy) => spy.mock.calls.filter((c) => c[0] === "llm.token_usage");
const errorLines = (spy) => spy.mock.calls.map((c) => c.map(String).join(" "));

const ENV_KEYS = ["ROUTEKIT_ANTHROPIC_BASE_URL", "ROUTEKIT_LLM_BASE_URL", "RKS_SKIP_LLM", "RKS_PLANNER_MODE", "RKS_PLANNER_REFINEMENT"];
let savedEnv;
let originalFetch;
let emitSpy;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RKS_PLANNER_REFINEMENT = "off";
  originalFetch = global.fetch;
  for (const fn of [h.loadEnv, h.withUsage, h.chat, h.openAi]) fn.mockReset();
  h.loadEnv.mockImplementation(() => ({ ...LOADENV_DECOY }));
  resetTelemetryCollector();
  emitSpy = vi.spyOn(getTelemetryCollector(), "emit");
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  resetTelemetryCollector();
});

describe("planner raw-code generation (enrichCreateFileContent) through the backend", () => {
  it("anthropic: unchanged transport arguments, request and llm.token_usage", async () => {
    const f = stubFetch(anthropicReply(REAL_BODY));
    const out = await enrichCreateFileContent({ actions: PROSE_STEP(), requirements: "calc", env: ANTHROPIC_ENV, llmContext: LLM_CONTEXT });
    expect(out[0].content).toBe(REAL_BODY);
    expect(h.withUsage).toHaveBeenCalledTimes(1);
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.openAi).not.toHaveBeenCalled();
    expect(h.loadEnv).not.toHaveBeenCalled();
    const args = h.withUsage.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(TRANSPORT_KEYS);
    expect(args.client).toStrictEqual(h.actual.createAnthropicClient(ANTHROPIC_ENV));
    expect(args.model).toBe("claude-parity");
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.systemPrompt).toMatch(/raw/i);
    expect(args.prompt).toContain(TSX);
    expect(args.context).toStrictEqual(PLANNER_CONTEXT);

    expect(f).toHaveBeenCalledTimes(1);
    const migrated = fetchShape(f.mock.calls[0]);
    expect(migrated.url).toBe("https://api.anthropic.com/v1/messages");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe("proj-parity");
    expect(events[0][2]).toMatchObject({
      clientName: "anthropic-http",
      model: "claude-parity",
      caller: "planner",
      problemId: LLM_CONTEXT.problemId,
    });
    expect(events[0][2].tokens).toStrictEqual({ in: 11, out: 7, cacheRead: 3, cacheCreate: 2 });

    // Pre-migration reference: the argument object planner.mjs built before the move.
    const ref = stubFetch(anthropicReply(REAL_BODY));
    await h.actual.callAnthropicChatWithUsage({
      client: h.actual.createAnthropicClient(ANTHROPIC_ENV),
      model: ANTHROPIC_ENV.model,
      prompt: args.prompt,
      signal: new AbortController().signal,
      systemPrompt: args.systemPrompt,
      context: PLANNER_CONTEXT,
    });
    expect(migrated).toStrictEqual(fetchShape(ref.mock.calls[0]));
  });

  it("openai: callOpenAiChat with unchanged arguments, and the body is the content string", async () => {
    const f = stubFetch(openAiReply(REAL_BODY));
    const out = await enrichCreateFileContent({ actions: PROSE_STEP(), requirements: "calc", env: OPENAI_ENV, llmContext: LLM_CONTEXT });
    expect(out[0].content).toBe(REAL_BODY);
    expect(h.openAi).toHaveBeenCalledTimes(1);
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
    expect(h.loadEnv).not.toHaveBeenCalled();
    const args = h.openAi.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(TRANSPORT_KEYS);
    expect(args.client).toStrictEqual(h.actual.createOpenAiClient(OPENAI_ENV));
    expect(args.model).toBe("gpt-parity");
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.context).toStrictEqual(PLANNER_CONTEXT);

    expect(f).toHaveBeenCalledTimes(1);
    const migrated = fetchShape(f.mock.calls[0]);
    expect(migrated.url).toBe("https://api.openai.com/v1/chat/completions");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][2]).toMatchObject({ clientName: "openai-http", model: "gpt-parity", caller: "planner" });
    expect(events[0][2].tokens).toStrictEqual({ in: 13, out: 5, cacheRead: 0, cacheCreate: 0 });

    const ref = stubFetch(openAiReply(REAL_BODY));
    await h.actual.callOpenAiChat({
      client: h.actual.createOpenAiClient(OPENAI_ENV),
      model: OPENAI_ENV.model,
      prompt: args.prompt,
      signal: new AbortController().signal,
      systemPrompt: args.systemPrompt,
      context: PLANNER_CONTEXT,
    });
    expect(migrated).toStrictEqual(fetchShape(ref.mock.calls[0]));
  });

  it("an unknown provider keeps the Unsupported provider error text and makes no request", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = stubFetch(anthropicReply(REAL_BODY));
    const out = await enrichCreateFileContent({
      actions: PROSE_STEP(), requirements: "calc", env: { ...ANTHROPIC_ENV, provider: "google" }, llmContext: LLM_CONTEXT,
    });
    expect(out[0].content).toBe("Create a Calculator.");
    expect(f).not.toHaveBeenCalled();
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.openAi).not.toHaveBeenCalled();
    expect(errorLines(errSpy)).toContain(`[planner] enrichCreateFileContent failed for ${TSX}: Unsupported provider: google`);
  });

  it.each([
    ["anthropic", { ...ANTHROPIC_ENV, anthropicKey: null }, "Anthropic client not configured"],
    ["openai", { ...OPENAI_ENV, openaiKey: null }, "OpenAI client not configured"],
  ])("%s without a key keeps the pre-migration error text and makes no request", async (_provider, env, message) => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = stubFetch(anthropicReply(REAL_BODY));
    const out = await enrichCreateFileContent({ actions: PROSE_STEP(), requirements: "calc", env, llmContext: LLM_CONTEXT });
    expect(out[0].content).toBe("Create a Calculator.");
    expect(f).not.toHaveBeenCalled();
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.openAi).not.toHaveBeenCalled();
    expect(errorLines(errSpy)).toContain(`[planner] enrichCreateFileContent failed for ${TSX}: ${message}`);
  });
});

describe("planner plan generation (runLlmPlanner) through the backend", () => {
  it("anthropic: one loadEnv, unchanged transport arguments, abort on settle, usage passthrough", async () => {
    h.loadEnv.mockImplementation(() => ({ ...ANTHROPIC_ENV }));
    const f = stubFetch(anthropicReply(NOTE_PLAN));
    const result = await runLlmPlanner(PLAN_INPUT);
    expect(h.loadEnv).toHaveBeenCalledTimes(1);
    expect(h.openAi).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
    const calls = h.withUsage.mock.calls.map(([a]) => a);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) {
      expect(Object.keys(args).sort()).toEqual(TRANSPORT_KEYS);
      expect(args.client).toStrictEqual(h.actual.createAnthropicClient(ANTHROPIC_ENV));
      expect(args.model).toBe("claude-parity");
      expect(typeof args.systemPrompt).toBe("string");
      expect(args.systemPrompt.length).toBeGreaterThan(0);
      expect(args.context).toStrictEqual(PLANNER_CONTEXT);
      expect(args.signal).toBeInstanceOf(AbortSignal);
      // callOnce's .finally(() => controller.abort()) still runs once the call settles.
      expect(args.signal.aborted).toBe(true);
    }
    expect(f).toHaveBeenCalledTimes(calls.length);
    expect(result.usage).toStrictEqual(ANTHROPIC_USAGE);
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(calls.length);
    for (const [, projectId, payload] of events) {
      expect(projectId).toBe("proj-parity");
      expect(payload).toMatchObject({ clientName: "anthropic-http", model: "claude-parity", caller: "planner" });
    }
  });

  it("openai: callOpenAiChat only, and usage stays null", async () => {
    h.loadEnv.mockImplementation(() => ({ ...OPENAI_ENV }));
    const f = stubFetch(openAiReply(NOTE_PLAN));
    const result = await runLlmPlanner(PLAN_INPUT);
    expect(h.loadEnv).toHaveBeenCalledTimes(1);
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
    const calls = h.openAi.mock.calls.map(([a]) => a);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const args of calls) {
      expect(Object.keys(args).sort()).toEqual(TRANSPORT_KEYS);
      expect(args.client).toStrictEqual(h.actual.createOpenAiClient(OPENAI_ENV));
      expect(args.model).toBe("gpt-parity");
      expect(args.context).toStrictEqual(PLANNER_CONTEXT);
      expect(args.signal.aborted).toBe(true);
    }
    expect(f).toHaveBeenCalledTimes(calls.length);
    expect(result.usage).toBeNull();
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(calls.length);
    expect(events.every(([, , p]) => p.clientName === "openai-http")).toBe(true);
  });

  it("an unknown provider makes no request and still reports Unsupported provider", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.loadEnv.mockImplementation(() => ({ ...ANTHROPIC_ENV, provider: "google" }));
    const f = stubFetch(anthropicReply(NOTE_PLAN));
    const result = await runLlmPlanner(PLAN_INPUT);
    expect(f).not.toHaveBeenCalled();
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.openAi).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("Unsupported provider: google");
  });
});

describe("external research synthesis stays pinned to anthropic", () => {
  it("provider openai still sends one callAnthropicChat with the pre-migration argument shape", async () => {
    h.loadEnv.mockImplementation(() => ({
      provider: "openai", model: null, anthropicKey: "anthropic-research-key", openaiKey: "openai-research-key",
    }));
    const f = stubFetch(anthropicReply("synthesized answer"));
    const res = await runExternalResearch(
      { projectId: "proj-ext", query: "token usage telemetry" },
      {
        searchFn: async () => [{ title: "T", url: "https://example.com/a", snippet: "s" }],
        collector: { emit: () => {} },
      },
    );
    expect(res.ok).toBe(true);
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.openAi).not.toHaveBeenCalled();
    expect(h.withUsage).not.toHaveBeenCalled();
    const { systemPrompt, ...rest } = h.chat.mock.calls[0][0];
    expect(systemPrompt ?? null).toBeNull();
    expect(Object.keys(rest).sort()).toEqual(["client", "context", "model", "prompt", "signal"]);
    const env = h.loadEnv.mock.results[0].value;
    const expectedClient = h.actual.createAnthropicClient({ ...env, provider: "anthropic" });
    expect(rest.client).toStrictEqual(expectedClient);
    expect(rest.context).toStrictEqual({ projectId: "proj-ext", caller: "external-research" });
    expect(typeof rest.model).toBe("string");
    expect(rest.model.length).toBeGreaterThan(0);

    expect(f).toHaveBeenCalledTimes(1);
    const migrated = fetchShape(f.mock.calls[0]);
    expect(migrated.url).toBe("https://api.anthropic.com/v1/messages");
    expect(migrated.headers["x-api-key"]).toBe("anthropic-research-key");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe("proj-ext");
    expect(events[0][2]).toMatchObject({ clientName: "anthropic-http", model: rest.model, caller: "external-research" });
    expect("problemId" in events[0][2]).toBe(false);

    const ref = stubFetch(anthropicReply("synthesized answer"));
    await h.actual.callAnthropicChat({
      client: expectedClient,
      model: rest.model,
      prompt: rest.prompt,
      signal: new AbortController().signal,
      context: rest.context,
    });
    expect(migrated).toStrictEqual(fetchShape(ref.mock.calls[0]));
  });
});

describe("source shape after the migration", () => {
  it("planner.mjs has no provider switch or client construction and calls resolveBackend on both paths", () => {
    const src = read("packages/mcp-rks/src/llm/planner.mjs");
    expect(src).not.toMatch(/env\.provider\s*===\s*["'](openai|anthropic)["']/);
    expect(src).not.toContain("createAnthropicClient(");
    expect(src).not.toContain("createOpenAiClient(");
    expect((src.match(/\bresolveBackend\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/from\s+["']\.\/backend\.mjs["']/);
  });

  it.each([
    ["packages/mcp-rks/src/server/review.mjs", "reviewer"],
    ["packages/mcp-rks/src/agents/external-research.mjs", "external-research"],
  ])("%s builds no client itself and pins the anthropic backend", (rel, caller) => {
    const src = read(rel);
    expect(src).not.toContain("createAnthropicClient(");
    expect(src).toMatch(/\bresolveBackend\(/);
    expect(src).toMatch(/pinProvider:\s*['"]anthropic['"]/);
    expect(src).toMatch(/withUsage:\s*false/);
    expect(src).toMatch(new RegExp(`caller:\\s*['"]${caller}['"]`));
    expect(src).toMatch(/from\s+['"]\.\.\/llm\/backend\.mjs['"]/);
  });
});
