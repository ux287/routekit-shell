/**
 * Contract test: plan-worker marker preserves structured error context.
 *
 * Validates that when runPlanTool returns a structured failure (readiness issues,
 * workflow hints), the plan-worker writes those fields to the marker file, and
 * that the plan_review response format includes them.
 *
 * This test does NOT run the actual plan worker or MCP server — it tests the
 * marker write/read contract directly by simulating what the worker writes and
 * what plan_review reads.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ──────────────────────────────────────────────────────────

function createTempMarkerPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-worker-marker-'));
  return path.join(dir, 'pending-plan.json');
}

function writeMarker(markerPath, data) {
  fs.writeFileSync(markerPath, JSON.stringify(data, null, 2));
}

function readMarker(markerPath) {
  return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
}

/**
 * Simulates what plan-worker.mjs does when runPlanTool returns a result.
 * This mirrors the logic at plan-worker.mjs lines 105-118.
 */
function simulateWorkerMarkerWrite(markerPath, res) {
  const markerUpdate = { done: true, ok: res.ok !== false, completedAt: Date.now() };
  if (res.ok === false) {
    if (res.error) markerUpdate.error = res.error;
    if (res.errors) markerUpdate.errors = res.errors;
    if (res.issues) markerUpdate.issues = res.issues;
    if (res.warnings) markerUpdate.warnings = res.warnings;
    if (res.hint) markerUpdate.hint = res.hint;
    if (res.workflow) markerUpdate.workflow = res.workflow;
    if (res.status) markerUpdate.status = res.status;
    if (res.reason) markerUpdate.reason = res.reason;   // F3: discriminator propagated in lockstep with worker
    if (res.suggestions) markerUpdate.suggestions = res.suggestions;
  }
  // Merge with existing marker (same as updateMarker in worker)
  let existing = {};
  if (fs.existsSync(markerPath)) {
    existing = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  }
  fs.writeFileSync(markerPath, JSON.stringify({ ...existing, ...markerUpdate }, null, 2));
}

/**
 * F3: derive the operator-facing failure class from marker.status + marker.reason
 * (mirrors server.mjs plan_review failure branch).
 */
function deriveFailureClass(marker) {
  return marker.failureClass
    || (marker.status === 'refinement_required'
          ? (marker.reason === 'create_file_complexity' ? 'story_unplannable' : 'output_invalid')
          : marker.status === 'quality_failed' ? 'output_invalid' : 'worker_crashed');
}

/**
 * Simulates what server.mjs plan_review handler builds from the marker (F3-aware).
 */
