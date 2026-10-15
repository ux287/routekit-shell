/**
 * Witness for backlog.fix.llm-token-usage-complete-coverage: the two one-shot Anthropic SDK
 * call sites (server/qa-agent.mjs, agents/visual.mjs) emit llm.token_usage per response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
// A plain constructor, NOT vi.fn().mockImplementation(...): under vitest 2.1.9, vi.restoreAllMocks()
// in the afterEach below calls mockRestore on EVERY mock, which drops an implementation set with
// mockImplementation and would leave new Anthropic() without messages from the second test on.
vi.mock("@anthropic-ai/sdk", () => ({
  default: function Anthropic() {
    return { messages: { create: (...args) => createMock(...args) } };
  },
}));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(async () => Buffer.from("fake-png")) };
});

import { getTelemetryCollector, resetTelemetryCollector } from "@routekit/telemetry/collector";
import { runQaAgentReview } from "../../packages/mcp-rks/src/server/qa-agent.mjs";
import { assessScreenshot } from "../../packages/mcp-rks/src/agents/visual.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const USAGE = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 };
const EXPECTED_TOKENS = { in: 900, out: 120, cacheRead: 50, cacheCreate: 25 };
const tokenEvents = (spy) => spy.mock.calls.filter((c) => c[0] === "llm.token_usage");
const QA_INPUT = { plan: { steps: [] }, tddApplicable: "none", testCode: "t", implementationCode: "i", projectId: "proj-qa" };
const CHECK = { url: "http://localhost:3000", criteria: "header is visible" };

let savedKey;
let emitSpy;
beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  createMock.mockReset();
  resetTelemetryCollector();
  emitSpy = vi.spyOn(getTelemetryCollector(), "emit");
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  vi.restoreAllMocks();
  resetTelemetryCollector();
});

describe("runQaAgentReview", () => {
  it("emits exactly one llm.token_usage per response with model, caller, projectId and cache fields", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ verdict: "pass", exploitableGaps: [] }) }],
      usage: USAGE,
    });
    const res = await runQaAgentReview(QA_INPUT);
    expect(res.ok).toBe(true);
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    const [, projectId, payload] = events[0];
    expect(projectId).toBe("proj-qa");
    expect(payload.clientName).toBe("anthropic-sdk");
    expect(payload.model).toBe("claude-sonnet-4-6");
    expect(payload.caller).toBe("qa-agent");
    expect(payload.tokens).toEqual(EXPECTED_TOKENS);
    expect(emitSpy.mock.calls.some((c) => c[0] === "qa_agent.review")).toBe(true);
  });

  it("a response without usage still succeeds and emits no llm.token_usage", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ verdict: "pass" }) }] });
    const res = await runQaAgentReview(QA_INPUT);
    expect(res.ok).toBe(true);
    expect(tokenEvents(emitSpy)).toHaveLength(0);
  });

  it("a throwing token emit does not turn a good review into ok false", async () => {
    emitSpy.mockImplementation((type) => {
      if (type === "llm.token_usage") throw new Error("collector down");
    });
    createMock.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ verdict: "pass", exploitableGaps: [] }) }],
      usage: USAGE,
    });
    const res = await runQaAgentReview(QA_INPUT);
    expect(res.ok).toBe(true);
  });
});

describe("assessScreenshot", () => {
  const VISION_REPLY = { content: [{ type: "text", text: JSON.stringify({ passed: true, observation: "header shown" }) }], usage: USAGE };

  it("emits exactly one llm.token_usage per response, attributed to the supplied projectId", async () => {
    createMock.mockResolvedValue(VISION_REPLY);
    const out = await assessScreenshot("/virtual/shot.png", CHECK, { projectId: "proj-vis" });
    expect(out.passed).toBe(true);
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    const [, projectId, payload] = events[0];
    expect(projectId).toBe("proj-vis");
    expect(payload.clientName).toBe("anthropic-sdk");
    expect(payload.model).toBe("claude-sonnet-4-6");
    expect(payload.caller).toBe("visual");
    expect(payload.tokens).toEqual(EXPECTED_TOKENS);
  });

  it("emits with a null projectId when no context is supplied", async () => {
    createMock.mockResolvedValue(VISION_REPLY);
    await assessScreenshot("/virtual/shot.png", CHECK);
    const events = tokenEvents(emitSpy);
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBeNull();
  });

  it("a throwing token emit still returns the parsed assessment", async () => {
    emitSpy.mockImplementation((type) => {
      if (type === "llm.token_usage") throw new Error("collector down");
    });
    createMock.mockResolvedValue(VISION_REPLY);
    const out = await assessScreenshot("/virtual/shot.png", CHECK, { projectId: "proj-vis" });
    expect(out.passed).toBe(true);
    expect(out.observation).not.toMatch(/Vision API assessment failed/);
  });
});

describe("runVisualAgent threads projectId into assessScreenshot", () => {
  // runVisualAgent needs a browser and a dev server, so its single assessScreenshot call
  // (visual.mjs:422) is asserted on the source. Without this, production visual events could
  // carry a null projectId while every behavioural test above passes.
  const SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/agents/visual.mjs"), "utf8");

  it("passes a context object carrying projectId as the third argument", () => {
    const calls = [...SRC.matchAll(/await assessScreenshot\(([^;]*)\);/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatch(/^captureResult\.screenshotPath,\s*checkPlanEntry,\s*\{[^}]*\bprojectId\b[^}]*\}$/);
  });

  it("imports getTelemetryCollector from @routekit/telemetry", () => {
    expect(SRC).toMatch(/^import \{ getTelemetryCollector \} from ['"]@routekit\/telemetry['"];$/m);
  });
});
