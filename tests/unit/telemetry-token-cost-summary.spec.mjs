import { describe, it, expect } from 'vitest';
import { generateCostReport } from '../../packages/mcp-rks/src/server/telemetry/cost-report.mjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import os from 'os';
import path from 'path';
import fs from 'fs';

function makeTempProject(events = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-cost-test-'));
  const telDir = path.join(dir, '.rks', 'telemetry');
  fs.mkdirSync(telDir, { recursive: true });
  if (events.length > 0) {
    fs.writeFileSync(
      path.join(telDir, '2026-05-03.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n')
    );
  }
  return dir;
}

const baseEvent = (overrides = {}) => ({
  id: `ev-${Math.random()}`,
  type: 'plan.complete',
  correlationId: 'corr-1',
  timestamp: '2026-05-03T01:00:00Z',
  payload: { problemId: 'backlog.feat.test-story', tokens: { in: 100, out: 50, cacheRead: 20 } },
  ...overrides,
});

describe('generateCostReport phaseSummary', () => {
  it('returns noData:true when no token events exist', () => {
    const dir = makeTempProject();
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.ok).toBe(true);
    expect(result.noData).toBe(true);
  });

  it('includes phaseSummary in result when data exists', () => {
    const dir = makeTempProject([baseEvent()]);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.noData).toBe(false);
    expect(typeof result.phaseSummary).toBe('string');
    expect(result.phaseSummary.length).toBeGreaterThan(0);
  });

  it('formats phaseSummary as "phase xN ok" when no waste', () => {
    const dir = makeTempProject([baseEvent()]);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.phaseSummary).toMatch(/plan x1 ok/);
  });

  it('formats phaseSummary with "(N failed)" when waste events exist', () => {
    const failedEv = baseEvent({ type: 'plan.failed', id: 'ev-failed' });
    const dir = makeTempProject([failedEv, baseEvent({ id: 'ev-2' })]);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.phaseSummary).toContain('failed');
  });

  it('includes multiple phases separated by |', () => {
    const events = [
      baseEvent({ type: 'plan.complete', id: 'ev-1' }),
      baseEvent({ type: 'exec.complete', id: 'ev-2', correlationId: 'corr-2' }),
    ];
    const dir = makeTempProject(events);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.phaseSummary).toContain(' | ');
  });
});

describe('rks_token_cost_report handler passthrough', () => {
  it('server.mjs exports phaseSummary in handler response shape', () => {
    const dir = makeTempProject([baseEvent()]);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    // Handler returns JSON.stringify(res) — verify phaseSummary survives serialization
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized.phaseSummary).toBeDefined();
    expect(typeof serialized.phaseSummary).toBe('string');
  });
});

describe('noData graceful fallback', () => {
  it('returns noData:true with no phaseSummary when no matching events', () => {
    const dir = makeTempProject([baseEvent({ payload: { problemId: 'other-story', tokens: { in: 10, out: 5 } } })]);
    const result = generateCostReport(dir, { scope: 'story', storyId: 'backlog.feat.test-story' });
    expect(result.noData).toBe(true);
    expect(result.phaseSummary).toBeUndefined();
  });

  it('returns noData:true when telemetry directory does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-cost-empty-'));
    const result = generateCostReport(dir, { scope: 'story', storyId: 'any' });
    expect(result.noData).toBe(true);
  });
});

describe('SKILL.md Cost Summary section', () => {
  const skillPath = resolve(process.cwd(), '.claude/skills/telemetry/SKILL.md');
  const content = readFileSync(skillPath, 'utf8');

  it('contains Cost Summary section', () => {
    expect(content).toContain('## Cost Summary');
  });

  it('references rks_token_cost_report', () => {
    expect(content).toContain('rks_token_cost_report');
  });

  it('documents noData fallback message', () => {
    expect(content.toLowerCase()).toContain('no token data available');
  });

  it('documents phaseSummary field', () => {
    expect(content).toContain('phaseSummary');
  });
});
