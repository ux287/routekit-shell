/**
 * Tests for backlog.feat.phase-advance-binds-to-ac-coverage-evidence.
 *
 * THE DEFECT. `rks_guardrails_on` advanced a story to `integrated` whatever the
 * review said. The suppression gate read BLOCK-SEVERITY FINDINGS, and a reviewer
 * that never ran produces no findings at all — so `buildUnavailableReview`, the
 * path every CI fixture takes, scored zero blockers and the story was recorded
 * done without a single acceptance criterion having been examined. "The reviewer
 * found nothing wrong" and "the reviewer assessed nothing" were the same answer.
 *
 * THE FIX UNDER TEST. The phase advance is bound to acceptance-criteria
 * EVIDENCE, and "no evidence" is given its own state that SUPPRESSES. The
 * decisive case is therefore the one that used to be invisible: a broken
 * reviewer must now stop the story being marked done MORE reliably than a
 * working one, not less.
 *
 * WHY PURE-HELPER AND MOCKED-RUNREVIEW TESTS. The off-rail integration fixtures
 * run against an unregistered project id, so runReview throws in loadContext and
 * every fixture yields `reviewerUnavailable: true` with no findings and no
 * coverage. There is no end-to-end route in CI to a populated `acCoverage`; an
 * "integration test" for these ACs would be a fake. The decision is an exported
 * pure function for exactly this reason, and the runReview half is driven
 * through the exported entry point with its collaborators mocked.
 *
 * UNIT TIER: no subprocesses anywhere in this file (child_process is mocked, and
 * no spawn-family call form appears). This file must contain NO literal
 * '@routekit' + '/telemetry' specifier — telemetry-global-mock-triage.test.mjs
 * classifies files by scanning for it and an untriaged consumer reddens the tier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// A root with no .rks/review-policy.yaml, so loadReviewPolicy falls back to its
// defaults. Nothing here ever touches the path on disk.
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'ac-coverage-gate-nonexistent-root');

const chatMock = vi.fn();
const loadEnvMock = vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' }));
const readNoteMock = vi.fn(() => null);

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: (...args) => loadEnvMock(...args),
  createAnthropicClient: vi.fn(() => ({ stub: true })),
  callAnthropicChat: (...args) => chatMock(...args),
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', () => ({
  loadContext: vi.fn(async () => ({ record: { root: FAKE_ROOT } })),
}));

vi.mock('../../packages/mcp-rks/src/dendron.mjs', () => ({
  resolveNotesDir: vi.fn(() => path.join(FAKE_ROOT, 'notes')),
  readNote: (...args) => readNoteMock(...args),
}));

vi.mock('@routekit/rag', () => ({
  runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })),
}));

// A benign .md diff, so runPatternChecks produces ZERO findings and cannot
// contaminate the coverage-driven outcomes under test.
const FAKE_DIFF = [
  'diff --git a/docs/notes.md b/docs/notes.md',
  '--- a/docs/notes.md',
  '+++ b/docs/notes.md',
  '@@ -1,1 +1,2 @@',
  ' existing line',
  '+an added documentation line',
].join('\n');

vi.mock('child_process', () => {
  const impl = (_cmd, args = []) =>
    args.includes('--name-only')
      ? { stdout: 'docs/notes.md\n', stderr: '', status: 0 }
      : { stdout: FAKE_DIFF, stderr: '', status: 0 };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const { runReview, buildReviewPrompt, buildUnavailableReview, loadReviewPolicy, redactReview } =
  await import('../../packages/mcp-rks/src/server/review.mjs');

const {
  buildOffRailReviewStep,
  resolvePhaseAdvanceSuppression,
  MAX_AC_COVERAGE_ENTRIES,
  MAX_AC_COVERAGE_ENTRY_CHARS,
} = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');

const REVIEW_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/review.mjs'),
  'utf8',
);
const AUDIT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8',
);
const GUARDRAILS_ON = AUDIT_SRC.slice(AUDIT_SRC.indexOf('export async function guardrailsOn'));

/** A review step as buildOffRailReviewStep emits it, with the given coverage. */
const stepWithCoverage = (acCoverage) =>
  buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [], acCoverage });

const CLEAN = { assessed: true, covered: ['AC1', 'AC2'], notCovered: [], uncertain: [] };

const storyWithAc = (body) => ({
  title: 'A story',
  desc: 'A description',
  content: `# A story\n\n## Problem\n\nsomething\n\n## Acceptance Criteria\n${body}\n\n## Testing Requirements\n\n- a test\n`,
});

// backlog.fix.ac-section-extraction-truncates-at-subheading.
//
// EVERY fixture above is FLAT. That is exactly why the shipped binding pair
// passes against the defect: a flat body contains no level-3 subheading, so the
// lazy quantifier never terminates early and the whole section is extracted. The
// fixtures below are subsectioned, which is the one property a real witness of
// this defect must have.
const storyWithSubsectionedAc = (groups) => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Problem\n\nsomething\n\n## Acceptance Criteria\n\n' +
    groups.map(([h, body]) => `### ${h}\n${body}\n`).join('\n') +
    '\n## Testing Requirements\n\n- a test\n',
});

/** AC section subsectioned AND final — no following level-2 heading at all. */
const storyWithSubsectionedFinalAc = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Problem\n\nsomething\n\n## Acceptance Criteria\n\n' +
    '### Group A\n- [ ] alpha-final\n\n### Group B\n- [ ] beta-final\n',
});

/** Headings on consecutive lines, no blank separator anywhere. */
const storyAdjacentHeadings = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n## Acceptance Criteria\n### Group\n- [ ] alpha\n' +
    '## Testing Requirements\n- [ ] beta\n',
});

const storyWithSubsectionedTesting = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1\n\n' +
    '## Testing Requirements\n\n### Tier one\n- [ ] tier-one-marker\n',
});

const promptFor = (story) =>
  buildReviewPrompt({ diff: FAKE_DIFF, story, ragContext: [], changedFiles: ['docs/notes.md'] });

