import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock cost-report before importing dashboard
vi.mock('../../packages/mcp-rks/src/server/telemetry/cost-report.mjs', () => ({
  generateCostReport: vi.fn(),
  generateDailyCostSeries: vi.fn(),
}));

import { generateCostReport, generateDailyCostSeries } from '../../packages/mcp-rks/src/server/telemetry/cost-report.mjs';
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

describe('named exports', () => {
  it('renderActivityByStory is a named export', () => {
    expect(typeof renderActivityByStory).toBe('function');
  });

  it('renderTokenSpendAndEfficiency is a named export', () => {
    expect(typeof renderTokenSpendAndEfficiency).toBe('function');
  });
});
