/**
 * Witness for backlog.fix.llm-token-usage-complete-coverage: callers of the HTTP transports
 * pass attribution context (projectId, problemId, caller), and the plan worker drains
 * outstanding LLM requests before it flushes telemetry and exits.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { chatMock, withUsageMock, openAiMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  withUsageMock: vi.fn(),
  openAiMock: vi.fn(),
}));
vi.mock("../../packages/mcp-rks/src/llm/clients.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadEnv: () => ({ provider: "anthropic", model: null, anthropicKey: "test-key", openaiKey: null }),
    createAnthropicClient: () => ({ apiKey: "test-key", baseURL: "https://api.anthropic.test" }),
    createOpenAiClient: () => ({ apiKey: "test-key", baseURL: "https://api.openai.test/v1" }),
    callAnthropicChat: (...args) => chatMock(...args),
    callAnthropicChatWithUsage: (...args) => withUsageMock(...args),
    callOpenAiChat: (...args) => openAiMock(...args),
  };
});

import { runExternalResearch } from "../../packages/mcp-rks/src/agents/external-research.mjs";
import { enrichCreateFileContent } from "../../packages/mcp-rks/src/llm/planner.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const REAL_BODY = "export function Calculator() {\n  return null;\n}";
const PROSE_STEP = () => [{ action: "create_file", path: "src/components/Calculator.tsx", content: "Create a Calculator." }];
const LLM_CONTEXT = { projectId: "proj-plan", problemId: "backlog.fix.example" };

// Every `${fnName}({ ... })` call object in a source file, extracted by brace balancing over
// the FULL source (no fixed-size window), so nearby edits cannot break the assertion.
function callObjects(src, fnName) {
  const out = [];
  const needle = `${fnName}({`;
  let i = src.indexOf(needle);
  while (i !== -1) {
    let depth = 0;
    let j = i + fnName.length + 1;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(needle, j);
  }
  return out;
}

beforeEach(() => {
  chatMock.mockReset();
  withUsageMock.mockReset();
  openAiMock.mockReset();
});

describe("external research synthesis attribution", () => {
  it("passes projectId and caller external-research, and no problemId key", async () => {
    chatMock.mockResolvedValue("synthesized answer");
    const res = await runExternalResearch(
      { projectId: "proj-ext", query: "token usage telemetry" },
      {
        searchFn: async () => [{ title: "T", url: "https://example.com/a", snippet: "s" }],
        collector: { emit: () => {} },
      },
    );
    expect(res.ok).toBe(true);
    expect(chatMock).toHaveBeenCalledTimes(1);
    const { context } = chatMock.mock.calls[0][0];
    expect(context.projectId).toBe("proj-ext");
    expect(context.caller).toBe("external-research");
    expect("problemId" in context).toBe(false);
  });
});

describe("planner attribution", () => {
  it("anthropic branch passes llmContext plus caller planner", async () => {
    withUsageMock.mockResolvedValue({ content: REAL_BODY, usage: {} });
    await enrichCreateFileContent({
      actions: PROSE_STEP(), requirements: "calc",
      env: { provider: "anthropic", model: "claude-test" }, llmContext: LLM_CONTEXT,
    });
    const { context } = withUsageMock.mock.calls[0][0];
    expect(context).toMatchObject({ ...LLM_CONTEXT, caller: "planner" });
  });

  it("openai branch passes the same context to callOpenAiChat", async () => {
    openAiMock.mockResolvedValue(REAL_BODY);
    await enrichCreateFileContent({
      actions: PROSE_STEP(), requirements: "calc",
      env: { provider: "openai", model: "gpt-test" }, llmContext: LLM_CONTEXT,
    });
    const { context } = openAiMock.mock.calls[0][0];
    expect(context).toMatchObject({ ...LLM_CONTEXT, caller: "planner" });
  });

  it("every transport call object in llm/planner.mjs carries a context property", () => {
    const src = read("packages/mcp-rks/src/llm/planner.mjs");
    const openai = callObjects(src, "callOpenAiChat");
    const anthropic = callObjects(src, "callAnthropicChatWithUsage");
    expect(openai.length).toBeGreaterThanOrEqual(2);
    expect(anthropic.length).toBeGreaterThanOrEqual(2);
    for (const call of [...openai, ...anthropic]) {
      expect(call).toMatch(/\bcontext\b/);
      expect(call).toMatch(/caller:\s*['"]planner['"]/);
    }
  });
});

describe("plan worker drains outstanding LLM requests after the done marker, bounded", () => {
  // bin/plan-worker.mjs is not importable (top-level argv handling and process.exit), so these
  // are source assertions.
  const src = read("packages/mcp-rks/bin/plan-worker.mjs");
  const fn = src.match(/async function flushTelemetry\(\) \{[\s\S]*?\n\}/);

  it("flushTelemetry awaits awaitOutstandingLlmRequests with the 60 s bound before telemetryCollector.flush()", () => {
    expect(src).toMatch(/const LLM_DRAIN_TIMEOUT_MS = 60000;/);
    expect(fn).not.toBeNull();
    const body = fn[0];
    const drainAt = body.indexOf("awaitOutstandingLlmRequests({ timeoutMs: LLM_DRAIN_TIMEOUT_MS })");
    const flushAt = body.indexOf("telemetryCollector.flush()");
    expect(drainAt).toBeGreaterThan(-1);
    expect(flushAt).toBeGreaterThan(drainAt);
    expect(body).not.toMatch(/DEFAULT_LLM_TIMEOUT_MS/);
  });

  it("loads awaitOutstandingLlmRequests with a dynamic import inside flushTelemetry", () => {
    const body = fn[0];
    const importAt = body.search(/await import\(\s*['"]\.\.\/src\/llm\/clients\.mjs['"]\s*\)/);
    expect(importAt).toBeGreaterThan(-1);
    expect(body.indexOf("awaitOutstandingLlmRequests({ timeoutMs: LLM_DRAIN_TIMEOUT_MS })")).toBeGreaterThan(importAt);
  });

  it("has no static import of clients.mjs, so clients.mjs loads after dotenv.config reads the project .env", () => {
    // A top-level static import would evaluate clients.mjs (which reads RKS_LLM_TIMEOUT_MS and
    // RKS_LLM_MAX_TOKENS at module load) before dotenv.config runs.
    const STATIC_IMPORT = /^\s*import\s[^;]*clients\.mjs/m;
    const STATIC_REEXPORT = /^\s*export\s[^;]*from\s*['"][^'"]*clients\.mjs/m;
    // Controls, so a zero is not vacuous: both patterns catch the forms they exist to forbid
    // (single-line and multi-line static import, re-export), and neither matches the required
    // dynamic-import line (`import(` has no whitespace after `import`, and the line starts with
    // `const`), nor an unrelated static import followed by a later clients.mjs mention (`[^;]*`
    // stops at the first import's semicolon).
    expect("import { awaitOutstandingLlmRequests } from '../src/llm/clients.mjs';").toMatch(STATIC_IMPORT);
    expect("import {\n  awaitOutstandingLlmRequests,\n} from '../src/llm/clients.mjs';").toMatch(STATIC_IMPORT);
    expect("export { awaitOutstandingLlmRequests } from '../src/llm/clients.mjs';").toMatch(STATIC_REEXPORT);
    const dynamicLine = "  const { awaitOutstandingLlmRequests } = await import('../src/llm/clients.mjs');";
    const unrelated = "import fs from 'fs';\n" + dynamicLine;
    for (const s of [dynamicLine, unrelated]) {
      expect(s).not.toMatch(STATIC_IMPORT);
      expect(s).not.toMatch(STATIC_REEXPORT);
    }
    expect(src).not.toMatch(STATIC_IMPORT);
    expect(src).not.toMatch(STATIC_REEXPORT);
    const dotenvAt = src.indexOf("dotenv.config(");
    expect(dotenvAt).toBeGreaterThan(-1);
    expect(fn.index).toBeGreaterThan(dotenvAt);
  });

  it("the drain's catch logs with console.error instead of swallowing the error (R9)", () => {
    const body = fn[0];
    const drainAt = body.indexOf("awaitOutstandingLlmRequests({ timeoutMs: LLM_DRAIN_TIMEOUT_MS })");
    expect(drainAt).toBeGreaterThan(-1);
    const rest = body.slice(drainAt);
    const m = /catch\s*\(\s*\w+\s*\)\s*\{([^}]*)\}/.exec(rest);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/console\.error\(/);
    expect(rest.indexOf("telemetryCollector.flush()")).toBeGreaterThan(m.index);
  });

  it("logs and emits a non-zero abandoned count before the flush", () => {
    const body = fn[0];
    const emitAt = body.indexOf("plan.worker.llm_drain_abandoned");
    expect(emitAt).toBeGreaterThan(-1);
    expect(body.indexOf("telemetryCollector.flush()")).toBeGreaterThan(emitAt);
    expect(body).toMatch(/abandoned/);
    expect(body).toMatch(/console\.error\(/);
  });

  it("writes the done marker before the drain on both exit paths", () => {
    const flushCalls = [...src.matchAll(/await flushTelemetry\(\);/g)].map((m) => m.index);
    expect(flushCalls).toHaveLength(2);
    const def = src.indexOf("function updateMarker(");
    expect(def).toBeGreaterThan(-1);
    let from = def + "function updateMarker(".length;
    for (const at of flushCalls) {
      const marker = src.indexOf("updateMarker(", from);
      expect(marker).toBeGreaterThan(-1);
      expect(marker).toBeLessThan(at);
      const exitAt = src.indexOf("process.exit(", at);
      expect(exitAt).toBeGreaterThan(at);
      from = at;
    }
  });
});

describe("awaitOutstandingLlmRequests import boundary", () => {
  // Seven tests/unit files mock clients.mjs with closed factories; a new clients.mjs import in
  // review.mjs (or any module they load) would break them.
  it("under packages/mcp-rks/src and packages/mcp-rks/bin only clients.mjs and plan-worker.mjs reference it", () => {
    // bin/ is scanned too: plan-worker.mjs lives in bin/, outside src/, and the AC names it as
    // the ONLY importer, so another bin entry point importing it must also go red.
    // The scan is a substring test on file text, so plan-worker.mjs's dynamic-import
    // destructuring (const { awaitOutstandingLlmRequests } = await import(...)) still counts as a reference.
    const pkgRoot = path.join(ROOT, "packages/mcp-rks");
    const hits = ["src", "bin"]
      .flatMap((dir) =>
        fs
          .readdirSync(path.join(pkgRoot, dir), { recursive: true })
          .map((rel) => `${dir}/${String(rel).split(path.sep).join("/")}`),
      )
      .filter((rel) => rel.endsWith(".mjs"))
      .filter((rel) => fs.readFileSync(path.join(pkgRoot, rel), "utf8").includes("awaitOutstandingLlmRequests"))
      .sort();
    expect(hits).toEqual(["bin/plan-worker.mjs", "src/llm/clients.mjs"]);
  });

  it("review.mjs keeps its clients.mjs import line unchanged", () => {
    expect(read("packages/mcp-rks/src/server/review.mjs")).toContain(
      "import { loadEnv, createAnthropicClient, callAnthropicChat, DEFAULT_LLM_TIMEOUT_MS } from '../llm/clients.mjs';",
    );
  });
});