/** The Acceptance Criteria slot of the prompt, up to the next level-3 heading. */
const acSlotOf = (prompt) => {
  const start = prompt.indexOf('### Acceptance Criteria');
  const end = prompt.indexOf('### Testing Requirements', start);
  expect(start, 'prompt has no Acceptance Criteria slot').toBeGreaterThan(-1);
  expect(end, 'prompt has no Testing Requirements slot').toBeGreaterThan(start);
  return prompt.slice(start, end);
};


// backlog.fix.ac-section-opener-not-line-anchored — decoy fixtures.
//
// THE DEFECT. The section terminator is anchored (it demands a newline before
// the hashes) but the OPENER is the bare literal with no start anchor, no `m`
// and no `g`. `String.match` on a non-global pattern returns the FIRST
// occurrence anywhere in the content — so a mention inside prose, inside an
// inline code span, or inside a fenced example opens the section, and the
// reviewer is shown text that is not the story's criteria at all.
const AC_H = '## Acceptance Criteria';
const TS_H = '## Testing Requirements';

/** The Testing Requirements slot of the prompt, from its heading to the end. */
const tsSlotOf = (prompt) => {
  const start = prompt.indexOf('### Testing Requirements');
  expect(start, 'prompt has no Testing Requirements slot').toBeGreaterThan(-1);
  return prompt.slice(start);
};

/** A story whose decoy mention sits MID-LINE inside a backtick span. */
const storyMidLineDecoy = ({ realHeading = true } = {}) => ({
  title: 'A story', desc: 'A description',
  content:
    '# A story\n\n## Solution\n\n' +
    'The pin asserts `' + AC_H + '` occurs once. DECOY-PROSE-MARKER lives here.\n\n' +
    (realHeading ? AC_H + '\n\n- [ ] REAL-CRITERION-MARKER\n\n' : '') +
    TS_H + '\n\n- a test\n',
});

/** A story whose decoy is a LINE-INITIAL heading inside a fenced block. */
const storyFencedDecoy = ({ fence = '```', realHeading = true } = {}) => ({
  title: 'A story', desc: 'A description',
  content:
    '# A story\n\n## Solution\n\n' + fence + 'markdown\n' +
    AC_H + '\n- [ ] DECOY-PROSE-MARKER\n' + fence + '\n\n' +
    (realHeading ? AC_H + '\n\n- [ ] REAL-CRITERION-MARKER\n\n' : '') +
    TS_H + '\n\n- a test\n',
});

/** Decoys placed before the real TESTING heading, for the second call site. */
const storyTestingDecoy = ({ fenced = false } = {}) => ({
  title: 'A story', desc: 'A description',
  content:
    '# A story\n\n' + AC_H + '\n\n- [ ] REAL-CRITERION-MARKER\n\n## Solution\n\n' +
    (fenced
      ? '```markdown\n' + TS_H + '\n- [ ] DECOY-TEST-MARKER\n```\n\n'
      : 'The `' + TS_H + '` slot. DECOY-TEST-MARKER lives here.\n\n') +
    TS_H + '\n\n- [ ] REAL-TEST-MARKER\n',
});

/** The two consecutive real-corpus lines from the ac4d4eb1 production failure. */
const CORPUS_184 = '- ' + '`' + AC_H + '`' + ' occurring mid-line (inside a fenced block, say) would open a section.';
const CORPUS_185 = '- The three e2e files failing on `staging` at a clean HEAD through `planner.mjs:1013`. Pre-existing, unrelated.';

const storyProductionRepro = () => ({
  title: 'A story', desc: 'A description',
  content:
    '# A story\n\n## Out of scope\n\n' + CORPUS_184 + '\n' + CORPUS_185 + '\n\n' +
    AC_H + '\n\n- [ ] REAL-CRITERION-MARKER\n\n' + TS_H + '\n\n- a test\n',
});

const storyWithoutAc = () => ({
  title: 'A story',
  desc: 'A description',
  content: '# A story\n\n## Problem\n\nsomething\n\n## Testing Requirements\n\n- a test\n',
});

const runReviewUnderTest = () =>
  runReview({
    projectId: 'routekit-shell-core',
    problemId: 'backlog.feat.some-story',
    branch: 'staging',
    targetBranch: 'staging',
  });

beforeEach(() => {
  chatMock.mockReset();
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => null);
  loadEnvMock.mockReset();
  loadEnvMock.mockImplementation(() => ({ anthropicKey: 'test-key-not-a-real-credential' }));
});

describe('the three states of coverage evidence are three different answers', () => {
  it('THREE-STATE WITNESS: clean, not-covered and never-assessed are pairwise distinguishable', () => {
    // The whole point of the story. Asserting only suppressed-versus-not cannot
    // separate state B from state C, and a gate that conflates them is the gate
    // this story replaces.
    const cases = [
      {
        state: 'A — assessed, everything covered',
        step: stepWithCoverage(CLEAN),
        expectNull: true,
      },
      {
        state: 'B — assessed, a criterion is NOT covered',
        step: stepWithCoverage({ ...CLEAN, notCovered: ['AC3 is not implemented'] }),
        expectNull: false,
      },
      {
        state: 'C — no coverage report at all',
        step: buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] }),
        expectNull: false,
      },
    ];

    const outcomes = cases.map(({ state, step, expectNull }) => {
      const suppression = resolvePhaseAdvanceSuppression(step);
      if (expectNull) {
        expect(suppression, state).toBeNull();
        return null;
      }
      expect(suppression, state).not.toBeNull();
      return suppression.reason;
    });

    expect(outcomes[0]).toBeNull();
    // B and C both suppress — and say DIFFERENT things about why.
    expect(outcomes[1]).not.toBe(outcomes[2]);
  });

  it('REASON DISCRIMINATORS ARE PAIRWISE DISTINCT', () => {
    // Never a bare toContain('ac_coverage'): that substring is a prefix of two of
    // these reasons AND is the existing block-finding category value already
    // asserted at offrail-block-severity-gate.test.mjs. Word-anchored, with
    // explicit negatives on the siblings.
    const notCovered = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, notCovered: ['AC3'] }),
    ).reason;
    const uncertain = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, uncertain: ['AC4'] }),
    ).reason;
    const notAssessed = resolvePhaseAdvanceSuppression(undefined).reason;

    expect(notCovered).toMatch(/\bac_not_covered\b/);
    expect(notCovered).not.toMatch(/\bac_coverage_not_assessed\b/);
    expect(notCovered).not.toMatch(/\bac_coverage_uncertain\b/);

    expect(uncertain).toMatch(/\bac_coverage_uncertain\b/);
    expect(uncertain).not.toMatch(/\bac_not_covered\b/);
    expect(uncertain).not.toMatch(/\bac_coverage_not_assessed\b/);

    expect(notAssessed).toMatch(/\bac_coverage_not_assessed\b/);
    expect(notAssessed).not.toMatch(/\bac_not_covered\b/);
    expect(notAssessed).not.toMatch(/\bac_coverage_uncertain\b/);
  });

  it('THE COUNT IS MEASURED, NOT HARDCODED: three uncovered criteria report three', () => {
    const three = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, notCovered: ['AC3', 'AC4', 'AC5'] }),
    ).reason;
    const one = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, notCovered: ['AC3'] }),
    ).reason;
    expect(three).toMatch(/\b3\b/);
    expect(one).toMatch(/\b1\b/);
    expect(three).not.toBe(one);

    const twoUncertain = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, uncertain: ['AC4', 'AC5'] }),
    ).reason;
    expect(twoUncertain).toMatch(/\b2\b/);
  });

  it('NOT-COVERED WINS over uncertain when both are non-empty', () => {
    // Deterministic and asserted, per the story's fixed predicate order.
    const suppression = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ ...CLEAN, notCovered: ['AC3'], uncertain: ['AC4'] }),
    );
    expect(suppression.reason).toMatch(/\bac_not_covered\b/);
    expect(suppression.reason).not.toMatch(/\bac_coverage_uncertain\b/);
  });

  it('VACUITY GUARD: assessed true with all three lists empty is an echo, not an assessment', () => {
    // The example object in the prompt has exactly this shape. Reporting it as a
    // clean pass would be the defect re-entering one layer down.
    const suppression = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ assessed: true, covered: [], notCovered: [], uncertain: [] }),
    );
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
  });
});

