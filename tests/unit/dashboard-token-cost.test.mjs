import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock cost-report before importing dashboard
vi.mock('@routekit/telemetry/cost-report', () => ({
  generateCostReport: vi.fn(),
  generateDailyCostSeries: vi.fn(),
}));

import { generateCostReport, generateDailyCostSeries } from '@routekit/telemetry/cost-report';
import { renderActivityByStory, renderTokenSpendAndEfficiency } from '../../scripts/telemetry/dashboard.mjs';

function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  fn();
  console.log = orig;
  return lines.join('\n');
}

const noDataReport = { ok: true, noData: true };
const okReport = (overrides = {}) => ({
  ok: true, noData: false,
  rawCost: 1500, wasteRatio: 0.05, cacheRatio: 0.4,
  healthBand: 'green', phaseSummary: 'plan x1 ok',
  ...overrides,
});

const emptySeriesDay = { date: '2026-05-03', rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: true };
const activeSeriesDay = (date = '2026-05-03') => ({ date, rawCost: 2000, wasteRatio: 0.08, cacheRatio: 0.35, noData: false });

beforeEach(() => vi.clearAllMocks());

describe('renderActivityByStory', () => {
  it('shows empty state when no events have problemId', () => {
    const out = captureConsole(() => renderActivityByStory([], '/fake'));
    expect(out).toContain('No story activity');
  });

  it('renders column headers', () => {
    generateCostReport.mockReturnValue(noDataReport);
    const events = [{ payload: { problemId: 'backlog.feat.foo' } }];
    const out = captureConsole(() => renderActivityByStory(events, '/fake'));
    expect(out).toContain('Story ID');
    expect(out).toContain('Tokens');
    expect(out).toContain('Waste');
  });

  it('renders story row with cost data when report has data', () => {
    generateCostReport.mockReturnValue(okReport());
    const events = [{ payload: { problemId: 'backlog.feat.my-story' } }];
    const out = captureConsole(() => renderActivityByStory(events, '/fake'));
    expect(out).toContain('backlog.feat.my-story');
    expect(out).toContain('1,500');
    expect(out).toContain('green');
  });

  it('renders dash row when story has no token data', () => {
    generateCostReport.mockReturnValue(noDataReport);
    const events = [{ payload: { problemId: 'backlog.feat.empty' } }];
    const out = captureConsole(() => renderActivityByStory(events, '/fake'));
    expect(out).toContain('backlog.feat.empty');
    expect(out).toContain('—');
  });

  it('uses health-band color coding (green/yellow/red)', () => {
    generateCostReport
      .mockReturnValueOnce(okReport({ healthBand: 'green' }))
      .mockReturnValueOnce(okReport({ healthBand: 'yellow' }))
      .mockReturnValueOnce(okReport({ healthBand: 'red' }));
    const events = ['a', 'b', 'c'].map(id => ({ payload: { problemId: `backlog.feat.${id}` } }));
    const out = captureConsole(() => renderActivityByStory(events, '/fake'));
    expect(out).toContain('green');
    expect(out).toContain('yellow');
    expect(out).toContain('red');
  });

  it('delegates to generateCostReport, not reimplementing inline', () => {
    generateCostReport.mockReturnValue(okReport());
    const events = [{ payload: { problemId: 'backlog.feat.x' } }];
    captureConsole(() => renderActivityByStory(events, '/fakeroot'));
    expect(generateCostReport).toHaveBeenCalledWith('/fakeroot', expect.objectContaining({ scope: 'story' }));
  });
});

describe('renderTokenSpendAndEfficiency', () => {
  it('shows empty state when all days have no data', () => {
    generateDailyCostSeries.mockReturnValue([emptySeriesDay, emptySeriesDay]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 2));
    expect(out).toContain('No token data available');
  });

  it('renders cost-over-time bar chart header', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 1));
    expect(out).toContain('Cost over time');
  });

  it('renders efficiency trend section', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 1));
    expect(out).toContain('Efficiency trend');
  });

  it('renders cache-hit ratio', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 1));
    expect(out).toContain('Cache-hit ratio');
  });

  it('renders total tokens line', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 1));
    expect(out).toContain('Total tokens');
    expect(out).toContain('2,000');
  });

  it('delegates to generateDailyCostSeries, not reimplementing inline', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    captureConsole(() => renderTokenSpendAndEfficiency('/fakeroot', 7));
    expect(generateDailyCostSeries).toHaveBeenCalledWith('/fakeroot', { days: 7 });
  });
});

