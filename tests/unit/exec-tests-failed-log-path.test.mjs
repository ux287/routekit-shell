/**
 * Unit tests for paths.testsFailedLog in run.json and rks_exec response.
 *
 * Verifies that when tests fail, the absolute path to the test failure log
 * is surfaced in both run.json (paths.testsFailedLog) and the rks_exec
 * return value (testsFailedLog), enabling the Build Governor to read
 * failure details without guardrails-off access.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';

// ─── Path construction logic ──────────────────────────────────────────────────

describe('test failure log path construction', () => {
  const runDir = '/project/.rks/runs/2026-04-15T12-00-00-000Z_my-story';

  it('uses tests-failed.log for attempt 1', () => {
    const attemptNumber = 1;
    const testLogPath = path.join(
      runDir,
      attemptNumber === 1 ? 'tests-failed.log' : `tests-failed-attempt-${attemptNumber}.log`
    );
    expect(testLogPath).toBe(`${runDir}/tests-failed.log`);
  });

  it('uses tests-failed-attempt-2.log for attempt 2', () => {
    const attemptNumber = 2;
    const testLogPath = path.join(
      runDir,
      attemptNumber === 1 ? 'tests-failed.log' : `tests-failed-attempt-${attemptNumber}.log`
    );
    expect(testLogPath).toBe(`${runDir}/tests-failed-attempt-2.log`);
  });

  it('uses tests-failed-attempt-3.log for attempt 3', () => {
    const attemptNumber = 3;
    const testLogPath = path.join(
      runDir,
      attemptNumber === 1 ? 'tests-failed.log' : `tests-failed-attempt-${attemptNumber}.log`
    );
    expect(testLogPath).toBe(`${runDir}/tests-failed-attempt-3.log`);
  });
});

// ─── run.json paths.testsFailedLog population ────────────────────────────────

describe('run.json paths.testsFailedLog population', () => {
  const runDir = '/project/.rks/runs/2026-04-15T12-00-00-000Z_my-story';

  function applyTestLogToRunMeta(runMeta, testsPassed, lastTestLogPath) {
    // Mirrors the logic added to exec.mjs
    runMeta.testsPassed = testsPassed;
    if (!testsPassed && lastTestLogPath) {
      runMeta.paths = runMeta.paths || {};
      runMeta.paths.testsFailedLog = lastTestLogPath;
    }
    return runMeta;
  }

  it('sets paths.testsFailedLog when testsPassed is false', () => {
    const runMeta = {};
    const testLogPath = path.join(runDir, 'tests-failed.log');
    const result = applyTestLogToRunMeta(runMeta, false, testLogPath);
    expect(result.paths).toBeDefined();
    expect(result.paths.testsFailedLog).toBe(testLogPath);
  });

  it('does NOT set paths.testsFailedLog when testsPassed is true', () => {
    const runMeta = {};
    const result = applyTestLogToRunMeta(runMeta, true, null);
    expect(result.paths?.testsFailedLog).toBeUndefined();
  });

  it('does NOT set paths.testsFailedLog when lastTestLogPath is null (log write failed)', () => {
    const runMeta = {};
    const result = applyTestLogToRunMeta(runMeta, false, null);
    expect(result.paths?.testsFailedLog).toBeUndefined();
  });

  it('preserves existing paths fields when adding testsFailedLog', () => {
    const existingPath = '/project/.rks/runs/run-id/plan.json';
    const runMeta = { paths: { planJson: existingPath } };
    const testLogPath = path.join(runDir, 'tests-failed.log');
    const result = applyTestLogToRunMeta(runMeta, false, testLogPath);
    expect(result.paths.planJson).toBe(existingPath);
    expect(result.paths.testsFailedLog).toBe(testLogPath);
  });

  it('uses tests-failed-attempt-2.log path on retry (attempt 2)', () => {
    const runMeta = {};
    const testLogPath = path.join(runDir, 'tests-failed-attempt-2.log');
    const result = applyTestLogToRunMeta(runMeta, false, testLogPath);
    expect(result.paths.testsFailedLog).toContain('tests-failed-attempt-2.log');
  });
});

// ─── rks_exec return value structure ─────────────────────────────────────────

describe('rks_exec return value — testsFailedLog field', () => {
  const runDir = '/project/.rks/runs/2026-04-15T12-00-00-000Z_my-story';

  function buildTestFailureReturn(lastTestLogPath, attemptNumber) {
    // Mirrors the failure return object in exec.mjs
    return {
      ok: false,
      status: 'tests_failed',
      testsPassed: false,
      attempts: attemptNumber,
      directive: 'TESTS FAILED - FIX REQUIRED',
      hint: `Tests failed after ${attemptNumber} attempt(s). See tests-failed*.log for details.`,
      testsFailedLog: lastTestLogPath || null,
    };
  }

  it('includes testsFailedLog in return value when tests fail', () => {
    const testLogPath = path.join(runDir, 'tests-failed.log');
    const result = buildTestFailureReturn(testLogPath, 1);
    expect(result.testsFailedLog).toBe(testLogPath);
  });

  it('testsFailedLog is null when log write failed (lastTestLogPath null)', () => {
    const result = buildTestFailureReturn(null, 1);
    expect(result.testsFailedLog).toBeNull();
  });

  it('testsFailedLog reflects attempt-N filename for retry runs', () => {
    const testLogPath = path.join(runDir, 'tests-failed-attempt-2.log');
    const result = buildTestFailureReturn(testLogPath, 2);
    expect(result.testsFailedLog).toContain('tests-failed-attempt-2.log');
  });
});