describe('the decisive case: a reviewer that never ran', () => {
  it('DECISIVE NOT-ASSESSED WITNESS: buildUnavailableReview does NOT advance the phase', () => {
    // THE LOAD-BEARING TEST. buildUnavailableReview emits no findings, so the old
    // block-severity gate scored it zero and advanced. Every CI fixture takes this
    // path. Without this assertion the suite never demonstrates that a broken
    // reviewer has stopped marking stories done.
    const step = buildOffRailReviewStep(
      buildUnavailableReview({ error: 'reviewer exploded', cause: 'call_failed' }),
    );
    // Precondition, so this is not vacuous: there really are no findings to score.
    expect(step.findingCount).toBe(0);
    expect(step.reviewerUnavailable).toBe(true);

    const suppression = resolvePhaseAdvanceSuppression(step);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
  });

  it('A REVIEWER-UNAVAILABLE RESULT never reports assessed true', () => {
    const unavailable = buildUnavailableReview({ error: 'boom', cause: 'call_failed' });
    expect(unavailable.acCoverage == null || unavailable.acCoverage.assessed !== true).toBe(true);
    const step = buildOffRailReviewStep(unavailable);
    expect(step.acCoverage === undefined || step.acCoverage.assessed !== true).toBe(true);
  });
});

describe('the opt-in, in both directions', () => {
  it('advanceOnUnassessedAC true advances; omitted, empty and false all suppress', () => {
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true })).toBeNull();
    expect(resolvePhaseAdvanceSuppression(step)).not.toBeNull();
    expect(resolvePhaseAdvanceSuppression(step, {})).not.toBeNull();
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: false })).not.toBeNull();
  });

  it('the opt-in does NOT rescue a real not-covered finding', () => {
    // It opts out of the ABSENCE rule only. Evidence that criteria are unmet is
    // still evidence, and still suppresses.
    const step = stepWithCoverage({ ...CLEAN, notCovered: ['AC3'] });
    expect(resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true })).not.toBeNull();
  });
});

describe('degenerate coverage shapes all resolve to not-assessed, and never throw', () => {
  it('every degenerate acCoverage suppresses as not-assessed', () => {
    const shapes = [
      ['key absent', {}],
      ['null', { acCoverage: null }],
      ['undefined', { acCoverage: undefined }],
      ['empty object', { acCoverage: {} }],
      ['assessed false', { acCoverage: { assessed: false, notCovered: ['AC3'] } }],
      ['assessed as the STRING "true"', { acCoverage: { assessed: 'true', covered: ['AC1'] } }],
      ['a primitive', { acCoverage: 7 }],
      ['a string', { acCoverage: 'assessed' }],
      ['an array', { acCoverage: ['AC1'] }],
      [
        'non-array list fields',
        { acCoverage: { assessed: true, covered: 'AC1', notCovered: 3, uncertain: null } },
      ],
    ];
    for (const [label, extra] of shapes) {
      const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [], ...extra });
      const suppression = resolvePhaseAdvanceSuppression(step);
      expect(suppression, label).not.toBeNull();
      expect(suppression.reason, label).toMatch(/\bac_coverage_not_assessed\b/);
    }
  });

  it('buildOffRailReviewStep never throws on a degenerate review result', () => {
    for (const result of [null, undefined, 7, 'review', ['a'], { acCoverage: ['a'] }]) {
      expect(() => buildOffRailReviewStep(result)).not.toThrow();
    }
  });

  it('buildOffRailReviewStep never throws when acCoverage property access throws', () => {
    const hostile = {
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: {
        get assessed() {
          throw new Error('hostile getter');
        },
      },
    };
    let step;
    expect(() => {
      step = buildOffRailReviewStep(hostile);
    }).not.toThrow();
    // And it degrades to "no evidence" rather than to a half-built object.
    expect(resolvePhaseAdvanceSuppression(step).reason).toMatch(/\bac_coverage_not_assessed\b/);
  });

  it('resolvePhaseAdvanceSuppression never throws on a degenerate step', () => {
    for (const step of [undefined, null, {}, 7, 'step', [], { acCoverage: 'x' }]) {
      expect(() => resolvePhaseAdvanceSuppression(step)).not.toThrow();
    }
  });
});

