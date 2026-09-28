/**
 * Witness for backlog.fix.planner-persist-ready-phase-exec-start-crash
 *
 * Regression: an EXECUTABLE plan produced for a story at phase 'ready' hit
 * persistAndFinalize's exec_start branch, which called advancePhase('exec_start').
 * exec_start.from is ["arch-approved"] only (workflow/phases.mjs), so the transition
 * failed and persistAndFinalize returned { ok:false, error:'state_transition_failed' },
 * surfaced to the caller (rks_plan_review) as worker_crashed — losing the valid plan.
 *
 * Reproduced live (2026-07-08): a from-scratch single op:create story at phase 'ready'
 * → real rks_plan → executable create_file plan → worker_crashed/state_transition_failed
 * (2/2). The same story at phase 'arch-approved' planned + advanced to 'executing' cleanly.
 *
 * Fix: decideExecStartAction() gates the exec_start advance so it fires only from
 * 'arch-approved' (resetting post-arch re-plan phases first). For a pre-ARCH phase
 * ('ready'), the plan persists WITHOUT advancing — no arch-gate bypass, no crash.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideExecStartAction } from '../../packages/mcp-rks/src/server/planner-persistence.mjs';

describe('decideExecStartAction — exec_start phase gate', () => {
  it('READY-PHASE NO-CRASH: a ready story does NOT advance (no exec_start call → no state_transition_failed)', () => {
    // This is the core of the fix: exec_start.from=["arch-approved"] only, so advancing
    // from 'ready' would fail. The gate must skip the advance entirely.
    const d = decideExecStartAction('ready');
    expect(d.advance).toBe(false);
    expect(d.reset).toBe(false);
    expect(d).toEqual({ reset: false, advance: false });
  });

  it('ARCH-APPROVED REGRESSION: advances to executing, no reset needed', () => {
    expect(decideExecStartAction('arch-approved')).toEqual({ reset: false, advance: true });
  });

  it('P0-3 RESET PRESERVED: planned/executing/executed reset to arch-approved then advance', () => {
    for (const p of ['planned', 'executing', 'executed']) {
      expect(decideExecStartAction(p)).toEqual({ reset: true, advance: true });
    }
  });

  it('UNKNOWN PHASE (read failed): advances so advancePhase can validate (prior behavior preserved)', () => {
    expect(decideExecStartAction(undefined)).toEqual({ reset: false, advance: true });
    expect(decideExecStartAction(null)).toEqual({ reset: false, advance: true });
  });

  it('SAFE DEFAULT: any other non-arch phase (e.g. draft) does not advance and does not reset', () => {
    const d = decideExecStartAction('draft');
    expect(d.advance).toBe(false);
    expect(d.reset).toBe(false);
  });

  it('POST-RELEASE REJECT: released/integrated are rejected (immutable), not silently skipped (backlog.fix.planner-persist-reject-post-release-phase)', () => {
    for (const p of ['released', 'integrated']) {
      const d = decideExecStartAction(p);
      expect(d.reject).toBe(true);
      expect(d.advance).toBe(false);
      expect(d.reset).toBe(false);
      expect(d).toEqual({ reset: false, advance: false, reject: true });
    }
  });

  it('pre-ARCH phases are NOT reject-flagged (ready/draft skip cleanly, no reject)', () => {
    expect(decideExecStartAction('ready').reject).toBeUndefined();
    expect(decideExecStartAction('draft').reject).toBeUndefined();
  });
});

describe('exec_start advance is gated (source guards)', () => {
  // RE-POINTED (backlog.fix.plan-exec-start-phase-write-durability). The reset/advance
  // sequence moved from planner-persistence.mjs into exec-start-durability.mjs so the
  // detached plan worker and the parent-side durability net share one implementation.
  // The guarantees pinned here are unchanged — only their home moved. The
  // decideExecStartAction cases in the describe block above are untouched.
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/planner-persistence.mjs'),
    'utf8'
  );
  const durability = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/exec-start-durability.mjs'),
    'utf8'
  );

  it('advancePhase("exec_start") is only called inside the decideExecStartAction advance guard', () => {
    // The advance call must be guarded so a ready-phase plan never reaches it.
    expect(durability).toContain('const decision = decideExecStartAction(from);');
    expect(durability).toContain('if (!decision.advance) {');
    const guardIdx = durability.indexOf('if (!decision.advance) {');
    const advanceIdx = durability.indexOf('advancePhase(projectRoot, problemId, "exec_start"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(advanceIdx).toBeGreaterThan(guardIdx);
  });

  it('a reject-flagged (post-release) phase returns a loud immutability error, not ok:true', () => {
    expect(durability).toContain('if (decision.reject) {');
    expect(src).toContain('phase_immutable_plan_rejected');
  });

  it('ARCH-GATE DELIBERATE: pre-ARCH phase emits exec_start_skipped instead of crashing', () => {
    expect(src).toContain('story.phase.exec_start_skipped');
  });

  it('genuine invalid transitions still fail loud (no silent ok:true)', () => {
    expect(durability).toContain('state_transition_failed');
    expect(src).toContain('phase_write_failed');
  });

  it('persistAndFinalize routes through the shared durability module', () => {
    expect(src).toContain('ensureExecStartPhase');
  });
});
