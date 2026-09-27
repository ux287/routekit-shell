/**
 * backlog.feat.ship-review-ac-evidence-and-suppression-telemetry — the ship half.
 *
 * Both guardrails.auto_shipped emits carry the phase-advance decision as applied
 * and the observed result of the reconcile, derived from the advance_phase entry
 * the executed path RECORDED on shipSteps. The derivation is an exported pure
 * function, so these witnesses need no subprocess, no git repo and no off-rail
 * session.
 *
 * Deliberately references no telemetry module: nothing here reads an emit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPhaseAdvanceTelemetry,
  buildOffRailReviewStep,
} from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';
import { reconcileToIntegrated } from '../../packages/mcp-rks/src/workflow/auto-phase.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');

const SUPPRESSION_REASON = 'ac_not_covered (1 of the story\'s acceptance criteria are not covered)';
const PARTIAL_NOTICE =
  'ac_coverage_partial_diff (the diff under review spans only part of this story, so acceptance-criteria coverage could not be assessed from it)';
const REMEDY = 'resolve the outstanding acceptance criteria and re-ship';

const sortedKeys = (o) => Object.keys(o).sort();

/** A realistic two-branch ship prefix, before the advance_phase entry. */
const twoBranchPrefix = () => [
  { step: 'review', ok: true, verdict: 'pass', findingCount: 0 },
  { step: 'commit', ok: true, sha: 'abc1234' },
  { step: 'local-merge', ok: true },
  { step: 'delete-branch', ok: true },
  { step: 'push-staging', ok: true },
];

describe('NOT CONSULTED IS RECORDED, NOT INFERRED', () => {
  it('a three-branch ship records no advance_phase entry', () => {
    const shipSteps = [
      { step: 'local_merge', ok: true },
      { step: 'working_pr', skipped: true, reason: 'three_branch_local_only' },
      { step: 'working_merge', skipped: true, reason: 'three_branch_local_only' },
      { step: 'cycle_complete', skipped: true, reason: 'three_branch_local_only' },
      { step: 'cost', ok: true },
    ];
    const out = buildPhaseAdvanceTelemetry(shipSteps);

    // A helper keyed on ANY skipped step would report suppressed with the
    // three_branch_local_only reason here.
    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult']);
    expect(out).toEqual({ phaseAdvanceDecision: 'not_consulted', phaseAdvanceResult: 'not_attempted' });
  });

  it('a two-branch ship with no problemId records no advance_phase entry', () => {
    const shipSteps = [
      { step: 'local-merge', ok: true },
      { step: 'delete-branch', ok: true },
      { step: 'push-staging', ok: true },
      { step: 'cost', ok: true },
      { step: 'cycle_complete', ok: true },
    ];
    const out = buildPhaseAdvanceTelemetry(shipSteps);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult']);
    expect(out).toEqual({ phaseAdvanceDecision: 'not_consulted', phaseAdvanceResult: 'not_attempted' });
  });

  it('is total over a missing or malformed shipSteps', () => {
    for (const input of [undefined, null, 'nope', {}, [null, 7]]) {
      expect(buildPhaseAdvanceTelemetry(input)).toEqual({
        phaseAdvanceDecision: 'not_consulted',
        phaseAdvanceResult: 'not_attempted',
      });
    }
  });
});

describe('the recorded entry decides the fields, and no key is ever undefined', () => {
  it('suppressed', () => {
    const out = buildPhaseAdvanceTelemetry([
      ...twoBranchPrefix(),
      { step: 'advance_phase', skipped: true, reason: SUPPRESSION_REASON, remedy: REMEDY },
    ]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult', 'phaseAdvanceSuppressionReason']);
    expect(out).toEqual({
      phaseAdvanceDecision: 'suppressed',
      phaseAdvanceResult: 'not_attempted',
      phaseAdvanceSuppressionReason: SUPPRESSION_REASON,
    });
  });

  it('clean advance', () => {
    const out = buildPhaseAdvanceTelemetry([
      ...twoBranchPrefix(),
      { step: 'advance_phase', ok: true, to: 'integrated' },
    ]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult']);
    expect(out).toEqual({ phaseAdvanceDecision: 'permitted', phaseAdvanceResult: 'reached_integrated' });
  });

  it('permitted under a partial diff is distinguishable from a clean advance', () => {
    const clean = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: true, to: 'integrated' }]);
    const out = buildPhaseAdvanceTelemetry([
      ...twoBranchPrefix(),
      { step: 'advance_phase', ok: true, to: 'integrated', notice: PARTIAL_NOTICE },
    ]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceNotice', 'phaseAdvanceResult']);
    expect(out).toEqual({
      phaseAdvanceDecision: 'permitted_with_notice',
      phaseAdvanceResult: 'reached_integrated',
      phaseAdvanceNotice: PARTIAL_NOTICE,
    });
    expect(out).not.toEqual(clean);
  });

  it('never reads the remedy — the same entry with and without one emits the same fields', () => {
    const entries = [
      { step: 'advance_phase', skipped: true, reason: SUPPRESSION_REASON },
      { step: 'advance_phase', ok: true, to: 'integrated' },
      { step: 'advance_phase', ok: true, to: 'integrated', notice: PARTIAL_NOTICE },
      { step: 'advance_phase', ok: false, to: null },
    ];
    for (const entry of entries) {
      expect(buildPhaseAdvanceTelemetry([{ ...entry, remedy: REMEDY }])).toEqual(
        buildPhaseAdvanceTelemetry([entry]),
      );
    }
  });
});

