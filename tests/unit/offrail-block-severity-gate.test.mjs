/**
 * Tests for backlog.fix.offrail-gate-block-findings-are-inert.
 *
 * THE DEFECT. Three off-rail ships in one day returned `verdict: "warn"` while
 * carrying findings whose own `severity` read `"block"` — "zero of the story's
 * acceptance criteria are implemented" was one of them — and auto-shipped, with
 * the story marked `integrated`.
 *
 * The obvious reading ("advisory was too permissive") is wrong. `computeFinalVerdict`
 * in review.mjs downgrades a block-severity finding to a `warn` VERDICT whenever the
 * finding's category is absent from `policy.blockCategories`, and the default policy
 * lists only enforcement_modification and security_issue while putting `ac_coverage`
 * and `test_coverage` — exactly what a reviewer raises most — in warnCategories. The
 * gate then read only the collapsed verdict. So `offRail: block` was INERT against
 * the findings it most needed to catch, and advisory additionally marked the story
 * done.
 *
 * WHY THESE ARE PURE-HELPER TESTS AND NOT FIXTURES. The off-rail integration
 * fixtures run against an UNREGISTERED project id, so `runReview` throws in
 * `loadContext` and yields `reviewerUnavailable: true`; `buildOffRailReviewStep`
 * spreads `findings` only under `r.findings?.length`, so that path emits no
 * `findings` key at all. There is therefore NO end-to-end route in CI to a
 * block-severity finding — an "integration test" for these ACs would be a fake.
 * The halt decision and the phase-advance-suppression decision are exported pure
 * functions for exactly this reason, following the precedent already set by
 * `resolveOffRailPosture`, `buildOffRailReviewStep` and `buildScopeReconcileStep`
 * (see tests/unit/off-rail-enforcement-helpers.test.mjs).
 *
 * UNIT TIER: no subprocesses anywhere in this file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveOffRailHalt,
  resolvePhaseAdvanceSuppression,
  blockSeverityCategories,
  blockSeverityFindingCount,
  buildOffRailReviewStep,
  resolveOffRailPosture,
} from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';
import {
  redactFindings,
  redactReview,
  loadReviewPolicy,
  computeFinalVerdict,
  MAX_PERSISTED_FINDINGS,
} from '../../packages/mcp-rks/src/server/review.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8'
);
const GUARDRAILS_ON = AUDIT_SRC.slice(AUDIT_SRC.indexOf('export async function guardrailsOn'));

/** A review step as buildOffRailReviewStep would emit it for a policy-downgraded block. */
const downgradedBlockStep = (overrides = {}) => ({
  step: 'review',
  ok: true,
  verdict: 'warn',
  findingCount: 1,
  categories: ['ac_coverage'],
  findings: [{ severity: 'block', category: 'ac_coverage', message: 'no ACs implemented' }],
  ...overrides,
});

const passingScope = { step: 'scope_reconcile', ok: true, inScopeCount: 2, violations: [] };
const violatingScope = {
  step: 'scope_reconcile',
  ok: false,
  inScopeCount: 0,
  violations: ['src/rogue.mjs'],
};

