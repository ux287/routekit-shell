/**
 * Tests for backlog.fix.off-rail-ship-enforcement-gate — pure helpers.
 *
 * The off-rail auto-ship block had NO enforcement layer: no code review (the
 * token `review` appeared once in the whole module, in an unrelated error
 * string) and no re-check of the session's write scope (`allowedFiles` had zero
 * occurrences inside guardrailsOn; the scope file was DELETED before an
 * unfiltered `git add -A`). Meanwhile the on-rail rks_story_ship path enforced
 * both.
 *
 * The posture is ADVISORY BY DEFAULT and that asymmetry is deliberate — see
 * resolveOffRailPosture's own comment. These tests pin it, because "helpfully"
 * making the default halt would lock a keyless user out of both ship routes.
 *
 * UNIT TIER: no subprocesses here. Behavioral coverage of the gate itself lives
 * in tests/integration/off-rail-ship-enforcement-gate.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveOffRailPosture,
  buildOffRailReviewStep,
  buildScopeReconcileStep,
} from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8'
);
const REVIEW_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/review.mjs'),
  'utf8'
);

describe('resolveOffRailPosture — advisory by default, fails open', () => {
  it("resolves to 'advisory' when there is no policy at all", () => {
    for (const policy of [undefined, null, {}]) {
      expect(resolveOffRailPosture(policy)).toBe('advisory');
    }
  });

  it("resolves to 'advisory' when the offRail key is absent", () => {
    expect(resolveOffRailPosture({ enabled: true, verdictMode: 'warn' })).toBe('advisory');
  });

  it("resolves to 'block' only for the literal string 'block'", () => {
    expect(resolveOffRailPosture({ offRail: 'block' })).toBe('block');
  });

  it('fails open to advisory for anything unrecognized', () => {
    // A malformed policy must never wedge the escape hatch shut.
    for (const value of ['BLOCK', 'blocked', true, 1, {}, [], 'advisory', 'nonsense']) {
      expect(resolveOffRailPosture({ offRail: value })).toBe('advisory');
    }
  });
});

describe('buildOffRailReviewStep — a review that did not run is never a pass', () => {
  it('marks a skipped review as skipped, with no verdict and no ok:false', () => {
    const step = buildOffRailReviewStep({ skipped: true, reason: 'policy_disabled' });
    expect(step).toEqual({ step: 'review', skipped: true, reason: 'policy_disabled' });
    // Critically: not ok:false, so the halt logic cannot treat it as a failure.
    expect(step.ok).toBeUndefined();
    expect(step.verdict).toBeUndefined();
  });

  it('preserves the skip reason, defaulting when absent', () => {
    expect(buildOffRailReviewStep({ skipped: true, reason: 'no_project_context' }).reason)
      .toBe('no_project_context');
    expect(buildOffRailReviewStep({ skipped: true }).reason).toBe('review_skipped');
  });

  it('records a genuine pass as ok with its verdict', () => {
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    expect(step.ok).toBe(true);
    expect(step.verdict).toBe('pass');
    expect(step.findingCount).toBe(0);
  });

  it("reports an unavailable reviewer as ok:false with verdict 'unavailable', never 'pass'", () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'unavailable',
      reviewerUnavailable: true,
      llmFailed: true,
      cause: 'not_configured',
      error: 'No ANTHROPIC_API_KEY configured for reviewer',
    });
    expect(step.ok).toBe(false);
    expect(step.verdict).toBe('unavailable');
    expect(step.reviewerUnavailable).toBe(true);
    expect(step.cause).toBe('not_configured');
    expect(step.error).toContain('ANTHROPIC_API_KEY');
  });

  it("refuses to echo verdict 'pass' back for an unavailable reviewer", () => {
    // The exact shape of the defect closed by backlog.fix.ship-review-fail-closed.
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', llmFailed: true });
    expect(step.ok).toBe(false);
    expect(step.verdict).not.toBe('pass');
    expect(step.verdict).toBe('unavailable');
  });

  it("keeps a block verdict from a degraded review", () => {
    const step = buildOffRailReviewStep({
      verdict: 'block',
      reviewerUnavailable: true,
      findings: [{ severity: 'block', category: 'enforcement_modification' }],
    });
    expect(step.verdict).toBe('block');
    expect(step.categories).toContain('enforcement_modification');
  });

  it('normalizes an unrecognized cause to call_failed', () => {
    expect(buildOffRailReviewStep({ llmFailed: true, cause: 'weird' }).cause).toBe('call_failed');
    expect(buildOffRailReviewStep({ llmFailed: true }).cause).toBe('call_failed');
  });

  it('does not throw on an empty or missing result', () => {
    expect(() => buildOffRailReviewStep()).not.toThrow();
    expect(() => buildOffRailReviewStep({})).not.toThrow();
  });
});

describe('buildScopeReconcileStep — enumerates every violation', () => {
  const allowed = ['packages/mcp-rks/src/server/guardrails-audit.mjs', 'tests/unit/*'];

  it('skips with no_scope when there is no scope (session opened without a problemId)', () => {
    for (const allowedFiles of [null, undefined, []]) {
      const step = buildScopeReconcileStep({ changedFiles: ['anything.mjs'], allowedFiles });
      expect(step).toEqual({ step: 'scope_reconcile', skipped: true, reason: 'no_scope' });
    }
    // It must NOT flag every changed file as a violation just because scope is absent.
    expect(buildScopeReconcileStep({ changedFiles: ['a', 'b'], allowedFiles: null }).violations)
      .toBeUndefined();
  });

  it('passes when every changed file is in scope', () => {
    const step = buildScopeReconcileStep({
      changedFiles: ['packages/mcp-rks/src/server/guardrails-audit.mjs', 'tests/unit/a.test.mjs'],
      allowedFiles: allowed,
    });
    expect(step.ok).toBe(true);
    expect(step.violations).toEqual([]);
    expect(step.inScopeCount).toBe(2);
  });

  it('enumerates EVERY violating path — not a count, not a sample', () => {
    const violating = ['src/rogue-one.mjs', 'docs/rogue-two.md', 'scripts/rogue-three.sh'];
    const step = buildScopeReconcileStep({
      changedFiles: ['tests/unit/ok.test.mjs', ...violating],
      allowedFiles: allowed,
    });
    expect(step.ok).toBe(false);
    expect(step.violations).toEqual(violating);
    expect(step.inScopeCount).toBe(1);
  });

  it('honours trailing-* prefix patterns', () => {
    const step = buildScopeReconcileStep({
      changedFiles: ['tests/unit/deep/nested.test.mjs', 'tests/integration/x.test.mjs'],
      allowedFiles: ['tests/unit/*'],
    });
    expect(step.violations).toEqual(['tests/integration/x.test.mjs']);
  });

  it('does not throw on empty or missing input', () => {
    expect(() => buildScopeReconcileStep()).not.toThrow();
    expect(buildScopeReconcileStep({ changedFiles: [], allowedFiles: allowed }).ok).toBe(true);
  });
});

describe('wiring (full-source scans, no fixed windows)', () => {
  // guardrailsAbort also calls removeScopeFile, and it appears earlier in the
  // file — so these assertions must be scoped to guardrailsOn.
  const GUARDRAILS_ON = AUDIT_SRC.slice(AUDIT_SRC.indexOf('export async function guardrailsOn'));

  it('snapshots the scope BEFORE removeScopeFile destroys it', () => {
    const snapshotIdx = GUARDRAILS_ON.indexOf('const scopeSnapshot = readActiveScope(');
    const removeIdx = GUARDRAILS_ON.indexOf('const scopeFileRemoved = removeScopeFile(');
    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(removeIdx).toBeGreaterThan(snapshotIdx);
  });

  it('invokes the gate at exactly the two pre-integration sites', () => {
    expect(AUDIT_SRC).toMatch(/gate: "gate_alpha"/);
    expect(AUDIT_SRC).toMatch(/gate: "gate_beta"/);
  });

  it('reviews the session commits, never a bare branch name', () => {
    // The direct guard against review.mjs returning a false verdict 'pass' over
    // an empty diff: at the gates HEAD is a branch with no commits relative to
    // the working branch, so `staging...HEAD` would be empty.
    expect(AUDIT_SRC).toMatch(/targetBranch: activeSession\.headCommit/);
    expect(AUDIT_SRC).not.toMatch(/targetBranch: ['"]staging['"]/);
    expect(AUDIT_SRC).not.toMatch(/targetBranch: gitState\.branch/);
  });

  it('leaves review.mjs unmodified', () => {
    expect(REVIEW_SRC).toMatch(/export function getDiff\(projectRoot, targetBranch = 'staging'\)/);
    expect(REVIEW_SRC).toMatch(/targetBranch = 'staging'/);
  });

  it('keeps git add -A argument-free — no partial-commit path', () => {
    // Filtering the index to in-scope paths only would leave the remainder dirty
    // on an off-rail branch that the later delete/merge steps destroy — silent
    // work loss. Out-of-scope files are committed and reported, never filtered.
    const autoShip = AUDIT_SRC.slice(AUDIT_SRC.indexOf('skipAutoShip'));
    expect(autoShip).toMatch(/execSync\("git add -A"/);
    const addCalls = autoShip.split('\n').filter((l) => l.includes('git add'));
    expect(addCalls.length).toBeGreaterThan(0);
    for (const line of addCalls) {
      expect(line).toContain('"git add -A"');
    }
  });

  it('keeps commitAndEmbed after the first skipAutoShip token', () => {
    // tests/unit/guardrails-audit.spec.mjs:717 slices from indexOf("skipAutoShip")
    // to EOF and asserts commitAndEmbed is inside that slice.
    const skipIdx = AUDIT_SRC.indexOf('skipAutoShip');
    const commitIdx = AUDIT_SRC.indexOf('await commitAndEmbed(projectRoot, commitMessage)');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(skipIdx);
  });

  it('leaves the skipAutoShip else-branch ungated by design', () => {
    // Exit :1830 is deliberately not gated — it is reached when the session
    // produced nothing, or when an internal caller passes skipAutoShip.
    const elseIdx = AUDIT_SRC.lastIndexOf('// No uncommitted changes, but check for unpushed commits');
    expect(elseIdx).toBeGreaterThan(-1);
    expect(AUDIT_SRC.slice(elseIdx)).not.toMatch(/runOffRailEnforcementGate\(/);
  });

  it('carries the enforcement fields on all three auto-ship telemetry emits', () => {
    for (const event of ['guardrails.direct_pushed', 'guardrails.auto_shipped']) {
      const blocks = AUDIT_SRC.split(`collector.emit("${event}"`).slice(1);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const emit = block.slice(0, block.indexOf('});'));
        expect(emit).toContain('reviewVerdict');
        expect(emit).toContain('scopeViolations');
      }
    }
  });

  it('documents the intentional asymmetry with the on-rail gate', () => {
    expect(AUDIT_SRC).toMatch(/asymmetric|asymmetry/i);
    expect(AUDIT_SRC).toMatch(/escape hatch/i);
  });
});
