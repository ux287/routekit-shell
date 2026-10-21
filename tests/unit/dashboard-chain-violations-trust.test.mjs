/**
 * Consumer seam for chain.violation telemetry (backlog.feat.chain-violation-telemetry-server-slice).
 *
 * Drives the REAL exported aggregator extracted from the /api/telemetry/trust middleware with
 * synthetic events — live aggregation, NOT a source-substring check. Proves the new
 * chainViolations counter lights up and the extraction is behavior-preserving for the
 * pre-existing counters.
 */
import { describe, it, expect } from "vitest";
import { aggregateTrustCounters } from "../../packages/telemetry-dashboard/vite-plugin-telemetry-api.ts";

describe("aggregateTrustCounters — chain.violation consumer", () => {
  it("counts chain.violation events (both {type} and legacy {event} shapes) into chainViolations", () => {
    const c = aggregateTrustCounters([
      { type: "chain.violation" },
      { type: "chain.violation" },
      { type: "plan.complete" },
      { event: "chain.violation" },
    ]);
    expect(c.chainViolations).toBe(3);
  });

  it("non-chain.violation events do not inflate chainViolations", () => {
    const c = aggregateTrustCounters([{ type: "guardrails.off" }, { type: "hooks.blocked" }, { type: "plan.start" }]);
    expect(c.chainViolations).toBe(0);
  });

  it("is behavior-preserving for the pre-existing trust counters + trustScore", () => {
    const c = aggregateTrustCounters([
      { type: "guardrails.off" },
      { type: "guardrails.blocked" },
      { type: "guardrails.passed" },
      { type: "hooks.blocked" },
      { type: "hooks.allowed" },
      { type: "chain.violation" },
    ]);
    expect(c.offRailSessions).toBe(1);
    expect(c.guardrailsTriggered).toBe(1);
    expect(c.guardrailsPassed).toBe(1);
    expect(c.hooksBlocked).toBe(1);
    expect(c.hooksAllowed).toBe(1);
    expect(c.chainViolations).toBe(1);
    expect(typeof c.trustScore).toBe("number");
    expect(c.trustScore).toBe(50); // (1 passed + 1 allowed) / (1+1+1+1) = 50%
  });

  it("empty / undefined input is safe", () => {
    expect(aggregateTrustCounters([]).chainViolations).toBe(0);
    expect(aggregateTrustCounters(undefined).chainViolations).toBe(0);
    expect(aggregateTrustCounters([]).trustScore).toBe(100);
    expect(aggregateTrustCounters([]).guardrailBumps).toBe(0);
  });

  it("counts hook.guardrail_bump events into guardrailBumps (distinct from chainViolations)", () => {
    const c = aggregateTrustCounters([
      { type: "hook.guardrail_bump" },
      { type: "hook.guardrail_bump" },
      { type: "chain.violation" },
      { type: "plan.start" },
    ]);
    expect(c.guardrailBumps).toBe(2);
    expect(c.chainViolations).toBe(1);
  });
});