describe('resolveOffRailHalt — the block posture finally fires on a downgraded block', () => {
  it('HALT ON DOWNGRADED BLOCK: severity block + verdict warn halts as review_block_finding', () => {
    // The exact defect case. The collapsed verdict never says "block", so the old
    // predicate saw nothing to halt on.
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: downgradedBlockStep(),
        scopeStep: passingScope,
        overrideApplied: false,
      })
    ).toBe('review_block_finding');
  });

  it('PRECEDENCE PRESERVED: a genuine verdict block still reports review_block', () => {
    // The two values must stay separable in telemetry: one means "the reviewer
    // said block", the other means "policy softened a block the reviewer raised".
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: { step: 'review', ok: true, verdict: 'block', findings: [] },
        scopeStep: passingScope,
      })
    ).toBe('review_block');

    // A block-severity finding whose category IS in blockCategories never reaches
    // the gate as a warn — computeFinalVerdict leaves the verdict at block — so it
    // reports review_block, NOT review_block_finding.
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: {
          step: 'review',
          verdict: 'block',
          findings: [{ severity: 'block', category: 'security_issue' }],
        },
        scopeStep: passingScope,
      })
    ).toBe('review_block');
  });

  it('review_unavailable UNCHANGED: an unavailable reviewer carries no findings and still halts', () => {
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: {
          step: 'review',
          ok: false,
          verdict: 'unavailable',
          reviewerUnavailable: true,
          cause: 'not_configured',
        },
        scopeStep: passingScope,
      })
    ).toBe('review_unavailable');
  });

  it('scope_violation UNCHANGED — the predicate still fires for a genuine ok:false step', () => {
    // COMMENT CORRECTED by backlog.fix.offrail-scope-containment-unevidenced.
    // This used to say buildScopeReconcileStep returns ok:true so no live scope
    // violation could be produced any more. That is no longer true, and while it
    // was true it was itself an instance of the defect class this area keeps
    // producing: the reconcile input was pre-filtered by allowedFiles, so
    // `violations` was [] by construction and the field named an evaluation that
    // never happened. `violations` is now read from the real commit manifest, so a
    // violation IS reachable end to end — see the fixture in
    // tests/integration/off-rail-ship-enforcement-gate.test.mjs. The predicate-level
    // assertion below is unchanged and still the right place to pin the branch.
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: { step: 'review', ok: true, verdict: 'pass', findings: [] },
        scopeStep: violatingScope,
      })
    ).toBe('scope_violation');
  });

  it('THE DEFERRAL PROOF — an unevaluated scope step never halts, in either flavour', () => {
    // This is the direct, testable consequence of buildScopeReconcileStep omitting
    // `ok` rather than setting it false, and the reason ok:false was rejected. If
    // someone "tidies" that to ok:false, gate alpha starts halting every
    // empty-index ship under block posture and the deferred halt-posture concern
    // ships by accident. This assertion is what catches that.
    for (const reason of ['no_commit', 'manifest_unreadable']) {
      expect(
        resolveOffRailHalt({
          posture: 'block',
          reviewStep: { step: 'review', ok: true, verdict: 'pass', findings: [] },
          scopeStep: { step: 'scope_reconcile', evaluated: false, reason },
        })
      ).toBeNull();
    }
  });

  it('ADVISORY NEVER HALTS, for every finding shape — the escape hatch is not wedged', () => {
    const shapes = [
      downgradedBlockStep(),
      { step: 'review', verdict: 'block', findings: [{ severity: 'block', category: 'security_issue' }] },
      { step: 'review', ok: false, verdict: 'unavailable', reviewerUnavailable: true },
      { step: 'review', skipped: true, reason: 'policy_disabled' },
      { step: 'review', ok: true, verdict: 'pass', findings: [] },
    ];
    for (const reviewStep of shapes) {
      for (const scopeStep of [passingScope, violatingScope]) {
        expect(resolveOffRailHalt({ posture: 'advisory', reviewStep, scopeStep })).toBeNull();
      }
    }
  });

  it('OVERRIDE UNCHANGED: an applied override suppresses the halt even with a block finding', () => {
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: downgradedBlockStep(),
        scopeStep: passingScope,
        overrideApplied: true,
      })
    ).toBeNull();
  });

  it('DEFENSIVE INPUTS: no findings key, null, [], a non-array, or severity-less entries', () => {
    // buildOffRailReviewStep spreads `findings` only under r.findings?.length, so
    // the skipped and unavailable paths genuinely arrive with the key ABSENT. This
    // is a required contract, not belt-and-braces.
    const findingShapes = [
      undefined,
      null,
      [],
      'not-an-array',
      42,
      {},
      [{ category: 'ac_coverage' }],
      [null, undefined],
      [{ severity: 'warn', category: 'anti_patterns' }],
    ];
    for (const findings of findingShapes) {
      for (const posture of ['block', 'advisory']) {
        const reviewStep = { step: 'review', ok: true, verdict: 'warn', findings };
        expect(() =>
          resolveOffRailHalt({ posture, reviewStep, scopeStep: passingScope })
        ).not.toThrow();
        expect(resolveOffRailHalt({ posture, reviewStep, scopeStep: passingScope })).toBeNull();
      }
    }
    // And the helper itself survives being called with nothing at all.
    expect(() => resolveOffRailHalt()).not.toThrow();
    expect(resolveOffRailHalt()).toBeNull();
    expect(resolveOffRailHalt({})).toBeNull();
    expect(resolveOffRailHalt({ posture: 'block' })).toBeNull();
  });

  it('NO-BLOCK-FINDINGS PARITY: block posture with a clean review still does not halt', () => {
    expect(
      resolveOffRailHalt({
        posture: 'block',
        reviewStep: buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] }),
        scopeStep: passingScope,
      })
    ).toBeNull();
  });
});

