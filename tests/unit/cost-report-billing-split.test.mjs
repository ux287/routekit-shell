// CREATE FILE: tests/unit/cost-report-billing-split.test.mjs
/**
 * backlog.feat.cost-report-billing-split: the cost report separates subscription-billed
 * usage (payload.billing === "subscription") from API spend.
 *
 * Exercises the REAL packages/telemetry/src/cost-report.mjs through the un-globally-mocked
 * @routekit/telemetry/cost-report subpath, against temp .rks/telemetry/*.jsonl fixtures.
 * No LLM calls, no network, no subprocesses. Prices come from the real calculateCost
 * (@routekit/telemetry/cost), the single source the module itself prices with.
 *
 * Tier: unit (vitest.config.unit.mjs collects tests/unit/**). Run alone with
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/cost-report-billing-split.test.mjs
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  generateCostReport,
  generateDailyCostSeries,
  billingOf,
  BILLING_API,
  BILLING_SUBSCRIPTION,
  HEALTH_BAND_NA,
} from "@routekit/telemetry/cost-report";
import { calculateCost } from "@routekit/telemetry/cost";

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-5-20251101";
const FIXED_TS = "2026-01-01T00:00:00.000Z";

const round4 = (n) => Math.round(n * 10000) / 10000;
const tempRoots = [];

function makeRoot(events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost-report-billing-"));
  tempRoots.push(root);
  const dir = path.join(root, ".rks", "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  const body = events.map((ev) => JSON.stringify(ev)).join("\n");
  fs.writeFileSync(path.join(dir, "events-2026-01-01.jsonl"), events.length ? body + "\n" : "");
  return root;
}

afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function apiEvent(overrides = {}) {
  return {
    id: overrides.id || "ev-api-1",
    type: overrides.type || "plan.complete",
    timestamp: overrides.timestamp || FIXED_TS,
    correlationId: "corr-api",
    payload: {
      model: SONNET,
      tokens: { in: 1000, out: 500, cacheRead: 200, cacheCreate: 40 },
      ...(overrides.payload || {}),
    },
  };
}

function subscriptionEvent(overrides = {}) {
  return {
    id: overrides.id || "ev-sub-1",
    type: overrides.type || "agent.research.complete",
    timestamp: overrides.timestamp || FIXED_TS,
    correlationId: "corr-sub",
    payload: {
      billing: "subscription",
      model: OPUS,
      tokens: { in: 2000, out: 300, cacheRead: 50, cacheCreate: 10 },
      costUsdEstimate: 0.12,
      ...(overrides.payload || {}),
    },
  };
}

describe("billingOf and billing constants", () => {
  it("exports the two billing classes", () => {
    expect(BILLING_API).toBe("api");
    expect(BILLING_SUBSCRIPTION).toBe("subscription");
  });

  it("returns subscription only for payload.billing === 'subscription'", () => {
    expect(billingOf({ payload: { billing: "subscription" } })).toBe("subscription");
  });

  it("returns api for absent, api, and any other billing value", () => {
    const cases = [
      undefined,
      null,
      {},
      { payload: {} },
      { payload: { billing: "api" } },
      { payload: { billing: "Subscription" } },
      { payload: { billing: "sub" } },
      { payload: { billing: null } },
      { payload: { billing: 1 } },
    ];
    for (const ev of cases) expect(billingOf(ev), JSON.stringify(ev)).toBe("api");
  });
});

describe("generateCostReport — untagged history is unchanged", () => {
  it("an untagged fixture reports exactly the API-priced aggregates and has no subscription key", () => {
    const report = generateCostReport(makeRoot([apiEvent()]));
    expect(report.noData).toBe(false);
    expect("subscription" in report).toBe(false);
    expect(report.rawCost).toBe(1500);
    expect(report.efficientCost).toBe(1500);
    expect(report.totalEvents).toBe(1);
    expect(report.cacheCreateTotal).toBe(40);
    expect(Object.keys(report.byModel)).toEqual([SONNET]);
    expect(report.byModel[SONNET].cost).toBe(calculateCost(SONNET, 1000, 500).totalCost);
    expect(report.phases).toEqual({ plan: { calls: 1, tokens: 1500, wastedTokens: 0, wastedCalls: 0 } });
    expect(report.healthBand).toBe("green");
    expect("apiNoData" in report).toBe(false);
  });

  it("untagged, billing 'api' and an unrecognised billing value produce deep-equal reports", () => {
    const untagged = generateCostReport(makeRoot([apiEvent()]));
    const tagged = generateCostReport(makeRoot([apiEvent({ payload: { billing: "api" } })]));
    const bogus = generateCostReport(makeRoot([apiEvent({ payload: { billing: "bogus" } })]));
    expect(tagged).toEqual(untagged);
    expect(bogus).toEqual(untagged);
  });

  it("a fixture with no token events returns the existing noData sentinel unchanged", () => {
    const root = makeRoot([
      { id: "ev-0", type: "plan.start", timestamp: FIXED_TS, payload: {} },
      { id: "ev-1", type: "agent.research.start", timestamp: FIXED_TS, payload: { billing: "subscription" } },
    ]);
    const report = generateCostReport(root);
    expect(report).toEqual({ ok: true, noData: true, scope: undefined, storyId: null, commitSha: null });
    expect("subscription" in report).toBe(false);
  });
});

describe("generateCostReport — subscription events are not API spend", () => {
  it("with one API and one subscription event, every existing aggregate reflects only the API event", () => {
    const apiOnly = generateCostReport(makeRoot([apiEvent()]));
    const mixed = generateCostReport(makeRoot([apiEvent(), subscriptionEvent()]));

    const { subscription, ...rest } = mixed;
    expect(rest).toEqual(apiOnly);

    expect(mixed.rawCost).toBe(1500);
    expect(mixed.totalEvents).toBe(1);
    expect(Object.keys(mixed.byModel)).toEqual([SONNET]);
    expect(Object.keys(mixed.byAgentModel)).toEqual(["plan"]);
    expect(Object.keys(mixed.phases)).toEqual(["plan"]);

    expect(subscription.calls).toBe(1);
    expect(subscription.tokens).toEqual({ in: 2000, out: 300, cacheRead: 50, cacheCreate: 10 });
  });

  it("prices subscription tokens as an estimated API equivalent via calculateCost, grouped by model", () => {
    const { subscription } = generateCostReport(makeRoot([apiEvent(), subscriptionEvent()]));
    const expected = calculateCost(OPUS, 2000, 300).totalCost;
    expect(subscription.estimatedApiEquivalentCost).toBeCloseTo(round4(expected), 8);
    expect(subscription.cliCostUsdEstimate).toBeCloseTo(0.12, 8);
    expect(Object.keys(subscription.byModel)).toEqual([OPUS]);
    expect(subscription.byModel[OPUS].calls).toBe(1);
    expect(subscription.byModel[OPUS].tokens).toBe(2300);
    expect(subscription.byModel[OPUS].estimatedApiEquivalentCost).toBeCloseTo(round4(expected), 8);
  });

  it("buckets an untagged subscription model as unknown and sums only numeric costUsdEstimate", () => {
    const root = makeRoot([
      subscriptionEvent({ id: "s1", payload: { costUsdEstimate: 0.25 } }),
      subscriptionEvent({ id: "s2", payload: { model: undefined, costUsdEstimate: "0.5" } }),
      subscriptionEvent({ id: "s3", payload: { costUsdEstimate: null, tokens: { in: 100, out: 100 } } }),
    ]);
    const { subscription } = generateCostReport(root);
    expect(subscription.calls).toBe(3);
    expect(subscription.cliCostUsdEstimate).toBeCloseTo(0.25, 8);
    expect(Object.keys(subscription.byModel).sort()).toEqual([OPUS, "unknown"].sort());
    expect(subscription.byModel[OPUS].calls).toBe(2);
    expect(subscription.byModel.unknown.calls).toBe(1);
    const expected =
      calculateCost(OPUS, 2000, 300).totalCost +
      calculateCost("unknown", 2000, 300).totalCost +
      calculateCost(OPUS, 100, 100).totalCost;
    expect(subscription.estimatedApiEquivalentCost).toBeCloseTo(round4(expected), 8);
  });

  it("a subscription-only fixture is not noData: rawCost 0, totalEvents 0, populated subscription", () => {
    const report = generateCostReport(makeRoot([subscriptionEvent()]));
    expect(report.noData).toBe(false);
    expect(report.rawCost).toBe(0);
    expect(report.totalEvents).toBe(0);
    expect(report.subscription.calls).toBe(1);
    expect(report.subscription.tokens).toEqual({ in: 2000, out: 300, cacheRead: 50, cacheCreate: 10 });
  });

  it("R4: a subscription-only report flags apiNoData and carries the n/a band, never green from the defaulted ratio", () => {
    const report = generateCostReport(makeRoot([subscriptionEvent()]));
    expect(report.wasteRatio).toBe(0);
    expect(report.apiNoData).toBe(true);
    expect(HEALTH_BAND_NA).toBe("n/a");
    expect(report.healthBand).toBe(HEALTH_BAND_NA);
    expect(report.healthBand).not.toBe("green");
  });

  it("R4: a report with any API-billed token event keeps today's band and has no apiNoData key", () => {
    const mixed = generateCostReport(makeRoot([apiEvent(), subscriptionEvent()]));
    expect(mixed.healthBand).toBe("green");
    expect("apiNoData" in mixed).toBe(false);
  });
});

describe("generateCostReport — markdown", () => {
  it("adds exactly one subscription line, after the unchanged existing lines, only when subscription exists", () => {
    const apiMd = generateCostReport(makeRoot([apiEvent()]), { format: "markdown" }).markdown;
    const mixed = generateCostReport(makeRoot([apiEvent(), subscriptionEvent()]), { format: "markdown" });

    expect(apiMd).not.toMatch(/subscription/i);

    const lines = mixed.markdown.split("\n");
    expect(lines.slice(0, -1).join("\n")).toBe(apiMd);
    const extra = lines[lines.length - 1];
    expect(extra).toContain(`${mixed.subscription.calls} calls`);
    expect(extra).toContain(mixed.subscription.estimatedApiEquivalentCost.toFixed(4));
    expect(extra).toMatch(/not API spend/);
  });

  it("R4: a subscription-only report's markdown states n/a for the waste ratio and names no band", () => {
    const report = generateCostReport(makeRoot([subscriptionEvent()]), { format: "markdown" });
    const lines = report.markdown.split("\n");
    const wasteLine = lines.find((l) => l.startsWith("**Waste ratio:**"));
    expect(wasteLine).toBe("**Waste ratio:** n/a (no API-billed token events)");
    expect(lines.find((l) => l.startsWith("**Cache ratio:**"))).toBe("**Cache ratio:** n/a (no API-billed token events)");
    expect(report.markdown).not.toMatch(/\b(green|yellow|red)\b/);
    expect(lines[lines.length - 1]).toMatch(/not API spend/);
  });
});

describe("generateDailyCostSeries — billing split", () => {
  // The series is keyed on dates derived from the current clock, so fixtures are stamped now
  // and the entry is located by date rather than by index.
  function seriesDay(events) {
    const ts = new Date().toISOString();
    const date = ts.split("T")[0];
    const stamped = events.map((ev) => ({ ...ev, timestamp: ts }));
    const series = generateDailyCostSeries(makeRoot(stamped), { days: 3 });
    const day = series.find((d) => d.date === date);
    expect(day, `series has no entry for ${date}`).toBeDefined();
    return { day, others: series.filter((d) => d.date !== date) };
  }

  it("an untagged day is identical in shape and value to today's output (no subscriptionTokens)", () => {
    const { day, others } = seriesDay([apiEvent()]);
    expect(Object.keys(day).sort()).toEqual(["cacheRatio", "date", "noData", "rawCost", "wasteRatio"]);
    expect(day.rawCost).toBe(1500);
    expect(day.wasteRatio).toBe(0);
    expect(day.cacheRatio).toBeCloseTo(200 / 1200, 10);
    expect(day.noData).toBe(false);
    for (const d of others) {
      expect(d.noData).toBe(true);
      expect("subscriptionTokens" in d).toBe(false);
    }
  });

  it("a mixed day excludes subscription tokens from rawCost and cacheRatio and carries subscriptionTokens", () => {
    const { day: apiDay } = seriesDay([apiEvent()]);
    const { day } = seriesDay([apiEvent(), subscriptionEvent()]);
    expect(day.rawCost).toBe(1500);
    expect(day.cacheRatio).toBeCloseTo(apiDay.cacheRatio, 10);
    expect(day.noData).toBe(false);
    expect(day.subscriptionTokens).toBe(2300);
    expect("apiNoData" in day).toBe(false);
  });

  it("a subscription-only day has rawCost 0, noData false and subscriptionTokens > 0", () => {
    const { day } = seriesDay([subscriptionEvent()]);
    expect(day.rawCost).toBe(0);
    expect(day.noData).toBe(false);
    expect(day.subscriptionTokens).toBe(2300);
    expect(day.subscriptionTokens).toBeGreaterThan(0);
    expect(day.apiNoData).toBe(true);
  });
});

describe("generateDailyCostSeries declared return shape (R7)", () => {
  it("the JSDoc @returns names apiNoData and subscriptionTokens", () => {
    const src = fs.readFileSync(new URL("../../packages/telemetry/src/cost-report.mjs", import.meta.url), "utf8");
    const line = src.split("\n").find((l) => l.includes("@returns {Array<{ date: string"));
    expect(line, "generateDailyCostSeries @returns line").toBeDefined();
    expect(line).toContain("apiNoData?: boolean");
    expect(line).toContain("subscriptionTokens?: number");
  });
});