describe('the recorded decision, and the two failures wearing its clothes', () => {
  it('SKIPPED policy_disabled returns null even carrying a non-empty notCovered', () => {
    // The fixture MUST set `reason` explicitly. Rule 3 narrows to policy_disabled,
    // and a skipped step built without a reason falls through to the not-assessed
    // rule and suppresses — which is the point of the narrowing.
    expect(
      resolvePhaseAdvanceSuppression({
        step: 'review',
        skipped: true,
        reason: 'policy_disabled',
        acCoverage: { ...CLEAN, notCovered: ['AC3'] },
      }),
    ).toBeNull();

    // The skipped rule is evaluated BEFORE the coverage rule; under the reverse
    // order this case would be unreachable.
    expect(
      resolvePhaseAdvanceSuppression({ step: 'review', skipped: true, reason: 'policy_disabled' }),
    ).toBeNull();
  });

  it('a skipped step with NO reason suppresses — absence is not a decision', () => {
    const suppression = resolvePhaseAdvanceSuppression({ step: 'review', skipped: true });
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toMatch(/\bac_coverage_not_assessed\b/);
  });

  it('the two FAILURE producers of skipped both suppress', () => {
    for (const reason of ['review_module_unavailable', 'no_project_context', 'review_skipped']) {
      const suppression = resolvePhaseAdvanceSuppression({ step: 'review', skipped: true, reason });
      expect(suppression, reason).not.toBeNull();
      expect(suppression.reason, reason).toMatch(/\bac_coverage_not_assessed\b/);
    }
  });
});

describe('nothing that suppressed before has stopped suppressing', () => {
  it('PRECEDENCE: a block finding beats a perfectly clean coverage report', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'warn',
      findings: [{ severity: 'block', category: 'security_issue', message: 'bad' }],
      acCoverage: CLEAN,
    });
    const suppression = resolvePhaseAdvanceSuppression(step);
    expect(suppression).not.toBeNull();
    expect(suppression.reason).toBe('block_severity_finding (security_issue)');
    expect(suppression.reason).not.toMatch(/\bac_/);
  });

  it('BYTE-IDENTICAL LEGACY REASONS', () => {
    expect(
      resolvePhaseAdvanceSuppression({ findings: [{ severity: 'block' }] }).reason,
    ).toBe('block_severity_finding');
    expect(
      resolvePhaseAdvanceSuppression({
        findings: [{ severity: 'block', category: 'ac_coverage' }],
      }).reason,
    ).toBe('block_severity_finding (ac_coverage)');

    const downgradeReason = "verdictMode 'warn' downgraded block to warn: reasons";
    expect(
      resolvePhaseAdvanceSuppression({
        downgradedFrom: 'block',
        downgradeReason,
        findings: [{ severity: 'block', category: 'ac_coverage' }],
      }).reason,
    ).toBe(downgradeReason);
  });

  it('the legacy cause still measures categories and findingCount', () => {
    const suppression = resolvePhaseAdvanceSuppression({
      findings: [
        { severity: 'block', category: 'ac_coverage' },
        { severity: 'block', category: 'test_coverage' },
      ],
    });
    expect(suppression.categories).toEqual(['ac_coverage', 'test_coverage']);
    expect(suppression.findingCount).toBe(2);
  });
});

describe('the payload surface: key absence, bounding and the canary', () => {
  it('KEY ABSENCE, NOT UNDEFINED: acCoverage is genuinely absent when unusable', () => {
    // toEqual and toBeUndefined both pass for an explicitly-undefined key, so
    // neither can witness this. The in-operator can.
    const step = buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [] });
    expect('acCoverage' in step).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(step, 'acCoverage')).toBe(false);

    // And genuinely PRESENT when there is a usable object — so the absence check
    // above is not passing because the key never appears at all.
    expect('acCoverage' in stepWithCoverage(CLEAN)).toBe(true);
  });

  it('SKIPPED SHAPE PINNED TWICE: deep equality AND the sorted key list', () => {
    const step = buildOffRailReviewStep({ skipped: true, reason: 'policy_disabled' });
    expect(step).toEqual({ step: 'review', skipped: true, reason: 'policy_disabled' });
    // An added key fails on key SET as well as on deep equality.
    expect(Object.keys(step).sort()).toEqual(['reason', 'skipped', 'step']);

    // Even when the skipped result somehow carries coverage.
    const withCoverage = buildOffRailReviewStep({
      skipped: true,
      reason: 'policy_disabled',
      acCoverage: CLEAN,
    });
    expect(Object.keys(withCoverage).sort()).toEqual(['reason', 'skipped', 'step']);
  });

  it('NORMALIZATION AND BOUNDING, read from the exported caps', () => {
    expect(MAX_AC_COVERAGE_ENTRIES).toBeGreaterThan(0);
    expect(MAX_AC_COVERAGE_ENTRY_CHARS).toBeGreaterThan(0);

    const overLong = Array.from({ length: MAX_AC_COVERAGE_ENTRIES + 5 }, (_, i) => `AC${i}`);
    const longEntry = 'x'.repeat(MAX_AC_COVERAGE_ENTRY_CHARS + 50);
    const step = stepWithCoverage({
      assessed: true,
      covered: overLong,
      notCovered: [longEntry],
      uncertain: 'not an array',
    });

    expect(step.acCoverage.covered).toHaveLength(MAX_AC_COVERAGE_ENTRIES);
    expect(step.acCoverage.notCovered[0]).toHaveLength(MAX_AC_COVERAGE_ENTRY_CHARS);
    expect(step.acCoverage.uncertain).toEqual([]);
  });

  it('CANARY ON A NEW PAYLOAD SURFACE: a credential in notCovered does not survive', () => {
    // Mirrors the findings canary in review-findings-redaction.test.mjs, on the
    // path the gate actually uses: redactReview -> buildOffRailReviewStep.
    const CANARY = 'hunter2-CANARY-9f3a';
    const dirty = {
      ok: true,
      verdict: 'warn',
      findings: [],
      acCoverage: {
        assessed: true,
        covered: [],
        notCovered: [`AC2 leaves password = "${CANARY}" in the diff`],
        uncertain: [],
      },
    };
    // The canary is genuinely present first — otherwise this proves nothing.
    expect(JSON.stringify(dirty).includes(CANARY)).toBe(true);

    const step = buildOffRailReviewStep(redactReview(dirty));
    expect(JSON.stringify(step).includes(CANARY)).toBe(false);
    // Never mutates its input.
    expect(dirty.acCoverage.notCovered[0]).toContain(CANARY);
  });
});

