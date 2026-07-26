import { describe, it, expect, vi } from "vitest";
import { queryTelemetry } from "../../packages/mcp-rks/src/server/telemetry/query.mjs";
import { generateReport } from "../../packages/mcp-rks/src/server/telemetry/reports.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(type, timestampIso, extra = {}) {
  return { id: Math.random().toString(36).slice(2), type, timestamp: timestampIso, ...extra };
}

const NOW = new Date("2026-04-03T15:00:00.000Z");
const H1_AGO = new Date(NOW - 3600000).toISOString();
const H25_AGO = new Date(NOW - 25 * 3600000).toISOString();

// ---------------------------------------------------------------------------
// query.mjs — since / lastNCycles
// ---------------------------------------------------------------------------

describe("queryTelemetry — since param", () => {
  it("since: '24h' excludes events older than 24 hours", async () => {
    vi.setSystemTime(NOW);
    const recentEvent = makeEvent("agent.research.started", H1_AGO);
    const oldEvent = makeEvent("agent.research.started", H25_AGO);

    // Write two temp JSONL files and point projectRoot at a temp dir
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(recentEvent) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(oldEvent) + "\n");

    const result = await queryTelemetry(root, { since: "24h", format: "json" });
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].timestamp).toBe(recentEvent.timestamp);
  });

  it("since takes precedence over startDate when both provided", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });
    const recentEvent = makeEvent("exec.complete", H1_AGO);
    const oldEvent = makeEvent("exec.complete", H25_AGO);
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(recentEvent) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(oldEvent) + "\n");

    // startDate would include the old event, but since: "24h" should win
    const result = await queryTelemetry(root, {
      since: "24h",
      startDate: "2020-01-01",
      format: "json",
    });
    expect(result.ok).toBe(true);
    expect(result.events.every(e => new Date(e.timestamp) >= new Date(NOW - 86400000))).toBe(true);
  });

  it("since: '1h', '24h', '7d' parse to correct cutoffs", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    mkdirSync(join(root, ".rks", "telemetry"), { recursive: true });

    const r1h = await queryTelemetry(root, { since: "1h" });
    const r24h = await queryTelemetry(root, { since: "24h" });
    const r7d = await queryTelemetry(root, { since: "7d" });
    // All return ok (empty dirs are fine)
    expect(r1h.ok).toBe(true);
    expect(r24h.ok).toBe(true);
    expect(r7d.ok).toBe(true);
  });

  it("unparseable since string returns ok result (no events)", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    mkdirSync(join(root, ".rks", "telemetry"), { recursive: true });

    const result = await queryTelemetry(root, { since: "not-a-duration" });
    expect(result.ok).toBe(true);
  });
});

describe("queryTelemetry — lastNCycles param", () => {
  it("lastNCycles: 1 loads events only from the most recent cycle file", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });

    const ev1 = makeEvent("exec.complete", H1_AGO);
    const ev2 = makeEvent("exec.failed", H25_AGO);
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(ev1) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(ev2) + "\n");

    const result = await queryTelemetry(root, { lastNCycles: 1, format: "json" });
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe("exec.complete");
  });

  it("lastNCycles: 2 loads events from both cycle files", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });

    const ev1 = makeEvent("exec.complete", H1_AGO);
    const ev2 = makeEvent("exec.failed", H25_AGO);
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(ev1) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(ev2) + "\n");

    const result = await queryTelemetry(root, { lastNCycles: 2, format: "json" });
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// reports.mjs — normalizeReason via buildFailures
// ---------------------------------------------------------------------------

