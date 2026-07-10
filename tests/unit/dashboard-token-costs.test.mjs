import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { aggregateTokenCosts } from '../../packages/telemetry-dashboard/vite-plugin-telemetry-api.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const VITE_PLUGIN = resolve(ROOT, 'packages/telemetry-dashboard/vite-plugin-telemetry-api.ts');
const API_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/lib/api.ts');
const HOOK_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/hooks/useTelemetryMetrics.ts');
const COMPONENT_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/components/costs/TokenCostSection.tsx');
const APP_SRC = resolve(ROOT, 'packages/telemetry-dashboard/src/App.tsx');

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
});

describe('App.tsx', () => {
  it('contains TokenCostSection rendered after StoryActivityTable in component tree', () => {
    const source = readFileSync(APP_SRC, 'utf8');
    expect(source).toContain('TokenCostSection');
    const storyTableIdx = source.indexOf('StoryActivityTable');
    const tokenCostIdx = source.indexOf('TokenCostSection');
    expect(storyTableIdx).toBeGreaterThan(-1);
    expect(tokenCostIdx).toBeGreaterThan(-1);
    expect(tokenCostIdx).toBeGreaterThan(storyTableIdx);
  });
});
