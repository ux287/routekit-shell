/**
 * Tests for generateFixPlan() in packages/mcp-rks/src/server/fix-planner.mjs.
 *
 * Pins the head+tail truncation contract that replaced the prior tail-only
 * `.slice(-150)` behavior. The regression to prevent: failures that land in
 * the first half of test output get silently dropped before reaching the
 * repair LLM, and the planner emits identical plans across refine cycles
 * because it never sees the early failure cluster.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLANNER_CALLS = [];
let plannerBehavior = 'success';

vi.mock('../../packages/mcp-rks/src/llm/planner.mjs', () => ({
  runLlmPlanner: vi.fn(async (args) => {
    PLANNER_CALLS.push(args);
    if (plannerBehavior === 'null') return null;
    return { steps: [{ action: 'note', target: 'noop' }], planSummary: 'fix plan' };
  }),
}));

const { generateFixPlan } = await import('../../packages/mcp-rks/src/server/fix-planner.mjs');

function makeTestOutput({ totalLines, earlyMarker, lateMarker, middleMarker }) {
  const lines = [];
  for (let i = 1; i <= totalLines; i++) {
    if (earlyMarker && i === Math.floor(totalLines * 0.05)) lines.push(earlyMarker);
    else if (lateMarker && i === Math.floor(totalLines * 0.95)) lines.push(lateMarker);
    else if (middleMarker && i === Math.floor(totalLines * 0.5)) lines.push(middleMarker);
    else lines.push(`line ${i}`);
  }
  return lines.join('\n');
}

let tmpRoot;
let runDir;

beforeEach(() => {
  PLANNER_CALLS.length = 0;
  plannerBehavior = 'success';
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-planner-test-'));
  runDir = path.join(tmpRoot, 'run');
  fs.mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function callGenerate({ testOutput, appliedFiles = [] }) {
  return generateFixPlan({
    projectRoot: tmpRoot,
    runDir,
    originalPlan: { problemId: 'backlog.test.x', planSummary: 'demo' },
    appliedFiles,
    testOutput,
    attemptNumber: 0,
  });
}

describe('generateFixPlan — head+tail truncation', () => {
  it('preserves BOTH an early failure cluster AND a late failure cluster when total lines exceed budget', async () => {
    const testOutput = makeTestOutput({
      totalLines: 2000,
      earlyMarker: 'EARLY_FAILURE_MARKER_XYZ',
      lateMarker: 'LATE_FAILURE_MARKER_XYZ',
    });
    await callGenerate({ testOutput });
    expect(PLANNER_CALLS.length).toBe(1);
    const req = PLANNER_CALLS[0].requirements;
    expect(req).toContain('EARLY_FAILURE_MARKER_XYZ');
    expect(req).toContain('LATE_FAILURE_MARKER_XYZ');
  });

  it('includes an explicit omission marker when middle is elided', async () => {
    const testOutput = makeTestOutput({
      totalLines: 2000,
      earlyMarker: 'EARLY_FAILURE_MARKER_XYZ',
      lateMarker: 'LATE_FAILURE_MARKER_XYZ',
      middleMarker: 'MIDDLE_MARKER_SHOULD_BE_DROPPED',
    });
    await callGenerate({ testOutput });
    const req = PLANNER_CALLS[0].requirements;
    expect(req).toMatch(/(…|\.\.\.)\s+\d+\s+lines\s+omitted\s+(…|\.\.\.)/);
    // The mid-output marker must NOT survive — confirms elision actually happened.
    expect(req).not.toContain('MIDDLE_MARKER_SHOULD_BE_DROPPED');
  });

  it('includes the full output verbatim with NO omission marker when total lines fit within budget', async () => {
    const testOutput = makeTestOutput({
      totalLines: 50,
      earlyMarker: 'EARLY_FAILURE_MARKER_XYZ',
      lateMarker: 'LATE_FAILURE_MARKER_XYZ',
    });
    await callGenerate({ testOutput });
    const req = PLANNER_CALLS[0].requirements;
    expect(req).toContain('EARLY_FAILURE_MARKER_XYZ');
    expect(req).toContain('LATE_FAILURE_MARKER_XYZ');
    expect(req).not.toMatch(/lines\s+omitted/);
  });

  it('regression guard: a unique EARLY marker at line 10 of a 1000-line output MUST survive (the old .slice(-150) would have dropped it)', async () => {
    const lines = [];
    for (let i = 1; i <= 1000; i++) {
      if (i === 10) lines.push('EARLY_FAILURE_MARKER_XYZ');
      else lines.push(`line ${i}`);
    }
    const testOutput = lines.join('\n');
    await callGenerate({ testOutput });
    const req = PLANNER_CALLS[0].requirements;
    expect(req).toContain('EARLY_FAILURE_MARKER_XYZ');
  });

  it('regression guard: source no longer contains the tail-only .slice(-150) literal', () => {
    const src = fs.readFileSync(
      new URL('../../packages/mcp-rks/src/server/fix-planner.mjs', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/\.slice\(-150\)/);
  });
});