describe('assessed is a measurement, not an echo', () => {
  it('ECHO-VERSUS-ASSESSMENT: no AC section in the prompt yields assessed false', async () => {
    // THE ONLY SEPARATING TEST. The model's `assessed` is byte-identical whether
    // it assessed the criteria or copied the example object out of the prompt, so
    // NO assertion on that field alone can tell the two apart. Only contradicting
    // it with an independent server-side observation can.
    readNoteMock.mockImplementation(() => storyWithoutAc());
    chatMock.mockResolvedValue(
      JSON.stringify({
        verdict: 'pass',
        summary: 'looks fine',
        findings: [],
        acCoverage: { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] },
      }),
    );

    const result = await runReviewUnderTest();
    expect(result.ok).toBe(true);
    expect(result.acCoverage).not.toBeNull();
    expect(result.acCoverage.assessed).toBe(false);
  });

  it('THE CONVERSE, so a hardcoded false cannot pass: a real AC section yields assessed true', async () => {
    readNoteMock.mockImplementation(() => storyWithAc('\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n'));
    chatMock.mockResolvedValue(
      JSON.stringify({
        verdict: 'pass',
        summary: 'looks fine',
        findings: [],
        acCoverage: { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] },
      }),
    );

    const result = await runReviewUnderTest();
    expect(result.acCoverage.assessed).toBe(true);
  });

  it('W5 — LIVE PRODUCTION REPRODUCTION: the ac4d4eb1 corpus lines do not reach uncertain', async () => {
    // The reviewer mock DERIVES its acCoverage from the criteria slot it is
    // actually given. A hardcoded acCoverage cannot fail pre-fix and would not
    // be a witness — the mock, not the code, would be deciding the arrays.
    readNoteMock.mockImplementation(() => storyProductionRepro());
    chatMock.mockImplementation(async (args) => {
      // `prompt` is a named field on the call payload — NOT the whole object.
      // Stringifying the payload escapes every newline, which silently defeats a
      // line split and leaves the derived arrays empty.
      const prompt = args?.prompt ?? '';
      expect(prompt, 'the reviewer mock received no prompt to derive from').toContain(
        '### Acceptance Criteria',
      );
      const slot = prompt.slice(
        prompt.indexOf('### Acceptance Criteria'),
        prompt.indexOf('### Testing Requirements'),
      );
      // Report back exactly the bullet lines the reviewer was shown.
      const bullets = slot.split('\n').filter((l) => l.trim().startsWith('- '));
      return JSON.stringify({
        verdict: 'pass',
        summary: 'derived from the prompt',
        findings: [],
        acCoverage: { assessed: true, covered: [], notCovered: [], uncertain: bullets },
      });
    });

    const result = await runReviewUnderTest();
    const uncertain = (result.acCoverage?.uncertain || []).join('\n');
    expect(uncertain).not.toContain('occurring mid-line');
    expect(uncertain).not.toContain('Pre-existing, unrelated');
    expect(uncertain).toContain('REAL-CRITERION-MARKER');
  });

  it('W6 — SHIP-PATH BINDING: a decoy with no real heading forces assessed false', async () => {
    // The GATE consumer site, not the prompt site. The mock reports assessed
    // true throughout, so the value is decided by the code under test.
    const mockTrue = () =>
      chatMock.mockResolvedValue(
        JSON.stringify({
          verdict: 'pass', summary: 'ok', findings: [],
          acCoverage: { assessed: true, covered: ['x'], notCovered: [], uncertain: [] },
        }),
      );

    readNoteMock.mockImplementation(() => storyMidLineDecoy({ realHeading: false }));
    mockTrue();
    expect((await runReviewUnderTest()).acCoverage.assessed).toBe(false);

    // THE CONVERSE, in the same block, so a hardcoded false cannot satisfy the pair.
    readNoteMock.mockImplementation(() => storyMidLineDecoy({ realHeading: true }));
    mockTrue();
    expect((await runReviewUnderTest()).acCoverage.assessed).toBe(true);
  });

  it('TR6 — SHIP-PATH BINDING: a subsectioned AC section yields assessed true', async () => {
    // backlog.fix.ac-section-extraction-truncates-at-subheading.
    //
    // The MOCKED note path is the witness for this, not a live ship: review.mjs
    // is held by the long-running MCP server, so a real ship keeps executing the
    // pre-fix module until the server is restarted.
    readNoteMock.mockImplementation(() =>
      storyWithSubsectionedAc([['Group A', '- [ ] alpha-ship'], ['Group B', '- [ ] beta-ship']]),
    );
    chatMock.mockResolvedValue(
      JSON.stringify({
        verdict: 'pass',
        summary: 'looks fine',
        findings: [],
        acCoverage: { assessed: true, covered: ['alpha-ship'], notCovered: [], uncertain: [] },
      }),
    );

    const result = await runReviewUnderTest();
    expect(result.ok).toBe(true);
    expect(result.acCoverage.assessed).toBe(true);

    // And the gate therefore does NOT suppress on not-assessed.
    const suppression = resolvePhaseAdvanceSuppression(stepWithCoverage(result.acCoverage));
    expect(suppression).toBeNull();
  });

  it('an EMPTY AC section is not an assessment either', async () => {
    // The regex matches a heading followed immediately by the next '##', so
    // keying `found` on the match alone would report true with nothing examined.
    readNoteMock.mockImplementation(() => storyWithAc('\n'));
    chatMock.mockResolvedValue(
      JSON.stringify({
        verdict: 'pass',
        summary: 'looks fine',
        findings: [],
        acCoverage: { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] },
      }),
    );

    const result = await runReviewUnderTest();
    expect(result.acCoverage.assessed).toBe(false);
  });

  it('a model reporting assessed false is not upgraded by the presence of a section', async () => {
    readNoteMock.mockImplementation(() => storyWithAc('\n- [ ] AC1 does a thing\n'));
    chatMock.mockResolvedValue(
      JSON.stringify({
        verdict: 'pass',
        summary: 'looks fine',
        findings: [],
        acCoverage: { assessed: false, covered: [], notCovered: [], uncertain: [] },
      }),
    );

    const result = await runReviewUnderTest();
    expect(result.acCoverage.assessed).toBe(false);
  });

  it('ONE OBSERVATION, TWO CONSUMERS: the prompt text and the assessed flag agree', () => {
    // The prompt half of the same observation. A prompt carrying the fallback
    // always accompanies assessed false; a prompt carrying real AC text always
    // accompanies assessed true.
    const withAc = buildReviewPrompt({
      diff: FAKE_DIFF,
      story: storyWithAc('\n- [ ] AC1 does a thing\n'),
      ragContext: [],
      changedFiles: ['docs/notes.md'],
    });
    expect(withAc).toContain('AC1 does a thing');

    const withoutAc = buildReviewPrompt({
      diff: FAKE_DIFF,
      story: storyWithoutAc(),
      ragContext: [],
      changedFiles: ['docs/notes.md'],
    });
    // The AC slot fell back, and no AC text reached the model.
    expect(withoutAc).toContain('Not specified');
    expect(withoutAc).not.toContain('AC1 does a thing');
  });

  // ---------------------------------------------------------------------------
  // backlog.fix.ac-section-extraction-truncates-at-subheading — the witnesses.
  //
  // THE DEFECT. The section terminator is `(?=##|$)` with a lazy quantifier. A
  // level-3 subheading BEGINS with two hashes, so the lookahead fires at the
  // first `###` exactly as it would at the next level-2 heading. The match
  // collapses to the heading line, `found` reads false, and the reviewer is
  // never shown the criteria at all — which is why every coverage array came
  // back empty, not merely the flag.
  // ---------------------------------------------------------------------------

  it('TR1 — a subsectioned AC section reaches the prompt', () => {
    const slot = acSlotOf(promptFor(storyWithSubsectionedAc([['Group A', '- [ ] alpha-one']])));
    expect(slot).toContain('alpha-one');
  });

  it('TR2 — BOTH subsection groups reach the prompt', () => {
    const slot = acSlotOf(
      promptFor(storyWithSubsectionedAc([['Group A', '- [ ] alpha-two'], ['Group B', '- [ ] beta-two']])),
    );
    expect(slot).toContain('alpha-two');
    expect(slot).toContain('beta-two');
  });

  it('TR3 — the AC slot holds every subsection AND stops at the next level-2 section', () => {
    // BOTH halves are required. The negative half alone PASSES on defective
    // code: pre-fix truncation leaves heading-plus-blank, which trivially
    // contains no Testing Requirements text. The positive half is the witness;
    // the negative half is the over-run guard against a greedy quantifier.
    const slot = acSlotOf(
      promptFor(storyWithSubsectionedAc([['Group A', '- [ ] alpha-three'], ['Group B', '- [ ] beta-three']])),
    );
    expect(slot).toContain('alpha-three');
    expect(slot).toContain('beta-three');
    expect(slot).not.toContain('- a test');
  });

  it('TR4 — adjacent headings with NO blank separator: includes alpha, excludes beta', () => {
    // Catches a terminator that wrongly demands a blank line before the heading
    // and therefore over-runs into the following section.
    const slot = acSlotOf(promptFor(storyAdjacentHeadings()));
    expect(slot).toContain('alpha');
    expect(slot).not.toContain('beta');
  });

  it('TR5 — an AC section that is BOTH subsectioned AND final extracts to end of content', () => {
    // The fixture MUST carry BOTH properties. A FLAT final section is not a
    // witness: with no following level-2 heading the unmodified lazy quantifier
    // already runs to end of input and reports found true, so such a test passes
    // against defective code. Subsectioned-and-final fails pre-fix, and still
    // discriminates a multiline-anchored repair (which would empty the body) and
    // an omitted end-of-input alternative (which would find no match at all).
    const slot = acSlotOf(promptFor(storyWithSubsectionedFinalAc()));
    expect(slot).toContain('alpha-final');
    expect(slot).toContain('beta-final');
    expect(slot).not.toContain('Not specified');
  });

  it('TR10 — SECOND SITE: a subsectioned Testing Requirements section reaches the prompt', () => {
    const prompt = promptFor(storyWithSubsectionedTesting());
    const start = prompt.indexOf('### Testing Requirements');
    expect(start).toBeGreaterThan(-1);
    expect(prompt.slice(start)).toContain('tier-one-marker');
  });

  // -------------------------------------------------------------------------
  // backlog.fix.ac-section-opener-not-line-anchored — the witnesses.
  //
  // The opener must select a REAL heading: line-initial, and not inside a fence.
  // -------------------------------------------------------------------------

  it('W1 — a MID-LINE mention before the real heading does not open the section', () => {
    const slot = acSlotOf(promptFor(storyMidLineDecoy()));
    expect(slot).toContain('REAL-CRITERION-MARKER');
    expect(slot).not.toContain('DECOY-PROSE-MARKER');
  });

  it('W2 — a LINE-INITIAL heading inside a BACKTICK fence does not open the section', () => {
    const slot = acSlotOf(promptFor(storyFencedDecoy({ fence: '```' })));
    expect(slot).toContain('REAL-CRITERION-MARKER');
    expect(slot).not.toContain('DECOY-PROSE-MARKER');
  });

  it('W2 — a LINE-INITIAL heading inside a TILDE fence does not open the section', () => {
    // Covered separately: a selector that handles only one fence marker leaves
    // the other open, and anchoring alone cannot tell either from a heading.
    const slot = acSlotOf(promptFor(storyFencedDecoy({ fence: '~~~' })));
    expect(slot).toContain('REAL-CRITERION-MARKER');
    expect(slot).not.toContain('DECOY-PROSE-MARKER');
  });

  it('W3 — a decoy with NO real heading restores the fail-closed text', () => {
    for (const [label, story] of [
      ['mid-line', storyMidLineDecoy({ realHeading: false })],
      ['fenced', storyFencedDecoy({ realHeading: false })],
    ]) {
      const slot = acSlotOf(promptFor(story));
      expect(slot, label).toContain('Not specified');
      expect(slot, label).not.toContain('DECOY-PROSE-MARKER');
    }
  });

  it('W4 — the TESTING extraction obeys the same real-heading selection', () => {
    for (const [label, story] of [
      ['mid-line', storyTestingDecoy({ fenced: false })],
      ['fenced', storyTestingDecoy({ fenced: true })],
    ]) {
      const slot = tsSlotOf(promptFor(story));
      expect(slot, label).toContain('REAL-TEST-MARKER');
      expect(slot, label).not.toContain('DECOY-TEST-MARKER');
    }
  });

  it('G1 GUARD — a real heading at index 0 with no preceding newline still extracts', () => {
    const story = {
      title: 'A story', desc: 'A description',
      content: AC_H + '\n- [ ] REAL-CRITERION-MARKER\n' + TS_H + '\n- [ ] REAL-TEST-MARKER',
    };
    expect(acSlotOf(promptFor(story))).toContain('REAL-CRITERION-MARKER');
    expect(tsSlotOf(promptFor(story))).toContain('REAL-TEST-MARKER');
  });

  it('G2 GUARD — a heading line carrying TRAILING TEXT is still a real heading', () => {
    // The start is anchored; the END must not be. Copying an end-anchored opener
    // from elsewhere in the repo would break exactly this.
    const story = {
      title: 'A story', desc: 'A description',
      content: '# A story\n\n' + AC_H + ' (revised)\n\n- [ ] REAL-CRITERION-MARKER\n\n' + TS_H + '\n\n- a test\n',
    };
    expect(acSlotOf(promptFor(story))).toContain('REAL-CRITERION-MARKER');
  });

  it('G4 GUARD — an ordinary story extracts CHARACTER FOR CHARACTER as before', () => {
    // Equality, not containment, so a selector that trims or shifts the boundary
    // is caught. The expected value is the pre-change extraction.
    const story = storyWithAc('\n- [ ] AC1\n- [ ] AC2\n');
    const slot = acSlotOf(promptFor(story));
    expect(slot).toContain(AC_H + '\n\n- [ ] AC1\n- [ ] AC2\n');
  });

  it('G6 SCOPE PIN — terminator semantics UNCHANGED: a fenced heading in the BODY still terminates', () => {
    // Recorded, not endorsed. This story anchors the OPENER only. The residual is
    // tracked as backlog.fix.review-section-terminator-not-fence-aware.
    const story = {
      title: 'A story', desc: 'A description',
      content:
        '# A story\n\n' + AC_H + '\n\n- [ ] REAL-CRITERION-MARKER\n\n```markdown\n' +
        TS_H + '\nAFTER-FENCE-MARKER\n```\n',
    };
    const slot = acSlotOf(promptFor(story));
    expect(slot).toContain('REAL-CRITERION-MARKER');
    expect(slot).not.toContain('AFTER-FENCE-MARKER');
  });

  it('ONE SHARED TERMINATOR, PINNED ON THE DISCRIMINATING FORM', () => {
    // RETARGETED, not deleted, by
    // backlog.fix.ac-section-extraction-truncates-at-subheading.
    //
    // WHAT THIS PIN IS FOR, unchanged: the prompt's view of a section and the
    // gate's view must not drift apart. Only the discriminating form moved. The
    // old form was the whole AC regex body; the extraction is now built from a
    // shared terminator, so the terminator literal is what must appear exactly
    // once. A second copy would let the two sites diverge again — which is the
    // shape of the defect this story fixed, one level up.
    //
    // Counted as a LITERAL SUBSTRING of the source, never compiled as a regex,
    // and never as a fixed-size window or a line number.
    const discriminating = '(?=\\\\n## |$)';
    expect(REVIEW_SRC.split(discriminating).length - 1).toBe(1);

    // The OLD level-blind form must be gone entirely — not merely outnumbered.
    expect(REVIEW_SRC).not.toContain('Acceptance Criteria[\\s\\S]*?(?=##|$)');

    // SECOND PIN, RECONCILED. This asserted 2: the regex literal plus the
    // prompt's own '###' + ' Acceptance Criteria' heading, which CONTAINS the
    // two-hash form — the very containment that caused the defect. The pattern is
    // now built from the heading NAME rather than the literal '##' + ' Acceptance
    // Criteria', so that occurrence is gone and the true count is 1: the prompt
    // heading alone. Updated rather than left asserting a stale number.
    expect(REVIEW_SRC.split('## Acceptance Criteria').length - 1).toBe(1);

    // Positive control on the counting method, so the 1s above are measurements
    // rather than a broken search.
    expect(REVIEW_SRC.split('Acceptance Criteria').length - 1).toBeGreaterThan(1);
  });

  it('buildReviewPrompt carries durable phrases about how acCoverage is read', () => {
    // Single durable phrases against the FULL prompt string — never a fixed-size
    // window and never an exact multi-line substring.
    const prompt = buildReviewPrompt({
      diff: FAKE_DIFF,
      story: storyWithAc('\n- [ ] AC1\n'),
      ragContext: [],
      changedFiles: ['docs/notes.md'],
    });
    expect(prompt).toMatch(/STORY-COMPLETION SIGNAL/);
    expect(prompt).toMatch(/assessed to false when no acceptance criteria are present/);
    expect(prompt).toMatch(/QUOTE the acceptance-criterion text/);
  });
});

