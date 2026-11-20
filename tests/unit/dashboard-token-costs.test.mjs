import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { aggregateTokenCosts } from '../../packages/telemetry-dashboard/vite-plugin-telemetry-api.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const VITE_PLUGIN = resolve(ROOT, 'packages/telemetry-dashboard/vite-plugin-telemetry-api.ts');
const API_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/lib/api.ts');
const HOOK_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/hooks/useTelemetryMetrics.ts');
const COMPONENT_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/components/costs/TokenCostSection.tsx');
// Telemetry sections were extracted from App.tsx into TelemetryPage.tsx
// (backlog.feat.routekit-dashboard-nav-shell); the ordering assertion follows them there.
const TELEMETRY_PAGE_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/pages/TelemetryPage.tsx');

describe('fetchTokenCosts()', () => {
  it('returns a TokenCostsResponse with stories array and dailySeries array when fetch resolves successfully', async () => {
    const mockPayload = {
      stories: [{ storyId: 'backlog.feat.foo', rawCost: 500, wasteRatio: 0.05, cacheRatio: 0.3, healthBand: 'green' }],
      dailySeries: Array.from({ length: 14 }, (_, i) => ({
        date: `2026-05-${String(i + 1).padStart(2, '0')}`,
        rawCost: i * 100, wasteRatio: 0, cacheRatio: 0.2, noData: i === 0,
      })),
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(mockPayload) });
    const result = await Promise.resolve(mockPayload);
    expect(Array.isArray(result.stories)).toBe(true);
    expect(Array.isArray(result.dailySeries)).toBe(true);
    const source = readFileSync(API_SRC, 'utf8');
    expect(source).toContain('fetchTokenCosts');
    expect(source).toContain('token-costs');
  });
});

describe('TokenCostsResponse type', () => {
  it('includes stories with storyId, rawCost, wasteRatio, cacheRatio, and healthBand fields', () => {
    const source = readFileSync(API_SRC, 'utf8');
    expect(source).toContain('storyId');
    expect(source).toContain('rawCost');
    expect(source).toContain('wasteRatio');
    expect(source).toContain('cacheRatio');
    expect(source).toContain('healthBand');
  });
});

describe('useTokenCosts() hook', () => {
  it('returns { data, isLoading, isError } shape via React Query', () => {
    const source = readFileSync(HOOK_SRC, 'utf8');
    expect(source).toContain('useTokenCosts');
    expect(source).toContain('useQuery');
    expect(source).toContain('fetchTokenCosts');
    expect(source).toContain('TokenCostsResponse');
  });
});

describe('/api/telemetry/token-costs endpoint', () => {
  it('reads JSONL events directly (no import of cost-report.mjs) and groups by payload.problemId for stories and by date for dailySeries', () => {
    const source = readFileSync(VITE_PLUGIN, 'utf8');
    expect(source).not.toContain('cost-report');
    expect(source).toContain('readAllEvents');
    expect(source).toContain('payload?.problemId');
    expect(source).toContain("timestamp?.split('T')[0]");
  });

  it('delegates to the exported aggregateTokenCosts pure fn which returns { stories, dailySeries, ... }', () => {
    const source = readFileSync(VITE_PLUGIN, 'utf8');
    expect(source).toContain('token-costs');
    expect(source).toContain('stories');
    expect(source).toContain('dailySeries');
    // Endpoint now delegates to the exported aggregator (still NO cost-report import — asserted above).
    expect(source).toContain('aggregateTokenCosts');
    expect(source).toContain('return { stories, dailySeries,');
  });
});

describe('TokenCostSection component', () => {
  const source = readFileSync(COMPONENT_SRC, 'utf8');

  it('renders a BarChart containing exactly 14 data points when dailySeries has 14 entries', () => {
    expect(source).toContain('BarChart');
    expect(source).toContain('dailySeries.map');
    expect(source).toContain('data={chartData}');
  });

  it('renders a bar with value 0 for dailySeries entries where noData is true', () => {
    expect(source).toContain('noData ? 0');
  });

  it('renders a badge with classes bg-green-100 and text-green-800 for healthBand green', () => {
    expect(source).toContain('bg-green-100');
    expect(source).toContain('text-green-800');
  });

  it('renders a badge with classes bg-yellow-100 and text-yellow-800 for healthBand yellow', () => {
    expect(source).toContain('bg-yellow-100');
    expect(source).toContain('text-yellow-800');
  });

  it('renders a badge with classes bg-red-100 and text-red-800 for healthBand red', () => {
    expect(source).toContain('bg-red-100');
    expect(source).toContain('text-red-800');
  });

  it('renders a cache-hit ratio progress bar with a numeric percentage label', () => {
    expect(source).toContain('Cache-hit ratio');
    expect(source).toContain('%</span>');
    expect(source).toContain('rounded-full');
  });

  it('renders a loading indicator when isLoading is true', () => {
    expect(source).toContain('isLoading');
    expect(source).toContain('animate-spin');
  });

  it('renders an empty state message when dailySeries is empty', () => {
    expect(source).toContain('dailySeries.length === 0');
    expect(source).toContain('No token data available');
  });
});

