/**
 * Tests for the projectId leak in refine telemetry events.
 * (backlog.feat.refine-projectid-telemetry-leak)
 *
 * Static analysis: signatures and call sites no longer rely on a
 * silent projectId="unknown" default.
 *
 * Runtime: invocations with an explicit projectId emit refine.* events
 * with the passed projectId, never "unknown".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Local vi.mock with relative path for named spy access (overrides global setup mock).
// Pattern matches tests/unit/init-telemetry.test.mjs.
const mockEmit = vi.fn();
vi.mock('../../packages/mcp-rks/src/server/telemetry/index.mjs', () => ({
  getTelemetryCollector: () => ({ emit: mockEmit, flush: vi.fn() }),
  ensureTelemetryStorage: () => ({ emit: vi.fn(), flush: vi.fn() }),
  resetTelemetryCollector: vi.fn(),
}));

const { runRefineTool, runRksReadyTool } = await import('../../packages/mcp-rks/src/server/refine.mjs');

const refineSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/refine.mjs'),
  'utf8'
);
const execSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/exec.mjs'),
  'utf8'
);
const serverSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server.mjs'),
  'utf8'
);

describe('refine projectId telemetry — static analysis', () => {
  it('runRefineTool signature has no projectId="unknown" default', () => {
    const sig = refineSrc.match(/export async function runRefineTool\([^)]*\)/)?.[0] ?? '';
    expect(sig).toContain('projectId');
    expect(sig).not.toContain('projectId = "unknown"');
  });

  it('runRksReadyTool signature has no projectId="unknown" default', () => {
    const sig = refineSrc.match(/export async function runRksReadyTool\([^)]*\)/)?.[0] ?? '';
    expect(sig).toContain('projectId');
    expect(sig).not.toContain('projectId = "unknown"');
  });

  it('runRksReadyTool passes projectId to runRefineTool', () => {
    const readyBody = refineSrc.split('export async function runRksReadyTool')[1] ?? '';
    const refineCall = readyBody.match(/runRefineTool\(\{[^}]*\}\)/)?.[0] ?? '';
    expect(refineCall).toContain('projectId');
  });

  it('exec.mjs test_failed retry call passes projectId to runRefineTool', () => {
    const calls = execSrc.match(/runRefineTool\(\{[\s\S]*?\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('projectId');
    }
  });

  it('rks_ready handler in server.mjs passes projectId: input.projectId to runRksReadyTool', () => {
    const handlerCall = serverSrc.match(/runRksReadyTool\(\{[\s\S]*?\}\)/)?.[0] ?? '';
    expect(handlerCall).toContain('projectId: input.projectId');
  });
});

describe('refine projectId telemetry — runtime', () => {
  let tmpDir;

  beforeEach(() => {
    mockEmit.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-projectid-telem-'));
    fs.mkdirSync(path.join(tmpDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.1' }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStoryNote(problemId) {
    const fm = [
      '---',
      `id: "${problemId}"`,
      'title: "Test"',
      'desc: "test"',
      'phase: "ready"',
      'targetFiles:',
      '  - path: "src/foo.mjs"',
      '    op: "edit"',
      '    desc: "test"',
      '---',
      '',
      '## Problem',
      'test',
      '',
      '## Solution',
      'test',
      '',
      '## Acceptance Criteria',
      '- [ ] ac1',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'notes', `${problemId}.md`), fm);
  }

  function emitsForType(type) {
    return mockEmit.mock.calls.filter(c => c[0] === type);
  }

  it('refine.start emits with passed projectId', async () => {
    writeStoryNote('backlog.feat.pid-test');
    await runRefineTool({
      projectRoot: tmpDir,
      problemId: 'backlog.feat.pid-test',
      projectId: 'test-project',
    });
    const calls = emitsForType('refine.start');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe('test-project');
      expect(call[1]).not.toBe('unknown');
    }
  });

  it('refine.analyze emits with passed projectId', async () => {
    writeStoryNote('backlog.feat.pid-test');
    await runRefineTool({
      projectRoot: tmpDir,
      problemId: 'backlog.feat.pid-test',
      projectId: 'test-project',
    });
    const calls = emitsForType('refine.analyze');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe('test-project');
    }
  });

  it('refine.complete emits with passed projectId', async () => {
    writeStoryNote('backlog.feat.pid-test');
    await runRefineTool({
      projectRoot: tmpDir,
      problemId: 'backlog.feat.pid-test',
      projectId: 'test-project',
    });
    const calls = emitsForType('refine.complete');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe('test-project');
    }
  });

  it('refine.failed emits with passed projectId on error path', async () => {
    // Force the outer try/catch by omitting projectRoot — validation throws,
    // bubbles to the outer catch which emits refine.failed.
    await runRefineTool({
      projectRoot: undefined,
      problemId: 'backlog.feat.test',
      projectId: 'test-project',
    });
    const calls = emitsForType('refine.failed');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe('test-project');
    }
  });

  it('runRksReadyTool threads projectId into runRefineTool', async () => {
    writeStoryNote('backlog.feat.pid-test');
    await runRksReadyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.feat.pid-test',
      projectId: 'test-project',
    });
    const allRefineCalls = mockEmit.mock.calls.filter(c => c[0].startsWith('refine.'));
    expect(allRefineCalls.length).toBeGreaterThan(0);
    for (const call of allRefineCalls) {
      expect(call[1]).toBe('test-project');
      expect(call[1]).not.toBe('unknown');
    }
  });

  it('test_failed trigger path emits all refine.* events with passed projectId', async () => {
    writeStoryNote('backlog.feat.pid-test');
    await runRefineTool({
      projectRoot: tmpDir,
      problemId: 'backlog.feat.pid-test',
      trigger: 'test_failed',
      context: 'tests failed',
      projectId: 'test-project',
    });
    const allRefineCalls = mockEmit.mock.calls.filter(c => c[0].startsWith('refine.'));
    expect(allRefineCalls.length).toBeGreaterThan(0);
    for (const call of allRefineCalls) {
      expect(call[1]).toBe('test-project');
      expect(call[1]).not.toBe('unknown');
    }
  });
});