// backlog.feat.cost-report-billing-split (R4): a subscription-only day or story has no API-billed
// token events, so its wasteRatio and cacheRatio are defaults and must not be rendered as measured.
describe('billing split (R4): subscription-only data is not rendered as measured API efficiency', () => {
  const subscriptionOnlyDay = (date = '2026-05-04') => ({ date, rawCost: 0, wasteRatio: 0, cacheRatio: 0, noData: false, apiNoData: true, subscriptionTokens: 2300 });

  it('a series whose only token days are subscription-only does not claim there is no token data and renders no trend or cache average', () => {
    generateDailyCostSeries.mockReturnValue([emptySeriesDay, subscriptionOnlyDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 2));
    expect(out).not.toContain('No token data available');
    expect(out).toContain('No API-billed token events');
    expect(out).toContain('2,300');
    expect(out).toContain('not API spend');
    expect(out).not.toContain('Efficiency trend');
    expect(out).not.toContain('Cache-hit ratio');
  });

  it('a subscription-only day is excluded from the efficiency trend and the cache-hit average', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay('2026-05-03'), subscriptionOnlyDay('2026-05-04')]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 2));
    const trend = out.slice(out.indexOf('Efficiency trend'), out.indexOf('Cache-hit ratio'));
    expect(trend).toContain('05-03');
    expect(trend).not.toContain('05-04');
    // activeSeriesDay has cacheRatio 0.35; averaging in the defaulted 0 would print 17.5%.
    expect(out).toContain('35.0%');
    expect(out).not.toContain('17.5%');
  });

  it('a story whose report is apiNoData shows the n/a band and no waste percentage', () => {
    generateCostReport.mockReturnValue({ ok: true, noData: false, apiNoData: true, rawCost: 0, wasteRatio: 0, cacheRatio: 0, healthBand: 'n/a', phaseSummary: '' });
    const out = captureConsole(() => renderActivityByStory([{ payload: { problemId: 'backlog.feat.sub-only' } }], '/fake'));
    expect(out).toContain('backlog.feat.sub-only');
    expect(out).toContain('n/a');
    expect(out).not.toContain('0%');
  });

  // R9: subscription usage is never dropped; Total tokens covers API-billed tokens only.
  it('a range with an API-billed day reports mixed and subscription-only days\' subscription tokens on a not-API-spend line', () => {
    generateDailyCostSeries.mockReturnValue([{ ...activeSeriesDay('2026-05-03'), subscriptionTokens: 1200 }, subscriptionOnlyDay('2026-05-04')]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 2));
    expect(out).toContain('Total tokens');
    expect(out).toContain('2,000');
    expect(out).toContain('Subscription tokens');
    expect(out).toContain('3,500');
    expect(out).toContain('not API spend');
  });

  it('an API-only range prints no subscription line', () => {
    generateDailyCostSeries.mockReturnValue([activeSeriesDay()]);
    const out = captureConsole(() => renderTokenSpendAndEfficiency('/fake', 1));
    expect(out).not.toContain('Subscription tokens');
    expect(out).not.toContain('not API spend');
  });

  it('a mixed story keeps its API row and adds a subscription line labelled not API spend', () => {
    generateCostReport.mockReturnValue({
      ok: true, noData: false, rawCost: 1500, wasteRatio: 0.05, cacheRatio: 0.2, healthBand: 'green', phaseSummary: '',
      subscription: { calls: 1, tokens: { in: 2000, out: 300, cacheRead: 0, cacheCreate: 0 }, estimatedApiEquivalentCost: 0.0123, cliCostUsdEstimate: 0, byModel: {} },
    });
    const out = captureConsole(() => renderActivityByStory([{ payload: { problemId: 'backlog.feat.mixed' } }], '/fake'));
    expect(out).toContain('backlog.feat.mixed');
    expect(out).toContain('1,500');
    expect(out).toContain('5%');
    expect(out).toContain('green');
    expect(out).toContain('1 calls');
    expect(out).toContain('2,300');
    expect(out).toContain('not API spend');
  });

  it('a story report without a subscription block prints no subscription line', () => {
    generateCostReport.mockReturnValue({ ok: true, noData: false, rawCost: 1500, wasteRatio: 0.05, cacheRatio: 0.2, healthBand: 'green', phaseSummary: '' });
    const out = captureConsole(() => renderActivityByStory([{ payload: { problemId: 'backlog.feat.api-only' } }], '/fake'));
    expect(out).toContain('backlog.feat.api-only');
    expect(out).not.toContain('not API spend');
  });
});

describe('named exports', () => {
  it('renderActivityByStory is a named export', () => {
    expect(typeof renderActivityByStory).toBe('function');
  });

  it('renderTokenSpendAndEfficiency is a named export', () => {
    expect(typeof renderTokenSpendAndEfficiency).toBe('function');
  });
});
