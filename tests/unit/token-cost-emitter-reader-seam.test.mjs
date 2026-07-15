/**
 * Regression witness for the emitter -> reader SEAM (backlog.fix.token-cost-telemetry-null-schema).
 *
 * The "dashboard cost reports always null" bug was a false-green: the hot-path token
 * emitter (packages/mcp-rks/src/llm/clients.mjs) wrote FLAT payload fields
 * (inputTokens/outputTokens/...), while BOTH readers gate on nested `payload.tokens != null`
 * and read tokens.{in,out,cacheRead}. Every real event was dropped at the filter. The
 * existing unit tests never caught it because each half was tested against a hand-authored
 * fixture in isolation — nobody fed ACTUAL emitter output through a reader.
 *
 * This witness drives the real emitter, captures the REAL emitted `llm.token_usage`
 * payload (the 3rd arg to collector.emit), and feeds it verbatim through:
 *   1. the dashboard token-costs filter contract (`payload?.tokens != null` + tokens.{in,out})
 *   2. the cost-report aggregator (generateCostReport) reading from a real telemetry dir
 * asserting a NON-NULL, correct cost. On the pre-fix flat emitter, `payload.tokens` is
 * undefined -> the dashboard filter drops it and generateCostReport returns noData -> RED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { callAnthropicChatWithUsage } from "../../packages/mcp-rks/src/llm/clients.mjs";
import {
  getTelemetryCollector,
  resetTelemetryCollector,
} from "../../packages/mcp-rks/src/server/telemetry/collector.mjs";
import { generateCostReport } from "../../packages/mcp-rks/src/server/telemetry/cost-report.mjs";

function makeFetchResponse({ text = "ok", usage = null, status = 200 } = {}) {
  return {
    ok: status < 400,
    status,
    json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage }),
    text: async () => "error body",
  };
}

// Mirror of the dashboard token-costs reader contract
// (packages/telemetry-dashboard/vite-plugin-telemetry-api.ts L446 + L455-460): kept in
// this test so a shape divergence between emitter and dashboard reader reddens here.
function dashboardReadsEvent(ev) {
  if (ev.payload?.tokens == null) return null; // the exact kill-switch filter
  const storyId = ev.payload?.problemId || "(off-rail)";
  const t = ev.payload.tokens;
  return { storyId, rawCost: (t.in || 0) + (t.out || 0), cacheRead: t.cacheRead || 0 };
}

describe("token-cost emitter -> reader SEAM (real emitter output through both readers)", () => {
  const PROBLEM_ID = "backlog.fix.token-cost-telemetry-null-schema";
  let originalFetch;
  let emitSpy;
  let tmpDir;

  beforeEach(() => {
    originalFetch = global.fetch;
    resetTelemetryCollector();
    emitSpy = vi.spyOn(getTelemetryCollector(), "emit");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-witness-"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    resetTelemetryCollector();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function captureEmittedTokenPayload() {
    const call = emitSpy.mock.calls.find(c => c[0] === "llm.token_usage");
    expect(call, "emitter must emit an llm.token_usage event").toBeDefined();
    return call[2];
  }

  it("emitter output survives the dashboard `payload.tokens != null` filter and yields a non-null cost", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse({ usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } }),
    );

    await callAnthropicChatWithUsage({
      client: { apiKey: "k", baseURL: "https://api.anthropic.com" },
      model: "m",
      prompt: "p",
      context: { problemId: PROBLEM_ID, projectId: "routekit-shell" },
    });

    const payload = captureEmittedTokenPayload();

    // The exact contract that was failing: the reader kill-switch.
    // Pre-fix (flat emitter) this is undefined -> event dropped -> null cost.
    expect(payload.tokens, "emitted payload must carry the nested tokens object the readers require").not.toBeNull();
    expect(payload.tokens).toBeDefined();

    const read = dashboardReadsEvent({ payload });
    expect(read, "dashboard reader must not drop the real emitter event").not.toBeNull();
    expect(read.rawCost).toBe(280); // 200 in + 80 out
    expect(read.cacheRead).toBe(30);
    expect(read.storyId).toBe(PROBLEM_ID); // buckets to the story, not '(off-rail)'
  });

  it("emitter output flows through generateCostReport to a non-null story cost", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeFetchResponse({ usage: { input_tokens: 150, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    );

    await callAnthropicChatWithUsage({
      client: { apiKey: "k", baseURL: "https://api.anthropic.com" },
      model: "m",
      prompt: "p",
      context: { problemId: PROBLEM_ID, projectId: "routekit-shell" },
    });

    const payload = captureEmittedTokenPayload();

    // Persist the REAL emitted payload as a telemetry event and read it back through the
    // production aggregator — the true end-to-end seam.
    const telDir = path.join(tmpDir, ".rks", "telemetry");
    fs.mkdirSync(telDir, { recursive: true });
    fs.appendFileSync(
      path.join(telDir, "events-2026-01-01.jsonl"),
      JSON.stringify({ id: "seam-1", type: "plan.complete", timestamp: "2026-01-01T00:00:00Z", payload }) + "\n",
    );

    const report = generateCostReport(tmpDir, { scope: "story", storyId: PROBLEM_ID });
    expect(report.ok).toBe(true);
    expect(report.noData, "real emitter output must NOT be filtered out as noData").not.toBe(true);
    expect(report.rawCost).toBe(200); // 150 in + 50 out
  });
});
