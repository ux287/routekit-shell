/**
 * Witness for backlog.feat.telemetry-report-escalation-structural-rollup.
 *
 * Drives the REAL generateReport aggregators over synthetic on-disk event stores (no live LLM):
 *  - self-escalation count (per-agent + overall) — DISTINCT from failure-escalation
 *  - self-escalation rate with the pinned agent.<name>.started denominator
 *  - divide-by-zero → finite 0
 *  - structural_create_unauthorable / failureClass surfaced as its OWN failures bucket
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateReport } from "../../packages/mcp-rks/src/server/telemetry/reports.mjs";

const TS = "2026-07-08T12:00:00.000Z";

function makeProject(events) {
  const root = mkdtempSync(path.join(os.tmpdir(), "reports-escalation-"));
  const dir = path.join(root, ".rks", "telemetry");
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify({ timestamp: TS, ...e })).join("\n");
  writeFileSync(path.join(dir, "events-2026-07-08.jsonl"), lines + "\n");
  return root;
}

describe("generateReport — self-escalation rollup", () => {
  let root;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it("counts per-agent selfEscalations (distinct from failure escalations) and the pinned rate", async () => {
    // foo: 4 started, 1 self_escalation, 1 (failure) escalation -> selfRate 0.25, escalations 1
    // bar: 2 started, 2 self_escalation                          -> selfRate 1.0
    root = makeProject([
      { type: "agent.foo.started" }, { type: "agent.foo.started" },
      { type: "agent.foo.started" }, { type: "agent.foo.started" },
      { type: "agent.foo.self_escalation", payload: { from: "haiku", to: "sonnet", reason: "self_signal" } },
      { type: "agent.foo.escalation", payload: { from: "haiku", to: "sonnet" } },
      { type: "agent.bar.started" }, { type: "agent.bar.started" },
      { type: "agent.bar.self_escalation", payload: { reason: "self_signal" } },
      { type: "agent.bar.self_escalation", payload: { reason: "self_signal" } },
    ]);
    const rep = await generateReport(root, { reportType: "summary" });

    expect(rep.agents.foo.selfEscalations).toBe(1);
    expect(rep.agents.foo.selfEscalationRate).toBe(0.25); // 1 / 4 started
    expect(rep.agents.foo.escalations).toBe(1);           // failure-escalation UNCHANGED, not conflated
    expect(rep.agents.bar.selfEscalations).toBe(2);
    expect(rep.agents.bar.selfEscalationRate).toBe(1);    // 2 / 2 started

    // overall: denominator is totals.agentInvocations (started count) = 6
    expect(rep.totals.agentInvocations).toBe(6);
    expect(rep.totals.selfEscalations).toBe(3);
    expect(rep.totals.selfEscalationRate).toBe(0.5);      // 3 / 6
  });

  it("FAILURE vs SELF ESCALATION are never summed: escalations counts only failure-escalation events", async () => {
    root = makeProject([
      { type: "agent.foo.started" },
      { type: "agent.foo.escalation" }, { type: "agent.foo.escalation" },
      { type: "agent.foo.self_escalation" },
    ]);
    const rep = await generateReport(root, { reportType: "summary" });
    expect(rep.agents.foo.escalations).toBe(2);       // only the two failure escalations
    expect(rep.agents.foo.selfEscalations).toBe(1);   // only the self escalation
  });

  it("DIVIDE-BY-ZERO: zero started yields a finite selfEscalationRate of 0", async () => {
    // agent baz has a self_escalation but no started event -> invocations 0
    root = makeProject([{ type: "agent.baz.self_escalation" }]);
    const rep = await generateReport(root, { reportType: "summary" });
    expect(rep.agents.baz.selfEscalations).toBe(1);
    expect(rep.agents.baz.selfEscalationRate).toBe(0);
    expect(Number.isFinite(rep.agents.baz.selfEscalationRate)).toBe(true);
    // overall rate also finite 0 when there are zero started events
    expect(rep.totals.agentInvocations).toBe(0);
    expect(rep.totals.selfEscalationRate).toBe(0);
    expect(Number.isFinite(rep.totals.selfEscalationRate)).toBe(true);
  });

  it("no self_escalation events -> per-agent and overall rate are 0 (finite), counters 0", async () => {
    root = makeProject([{ type: "agent.foo.started" }, { type: "agent.foo.complete", payload: { durationMs: 5 } }]);
    const rep = await generateReport(root, { reportType: "summary" });
    expect(rep.agents.foo.selfEscalations).toBe(0);
    expect(rep.agents.foo.selfEscalationRate).toBe(0);
    expect(rep.totals.selfEscalations).toBe(0);
    expect(rep.totals.selfEscalationRate).toBe(0);
  });
});

describe("generateReport — structural planner give-up bucket", () => {
  let root;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it("surfaces structural_create_unauthorable as its OWN bucket, distinct from generic plan.failed", async () => {
    root = makeProject([
      { type: "plan.failed", payload: { reason: "structural_create_unauthorable", failureClass: "structural" } },
      { type: "plan.retry.exhausted", payload: { failureClass: "structural", uncoveredCreateTargets: ["a.html"] } },
      { type: "plan.failed", payload: { error: "exec boom" } }, // generic control
    ]);
    const rep = await generateReport(root, { reportType: "failures" });

    // structural give-ups (plan.failed reason + plan.retry.exhausted failureClass) in their own bucket
    expect(rep.failures.structural_create_unauthorable).toBeDefined();
    expect(rep.failures.structural_create_unauthorable.total).toBe(2);

    // the generic plan.failed lands in its own plan.failed bucket, counted SEPARATELY
    expect(rep.failures["plan.failed"]).toBeDefined();
    expect(rep.failures["plan.failed"].total).toBe(1);

    // the structural plan.failed was NOT double-counted into the generic bucket
    expect(rep.failures["plan.failed"].byReason.structural_create_unauthorable).toBeUndefined();
  });

  it("a non-structural plan.failed alone lands only in the generic bucket (no structural bucket created)", async () => {
    root = makeProject([{ type: "plan.failed", payload: { error: "stale patterns" } }]);
    const rep = await generateReport(root, { reportType: "failures" });
    expect(rep.failures.structural_create_unauthorable).toBeUndefined();
    expect(rep.failures["plan.failed"].total).toBe(1);
  });
});
