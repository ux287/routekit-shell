/**
 * Witness for backlog.fix.cost-telemetry-haiku-pricing.
 *
 * The cost tables mis-priced Haiku 4.5: cost.mjs had no entry (fell to the Sonnet `default`
 * = 3x overstatement) and onboarder.mjs RATE_CARD used the old Haiku-3.5 rate (under-stated).
 * These pin the corrected rates and the exact-full-id lookup shape (the actual bug surface:
 * cost.mjs keys on the full id, so a short id silently falls to default).
 *
 * See notes/research.2026.07.07.model-usage-haiku-sonnet-escalation.md.
 */
import { describe, it, expect } from "vitest";
import { calculateCost } from "../../packages/mcp-rks/src/server/telemetry/cost.mjs";
import { RATE_CARD } from "../../packages/mcp-rks/src/server/onboarder.mjs";

const M = 1_000_000;

describe("calculateCost — MODEL_PRICING (cost.mjs)", () => {
  it("prices Haiku 4.5 (full id) at $1/$5 → $6.00 for 1M/1M, NOT the $18 sonnet default", () => {
    const c = calculateCost("claude-haiku-4-5-20251001", M, M);
    expect(c.inputCost).toBe(1.0);
    expect(c.outputCost).toBe(5.0);
    expect(c.totalCost).toBe(6.0);
    expect(c.totalCost).not.toBe(18.0); // regression guard: no longer the sonnet default
  });

  it("prices Sonnet 4.6 at $3/$15 → $18.00 for 1M/1M", () => {
    const c = calculateCost("claude-sonnet-4-6", M, M);
    expect(c.inputCost).toBe(3.0);
    expect(c.outputCost).toBe(15.0);
    expect(c.totalCost).toBe(18.0);
  });

  it("falls back to `default` ($3/$15) for an unknown model id", () => {
    const c = calculateCost("some-unknown-model", M, M);
    expect(c.totalCost).toBe(18.0);
  });

  it("KEY-SHAPE DISCRIMINATOR: the SHORT haiku id is NOT in cost.mjs → falls to default", () => {
    // cost.mjs keys on the exact FULL id. The short id (which the onboarder uses) must NOT
    // resolve to the haiku price here — proving the full-vs-short mismatch is the bug surface.
    const short = calculateCost("claude-haiku-4-5", M, M);
    expect(short.totalCost).toBe(18.0); // default, not $6
    const full = calculateCost("claude-haiku-4-5-20251001", M, M);
    expect(full.totalCost).toBe(6.0);
  });
});

describe("onboarder RATE_CARD (onboarder.mjs)", () => {
  it("prices Haiku 4.5 (short id, onboarder's key) at $1/$5 per 1M — not the old 3.5 rate", () => {
    expect(RATE_CARD["claude-haiku-4-5"]).toEqual({ input: 1 / M, output: 5 / M });
    // 1M input + 1M output → $6, not the old $1.50
    const dollars = M * RATE_CARD["claude-haiku-4-5"].input + M * RATE_CARD["claude-haiku-4-5"].output;
    expect(dollars).toBe(6);
  });

  it("keeps Sonnet 4.6 at $3/$15 per 1M", () => {
    expect(RATE_CARD["claude-sonnet-4-6"]).toEqual({ input: 3 / M, output: 15 / M });
  });
});
