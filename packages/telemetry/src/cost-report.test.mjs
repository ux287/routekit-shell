/**
 * Tests for generateCostReport
 * (backlog.feat.token-cost-report-core)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { generateCostReport } from "./cost-report.mjs";
import { calculateCost } from "./cost.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cost-report-test-"));
}

function writeTelemetryEvent(tmpDir, event) {
  const dir = path.join(tmpDir, ".rks", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events-2026-01-01.jsonl");
  fs.appendFileSync(file, JSON.stringify(event) + "\n");
}

function makeTokenEvent(overrides = {}) {
  return {
    id: overrides.id || `ev-${Math.random().toString(36).slice(2)}`,
    type: overrides.type || "plan.complete",
    timestamp: overrides.timestamp || "2026-01-01T00:00:00Z",
    projectId: "routekit-shell",
    correlationId: overrides.correlationId || "corr-1",
    runId: null,
    payload: {
      storyId: overrides.storyId || "backlog.feat.test",
      tokens: overrides.tokens || { in: 100, out: 50, cacheRead: 0 },
      ...(overrides.payloadExtra || {}),
    },
    context: {},
  };
}

describe("generateCostReport — noData sentinel", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns noData:true when telemetry dir does not exist", () => {
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.ok).toBe(true);
    expect(res.noData).toBe(true);
  });

  it("returns noData:true when events have no token data", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ev-1", type: "plan.start", timestamp: "2026-01-01T00:00:00Z",
      payload: { storyId: "backlog.feat.test" }, context: {},
    });
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.noData).toBe(true);
  });
});

describe("generateCostReport — basic token aggregation", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("sums in+out tokens into rawCost", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 300, out: 100, cacheRead: 0 } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "ev-2", tokens: { in: 200, out: 50, cacheRead: 0 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.rawCost).toBe(650);
    expect(res.totalEvents).toBe(2);
  });

  it("computes cacheRatio = cacheRead / (in + cacheRead)", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 50, cacheRead: 100 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.cacheRatio).toBeCloseTo(0.5);
  });

  it("computes cacheRatio=0 when no cache reads", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 50, cacheRead: 0 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.cacheRatio).toBe(0);
  });
});

describe("generateCostReport — phase grouping", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("groups events by first segment of type", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e1", type: "plan.start", tokens: { in: 100, out: 50 } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e2", type: "plan.complete", tokens: { in: 200, out: 80 } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e3", type: "exec.complete", tokens: { in: 50, out: 20 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.phases.plan).toBeDefined();
    expect(res.phases.plan.calls).toBe(2);
    expect(res.phases.plan.tokens).toBe(430);
    expect(res.phases.exec).toBeDefined();
    expect(res.phases.exec.calls).toBe(1);
    expect(res.phases.exec.tokens).toBe(70);
  });
});

describe("generateCostReport — health bands", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns green when wasteRatio is 0", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 1000, out: 0 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.healthBand).toBe("green");
    expect(res.wasteRatio).toBe(0);
  });

  it("returns red when all events are failed_plan waste (wasteRatio=1.0)", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e1", type: "plan.failed", tokens: { in: 500, out: 200 } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e2", type: "plan.failed", tokens: { in: 300, out: 100 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.healthBand).toBe("red");
    expect(res.wasteRatio).toBe(1);
  });
});

describe("generateCostReport — waste categorization", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("categorizes plan.failed events as failed_plan waste", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e1", type: "plan.failed", tokens: { in: 100, out: 50 } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "e2", type: "plan.complete", tokens: { in: 200, out: 80 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    const failedPlan = res.wasteEvents.filter(w => w.type === "failed_plan");
    expect(failedPlan.length).toBe(1);
  });

  it("categorizes exec.failed followed by exec.complete on same correlationId as failed_exec", () => {
    const cid = "corr-exec";
    writeTelemetryEvent(tmpDir, {
      id: "ef", type: "exec.failed", timestamp: "2026-01-01T00:01:00Z",
      correlationId: cid,
      payload: { storyId: "backlog.feat.test", tokens: { in: 100, out: 30 } }, context: {},
    });
    writeTelemetryEvent(tmpDir, {
      id: "ec", type: "exec.complete", timestamp: "2026-01-01T00:02:00Z",
      correlationId: cid,
      payload: { storyId: "backlog.feat.test", tokens: { in: 100, out: 40 } }, context: {},
    });
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    const failedExec = res.wasteEvents.filter(w => w.type === "failed_exec");
    expect(failedExec.length).toBe(1);
    expect(failedExec[0].eventId).toBe("ef");
  });

  it("does NOT flag exec.failed without a subsequent exec.complete", () => {
    writeTelemetryEvent(tmpDir, {
      id: "ef", type: "exec.failed", timestamp: "2026-01-01T00:01:00Z",
      correlationId: "corr-solo",
      payload: { storyId: "backlog.feat.test", tokens: { in: 100, out: 30 } }, context: {},
    });
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    const failedExec = res.wasteEvents.filter(w => w.type === "failed_exec");
    expect(failedExec.length).toBe(0);
  });

  it("categorizes plan.complete ok:false followed by refine.start as retry waste", () => {
    const cid = "corr-retry";
    writeTelemetryEvent(tmpDir, {
      id: "pc", type: "plan.complete", timestamp: "2026-01-01T00:01:00Z",
      correlationId: cid,
      payload: { storyId: "backlog.feat.test", ok: false, tokens: { in: 200, out: 80 } }, context: {},
    });
    writeTelemetryEvent(tmpDir, {
      id: "rs", type: "refine.start", timestamp: "2026-01-01T00:02:00Z",
      correlationId: cid,
      payload: { storyId: "backlog.feat.test" }, context: {},
    });
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "pc2", correlationId: "other", tokens: { in: 100, out: 50 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    const retry = res.wasteEvents.filter(w => w.type === "retry");
    expect(retry.length).toBe(1);
    expect(retry[0].eventId).toBe("pc");
  });
});

describe("generateCostReport — scope=commit", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("filters events by commitSha via payload.commitSha", () => {
    writeTelemetryEvent(tmpDir, {
      id: "e1", type: "plan.complete", timestamp: "2026-01-01T00:00:00Z",
      correlationId: "c1",
      payload: { commitSha: "abc12345", tokens: { in: 300, out: 100 } }, context: {},
    });
    writeTelemetryEvent(tmpDir, {
      id: "e2", type: "plan.complete", timestamp: "2026-01-01T00:00:00Z",
      correlationId: "c2",
      payload: { commitSha: "other000", tokens: { in: 999, out: 999 } }, context: {},
    });
    const res = generateCostReport(tmpDir, { scope: "commit", commitSha: "abc12345" });
    expect(res.rawCost).toBe(400);
    expect(res.totalEvents).toBe(1);
  });

  it("matches events when commitSha in telemetry is the short (8-char) prefix", () => {
    writeTelemetryEvent(tmpDir, {
      id: "e1", type: "plan.complete", timestamp: "2026-01-01T00:00:00Z",
      correlationId: "c1",
      payload: { commitSha: "abc12345", tokens: { in: 200, out: 80 } }, context: {},
    });
    const res = generateCostReport(tmpDir, { scope: "commit", commitSha: "abc123451234abcd" });
    expect(res.rawCost).toBe(280);
  });
});

describe("generateCostReport — cache economics + model mix (backlog.feat.cost-report-cache-and-model-rollup)", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("NEW cacheHitRate uses the INPUT-SIDE denominator (in + cacheRead + cacheCreate); per-story cacheRatio stays additive", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 20, cacheRead: 100, cacheCreate: 100 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.cacheHitRate).toBeCloseTo(100 / 300, 5);   // input-side incl. cacheCreate
    expect(res.cacheRatio).toBeCloseTo(100 / 200, 5);       // preserved: cacheRead/(in+cacheRead)
  });

  it("surfaces cacheCreateTotal + write/read/uncached split — cacheCreate no longer dropped", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 20, cacheRead: 50, cacheCreate: 30 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.cacheCreateTotal).toBe(30);
    expect(res.cacheBreakdown).toEqual({ write: 30, read: 50, uncached: 100 });
  });

  it("DIVIDE-BY-ZERO: zero input-side tokens → cacheHitRate 0 (finite)", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 0, out: 10, cacheRead: 0, cacheCreate: 0 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.cacheHitRate).toBe(0);
    expect(Number.isFinite(res.cacheHitRate)).toBe(true);
  });

  it("byModel OVERALL breaks down haiku vs sonnet, priced via calculateCost (single pricing source)", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "h1", tokens: { in: 1000000, out: 0 }, payloadExtra: { model: "claude-haiku-4-5-20251001", agent: "planner" } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "s1", tokens: { in: 1000000, out: 0 }, payloadExtra: { model: "claude-sonnet-4-6", agent: "research" } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.byModel["claude-haiku-4-5-20251001"].calls).toBe(1);
    expect(res.byModel["claude-haiku-4-5-20251001"].cost).toBeCloseTo(calculateCost("claude-haiku-4-5-20251001", 1000000, 0).totalCost, 4);
    expect(res.byModel["claude-sonnet-4-6"].cost).toBeCloseTo(calculateCost("claude-sonnet-4-6", 1000000, 0).totalCost, 4);
    const shareSum = res.byModel["claude-haiku-4-5-20251001"].share + res.byModel["claude-sonnet-4-6"].share;
    expect(shareSum).toBeCloseTo(1, 5);
  });

  it("byModel is also broken down PER-AGENT (byAgentModel), priced via calculateCost", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "h1", tokens: { in: 1000000, out: 0 }, payloadExtra: { model: "claude-haiku-4-5-20251001", agent: "planner" } }));
    writeTelemetryEvent(tmpDir, makeTokenEvent({ id: "s1", tokens: { in: 1000000, out: 0 }, payloadExtra: { model: "claude-sonnet-4-6", agent: "research" } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.byAgentModel.planner["claude-haiku-4-5-20251001"].calls).toBe(1);
    expect(res.byAgentModel.research["claude-sonnet-4-6"].calls).toBe(1);
    expect(res.byAgentModel.planner["claude-haiku-4-5-20251001"].cost).toBeCloseTo(calculateCost("claude-haiku-4-5-20251001", 1000000, 0).totalCost, 4);
  });

  it("UNTAGGED model → 'unknown' bucket, never misattributed to a real model", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 50 } })); // no payload.model
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.byModel.unknown).toBeDefined();
    expect(res.byModel.unknown.calls).toBe(1);
    expect(res.byModel["claude-haiku-4-5-20251001"]).toBeUndefined();
  });
});

describe("generateCostReport — markdown format", () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("includes markdown block when format=markdown", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 500, out: 200 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test", format: "markdown" });
    expect(res.markdown).toBeDefined();
    expect(res.markdown).toContain("Token Cost & Efficiency");
    expect(res.markdown).toContain("700");
  });

  it("does NOT include markdown block when format=json (default)", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 100, out: 50 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test" });
    expect(res.markdown).toBeUndefined();
  });

  it("markdown block contains health band emoji", () => {
    writeTelemetryEvent(tmpDir, makeTokenEvent({ tokens: { in: 1000, out: 0 } }));
    const res = generateCostReport(tmpDir, { scope: "story", storyId: "backlog.feat.test", format: "markdown" });
    expect(res.markdown).toContain("🟢");
  });
});
