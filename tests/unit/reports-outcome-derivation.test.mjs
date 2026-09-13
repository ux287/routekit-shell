/**
 * Witness for backlog.fix.telemetry-report-outcome-derivation.
 *
 * THE DEFECT, in the instrument you would use to detect this project's dominant defect class.
 * buildSummary classified plan operations two ways, both wrong, and they compounded:
 *
 *   1. `type.includes("plan")` — a SUBSTRING test. Every event whose type merely contains
 *      "plan" was counted as a plan operation, including `planning.snippets` and
 *      `planner.create_file_gate`, which are not operations at all.
 *   2. `isSuccess`/`isFailure` read a TOP-LEVEL `status`/`outcome`/`result` field that
 *      `createEvent` has never emitted, so both were permanently false.
 *
 * Measured against a real store (routekit-growth): the 22 plan-substring event types summed to
 * exactly the reported total of 1148, while `plan.start` was 69. Reported success and failed
 * were 0 and 0, rendering `successRate: "0%"` — which reads as "every plan failed" and actually
 * meant "no plan outcome was ever classified". The true figures were 69 / 41 / 22, i.e. 59%.
 *
 * Exec sat in the same report classifying correctly, by exact type. It is both the exemplar and
 * the regression guard here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { generateReport } from "@routekit/telemetry/reports";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TS = "2026-09-01T12:00:00.000Z";

const roots = [];
function makeProject(events) {
  const root = mkdtempSync(path.join(os.tmpdir(), "reports-outcome-"));
  roots.push(root);
  const dir = path.join(root, ".rks", "telemetry");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify({ timestamp: TS, ...e })).join("\n");
  writeFileSync(path.join(dir, "events-2026-09-01.jsonl"), lines + "\n");
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

// Known exactly: 4 plan.start, 2 plan.complete, 2 plan.failed → 0 unaccounted.
// The DECOYS are load-bearing. Both are real emitted types that contain "plan" as a substring
// but are not plan operations. A fixture of only `plan.*` types passes with the defect fully
// present, because the substring test and the exact-type test agree on that input.
const EVENTS = [
  { type: "plan.start" }, { type: "plan.start" }, { type: "plan.start" }, { type: "plan.start" },
  { type: "plan.complete" }, { type: "plan.complete" },
  { type: "plan.failed", payload: { reason: "structural_create_unauthorable", failureClass: "structural" } },
  { type: "plan.failed", payload: { reason: "dirty_tree" } },
  // decoys — 5 events that must NOT be counted as plan operations
  { type: "planning.snippets" }, { type: "planning.snippets" },
  { type: "planner.create_file_gate" },
  { type: "plan.retry.exhausted" },
  { type: "plan.prompt.saved" },
  // exec — the exemplar, already correct, must stay correct
  { type: "exec.start" }, { type: "exec.start" }, { type: "exec.start" },
  { type: "exec.complete" }, { type: "exec.complete" },
  { type: "exec.failed", payload: { reason: "dirty_tree" } },
];

const summaryOf = (events) => generateReport(makeProject(events), { reportType: "summary" });
const failuresOf = (events) => generateReport(makeProject(events), { reportType: "failures" });

describe("plan operations are counted by exact type, not substring", () => {
  it("counts plan.start as the total — decoys are excluded", async () => {
    const { operations } = await summaryOf(EVENTS);
    // 4, not 13 — pre-fix every plan-substring event in this fixture was counted.
    expect(operations.plan.total).toBe(4);
  });

  it("derives success and failed from the terminal events actually emitted", async () => {
    const { operations } = await summaryOf(EVENTS);
    expect(operations.plan.success).toBe(2);
    // plan.retry.exhausted is NOT a failure — it has its own terminal semantics.
    expect(operations.plan.failed).toBe(2);
  });

  it("surfaces starts with no terminal rather than silently absorbing them", async () => {
    const { operations } = await summaryOf(EVENTS);
    expect(operations.plan.unaccounted).toBe(0);
  });

  it("exec is unchanged — the exemplar is also the regression guard", async () => {
    const { operations } = await summaryOf(EVENTS);
    expect(operations.exec.total).toBe(3);
    expect(operations.exec.success).toBe(2);
    expect(operations.exec.failed).toBe(1);
    expect(operations.exec.unaccounted).toBe(0);
  });
});

describe("a rate is never reported over zero classified outcomes", () => {
  it("computes a real rate when outcomes were classified", async () => {
    const { operations } = await summaryOf(EVENTS);
    expect(operations.plan.successRate).toBe("50%");
  });

  it("divides by CLASSIFIED outcomes, not by starts", async () => {
    // DISCRIMINATING FIXTURE. The main EVENTS set is 2 success / 2 failed / 4 started, where
    // success/classified and success/total both give 50% — so it cannot tell the two formulas
    // apart, and an earlier build passed it while dividing by the start count. This one is
    // asymmetric on purpose: 2 succeeded, 1 failed, 10 started.
    //   success / classified = 2/3  = 67%   <- a success rate
    //   success / total      = 2/10 = 20%   <- unaccounted operations counted as failures
    const events = [
      ...Array.from({ length: 10 }, () => ({ type: "plan.start" })),
      { type: "plan.complete" }, { type: "plan.complete" },
      { type: "plan.failed", payload: { reason: "dirty_tree" } },
    ];
    const { operations } = await summaryOf(events);
    expect(operations.plan.total).toBe(10);
    expect(operations.plan.unaccounted).toBe(7);
    expect(operations.plan.successRate).toBe("67%");
  });

  it("applies the same rule to agent rows", async () => {
    const { agents } = await summaryOf([
      ...Array.from({ length: 10 }, () => ({ type: "agent.research.started" })),
      { type: "agent.research.complete" }, { type: "agent.research.complete" },
      { type: "agent.research.failed" },
    ]);
    expect(agents.research.successRate).toBe("67%");
    expect(agents.research.unaccounted).toBe(7);
  });

  it("returns null for an agent row with no terminal events either", async () => {
    const { agents } = await summaryOf([{ type: "agent.research.started" }]);
    expect(agents.research.successRate).toBeNull();
    expect(agents.research.unaccounted).toBe(1);
  });

  it("returns null, NOT '0%', when nothing was classified", async () => {
    // "0%" is indistinguishable from total failure. That indistinguishability IS the defect:
    // it is what made 1148 plans with 41 successes read as a dead system.
    const { operations } = await summaryOf([{ type: "plan.start" }, { type: "plan.start" }]);
    expect(operations.plan.total).toBe(2);
    expect(operations.plan.successRate).toBeNull();
    expect(operations.plan.unaccounted).toBe(2);
  });

  it("does not clamp a negative unaccounted count", async () => {
    // A terminal whose start fell outside the window, or was double-emitted. Clamping would
    // hide the inconsistency — the same concealment this fix removes.
    const { operations } = await summaryOf([{ type: "plan.complete" }]);
    expect(operations.plan.unaccounted).toBe(-1);
  });
});

describe("failure reasons round-trip from the payload the emitters write", () => {
  it("reports the SPECIFIC emitted reason, not 'unspecified'", async () => {
    const { failures } = await failuresOf(EVENTS);
    const generic = failures["plan.failed"];
    expect(generic).toBeDefined();
    // Strictly stronger than asserting "not unspecified": every emitter writes payload.reason
    // and none of it reached this report.
    const examples = Object.values(generic.byReason).map((r) => r.example);
    expect(examples).toContain("dirty_tree");
    expect(Object.keys(generic.byReason)).not.toContain("UNKNOWN");
  });

  it("keeps the structural bucket separate from the generic one", async () => {
    const { failures } = await failuresOf(EVENTS);
    // 2 plan.failed = 1 structural + 1 generic. The diversion lives in buildFailures, which
    // matches payload.reason === "structural_create_unauthorable" / payload.failureClass ===
    // "structural", buckets the event separately and `continue`s so it never reaches the
    // generic plan.failed bucket. That code is deliberately NOT touched by this story; this
    // assertion pins that it still splits, because collapsing the buckets would silently
    // change what the failures report means.
    expect(failures["plan.failed"].total).toBe(1);
    expect(failures.structural_create_unauthorable).toBeDefined();
    expect(failures.structural_create_unauthorable.total).toBe(1);
  });
});

describe("agent rows surface outcomes the report has no column for", () => {
  it("counts a denied invocation as unaccounted rather than losing it", async () => {
    const { agents } = await summaryOf([
      { type: "agent.fetch-raw.started" }, { type: "agent.fetch-raw.started" },
      { type: "agent.fetch-raw.complete" },
      { type: "agent.fetch-raw.denied" },
    ]);
    const a = agents["fetch-raw"];
    expect(a.invocations).toBe(2);
    expect(a.completed).toBe(1);
    expect(a.failed).toBe(0);
    // The denied invocation resolved — just in a category with no column. Visible here rather
    // than vanishing into a denominator.
    expect(a.unaccounted).toBe(1);
  });
});

describe("no fixture manufactures the legacy event shape", () => {
  it("no test supplies a top-level status field createEvent never emits", () => {
    // reports-guardrail-trust-aggregation.test.mjs:45 carried `{ type: "plan.start",
    // status: "success" }` — the only thing making the dead isSuccess predicate fire anywhere.
    // The predicate looked functional in tests while being permanently false in production.
    const dir = path.join(REPO_ROOT, "tests", "unit");
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("reports-") && f.endsWith(".mjs"));
    expect(files.length).toBeGreaterThan(0); // positive control — the sweep read something
    const offenders = files.filter((f) =>
      /type:\s*"[^"]*",\s*status:\s*"/.test(fs.readFileSync(path.join(dir, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