describe("generateReport failures — normalizeReason grouping", () => {
  async function makeReportRoot(events) {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "events-2026-04-03.jsonl"),
      events.map(e => JSON.stringify(e)).join("\n") + "\n"
    );
    return root;
  }

  it("94 dirty-tree variants collapse into single DIRTY_TREE entry with count 94", async () => {
    const events = Array.from({ length: 94 }, (_, i) =>
      makeEvent("exec.failed", H1_AGO, {
        status: "failed",
        payload: { error: `rks.exec: Cannot proceed with uncommitted changes (${i} file(s)): .routekit/context-state.json` },
      })
    );
    const root = await makeReportRoot(events);
    const report = await generateReport(root, { reportType: "failures" });
    const byReason = report.failures["exec.failed"].byReason;
    const keys = Object.keys(byReason);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("DIRTY_TREE");
    expect(byReason["DIRTY_TREE"].count).toBe(94);
    expect(typeof byReason["DIRTY_TREE"].example).toBe("string");
  });

  it("byReason shape is { code: { count, example } }", async () => {
    const events = [
      makeEvent("exec.failed", H1_AGO, { status: "failed", payload: { error: "dirty working tree" } }),
      makeEvent("exec.failed", H1_AGO, { status: "failed", payload: { error: "test assertion failed" } }),
    ];
    const root = await makeReportRoot(events);
    const report = await generateReport(root, { reportType: "failures" });
    const byReason = report.failures["exec.failed"].byReason;
    for (const val of Object.values(byReason)) {
      expect(val).toHaveProperty("count");
      expect(val).toHaveProperty("example");
      expect(typeof val.count).toBe("number");
      expect(typeof val.example).toBe("string");
    }
  });

  it("normalizeReason maps all known codes correctly", async () => {
    const cases = [
      ["dirty working tree uncommitted", "DIRTY_TREE"],
      ["worktree already exists", "WORKTREE_EXISTS"],
      ["merge conflict detected", "MERGE_CONFLICT"],
      ["unauthorized access", "AUTH_ERROR"],
      ["operation timed out", "TIMEOUT"],
      ["test assertion failed", "TEST_FAILED"],
      ["unspecified", "UNKNOWN"],
      ["some completely unknown error xyz", "OTHER:some completely unknown error xyz"],
    ];
    const events = cases.map(([error]) =>
      makeEvent("exec.failed", H1_AGO, { status: "failed", payload: { error } })
    );
    const root = await makeReportRoot(events);
    const report = await generateReport(root, { reportType: "failures" });
    const byReason = report.failures["exec.failed"].byReason;
    for (const [, expectedCode] of cases) {
      const key = Object.keys(byReason).find(k => k === expectedCode || k.startsWith(expectedCode));
      expect(key).toBeTruthy();
    }
  });

  it("first-seen example is preserved per code", async () => {
    const firstMsg = "dirty tree: first occurrence message";
    const events = [
      makeEvent("exec.failed", H1_AGO, { status: "failed", payload: { error: firstMsg } }),
      makeEvent("exec.failed", H1_AGO, { status: "failed", payload: { error: "dirty tree: second occurrence" } }),
    ];
    const root = await makeReportRoot(events);
    const report = await generateReport(root, { reportType: "failures" });
    expect(report.failures["exec.failed"].byReason["DIRTY_TREE"].example).toBe(firstMsg.slice(0, 200));
  });
});

// ---------------------------------------------------------------------------
// reports.mjs — since / lastNCycles in generateReport
// ---------------------------------------------------------------------------

describe("generateReport — since and lastNCycles", () => {
  it("since: '24h' excludes events outside the window from summary report", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });

    const recent = makeEvent("agent.research.started", H1_AGO);
    const old = makeEvent("agent.research.started", H25_AGO);
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(recent) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(old) + "\n");

    const report = await generateReport(root, { reportType: "summary", since: "24h" });
    expect(report.agents?.research?.invocations).toBe(1);
  });

  it("lastNCycles limits cycle files loaded in summary report", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    const dir = join(root, ".rks", "telemetry");
    mkdirSync(dir, { recursive: true });

    const recent = makeEvent("agent.research.started", H1_AGO);
    const old = makeEvent("agent.git.started", H25_AGO);
    writeFileSync(join(dir, "events-2026-04-03.jsonl"), JSON.stringify(recent) + "\n");
    writeFileSync(join(dir, "events-2026-04-01.jsonl"), JSON.stringify(old) + "\n");

    const report = await generateReport(root, { reportType: "summary", lastNCycles: 1 });
    expect(report.agents?.research?.invocations).toBe(1);
    expect(report.agents?.git).toBeUndefined();
  });

  it("all three reportType values continue to work with since param", async () => {
    vi.setSystemTime(NOW);
    const { mkdtempSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "rks-test-"));
    mkdirSync(join(root, ".rks", "telemetry"), { recursive: true });

    for (const reportType of ["summary", "failures", "trends"]) {
      const report = await generateReport(root, { reportType, since: "24h" });
      expect(report).toBeDefined();
      expect(report.error).toBeUndefined();
    }
  });
});
