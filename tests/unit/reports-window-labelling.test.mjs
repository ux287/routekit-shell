/**
 * Witness for backlog.fix.telemetry-report-window-labelling.
 *
 * THE DEFECT: every report announced `period: "(all) to (all)"` regardless of the window
 * applied. `generateReport` resolved `since` into `effectiveStartDate`, filtered with it, then
 * handed `buildSummary` the RAW `startDate` — and handed the other three builders no dates at
 * all. So a windowed report was indistinguishable from an unfiltered one from its output.
 *
 * That is not cosmetic. Comparing a 7d summary against an unfiltered failures report produces
 * differences that look like contradictions and are only elapsed time; it happened, and three
 * fabricated "disagreements" were nearly reported as defects on the strength of it.
 *
 * Also covers the substring classification in buildTrends — the identical bug the sibling story
 * fixed in buildSummary. Leaving it would make the two builders disagree about what an
 * operation is.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateReport } from "@routekit/telemetry/reports";

const REPORT_TYPES = ["summary", "failures", "trends", "guardrails"];
const roots = [];

function makeProject(events, dateKey = "2026-09-01") {
  const root = mkdtempSync(path.join(os.tmpdir(), "reports-window-"));
  roots.push(root);
  const dir = path.join(root, ".rks", "telemetry");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(path.join(dir, `events-${dateKey}.jsonl`), lines + "\n");
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

const nowIso = () => new Date().toISOString();
const recent = [{ type: "plan.start", timestamp: nowIso() }];

describe("every report type labels the window it actually applied", () => {
  it("reports a resolved start boundary for a `since` window, on all four types", async () => {
    const root = makeProject(recent);
    const failures = [];
    for (const reportType of REPORT_TYPES) {
      const rep = await generateReport(root, { reportType, since: "24h" });
      const start = rep?.window?.start;
      if (typeof start !== "string") {
        failures.push(`${reportType}: window.start is ${JSON.stringify(start)}`);
        continue;
      }
      // The RESOLVED boundary, not merely a non-empty label. A bare `!== "(all) to (all)"`
      // would pass on any string; this pins the actual instant the filter used. Tolerance is
      // ±5s against an 86,400,000ms offset — ~0.006% — so it excludes `undefined`, `"(all)"`,
      // `Date.now()` and a 7d boundary alike.
      const delta = Date.now() - 86_400_000 - Date.parse(start);
      if (!(Math.abs(delta) < 5000)) {
        failures.push(`${reportType}: start off by ${delta}ms`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("a windowed report can never read '(all) to (all)'", async () => {
    const root = makeProject(recent);
    const rep = await generateReport(root, { reportType: "summary", since: "24h" });
    expect(rep.period).not.toBe("(all) to (all)");
    expect(rep.period.startsWith("(all)")).toBe(false);
  });

  it("an UNFILTERED report stays distinguishable and still reads '(all) to (all)'", async () => {
    const root = makeProject(recent);
    const rep = await generateReport(root, { reportType: "summary" });
    expect(rep.period).toBe("(all) to (all)");
    expect(rep.window.start).toBeNull();
    expect(rep.window.end).toBeNull();
  });
});

describe("the label reports what was APPLIED, not what was requested", () => {
  it("`since` wins over a co-supplied startDate, and the label says so", async () => {
    const root = makeProject(recent);
    const discarded = "2020-01-01T00:00:00.000Z";
    const rep = await generateReport(root, {
      reportType: "summary",
      since: "24h",
      startDate: discarded,
    });
    // generateReport prefers `since`. The discarded argument must not be reported as the window.
    expect(rep.window.start).not.toBe(discarded);
    expect(Math.abs(Date.now() - 86_400_000 - Date.parse(rep.window.start))).toBeLessThan(5000);
  });

  it("a MALFORMED since discards startDate — and the label reports the unfiltered truth", async () => {
    // resolveSince('banana') returns null, but the ternary tests `since` for truthiness, so the
    // explicit startDate is discarded and the report runs UNFILTERED. Reporting the discarded
    // argument would be the same false status this story removes, one layer up.
    //
    // The discard itself is a real defect. Correcting the ternary is a FILTERING change and is
    // deliberately out of scope here — this pins only that the label does not lie about it.
    const root = makeProject(recent);
    const rep = await generateReport(root, {
      reportType: "summary",
      since: "banana",
      startDate: "2020-01-01T00:00:00.000Z",
    });
    expect(rep.window.start).toBeNull();
    expect(rep.period).toBe("(all) to (all)");
  });

  it("an explicit startDate with no `since` is reported verbatim", async () => {
    const root = makeProject(recent);
    const start = "2020-01-01T00:00:00.000Z";
    const rep = await generateReport(root, { reportType: "summary", startDate: start });
    expect(rep.window.start).toBe(start);
    expect(rep.period.startsWith(start)).toBe(true);
  });

  it("lastNCycles is reported verbatim and only when applied", async () => {
    const root = makeProject(recent);
    const withCycles = await generateReport(root, { reportType: "summary", lastNCycles: 2 });
    expect(withCycles.window.lastNCycles).toBe(2);
    // It slices FILES, not time, so it has no resolvable boundary — reported as itself rather
    // than as a fabricated timestamp.
    expect(withCycles.window.start).toBeNull();

    const without = await generateReport(root, { reportType: "summary" });
    expect("lastNCycles" in without.window).toBe(false);
  });
});

describe("buildTrends classifies operations by exact type", () => {
  it("counts one per operation STARTED — terminals do not re-count the same operation", async () => {
    // DISCRIMINATING FIXTURE. An earlier version of this test supplied only `plan.start` and
    // `exec.start`, so it passed whether or not terminals were counted — it could not detect
    // the very thing it was named for. Two complete operations are modelled here: each emits a
    // start AND a terminal, so a counter that tallied all three canonical types would report
    // 2 per operation type instead of 1.
    const ts = "2026-09-01T10:00:00.000Z";
    const root = makeProject([
      { type: "plan.start", timestamp: ts },
      { type: "plan.complete", timestamp: ts },
      { type: "exec.start", timestamp: ts },
      { type: "exec.failed", timestamp: ts, payload: { reason: "dirty_tree" } },
      // decoys — real emitted types that merely CONTAIN the substring
      { type: "planning.snippets", timestamp: ts },
      { type: "planner.create_file_gate", timestamp: ts },
      { type: "plan.prompt.saved", timestamp: ts },
      { type: "exec.guardrails_off", timestamp: ts },
      { type: "exec.deps_installed", timestamp: ts },
    ]);
    const rep = await generateReport(root, { reportType: "trends" });
    // `daily` is an ARRAY — Object.values(...).sort(...)
    const totals = rep.daily.reduce(
      (acc, d) => ({ plans: acc.plans + d.plans, execs: acc.execs + d.execs }),
      { plans: 0, execs: 0 },
    );
    // ONE plan operation and ONE exec operation happened. Not 2 (start + terminal), and not 4
    // (every substring match). This is the same convention agentCalls uses in the same
    // function: count the `.started` event, once per operation.
    expect(totals.plans).toBe(1);
    expect(totals.execs).toBe(1);
  });
});