function simulatePlanReviewResponse(marker) {
  const failureClass = deriveFailureClass(marker);
  const failureResponse = {
    ok: false,
    status: marker.status || 'failed',
    failureClass,
    elapsedSeconds: 10,
    error: marker.error || 'Plan generation failed in worker',
    message: `Plan worker failed (${failureClass}).`,
  };
  if (marker.reason) failureResponse.reason = marker.reason;
  if (marker.errors) failureResponse.errors = marker.errors;
  if (marker.issues) failureResponse.issues = marker.issues;
  if (marker.warnings) failureResponse.warnings = marker.warnings;
  if (marker.hint) failureResponse.hint = marker.hint;
  if (marker.workflow) failureResponse.workflow = marker.workflow;
  if (marker.suggestions) failureResponse.suggestions = marker.suggestions;
  return failureResponse;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('plan-worker marker contract', () => {

  it('preserves readiness failure context through marker round-trip', () => {
    const markerPath = createTempMarkerPath();
    // Pre-seed marker (as server.mjs does before spawning worker)
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });

    // Simulate runPlanTool returning a readiness failure
    const planResult = {
      ok: false,
      error: 'Story not ready for planning - refinement required',
      problemId: 'backlog.feat.test-story',
      issues: [
        { check: 'pattern_exists', message: 'No SEARCH patterns found in target files' },
        { check: 'missing_create_directive', message: 'New file lacks CREATE FILE directive' },
      ],
      warnings: [
        { check: 'shallow_testing_requirements', message: 'Less than 2 test cases' },
      ],
      hint: 'REQUIRED: Fix the issues listed above, then retry rks_plan.',
      workflow: [
        '1. Run rks_refine to get specific suggestions',
        '2. Run rks_refine_apply to apply fixes',
        '3. Run rks_plan_ready to verify',
        '4. Retry rks_plan',
      ],
    };

    // Worker writes to marker
    simulateWorkerMarkerWrite(markerPath, planResult);

    // Read marker back (as plan_review handler does)
    const marker = readMarker(markerPath);

    // Verify structured fields survived the write
    assert.strictEqual(marker.done, true);
    assert.strictEqual(marker.ok, false);
    assert.strictEqual(marker.error, planResult.error);
    assert.deepStrictEqual(marker.issues, planResult.issues);
    assert.deepStrictEqual(marker.warnings, planResult.warnings);
    assert.strictEqual(marker.hint, planResult.hint);
    assert.deepStrictEqual(marker.workflow, planResult.workflow);
    // Pre-seeded fields preserved
    assert.strictEqual(marker.planKey, 'test');
    assert.strictEqual(marker.pid, 12345);

    // Verify plan_review response propagates them
    const response = simulatePlanReviewResponse(marker);
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error, planResult.error);
    assert.deepStrictEqual(response.issues, planResult.issues);
    assert.deepStrictEqual(response.warnings, planResult.warnings);
    assert.strictEqual(response.hint, planResult.hint);
    assert.deepStrictEqual(response.workflow, planResult.workflow);

    // Cleanup
    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });

  it('handles exception-only failures (no structured fields)', () => {
    const markerPath = createTempMarkerPath();
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });

    // Simulate catch-block failure (exception) — the worker now stamps failureClass.
    const exceptionMarker = { done: true, ok: false, failureClass: 'worker_crashed', error: 'SIGILL crash', completedAt: Date.now() };
    const existing = readMarker(markerPath);
    writeMarker(markerPath, { ...existing, ...exceptionMarker });

    const marker = readMarker(markerPath);
    const response = simulatePlanReviewResponse(marker);

    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error, 'SIGILL crash');
    assert.strictEqual(response.failureClass, 'worker_crashed');
    // No structured fields — should be absent, not null/undefined
    assert.strictEqual(response.issues, undefined);
    assert.strictEqual(response.workflow, undefined);

    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });

  it('F3: classifies story_unplannable (create_file_complexity) distinctly from output_invalid', () => {
    const markerPath = createTempMarkerPath();
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });
    // Both classes share status 'refinement_required'; reason is the discriminator.
    simulateWorkerMarkerWrite(markerPath, {
      ok: false, status: 'refinement_required', reason: 'create_file_complexity',
      error: 'Too many create_file targets for one plan', hint: 'Split the story.',
    });
    const marker = readMarker(markerPath);
    assert.strictEqual(marker.reason, 'create_file_complexity'); // reason propagated to marker
    const response = simulatePlanReviewResponse(marker);
    assert.strictEqual(response.failureClass, 'story_unplannable');
    assert.strictEqual(response.reason, 'create_file_complexity');
    assert.strictEqual(response.error, 'Too many create_file targets for one plan');
    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });

  it('F3: classifies output_invalid (note_only) and does NOT collapse into story_unplannable', () => {
    const markerPath = createTempMarkerPath();
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });
    simulateWorkerMarkerWrite(markerPath, {
      ok: false, status: 'refinement_required', reason: 'note_only',
      error: 'Plan produced only note steps',
    });
    const marker = readMarker(markerPath);
    const response = simulatePlanReviewResponse(marker);
    assert.strictEqual(response.failureClass, 'output_invalid');
    // Non-collapse: same status, different reason -> different class.
    assert.notStrictEqual(response.failureClass, 'story_unplannable');
    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });

  it('handles success case (no error fields written)', () => {
    const markerPath = createTempMarkerPath();
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });

    // Simulate success
    simulateWorkerMarkerWrite(markerPath, { ok: true, problemId: 'test' });

    const marker = readMarker(markerPath);
    assert.strictEqual(marker.done, true);
    assert.strictEqual(marker.ok, true);
    assert.strictEqual(marker.error, undefined);
    assert.strictEqual(marker.issues, undefined);

    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });

  it('preserves generic failure when no error string provided', () => {
    const markerPath = createTempMarkerPath();
    writeMarker(markerPath, { planKey: 'test', pid: 12345, startedAt: Date.now() });

    // Simulate failure with no error message
    simulateWorkerMarkerWrite(markerPath, { ok: false });

    const marker = readMarker(markerPath);
    const response = simulatePlanReviewResponse(marker);

    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error, 'Plan generation failed in worker');
    assert.strictEqual(response.failureClass, 'worker_crashed'); // no status/reason -> worker_crashed

    fs.rmSync(path.dirname(markerPath), { recursive: true });
  });
});
