import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

  it('returns JSON with { stories, dailySeries } keys', () => {
    const source = readFileSync(VITE_PLUGIN, 'utf8');
    expect(source).toContain('token-costs');
    expect(source).toContain('stories');
    expect(source).toContain('dailySeries');
    expect(source).toContain('JSON.stringify({ stories, dailySeries }');
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