describe('blockSeverityCategories / blockSeverityFindingCount — never throw, never invent', () => {
  it('returns the complete DEDUPED category list, not a count and not a sample', () => {
    const step = {
      findings: [
        { severity: 'block', category: 'ac_coverage' },
        { severity: 'warn', category: 'anti_patterns' },
        { severity: 'block', category: 'test_coverage' },
        { severity: 'block', category: 'ac_coverage' },
      ],
    };
    expect(blockSeverityCategories(step)).toEqual(['ac_coverage', 'test_coverage']);
    expect(blockSeverityFindingCount(step)).toBe(3);
  });

  it('counts an uncategorised block finding without inventing a category for it', () => {
    const step = { findings: [{ severity: 'block' }, { severity: 'block', category: '' }] };
    expect(blockSeverityCategories(step)).toEqual([]);
    expect(blockSeverityFindingCount(step)).toBe(2);
  });

  it('tolerates every degenerate input', () => {
    for (const step of [undefined, null, {}, { findings: null }, { findings: 'x' }, { findings: 7 }]) {
      expect(blockSeverityCategories(step)).toEqual([]);
      expect(blockSeverityFindingCount(step)).toBe(0);
    }
  });
});

describe('resolvePhaseAdvanceSuppression — advisory ships the code, not the "done" flag', () => {
  // WITNESS UPDATE, NOT DELETION. This block was a five-entry loop asserting
  // toBeNull for all five. Four of the five now suppress, and folding them back
  // into a loop would hide WHICH one changed meaning, so the loop is split into
  // seven named cases. backlog.feat.phase-advance-binds-to-ac-coverage-evidence
  // is the story that moved them: "the reviewer found nothing wrong" and "the
  // reviewer assessed nothing" used to be the same answer here, and that is the
  // defect. Two of the seven did not exist before and are the only witnesses to
  // the policy_disabled narrowing.

  it('THE RECORDED DECISION still returns null: skipped with reason policy_disabled', () => {
    // The one skipped producer that is a DECISION rather than a failure. Unchanged.
    expect(
      resolvePhaseAdvanceSuppression({ step: 'review', skipped: true, reason: 'policy_disabled' })
    ).toBeNull();
  });

  it('THE STRONGEST NOT-ASSESSED CASE: a bare undefined step suppresses as not-assessed', () => {
    // Asserted explicitly rather than in a loop. There is no weaker input than
    // "no review step at all", and it previously returned null — a gate answering
    // "nothing to suppress" for a review that does not exist.
    const suppression = resolvePhaseAdvanceSuppression(undefined);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
    expect(resolvePhaseAdvanceSuppression(undefined, { advanceOnUnassessedAC: true })).toBeNull();
  });

  it('A FAILED REVIEWER SUPPRESSES: reviewerUnavailable carries no coverage evidence', () => {
    const step = { step: 'review', ok: false, reviewerUnavailable: true };
    const suppression = resolvePhaseAdvanceSuppression(step);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true })).toBeNull();
  });

  it('A CLEAN PASS WITH NO COVERAGE REPORT SUPPRESSES: zero findings is not evidence', () => {
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    const suppression = resolvePhaseAdvanceSuppression(step);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true })).toBeNull();
  });

  it('A WARN WITH NO COVERAGE REPORT SUPPRESSES', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'warn',
      findings: [{ severity: 'warn', category: 'anti_patterns' }],
    });
    const suppression = resolvePhaseAdvanceSuppression(step);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true })).toBeNull();
  });

  it('THE NARROWING HAS A WITNESS: review_module_unavailable is a FAILURE, and suppresses', () => {
    // NEW ENTRY — this input did not exist in this file before. Without it the
    // narrowing of the skipped rule to policy_disabled ships unwitnessed, and a
    // module that failed to load would report a user decision the user never made.
    const suppression = resolvePhaseAdvanceSuppression({
      step: 'review',
      skipped: true,
      reason: 'review_module_unavailable',
    });
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
  });

  it('THE NARROWING HAS A WITNESS: no_project_context is a FAILURE, and suppresses', () => {
    // NEW ENTRY — likewise absent before.
    const suppression = resolvePhaseAdvanceSuppression({
      step: 'review',
      skipped: true,
      reason: 'no_project_context',
    });
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
  });

  it('THE ORIGINAL INTENT PRESERVED: real coverage evidence with nothing outstanding returns null', () => {
    // What "nothing to suppress" means now that it has to be earned.
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: { assessed: true, covered: ['AC1', 'AC2'], notCovered: [], uncertain: [] },
    });
    expect(resolvePhaseAdvanceSuppression(step)).toBeNull();
  });

  it('names the responsible categories in full when a block-severity finding is present', () => {
    const suppression = resolvePhaseAdvanceSuppression({
      findings: [
        { severity: 'block', category: 'ac_coverage' },
        { severity: 'block', category: 'test_coverage' },
        { severity: 'warn', category: 'anti_patterns' },
      ],
    });
    expect(suppression).not.toBeNull();
    // The COMPLETE deduped array, asserted as an array — not a count, not a sample.
    expect(suppression.categories).toEqual(['ac_coverage', 'test_coverage']);
    expect(suppression.findingCount).toBe(2);
    expect(suppression.reason).toContain('ac_coverage');
    expect(suppression.reason).toContain('test_coverage');
  });

  it('DOWNGRADE-FIELD REUSE: reuses downgradeReason VERBATIM where legibility supplied it', () => {
    const downgradeReason =
      "verdictMode 'warn' downgraded block to warn: block-severity finding categories " +
      '[ac_coverage] are not listed in policy blockCategories [enforcement_modification, security_issue]';
    const suppression = resolvePhaseAdvanceSuppression(
      downgradedBlockStep({ downgradedFrom: 'block', downgradeReason })
    );
    // Verbatim — the rationale is not recomputed here.
    expect(suppression.reason).toBe(downgradeReason);
  });

  it('falls back to a locally composed reason when the downgrade fields are absent or null', () => {
    for (const overrides of [
      {},
      { downgradedFrom: null, downgradeReason: null },
      { downgradedFrom: 'block', downgradeReason: undefined },
      { downgradedFrom: 'block', downgradeReason: '' },
    ]) {
      const suppression = resolvePhaseAdvanceSuppression(downgradedBlockStep(overrides));
      expect(suppression.reason).toBe('block_severity_finding (ac_coverage)');
      // Never emit the literal string "undefined" into a Dispatcher-visible payload.
      expect(suppression.reason).not.toContain('undefined');
      expect(suppression.reason).not.toContain('null');
    }
  });

  it('composes a reason with no category list when the block finding is uncategorised', () => {
    const suppression = resolvePhaseAdvanceSuppression({ findings: [{ severity: 'block' }] });
    expect(suppression.reason).toBe('block_severity_finding');
    expect(suppression.reason).not.toContain('undefined');
  });

  it('does not throw on degenerate input', () => {
    for (const step of [undefined, null, {}, { findings: 'x' }, { findings: [null] }]) {
      expect(() => resolvePhaseAdvanceSuppression(step)).not.toThrow();
    }
  });
});