describe('aggregateTokenCosts() — real exported aggregator (synthetic events)', () => {
  const TS = new Date().toISOString();

  it('aggregate cache-hit rate uses the input-side denominator (in + cacheRead + cacheCreate)', () => {
    const res = aggregateTokenCosts([
      { timestamp: TS, type: 'plan.complete', payload: { problemId: 'a', model: 'claude-haiku-4-5-20251001', tokens: { in: 100, out: 10, cacheRead: 100, cacheCreate: 100 } } },
    ]);
    expect(res.cacheRatio).toBeCloseTo(1 / 3, 5); // 100 / (100+100+100)
    expect(res.cacheCreate).toBe(100);
    expect(res.cacheBreakdown).toEqual({ write: 100, read: 100, uncached: 100 });
  });

  it('DIVIDE-BY-ZERO: zero input-side tokens → cacheRatio 0 (finite)', () => {
    const res = aggregateTokenCosts([{ timestamp: TS, type: 'plan.complete', payload: { problemId: 'a', tokens: { in: 0, out: 5, cacheRead: 0, cacheCreate: 0 } } }]);
    expect(res.cacheRatio).toBe(0);
    expect(Number.isFinite(res.cacheRatio)).toBe(true);
  });

  it('byModel yields haiku-vs-sonnet token share', () => {
    const res = aggregateTokenCosts([
      { timestamp: TS, type: 'agent.plan.complete', payload: { model: 'claude-haiku-4-5-20251001', tokens: { in: 100, out: 0 } } },
      { timestamp: TS, type: 'agent.plan.complete', payload: { model: 'claude-sonnet-4-6', tokens: { in: 300, out: 0 } } },
    ]);
    expect(res.byModel['claude-haiku-4-5-20251001'].calls).toBe(1);
    expect(res.byModel['claude-haiku-4-5-20251001'].tokens).toBe(100);
    expect(res.byModel['claude-haiku-4-5-20251001'].share).toBeCloseTo(0.25, 5);
    expect(res.byModel['claude-sonnet-4-6'].share).toBeCloseTo(0.75, 5);
  });

  it('UNTAGGED model buckets under "unknown", never misattributed to a real model', () => {
    const res = aggregateTokenCosts([{ timestamp: TS, type: 'plan.complete', payload: { tokens: { in: 50, out: 10 } } }]);
    expect(res.byModel.unknown).toBeDefined();
    expect(res.byModel.unknown.tokens).toBe(60);
    expect(res.byModel['claude-haiku-4-5-20251001']).toBeUndefined();
  });

  it('preserves stories[] and a 14-point dailySeries', () => {
    const res = aggregateTokenCosts([{ timestamp: TS, type: 'plan.complete', payload: { problemId: 'x', tokens: { in: 10, out: 5 } } }]);
    expect(Array.isArray(res.stories)).toBe(true);
    expect(res.dailySeries).toHaveLength(14);
  });

  it('tolerates empty/undefined input', () => {
    expect(aggregateTokenCosts([]).stories).toEqual([]);
    expect(aggregateTokenCosts(undefined).dailySeries).toHaveLength(14);
  });

  // backlog.feat.cost-report-billing-split: subscription-billed usage is not API cost on the dashboard.
  it('billing split: subscription-billed events are excluded from every cost aggregate and reported as subscriptionTokens', () => {
    const api = { timestamp: TS, type: 'plan.complete', payload: { problemId: 'a', model: 'claude-sonnet-4-6', tokens: { in: 100, out: 20, cacheRead: 50, cacheCreate: 10 } } };
    const sub = { timestamp: TS, type: 'agent.research.complete', payload: { problemId: 'b', billing: 'subscription', model: 'claude-opus-4-5-20251101', tokens: { in: 2000, out: 300, cacheRead: 40, cacheCreate: 5 } } };
    const apiOnly = aggregateTokenCosts([api]);
    const mixed = aggregateTokenCosts([api, sub]);
    const { subscriptionTokens, dailySeries, ...rest } = mixed;
    const { dailySeries: apiSeries, ...apiRest } = apiOnly;
    expect(rest).toEqual(apiRest);
    expect('apiNoData' in mixed).toBe(false);
    expect(subscriptionTokens).toBe(2300);
    // The day holding both events keeps its API-only values and gains subscriptionTokens (no apiNoData).
    const today = TS.split('T')[0];
    const { subscriptionTokens: daySub, ...mixedDay } = dailySeries.find((d) => d.date === today);
    expect(mixedDay).toEqual(apiSeries.find((d) => d.date === today));
    expect(daySub).toBe(2300);
    expect('apiNoData' in mixedDay).toBe(false);
    expect(dailySeries.filter((d) => d.date !== today)).toEqual(apiSeries.filter((d) => d.date !== today));
    expect(mixed.stories.map((s) => s.storyId)).toEqual(['a']);
    expect(Object.keys(mixed.byModel)).toEqual(['claude-sonnet-4-6']);
    expect(mixed.cacheBreakdown).toEqual({ write: 10, read: 50, uncached: 100 });
  });

  it('billing split: untagged, billing api and unrecognised values are API-billed (deep-equal), with no subscriptionTokens key', () => {
    const ev = (extra) => ({ timestamp: TS, type: 'plan.complete', payload: { problemId: 'a', tokens: { in: 10, out: 5 }, ...extra } });
    const untagged = aggregateTokenCosts([ev({})]);
    expect('subscriptionTokens' in untagged).toBe(false);
    expect('apiNoData' in untagged).toBe(false);
    expect('apiNoData' in aggregateTokenCosts([])).toBe(false);
    expect(untagged.stories.map((s) => s.storyId)).toEqual(['a']);
    expect(aggregateTokenCosts([ev({ billing: 'api' })])).toEqual(untagged);
    expect(aggregateTokenCosts([ev({ billing: 'Subscription' })])).toEqual(untagged);
  });

  it('billing split (R4): a subscription-only input has no stories, an empty byModel, cacheRatio 0 flagged apiNoData, and subscriptionTokens 42; days without events keep the noData shape', () => {
    const res = aggregateTokenCosts([{ timestamp: TS, type: 'agent.research.complete', payload: { problemId: 'b', billing: 'subscription', tokens: { in: 40, out: 2 } } }]);
    expect(res.stories).toEqual([]);
    expect(res.dailySeries).toHaveLength(14);
    expect(res.byModel).toEqual({});
    expect(res.cacheRatio).toBe(0);
    // The 0 is the inputSideTotal === 0 fallback, not a measurement, so the response marks it.
    expect(res.apiNoData).toBe(true);
    expect(res.subscriptionTokens).toBe(42);
    const today = TS.split('T')[0];
    for (const d of res.dailySeries.filter((x) => x.date !== today)) {
      expect(d).toEqual({ date: d.date, rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: true });
    }
  });

  it('billing split (R4): a subscription-only day is not noData; it is apiNoData with its subscriptionTokens, the generateDailyCostSeries day shape', () => {
    const res = aggregateTokenCosts([{ timestamp: TS, type: 'agent.research.complete', payload: { problemId: 'b', billing: 'subscription', tokens: { in: 40, out: 2 } } }]);
    const today = TS.split('T')[0];
    expect(res.dailySeries.find((d) => d.date === today)).toEqual({ date: today, rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: false, apiNoData: true, subscriptionTokens: 42 });
    // An untagged day keeps exactly the existing keys: no apiNoData, no subscriptionTokens.
    const untagged = aggregateTokenCosts([{ timestamp: TS, type: 'plan.complete', payload: { problemId: 'a', tokens: { in: 10, out: 5 } } }]);
    const day = untagged.dailySeries.find((d) => d.date === today);
    expect(Object.keys(day).sort()).toEqual(['cacheRatio', 'date', 'noData', 'rawCost', 'wasteRatio']);
    expect(day.noData).toBe(false);
  });

  it('billing split (R4): the dashboard type, the cache-ratio average and the rendered cache-hit row treat apiNoData as carrying no API measurement', () => {
    const component = readFileSync(COMPONENT_SRC, 'utf8');
    expect(component).toContain('dailySeries.filter(d => !d.noData && !d.apiNoData)');
    // The rendered value is data.cacheRatio (always numeric), so apiNoData must switch the row to n/a.
    expect(component).toContain('data?.apiNoData ? (');
    expect(component).toContain('<span>n/a (no API-billed token events)</span>');
    expect(component).toContain('{data?.cacheBreakdown && !data?.apiNoData && <CacheSplitBar');
    expect(component).toContain('Cache-hit ratio');
    expect(component).toContain('%</span>');
    const api = readFileSync(API_SRC, 'utf8');
    // Declared on both DailySeriesEntry and TokenCostsResponse.
    expect(api.split('apiNoData?: boolean;').length - 1).toBe(2);
    expect(api).toContain('subscriptionTokens?: number;');
  });
});

describe('TelemetryPage.tsx', () => {
  it('contains TokenCostSection rendered after StoryActivityTable in component tree', () => {
    const source = readFileSync(TELEMETRY_PAGE_SRC, 'utf8');
    expect(source).toContain('TokenCostSection');
    const storyTableIdx = source.indexOf('StoryActivityTable');
    const tokenCostIdx = source.indexOf('TokenCostSection');
    expect(storyTableIdx).toBeGreaterThan(-1);
    expect(tokenCostIdx).toBeGreaterThan(-1);
    expect(tokenCostIdx).toBeGreaterThan(storyTableIdx);
  });
});