describe('the policy opt-in', () => {
  it('loadReviewPolicy defaults advancePhaseOnUnassessedAC to false', () => {
    const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-coverage-policy-default-'));
    try {
      expect(loadReviewPolicy(bareRoot).advancePhaseOnUnassessedAC).toBe(false);
    } finally {
      fs.rmSync(bareRoot, { recursive: true, force: true });
    }
  });

  it('a policy file overrides it, as the boolean true and not a string', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-coverage-policy-override-'));
    try {
      fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.rks', 'review-policy.yaml'),
        'advancePhaseOnUnassessedAC: true\n',
      );
      const loaded = loadReviewPolicy(root);
      expect(loaded.advancePhaseOnUnassessedAC).toBe(true);
      expect(typeof loaded.advancePhaseOnUnassessedAC).toBe('boolean');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('what the caller receives: the ship step and the response envelope', () => {
  /** Evaluate the real advance_phase literal from source against a real suppression. */
  const evalShipStep = (suppression) => {
    const branchIdx = AUDIT_SRC.indexOf('if (advanceSuppression) {');
    const pushIdx = AUDIT_SRC.indexOf('shipSteps.push({', branchIdx);
    const closeIdx = AUDIT_SRC.indexOf('});', pushIdx);
    const literal = AUDIT_SRC.slice(pushIdx + 'shipSteps.push('.length, closeIdx + 1);
    const truncated =
      'source slice TRUNCATED: the ship-step literal now contains a "});" before its own close';
    expect(literal.trimStart().startsWith('{'), truncated).toBe(true);
    expect(literal.trimEnd().endsWith('}'), truncated).toBe(true);
    return new Function('advanceSuppression', `return (${literal});`)(suppression);
  };

  /** Evaluate the real response.phaseAdvanceSuppressed literal from source. */
  const evalResponseEnvelope = (suppression) => {
    const assignIdx = GUARDRAILS_ON.indexOf('response.phaseAdvanceSuppressed = {');
    const openIdx = GUARDRAILS_ON.indexOf('{', assignIdx);
    const closeIdx = GUARDRAILS_ON.indexOf('};', openIdx);
    const literal = GUARDRAILS_ON.slice(openIdx, closeIdx + 1);
    const truncated =
      'source slice TRUNCATED: the response literal now contains a "};" before its own close';
    expect(literal.trimEnd().endsWith('}'), truncated).toBe(true);
    return new Function('advanceSuppression', `return (${literal});`)(suppression);
  };

  it('the suppressed advance_phase step carries the reason and a remedy, and NO ok key', () => {
    const suppression = resolvePhaseAdvanceSuppression(undefined);
    const step = evalShipStep(suppression);

    expect('ok' in step).toBe(false);
    expect(step.step).toBe('advance_phase');
    expect(step.skipped).toBe(true);
    expect(step.reason).toMatch(/\bac_coverage_not_assessed\b/);
    // The remedy names BOTH the flag and the file the operator must edit.
    expect(step.remedy).toContain('advancePhaseOnUnassessedAC');
    expect(step.remedy).toContain('.rks/review-policy.yaml');
  });

  it('the LEGACY step is byte-identical: three keys, no remedy', () => {
    const legacy = resolvePhaseAdvanceSuppression({
      findings: [{ severity: 'block', category: 'ac_coverage' }],
    });
    expect(legacy.remedy).toBeUndefined();
    const step = evalShipStep(legacy);
    expect(step).toEqual({
      step: 'advance_phase',
      skipped: true,
      reason: 'block_severity_finding (ac_coverage)',
    });
    expect(Object.keys(step).sort()).toEqual(['reason', 'skipped', 'step']);
  });

  it('RESPONSE ENVELOPE CARRIES NO UNDEFINED KEYS', () => {
    // guardrails-audit.mjs reads advanceSuppression.categories and .findingCount.
    // The coverage causes supply neither, and an explicitly-undefined key would
    // advertise a measurement that was never taken. Absence is asserted with the
    // in-operator, because toBeUndefined passes for both.
    const coverage = evalResponseEnvelope(
      resolvePhaseAdvanceSuppression(stepWithCoverage({ ...CLEAN, notCovered: ['AC3'] })),
    );
    expect('categories' in coverage).toBe(false);
    expect('findingCount' in coverage).toBe(false);
    expect(coverage.reason).toMatch(/\bac_not_covered\b/);

    const notAssessed = evalResponseEnvelope(resolvePhaseAdvanceSuppression(undefined));
    expect('categories' in notAssessed).toBe(false);
    expect('findingCount' in notAssessed).toBe(false);

    // The legacy cause still carries both, with their measured values.
    const legacy = evalResponseEnvelope(
      resolvePhaseAdvanceSuppression({
        findings: [{ severity: 'block', category: 'ac_coverage' }],
      }),
    );
    expect('categories' in legacy).toBe(true);
    expect(legacy.categories).toEqual(['ac_coverage']);
    expect(legacy.findingCount).toBe(1);
    // So the two causes stay separable on key set alone.
    expect(Object.keys(legacy).sort()).not.toEqual(Object.keys(notAssessed).sort());
  });

  it('autoShipSuppressed IS NEVER SET, and autoShipped stays true', () => {
    // resolveShipOutcome ranks autoShipSuppressed ABOVE autoShipped and returns
    // "skipped" for it, which would report a landed merge as not shipped. The
    // commit, merge and push all still happen — only the phase advance is held.
    //
    // NARROW, DELIBERATELY. `response.autoShipSuppressed = true` is a REAL and
    // unrelated line in guardrailsOn — it belongs to the options.skipAutoShip
    // feature, where nothing was shipped and "skipped" is the honest outcome. The
    // invariant is that the PHASE-ADVANCE suppression never borrows that key, not
    // that the key is absent from the file.
    expect(AUDIT_SRC).not.toContain('autoShipSuppressed = {');
    expect(GUARDRAILS_ON).not.toMatch(/autoShipSuppressed\s*=\s*advanceSuppression/);
    expect(GUARDRAILS_ON).not.toMatch(/phaseAdvance[A-Za-z]*\s*=\s*.*autoShipSuppressed/);
    // The suppression is reported under this name and no other.
    expect(GUARDRAILS_ON).toContain('response.phaseAdvanceSuppressed = {');
    // And nothing in the suppressed branch ASSIGNS autoShipped — the commit,
    // merge and push already landed above it. Matched on the assignment form,
    // not the bare word: the branch legitimately NAMES autoShipped in a comment
    // explaining why the response key is not called autoShipSuppressed.
    const branchIdx = GUARDRAILS_ON.indexOf('if (advanceSuppression) {');
    const elseIdx = GUARDRAILS_ON.indexOf('} else {', branchIdx);
    expect(elseIdx).toBeGreaterThan(branchIdx);
    const suppressedBranch = GUARDRAILS_ON.slice(branchIdx, elseIdx);
    expect(suppressedBranch).not.toMatch(/autoShipped\s*=[^=]/);
    // Positive control: the branch IS non-empty and IS the right region, so the
    // negative above is a real measurement rather than an empty-string pass.
    expect(suppressedBranch).toContain('response.phaseAdvanceSuppressed = {');
  });
});