describe('the redaction cap cannot hide the finding that halts', () => {
  it('REDACTION-CAP WITNESS: a block finding authored LAST among >25 still trips the halt', () => {
    // redactFindings sorts block-severity first inside its 25-finding cap, so the
    // block survives even when it was authored last. If that sort were ever lost,
    // the block would be truncated away and the halt would silently stop firing.
    const findings = [
      ...Array.from({ length: MAX_PERSISTED_FINDINGS + 5 }, (_, i) => ({
        severity: 'warn',
        category: 'anti_patterns',
        message: `warn ${i}`,
      })),
      { severity: 'block', category: 'ac_coverage', message: 'no ACs implemented' },
    ];
    expect(findings.length).toBeGreaterThan(MAX_PERSISTED_FINDINGS);

    const redacted = redactFindings(findings);
    expect(redacted).toHaveLength(MAX_PERSISTED_FINDINGS);
    expect(redacted[0].severity).toBe('block');

    // Drive the real chain the gate uses: redactReview → buildOffRailReviewStep → halt.
    const reviewStep = buildOffRailReviewStep(
      redactReview({ ok: true, verdict: 'warn', findings })
    );
    expect(reviewStep.verdict).toBe('warn');
    expect(
      resolveOffRailHalt({ posture: 'block', reviewStep, scopeStep: passingScope })
    ).toBe('review_block_finding');
    expect(resolvePhaseAdvanceSuppression(reviewStep).categories).toEqual(['ac_coverage']);
  });
});

