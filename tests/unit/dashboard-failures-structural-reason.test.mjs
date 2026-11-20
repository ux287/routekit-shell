/**
 * Witness for backlog.feat.telemetry-report-escalation-structural-rollup (dashboard half).
 *
 * Drives the REAL exported aggregateFailures() from the dashboard vite plugin with synthetic
 * events (no endpoint/network round-trip) and asserts structural_create_unauthorable is broken
 * out as its OWN topReasons entry, distinct from a generic plan.failed reason. Behavioral only —
 * no source-substring or fixed-window-slice assertions.
 */
import { describe, it, expect } from "vitest";
import { aggregateFailures } from "../../packages/telemetry-dashboard/vite-plugin-telemetry-api.ts";

const TS = "2026-07-08T12:00:00.000Z";

describe("aggregateFailures — structural give-up breakout", () => {
  it("surfaces structural_create_unauthorable as its own topReasons entry, distinct from generic plan.failed", () => {
    const events = [
      { timestamp: TS, type: "plan.failed", payload: { reason: "structural_create_unauthorable", failureClass: "structural" } },
      { timestamp: TS, type: "plan.retry.exhausted", payload: { failureClass: "structural" } }, // not a .failed type — still counted
      { timestamp: TS, type: "plan.failed", payload: { error: "exec boom" } },                   // generic control
      { timestamp: TS, type: "exec.failed", payload: { error: "timeout" } },                     // unrelated failure
    ];
    const res = aggregateFailures(events);

    const structural = res.topReasons.find((r) => r.reason === "structural_create_unauthorable");
    expect(structural).toBeDefined();
    expect(structural.count).toBe(2); // plan.failed(reason) + plan.retry.exhausted(failureClass)

    // generic plan.failed reason is a SEPARATE entry, not merged with structural
    const generic = res.topReasons.find((r) => r.reason === "exec boom");
    expect(generic).toBeDefined();
    expect(generic.count).toBe(1);

    expect(res.total).toBe(4);
    // plan location aggregates all three plan.* failures (2 structural + 1 generic)
    const planLoc = res.byLocation.find((l) => l.location === "plan");
    expect(planLoc.count).toBe(3);
  });

  it("does not invent a structural entry when there are none", () => {
    const res = aggregateFailures([
      { timestamp: TS, type: "plan.failed", payload: { error: "stale patterns" } },
      { timestamp: TS, type: "exec.failed", payload: { error: "boom" } },
    ]);
    expect(res.topReasons.find((r) => r.reason === "structural_create_unauthorable")).toBeUndefined();
    expect(res.total).toBe(2);
  });

  it("tolerates an empty/absent event array", () => {
    expect(aggregateFailures([]).total).toBe(0);
    expect(aggregateFailures(undefined).total).toBe(0);
  });
});
