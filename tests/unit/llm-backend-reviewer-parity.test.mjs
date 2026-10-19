/**
 * Witness for backlog.refactor.llm-backend-migrate-http-path, reviewer half: runReview's
 * reviewer call and its JSON-only retry reach callAnthropicChat through the anthropic-pinned
 * backend with request, attribution, error-text and llm.token_usage parity.
 * Hermetic in the same way as tests/unit/review-malformed-response-cause.test.mjs: project
 * context, RAG and child_process are mocked, global fetch is stubbed, and the clients.mjs
 * exports are wrapped (recorded, then delegated to the real implementation).
 * No network, no LLM, no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
// A root with no .rks/review-policy.yaml, so loadReviewPolicy falls back to its defaults.
// Nothing touches this path on disk: every disk and subprocess collaborator is mocked.
const FAKE_ROOT = path.join(REPO_ROOT, "tests", ".tmp", "llm-backend-reviewer-parity-nonexistent-root");

const h = vi.hoisted(() => ({
  actual: null,
  loadEnv: vi.fn(),
  withUsage: vi.fn(),
  chat: vi.fn(),
  openAi: vi.fn(),
}));

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

vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(async () => ({ record: { root: FAKE_ROOT } })),
}));

vi.mock("@routekit/rag", () => ({
  runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })),
}));

// A benign .md diff, so runPatternChecks produces zero findings.
const FAKE_DIFF = [
  "diff --git a/docs/notes.md b/docs/notes.md",
  "--- a/docs/notes.md",
  "+++ b/docs/notes.md",
  "@@ -1,1 +1,2 @@",
  " existing line",
  "+an added documentation line",
].join("\n");

vi.mock("child_process", () => {
  const impl = (_cmd, args = []) =>
    args.includes("--name-only")
      ? { stdout: "docs/notes.md\n", stderr: "", status: 0 }
      : { stdout: FAKE_DIFF, stderr: "", status: 0 };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry/collector";

const { runReview, loadReviewPolicy } = await import("../../packages/mcp-rks/src/server/review.mjs");

const VALID_REVIEW = {
  verdict: "warn",
  summary: "One concern about error handling",
  findings: [
    { category: "missing_error_handling", severity: "warn", file: "docs/notes.md", line: null, message: "no error path", suggestion: "add one" },
  ],
  acCoverage: { assessed: true, covered: ["AC1"], notCovered: [], uncertain: [] },
};
const REVIEW_ENV = { provider: "anthropic", model: null, anthropicKey: "review-anthropic-key", openaiKey: null };
const ANTHROPIC_USAGE = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
const REVIEW_KEYS = ["client", "context", "model", "prompt", "signal"];

const anthropicReply = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: ANTHROPIC_USAGE });
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const stubFetch = (...bodies) => {
  const f = vi.fn();
  for (const b of bodies) f.mockResolvedValueOnce(jsonResponse(b));
  global.fetch = f;
  return f;
};
const fetchShape = ([url, init]) => ({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
const tokenEvents = (spy) => spy.mock.calls.filter((c) => c[0] === "llm.token_usage");
const runReviewUnderTest = () =>
  runReview({ projectId: "routekit-shell-core", problemId: "backlog.fix.example-story", branch: "staging", targetBranch: "staging" });

const ENV_KEYS = ["ROUTEKIT_ANTHROPIC_BASE_URL", "ROUTEKIT_LLM_BASE_URL"];
let savedEnv;
let originalFetch;
let emitSpy;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  originalFetch = global.fetch;
  for (const fn of [h.loadEnv, h.withUsage, h.chat, h.openAi]) fn.mockReset();
  h.loadEnv.mockImplementation(() => ({ ...REVIEW_ENV }));
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

describe("reviewer call and JSON-only retry through the anthropic-pinned backend", () => {
  it("keeps the pre-migration transport arguments, request, single timeout signal and telemetry", async () => {
    const f = stubFetch(anthropicReply("I cannot produce JSON for this diff."), anthropicReply(JSON.stringify(VALID_REVIEW)));
    const result = await runReviewUnderTest();
    expect(result.verdict).toBe("warn");
    expect(h.loadEnv).toHaveBeenCalledTimes(1);
    expect(h.chat).toHaveBeenCalledTimes(2);
    expect(h.withUsage).not.toHaveBeenCalled();
    expect(h.openAi).not.toHaveBeenCalled();

    const expectedClient = h.actual.createAnthropicClient({ ...REVIEW_ENV, provider: "anthropic" });
    const expectedModel = loadReviewPolicy(FAKE_ROOT).model || "claude-sonnet-4-6";
    const calls = h.chat.mock.calls.map(([a]) => a);
    for (const args of calls) {
      const { systemPrompt, ...rest } = args;
      expect(systemPrompt ?? null).toBeNull();
      expect(Object.keys(rest).sort()).toEqual(REVIEW_KEYS);
      expect(rest.client).toStrictEqual(expectedClient);
      expect(rest.model).toBe(expectedModel);
      expect(rest.context).toMatchObject({ projectId: "routekit-shell-core", problemId: "backlog.fix.example-story", caller: "reviewer" });
      expect(rest.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls[1].signal).toBe(calls[0].signal);
    expect(calls[1].context).toStrictEqual(calls[0].context);
    expect(calls[1].prompt).not.toBe(calls[0].prompt);
    expect(calls[1].prompt).toMatch(/JSON/);

    expect(f).toHaveBeenCalledTimes(2);
    const migrated = f.mock.calls.map(fetchShape);
    for (const shape of migrated) expect(shape.url).toBe("https://api.anthropic.com/v1/messages");
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(2);
    for (const [, projectId, payload] of events) {
      expect(projectId).toBe("routekit-shell-core");
      expect(payload).toMatchObject({
        clientName: "anthropic-http",
        model: expectedModel,
        caller: "reviewer",
        problemId: "backlog.fix.example-story",
      });
      expect(payload.tokens).toStrictEqual({ in: 11, out: 7, cacheRead: 3, cacheCreate: 2 });
    }

    // Pre-migration reference: review.mjs called callAnthropicChat with exactly
    // { client, model, prompt, signal, context } and no systemPrompt key.
    const ref = stubFetch(anthropicReply("x"), anthropicReply("y"));
    for (const args of calls) {
      await h.actual.callAnthropicChat({
        client: expectedClient,
        model: expectedModel,
        prompt: args.prompt,
        signal: new AbortController().signal,
        context: args.context,
      });
    }
    expect(migrated).toStrictEqual(ref.mock.calls.map(fetchShape));
  });

  it("stays pinned to anthropic when the provider is openai", async () => {
    const env = { provider: "openai", model: null, anthropicKey: "review-anthropic-key", openaiKey: "review-openai-key" };
    h.loadEnv.mockImplementation(() => ({ ...env }));
    const f = stubFetch(anthropicReply(JSON.stringify(VALID_REVIEW)));
    const result = await runReviewUnderTest();
    expect(result.verdict).toBe("warn");
    expect(h.chat).toHaveBeenCalledTimes(1);
    expect(h.openAi).not.toHaveBeenCalled();
    expect(h.chat.mock.calls[0][0].client).toStrictEqual(h.actual.createAnthropicClient({ ...env, provider: "anthropic" }));
    expect(f).toHaveBeenCalledTimes(1);
    const shape = fetchShape(f.mock.calls[0]);
    expect(shape.url).toBe("https://api.anthropic.com/v1/messages");
    expect(shape.headers["x-api-key"]).toBe("review-anthropic-key");
  });

  it("a missing key still reports not_configured with no request", async () => {
    h.loadEnv.mockImplementation(() => ({}));
    const f = stubFetch(anthropicReply(JSON.stringify(VALID_REVIEW)));
    const result = await runReviewUnderTest();
    expect(result.cause).toBe("not_configured");
    expect(result.verdict).toBe("unavailable");
    expect(f).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("a transport failure keeps the call_failed error text and performs no retry", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "model not found" }));
    const result = await runReviewUnderTest();
    expect(result.cause).toBe("call_failed");
    expect(result.verdict).toBe("unavailable");
    expect(result.error).toContain("Reviewer LLM call failed: Anthropic error: 404 model not found");
    expect(h.chat).toHaveBeenCalledTimes(1);
  });
});
