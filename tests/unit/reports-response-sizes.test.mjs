// backlog.feat.mcp-tool-response-size-telemetry — generateReport({ reportType: "response_sizes" })
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateReport } from "@routekit/telemetry/reports";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

// One events-<date>.jsonl per event date, so file naming never disagrees with event timestamps.
function makeProject(events) {
  const root = mkdtempSync(path.join(os.tmpdir(), "reports-response-sizes-"));
  roots.push(root);
  const dir = path.join(root, ".rks", "telemetry");
  mkdirSync(dir, { recursive: true });
  const byDate = {};
  for (const e of events) (byDate[e.timestamp.slice(0, 10)] ||= []).push(JSON.stringify(e));
  for (const [d, lines] of Object.entries(byDate)) writeFileSync(path.join(dir, `events-${d}.jsonl`), lines.join("\n") + "\n");
  return root;
}
const nowIso = () => new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const sized = (tool, bytes, { type = "mcp.tool.complete", ts = nowIso(), tokens } = {}) => ({
  type, timestamp: ts,
  payload: { tool, ok: type === "mcp.tool.complete", latencyMs: 1, responseBytes: bytes, responseChars: bytes, approxTokens: tokens ?? Math.ceil(bytes / 4), contentBlocks: 1 },
});
const legacy = (tool, ts = nowIso()) => ({ type: "mcp.tool.complete", timestamp: ts, payload: { tool, ok: true, latencyMs: 1 } });
const ROW_KEYS = ["calls", "callsOver10kTokens", "maxBytes", "meanBytes", "p95Bytes", "tool", "totalApproxTokens", "totalBytes"];

describe("response_sizes report", () => {
  it("groups complete + failed events by tool, rows sorted by totalBytes desc, exact columns", async () => {
    const root = makeProject([sized("A", 100), sized("A", 300), sized("B", 1000), sized("C", 50, { type: "mcp.tool.failed" }), { type: "plan.start", timestamp: nowIso(), payload: { responseBytes: 9999 } }]);
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.tools.map((r) => r.tool)).toEqual(["B", "A", "C"]);
    for (const row of rep.tools) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(rep.tools.find((r) => r.tool === "A")).toEqual({ tool: "A", calls: 2, totalBytes: 400, meanBytes: 200, p95Bytes: 300, maxBytes: 300, totalApproxTokens: 100, callsOver10kTokens: 0 });
    expect(rep.tools.find((r) => r.tool === "C")).toMatchObject({ calls: 1, totalBytes: 50 });
    expect(rep.totalBytes).toBe(1450);
    expect(rep.totalApproxTokens).toBe(25 + 75 + 250 + 13);
  });

  it("p95Bytes is nearest-rank", async () => {
    const root = makeProject(Array.from({ length: 20 }, (_, i) => sized("D", i + 1)));
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.tools[0]).toMatchObject({ tool: "D", calls: 20, p95Bytes: 19, maxBytes: 20 });
  });

  it("callsOver10kTokens counts approxTokens strictly greater than 10000, per row and in total", async () => {
    const root = makeProject([sized("E", 40000, { tokens: 10000 }), sized("E", 40004, { tokens: 10001 }), sized("F", 100000, { tokens: 25000 })]);
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.tools.find((r) => r.tool === "E").callsOver10kTokens).toBe(1);
    expect(rep.tools.find((r) => r.tool === "F").callsOver10kTokens).toBe(1);
    expect(rep.callsOver10kTokens).toBe(2);
  });

  it("counts pre-change events lacking responseBytes in eventsWithoutSize, never as zero-sized calls", async () => {
    const root = makeProject([sized("A", 100), legacy("A"), legacy("L")]);
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.eventsWithoutSize).toBe(2);
    expect(rep.tools.find((r) => r.tool === "A")).toMatchObject({ calls: 1, totalBytes: 100 });
    expect(rep.tools.find((r) => r.tool === "L")).toBeUndefined();
  });

  it("a thrown-call mcp.tool.failed event (error, no size keys) counts in eventsWithoutSize and is excluded from row aggregates", async () => {
    const thrown = (tool) => ({ type: "mcp.tool.failed", timestamp: nowIso(), payload: { tool, ok: false, latencyMs: 1, error: "boom" } });
    const root = makeProject([sized("A", 100), thrown("A"), thrown("T")]);
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.eventsWithoutSize).toBe(2);
    expect(rep.tools.find((r) => r.tool === "A")).toEqual({ tool: "A", calls: 1, totalBytes: 100, meanBytes: 100, p95Bytes: 100, maxBytes: 100, totalApproxTokens: 25, callsOver10kTokens: 0 });
    expect(rep.tools.find((r) => r.tool === "T")).toBeUndefined();
    expect([rep.totalBytes, rep.totalApproxTokens, rep.callsOver10kTokens]).toEqual([100, 25, 0]);
  });

  it("empty telemetry yields no rows and zero totals", async () => {
    const root = makeProject([{ type: "plan.start", timestamp: nowIso() }]);
    const rep = await generateReport(root, { reportType: "response_sizes" });
    expect(rep.tools).toEqual([]);
    expect([rep.totalBytes, rep.totalApproxTokens, rep.callsOver10kTokens, rep.eventsWithoutSize]).toEqual([0, 0, 0, 0]);
  });

  it("applies since windowing and reports the resolved window", async () => {
    const root = makeProject([sized("OLD", 5000, { ts: daysAgo(3) }), sized("NEW", 10)]);
    const rep = await generateReport(root, { reportType: "response_sizes", since: "24h" });
    expect(rep.tools.map((r) => r.tool)).toEqual(["NEW"]);
    expect(typeof rep.window.start).toBe("string");
  });

  it("applies startDate/endDate windowing", async () => {
    const root = makeProject([sized("OLD", 5000, { ts: daysAgo(3) }), sized("NEW", 10)]);
    const rep = await generateReport(root, { reportType: "response_sizes", startDate: daysAgo(5), endDate: daysAgo(1) });
    expect(rep.tools.map((r) => r.tool)).toEqual(["OLD"]);
  });

  it("accepts lastNCycles like the other report types", async () => {
    const root = makeProject([sized("A", 100)]);
    const rep = await generateReport(root, { reportType: "response_sizes", lastNCycles: 1 });
    expect(rep.error).toBeUndefined();
    expect(Array.isArray(rep.tools)).toBe(true);
    expect(rep.window).toBeDefined();
  });
});