describe('wiring — full-source scans, no fixed-size windows', () => {
  it('THE SKIPPED STEP CARRIES NO ok KEY — evaluated from the real source literal', () => {
    // Assert key ABSENCE, not `ok === undefined`: the step-reducing consumer added by
    // backlog.fix.offrail-shipoutcome-ignores-failed-steps reads key-absence as a
    // legitimate skip and `ok: false` as a failure. Evaluate the object literal that
    // actually ships, so this cannot drift from the source.
    const branchIdx = AUDIT_SRC.indexOf('if (advanceSuppression) {');
    expect(branchIdx).toBeGreaterThan(-1);
    const pushIdx = AUDIT_SRC.indexOf('shipSteps.push({', branchIdx);
    const closeIdx = AUDIT_SRC.indexOf('});', pushIdx);
    expect(pushIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(pushIdx);
    const literal = AUDIT_SRC.slice(pushIdx + 'shipSteps.push('.length, closeIdx + 1);

    // STRUCTURAL GUARD ON THE STRING, BEFORE EVALUATION — not on the result.
    // The slice runs to the FIRST '});' after the push, so a literal that grows a
    // nested object or a template literal spanning that sequence truncates here.
    // A truncated slice is an UNBALANCED expression, so `new Function` throws a
    // SyntaxError below and no assertion on `step` ever runs: asserting the
    // evaluated result is non-null is dead code in the exact scenario this guard
    // exists for. Assert the shape of the source text itself.
    const braces = (str, ch) => (str.match(new RegExp(`\\${ch}`, 'g')) || []).length;
    const truncated = 'source slice TRUNCATED: the ship-step literal now contains a "});" ' +
      'before its own close, so indexOf stopped early. Widen the slice, or flatten the literal.';
    expect(literal.trimStart().startsWith('{'), truncated).toBe(true);
    expect(literal.trimEnd().endsWith('}'), truncated).toBe(true);
    expect(braces(literal, '{'), truncated).toBe(braces(literal, '}'));

    const step = new Function(
      'advanceSuppression',
      `return (${literal});`
    )({ reason: 'block_severity_finding (ac_coverage)', categories: ['ac_coverage'], findingCount: 1 });

    expect('ok' in step).toBe(false);
    expect(step).toEqual({
      step: 'advance_phase',
      skipped: true,
      reason: 'block_severity_finding (ac_coverage)',
    });
  });

  it('SHIP-NOTE IS NOT TAKEN WHEN THE ADVANCE IS SUPPRESSED — one gate, not two', () => {
    // (Renamed from "SHIP-NOTE FOLLOWS AUTOMATICALLY", whose title contradicted its
    // own body. The body is what is correct: when the advance is suppressed there is
    // no phase bump, so there is nothing for the note commit to persist.)
    expect((AUDIT_SRC.match(/step: "ship-note"/g) || []).length).toBe(1);
    // Exactly ONE phase-advance guard governs it. A second gate here would be a
    // second place to get the decision wrong.
    expect((AUDIT_SRC.match(/if \(phaseResult\.ok\)/g) || []).length).toBe(1);

    // The suppressed branch reaches neither the note commit nor the reconcile.
    const branchIdx = AUDIT_SRC.indexOf('if (advanceSuppression) {');
    const elseIdx = AUDIT_SRC.indexOf('} else {', branchIdx);
    expect(elseIdx).toBeGreaterThan(branchIdx);
    const suppressedBranch = AUDIT_SRC.slice(branchIdx, elseIdx);
    expect(suppressedBranch).not.toContain('reconcileToIntegrated(');
    expect(suppressedBranch).not.toContain('commitAndPushNote(');
    expect(suppressedBranch).not.toContain('step: "ship-note"');
  });

  it('STORY NOTE UNTOUCHED: reconcileToIntegrated is reachable only on the non-suppressed branch', () => {
    // The disk write that bumps the note to `phase: integrated` IS
    // reconcileToIntegrated; not calling it is what leaves the note at its pre-ship
    // phase. A live end-to-end witness is not achievable (see the file header), so
    // the guarantee is pinned where it is decided.
    expect((AUDIT_SRC.match(/await reconcileToIntegrated\(/g) || []).length).toBe(1);
    const suppressionIdx = GUARDRAILS_ON.indexOf('const advanceSuppression = gateBeta.phaseAdvanceSuppression;');
    const reconcileIdx = GUARDRAILS_ON.indexOf('await reconcileToIntegrated(');
    expect(suppressionIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(suppressionIdx);
  });

  it('RESPONSE NAMES THE SUPPRESSION, and never under the colliding name', () => {
    expect(GUARDRAILS_ON).toContain('response.phaseAdvanceSuppressed = {');
    expect(GUARDRAILS_ON).toMatch(/categories: advanceSuppression\.categories/);
    // resolveShipOutcome ranks autoShipSuppressed ABOVE autoShipped and returns
    // "skipped" for it, which would reclassify a landed merge. Never that name.
    expect(GUARDRAILS_ON).not.toMatch(/phaseAdvance[A-Za-z]*\s*=\s*.*autoShipSuppressed/);
    expect(AUDIT_SRC).not.toContain('autoShipSuppressed = {');
  });

  it('BOTH GATES, ONE IMPLEMENTATION: the severity check lives only inside the gate', () => {
    // One definition, one call — the gate's. Neither call site re-implements it.
    expect((AUDIT_SRC.match(/resolveOffRailHalt\(/g) || []).length).toBe(2);
    expect((AUDIT_SRC.match(/resolvePhaseAdvanceSuppression\(/g) || []).length).toBe(2);
    // And guardrailsOn itself scans no findings and reads no severity of its own.
    expect(GUARDRAILS_ON).not.toMatch(/\.findings\b/);
    expect(GUARDRAILS_ON).not.toMatch(/severity/);
  });

  it('both gates surface the new haltReason with the right haltedAt and recovery branch', () => {
    for (const gate of ['gateAlpha', 'gateBeta']) {
      expect(AUDIT_SRC).toContain(`if (${gate}.haltReason) {`);
      expect(AUDIT_SRC).toContain(`response.haltReason = ${gate}.haltReason;`);
      expect(AUDIT_SRC).toContain(`response.haltedAt = ${gate}.haltedAt;`);
      // Both inherit the block-severity signal from the single implementation.
      expect(AUDIT_SRC).toContain(`${gate}.blockFindingCategories`);
    }
    // haltedAt is stamped from the gate label, once, inside the gate.
    expect(AUDIT_SRC).toContain('haltedAt: haltReason ? gate : null');
    expect(AUDIT_SRC).toContain('response.recoveryBranch = gitState.branch;');
    expect(AUDIT_SRC).toContain('response.recoveryBranch = branchName;');
  });

  it('the halt decision is no longer built inline in the gate', () => {
    // The old three-branch let/if block is gone; the gate delegates.
    expect(AUDIT_SRC).not.toMatch(/let haltReason = null;/);
    expect(AUDIT_SRC).toMatch(
      /const haltReason = resolveOffRailHalt\(\{ posture, reviewStep, scopeStep, overrideApplied \}\)/
    );
  });
});

describe('the neighbouring decisions this story must NOT have moved', () => {
  it('resolveOffRailPosture is untouched: advisory by default, block only for "block"', () => {
    for (const policy of [undefined, null, {}, { enabled: true }, { offRail: 'BLOCK' }, { offRail: 'blocked' }, { offRail: true }, { offRail: 1 }, { offRail: {} }, { offRail: [] }, { offRail: 'advisory' }, { offRail: 'nonsense' }]) {
      expect(resolveOffRailPosture(policy)).toBe('advisory');
    }
    expect(resolveOffRailPosture({ offRail: 'block' })).toBe('block');
  });

  it('review.mjs IS NOT EDITED: no category moved between blockCategories and warnCategories', () => {
    // loadReviewPolicy falls back to its defaults when no policy file exists, so a
    // bare temp dir reads the defaults object directly. No subprocess involved.
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offrail-policy-defaults-'));
    try {
      const defaults = loadReviewPolicy(bareRoot);
      expect(defaults.blockCategories).toEqual(['enforcement_modification', 'security_issue']);
      expect(defaults.warnCategories).toContain('ac_coverage');
      expect(defaults.warnCategories).toContain('test_coverage');
      expect(defaults.blockCategories).not.toContain('ac_coverage');
      expect(defaults.blockCategories).not.toContain('test_coverage');
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it("computeFinalVerdict's verdict values are unchanged — the downgrade still happens", () => {
    const policy = {
      verdictMode: 'warn',
      blockCategories: ['enforcement_modification', 'security_issue'],
    };
    // The defect's own input: block severity, warn-category → verdict 'warn'.
    const softened = computeFinalVerdict({
      patternFindings: [],
      allFindings: [{ severity: 'block', category: 'ac_coverage' }],
      llmVerdict: 'block',
      policy,
    });
    expect(softened.verdict).toBe('warn');
    expect(softened.downgradedFrom).toBe('block');

    // A hard-block category is NOT softened.
    const hard = computeFinalVerdict({
      patternFindings: [{ severity: 'block', category: 'security_issue' }],
      allFindings: [{ severity: 'block', category: 'security_issue' }],
      llmVerdict: 'warn',
      policy,
    });
    expect(hard.verdict).toBe('block');

    // This story fixes the GATE, not the verdict: the softened verdict is still
    // 'warn' and it is the gate that now notices the severity underneath it.
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: softened.verdict,
      downgradedFrom: softened.downgradedFrom,
      downgradeReason: softened.downgradeReason,
      findings: [{ severity: 'block', category: 'ac_coverage' }],
    });
    expect(step.verdict).toBe('warn');
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: step, scopeStep: passingScope }))
      .toBe('review_block_finding');
    expect(resolvePhaseAdvanceSuppression(step).reason).toBe(softened.downgradeReason);
  });
});