describe('RECONCILE FAILED IS NOT AN ADVANCE', () => {
  const reached = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: true, to: 'integrated' }]);

  it('ok false and to null is permitted and reconcile_failed', () => {
    const out = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: false, to: null }]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult']);
    expect(out).toEqual({ phaseAdvanceDecision: 'permitted', phaseAdvanceResult: 'reconcile_failed' });
    expect(out).not.toEqual(reached);
  });

  it('the same entry under a notice is permitted_with_notice and reconcile_failed', () => {
    const reachedWithNotice = buildPhaseAdvanceTelemetry([
      { step: 'advance_phase', ok: true, to: 'integrated', notice: PARTIAL_NOTICE },
    ]);
    const out = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: false, to: null, notice: PARTIAL_NOTICE }]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceNotice', 'phaseAdvanceResult']);
    expect(out).toEqual({
      phaseAdvanceDecision: 'permitted_with_notice',
      phaseAdvanceResult: 'reconcile_failed',
      phaseAdvanceNotice: PARTIAL_NOTICE,
    });
    expect(out).not.toEqual(reachedWithNotice);
  });
});

describe('OK IS NOT PROOF OF AN ADVANCE', () => {
  it('the real producer returns ok true with no to for a note that does not exist', async () => {
    const missingRoot = path.join(REPO_ROOT, 'tests', '.tmp', `phase-advance-telemetry-missing-${process.pid}-${Date.now()}`);
    expect(fs.existsSync(missingRoot)).toBe(false);

    const res = await reconcileToIntegrated(missingRoot, `backlog.feat.no-such-note-${Date.now()}`, 'p');

    expect(res.ok).toBe(true);
    expect(res.to).toBeUndefined();
    // No file write: the root was never created.
    expect(fs.existsSync(missingRoot)).toBe(false);
  });

  it('the entry that input records is reconcile_ok_not_integrated, never reached_integrated', () => {
    // The attempted-branch push coerces a missing `to` into null.
    const out = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: true, to: null }]);
    const reached = buildPhaseAdvanceTelemetry([{ step: 'advance_phase', ok: true, to: 'integrated' }]);

    expect(sortedKeys(out)).toEqual(['phaseAdvanceDecision', 'phaseAdvanceResult']);
    expect(out).toEqual({ phaseAdvanceDecision: 'permitted', phaseAdvanceResult: 'reconcile_ok_not_integrated' });
    expect(out).not.toEqual(reached);
  });
});

describe('both auto-ship emits spread the helper over shipSteps', () => {
  const EMIT = 'collector.emit("guardrails.auto_shipped"';
  const SPREAD = '...buildPhaseAdvanceTelemetry(shipSteps)';
  const blocks = AUDIT_SRC.split(EMIT)
    .slice(1)
    .map((b) => b.slice(0, b.indexOf('});')));

  it('every guardrails.auto_shipped block carries the spread', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) expect(block).toContain(SPREAD);
  });

  it('the spread appears nowhere else — no phase-advance field leaks onto the response', () => {
    const occurrences = AUDIT_SRC.split(SPREAD).length - 1;
    const inBlocks = blocks.filter((b) => b.includes(SPREAD)).length;
    expect(occurrences).toBe(inBlocks);
  });
});

describe('the rks_guardrails_on review step is unchanged', () => {
  it('buildOffRailReviewStep output for a fixed review result is pinned, with no phase-advance key', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] },
    });

    expect(step).toEqual({
      step: 'review',
      ok: true,
      verdict: 'pass',
      findingCount: 0,
      acCoverage: { assessed: true, assessable: true, covered: ['AC1'], notCovered: [], uncertain: [] },
    });
    expect(Object.keys(step).some((k) => k.startsWith('phaseAdvance'))).toBe(false);
  });

  it('carries no acCoverage key when the review result has none, as today', () => {
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    expect('acCoverage' in step).toBe(false);
  });
});
