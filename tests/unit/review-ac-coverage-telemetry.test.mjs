/**
 * backlog.feat.ship-review-ac-evidence-and-suppression-telemetry — the review half.
 *
 * The full review.complete emit, the one written after the reviewer ran, records
 * the acceptance-criteria evidence the phase-advance gate reads. It records the
 * BOUND value — assessed and assessable derived from the diff and the note, not
 * the model's own claim — redacted, then normalized by the one rule in
 * packages/mcp-rks/src/shared/ac-coverage.mjs. So the value on disk is the value
 * the gate decides on, and it is allowlisted, bounded and scrubbed.
 *
 * Every payload here is read from the ensureTelemetryStorage emit calls, filtered
 * by event type and problemId — never from the review object runReview returns.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'review-ac-telemetry-nonexistent-root');

const chatMock = vi.fn();
const readNoteMock = vi.fn(() => null);
/** Whether the fake git reports an existing commit for this story behind the base. */
let priorStoryCommit = null;

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' })),
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

vi.mock('@routekit/rag', () => ({ runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })) }));

const FAKE_DIFF = [
  'diff --git a/docs/notes.md b/docs/notes.md',
  '--- a/docs/notes.md',
  '+++ b/docs/notes.md',
  '@@ -1,1 +1,2 @@',
  ' existing line',
  '+an added documentation line',
].join('\n');

vi.mock('child_process', () => {
  // `git log --format=%H` is the partial-diff probe. Returning a SHA means a
  // commit for this story is already reachable from the diff BASE.
  const impl = (_cmd, args = []) => {
    if (args[0] === 'log') return { stdout: priorStoryCommit ? `${priorStoryCommit}\n` : '', stderr: '', status: 0 };
    if (args.includes('--name-only')) return { stdout: 'docs/notes.md\n', stderr: '', status: 0 };
    return { stdout: FAKE_DIFF, stderr: '', status: 0 };
  };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const { runReview, redactReview, redactFindings, MAX_PERSISTED_FINDINGS, DEFAULT_SECURITY_PATTERNS } =
  await import('../../packages/mcp-rks/src/server/review.mjs');
const { buildOffRailReviewStep, resolvePhaseAdvanceSuppression } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);
const { MAX_AC_COVERAGE_ENTRIES, MAX_AC_COVERAGE_ENTRY_CHARS } = await import(
  '../../packages/mcp-rks/src/shared/ac-coverage.mjs'
);

const PROJECT_ID = 'routekit-shell-core';
const AC_KEYS = ['assessable', 'assessed', 'covered', 'notCovered', 'uncertain'];
const FULL_EMIT_KEYS = ['blockerCount', 'findingCount', 'findings', 'problemId', 'verdict', 'warningCount'];
const DEGRADED_EMIT_KEYS = [
  'blockerCount',
  'cause',
  'findingCount',
  'findings',
  'llmFailed',
  'problemId',
  'reviewerUnavailable',
  'verdict',
  'warningCount',
];

// The heading is assembled rather than spelled, so this file carries the same
// text only in the fixture the reviewer is handed.
const AC_HEADING = ['##', 'Acceptance', 'Criteria'].join(' ');

const storyWithAc = () => ({
  title: 'A story',
  desc: 'A description',
  content: `# A story\n\n${AC_HEADING}\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n\n## Testing Requirements\n\n- a test\n`,
});

const storyWithoutAc = () => ({
  title: 'A story',
  desc: 'A description',
  content: '# A story\n\n## Problem\n\nbody\n\n## Testing Requirements\n\n- a test\n',
});

let legCounter = 0;
const nextProblemId = () => `backlog.feat.review-ac-telemetry-leg-${++legCounter}`;

/** Drive runReview with a stubbed reviewer reply; return the returned review and the emitted payloads. */
async function driveReview(reply, { story = storyWithAc(), partial = false } = {}) {
  const problemId = nextProblemId();
  readNoteMock.mockImplementation(() => story);
  priorStoryCommit = partial ? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' : null;
  if (reply instanceof Error) chatMock.mockRejectedValue(reply);
  else chatMock.mockResolvedValue(JSON.stringify(reply));

  const returned = await runReview({ projectId: PROJECT_ID, problemId, branch: 'staging', targetBranch: 'abc1234' });

  const calls = ensureTelemetryStorage(FAKE_ROOT)
    .emit.mock.calls.filter((c) => c[0] === 'review.complete' && c[2]?.problemId === problemId);
  return { returned, calls, payloads: calls.map((c) => c[2]) };
}

/** The shape the phase-advance gate reads from the returned review. */
const gateShape = (returned) => buildOffRailReviewStep(redactReview(returned)).acCoverage;

const reply = (acCoverage, extra = {}) => ({
  verdict: 'pass',
  summary: 'review',
  findings: [],
  ...(acCoverage !== undefined ? { acCoverage } : {}),
  ...extra,
});

beforeEach(() => {
  chatMock.mockReset();
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyWithAc());
  priorStoryCommit = null;
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

describe('the full review.complete emit records acCoverage exactly when the bound value exists', () => {
  it('carries acCoverage, allowlisted, deep-equal to the shape the gate reads', async () => {
    const { returned, payloads } = await driveReview(
      reply({ assessed: true, covered: ['AC1 does a thing'], notCovered: ['AC2 does another'], uncertain: [] }),
    );

    expect(returned.ok).toBe(true);
    expect(returned.acCoverage).not.toBeNull();
    expect(payloads).toHaveLength(1);
    const [payload] = payloads;
    expect(Object.keys(payload).sort()).toEqual([...FULL_EMIT_KEYS, 'acCoverage'].sort());
    expect(Object.keys(payload.acCoverage).sort()).toEqual(AC_KEYS);
    expect(payload.acCoverage).toEqual(gateShape(returned));
  });

  it('carries no acCoverage KEY when the bound value is null — absent, never null or undefined', async () => {
    const { returned, payloads } = await driveReview(reply(undefined));

    expect(returned.acCoverage).toBeNull();
    expect(payloads).toHaveLength(1);
    // Keys, not toBeUndefined: an explicitly-undefined key passes toBeUndefined.
    expect(Object.keys(payloads[0]).sort()).toEqual(FULL_EMIT_KEYS);
  });

  it('the degraded emit, written when the reviewer did not run, never carries one', async () => {
    const { returned, payloads } = await driveReview(new Error('transport down'));

    expect(returned.reviewerUnavailable).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].llmFailed).toBe(true);
    expect(Object.keys(payloads[0]).sort()).toEqual(DEGRADED_EMIT_KEYS);
  });
});

describe('verdict, counts and findings on the full emit are unchanged', () => {
  it('reports the same verdict, counts and redacted findings as before', async () => {
    const findings = [
      { category: 'style', severity: 'warn', message: 'a warn', file: 'docs/notes.md', line: 'x' },
      { category: 'security_issue', severity: 'block', message: 'a block', file: 'docs/notes.md', line: 'y' },
    ];
    const { returned, payloads } = await driveReview(
      reply({ assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] }, { verdict: 'warn', findings }),
    );
    const [payload] = payloads;

    expect(payload.verdict).toBe(returned.verdict);
    expect(payload.findingCount).toBe(returned.findings.length);
    expect(payload.blockerCount).toBe(returned.findings.filter((f) => f.severity === 'block').length);
    expect(payload.warningCount).toBe(returned.findings.filter((f) => f.severity === 'warn').length);
    expect(payload.findings).toEqual(redactFindings(returned.findings));
  });

  it('still caps the findings array at MAX_PERSISTED_FINDINGS', async () => {
    const findings = Array.from({ length: MAX_PERSISTED_FINDINGS + 3 }, (_, i) => ({
      category: 'style',
      severity: 'warn',
      message: `finding ${i}`,
    }));
    const { returned, payloads } = await driveReview(reply(undefined, { verdict: 'warn', findings }));

    expect(returned.findings.length).toBeGreaterThan(MAX_PERSISTED_FINDINGS);
    expect(payloads[0].findingCount).toBe(returned.findings.length);
    expect(payloads[0].findings).toHaveLength(MAX_PERSISTED_FINDINGS);
  });
});

describe('the emit records the findings the consumers read, not the raw ones', () => {
  const AC_BLOCK = { category: 'ac_coverage', severity: 'block', message: 'AC 1 is not implemented' };
  const SEC_BLOCK = { category: 'security_issue', severity: 'block', message: 'a real security problem' };
  const coverage = { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] };

  it('a partial diff emits the DOWNGRADED ac_coverage finding, not the block-severity one', async () => {
    const { returned, payloads } = await driveReview(
      reply(coverage, { verdict: 'warn', findings: [AC_BLOCK] }),
      { partial: true },
    );

    // Fixture precondition, in this same leg: the returned review really did downgrade it,
    // so the emit assertions below cannot pass vacuously.
    const returnedAc = returned.findings.find((f) => f.category === 'ac_coverage');
    expect(returnedAc.severity).toBe('warn');
    expect(returnedAc.message).toContain('downgraded');

    expect(payloads).toHaveLength(1);
    expect(payloads[0].findings).toEqual(redactFindings(returned.findings));
    const emittedAc = payloads[0].findings.find((f) => f.category === 'ac_coverage');
    expect(emittedAc.severity).toBe('warn');
    expect(emittedAc.severity).not.toBe('block');
  });

  it('and counts it as a warning, not as a blocker', async () => {
    const { returned, payloads } = await driveReview(
      reply(coverage, { verdict: 'warn', findings: [AC_BLOCK] }),
      { partial: true },
    );
    const [payload] = payloads;

    expect(payload.blockerCount).toBe(returned.findings.filter((f) => f.severity === 'block').length);
    expect(payload.warningCount).toBe(returned.findings.filter((f) => f.severity === 'warn').length);
    expect(payload.blockerCount).toBe(0);
    expect(payload.warningCount).toBeGreaterThan(0);
    // Unchanged by this story: the array length and the verdict.
    expect(payload.findingCount).toBe(returned.findings.length);
    expect(payload.verdict).toBe(returned.verdict);
  });

  it('CONTROL — a whole diff still emits the ac_coverage finding at block', async () => {
    const { returned, payloads } = await driveReview(
      reply(coverage, { verdict: 'warn', findings: [AC_BLOCK] }),
    );

    const emittedAc = payloads[0].findings.find((f) => f.category === 'ac_coverage');
    expect(emittedAc.severity).toBe('block');
    expect(emittedAc.message).toBe(AC_BLOCK.message);
    expect(payloads[0].blockerCount).toBe(returned.findings.filter((f) => f.severity === 'block').length);
    expect(payloads[0].blockerCount).toBeGreaterThanOrEqual(1);
  });

  it('CONTROL — a partial diff leaves every other category at block', async () => {
    const { returned, payloads } = await driveReview(
      reply(coverage, { verdict: 'warn', findings: [SEC_BLOCK] }),
      { partial: true },
    );

    const emittedSec = payloads[0].findings.find((f) => f.category === 'security_issue');
    expect(emittedSec.severity).toBe('block');
    expect(emittedSec.message).toBe(SEC_BLOCK.message);
    expect(payloads[0].blockerCount).toBe(returned.findings.filter((f) => f.severity === 'block').length);
    expect(payloads[0].blockerCount).toBeGreaterThanOrEqual(1);
  });
});

describe('CANARY OVER EVERY SHAPE — no credential reaches the emitted event', () => {
  const SECRET = 'hunter2-canary-7f3a9e';
  const LITERAL = `password = "${SECRET}"`;

  it('fixture precondition — the literal is secret-shaped by the one definition', () => {
    expect(DEFAULT_SECURITY_PATTERNS.some((p) => new RegExp(p, 'i').test(LITERAL))).toBe(true);
  });

  const LEGS = [
    ['inside a notCovered string entry', { notCovered: [`AC2 ${LITERAL}`] }],
    ['as a string-valued notCovered', { notCovered: LITERAL }],
    ['inside a nested array used as a notCovered entry', { notCovered: [['AC2', LITERAL]] }],
    ['inside an object used as a notCovered entry', { notCovered: [{ detail: LITERAL }] }],
    ['in an extra model-authored key named notes', { notCovered: ['AC2'], notes: LITERAL }],
  ];

  it.each(LEGS)('%s', async (_label, shape) => {
    const claim = reply({ assessed: true, covered: ['AC1'], uncertain: [], ...shape });
    // Precondition: the stubbed reply really carries the credential.
    expect(JSON.stringify(claim)).toContain(SECRET);

    const { calls, payloads } = await driveReview(claim);

    expect(calls).toHaveLength(1);
    expect(payloads[0].acCoverage).toBeDefined();
    expect(JSON.stringify(calls[0])).not.toContain(SECRET);
    expect(Object.keys(payloads[0].acCoverage).sort()).toEqual(AC_KEYS);
  });

  it('bounds an over-limit notCovered by the exported caps', async () => {
    const notCovered = Array.from({ length: MAX_AC_COVERAGE_ENTRIES + 5 }, (_, i) =>
      i === 0 ? 'x'.repeat(MAX_AC_COVERAGE_ENTRY_CHARS + 50) : `AC${i}`,
    );
    const { payloads } = await driveReview(reply({ assessed: true, covered: [], notCovered, uncertain: [] }));

    expect(payloads[0].acCoverage.notCovered).toHaveLength(MAX_AC_COVERAGE_ENTRIES);
    expect(payloads[0].acCoverage.notCovered[0]).toHaveLength(MAX_AC_COVERAGE_ENTRY_CHARS);
  });
});

describe('BOUND, NOT CLAIMED — the emit records the derived assessment', () => {
  const CLAIM = reply({ assessed: true, covered: [], notCovered: ['AC1 does a thing'], uncertain: [] });

  it('fixture precondition — the model claims assessed true with criteria outstanding', () => {
    expect(CLAIM.acCoverage.assessed).toBe(true);
    expect(CLAIM.acCoverage.notCovered.length).toBeGreaterThan(0);
  });

  it('a partial diff emits assessed false and assessable false', async () => {
    const { returned, payloads } = await driveReview(CLAIM, { partial: true });
    const emitted = payloads[0].acCoverage;

    expect(emitted.assessed).toBe(false);
    expect(emitted.assessable).toBe(false);
    expect(emitted).toEqual(gateShape(returned));
  });

  it('a story with no criteria section emits assessed false and assessable true', async () => {
    const { returned, payloads } = await driveReview(CLAIM, { story: storyWithoutAc() });
    const emitted = payloads[0].acCoverage;

    expect(emitted.assessed).toBe(false);
    expect(emitted.assessable).toBe(true);
    expect(emitted).toEqual(gateShape(returned));
  });

  it('a whole diff with criteria emits assessed true — the two legs above are not a constant', async () => {
    const { returned, payloads } = await driveReview(CLAIM);
    const emitted = payloads[0].acCoverage;

    expect(emitted.assessed).toBe(true);
    expect(emitted.assessable).toBe(true);
    expect(emitted).toEqual(gateShape(returned));
  });
});

describe('DECISION-PRESERVING COERCION — the scrub never changes whether coverage reaches the gate', () => {
  const nonCoercible = () => JSON.parse('{"toString":1}');
  const fullList = () => [
    ...Array.from({ length: MAX_AC_COVERAGE_ENTRIES }, (_, i) => `AC${i + 1} is covered`),
    nonCoercible(),
  ];
  const review = (acCoverage) => ({ ok: true, verdict: 'pass', findings: [], acCoverage });

  it('fixture precondition — String throws on the entry', () => {
    expect(() => String(nonCoercible())).toThrow();
  });

  it('case one — a covered list ending in the entry still permits, as today', () => {
    const x = review({ assessed: true, covered: fullList(), notCovered: [], uncertain: [] });
    const step = buildOffRailReviewStep(redactReview(x));

    expect(step.acCoverage.covered).toHaveLength(MAX_AC_COVERAGE_ENTRIES);
    expect(resolvePhaseAdvanceSuppression(step)).toBeNull();

    const redacted = redactReview(x).acCoverage;
    expect(redacted).not.toBeNull();
    expect(redacted.covered.at(-1)).toBe(x.acCoverage.covered.at(-1));
  });

  it('case two — the same list in notCovered still suppresses, as today', () => {
    const x = review({ assessed: true, covered: [], notCovered: fullList(), uncertain: [] });
    const step = buildOffRailReviewStep(redactReview(x));

    expect(step.acCoverage.notCovered).toHaveLength(MAX_AC_COVERAGE_ENTRIES);
    const outcome = resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true });
    expect(outcome?.reason).toMatch(/^ac_not_covered/);

    const redacted = redactReview(x).acCoverage;
    expect(redacted).not.toBeNull();
    expect(redacted.notCovered.at(-1)).toBe(x.acCoverage.notCovered.at(-1));
  });

  it('the emit records the case-one list at the cap', async () => {
    // Serialized into the stubbed reply, then parsed back by the reviewer path,
    // so the entry arrives as the same non-coercible parsed object.
    chatMock.mockReset();
    const problemId = nextProblemId();
    readNoteMock.mockImplementation(() => storyWithAc());
    const covered = [
      ...Array.from({ length: MAX_AC_COVERAGE_ENTRIES }, (_, i) => `"AC${i + 1} is covered"`),
      '{"toString":1}',
    ].join(',');
    chatMock.mockResolvedValue(
      `{"verdict":"pass","summary":"s","findings":[],"acCoverage":{"assessed":true,"covered":[${covered}],"notCovered":[],"uncertain":[]}}`,
    );

    await runReview({ projectId: PROJECT_ID, problemId, branch: 'staging', targetBranch: 'abc1234' });
    const payloads = ensureTelemetryStorage(FAKE_ROOT)
      .emit.mock.calls.filter((c) => c[0] === 'review.complete' && c[2]?.problemId === problemId)
      .map((c) => c[2]);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].acCoverage).toBeDefined();
    expect(payloads[0].acCoverage.covered).toHaveLength(MAX_AC_COVERAGE_ENTRIES);
  });

  it('the entry FIRST in covered still drops acCoverage from the step, as today', () => {
    const x = review({
      assessed: true,
      covered: [nonCoercible(), 'AC1 is covered'],
      notCovered: [],
      uncertain: [],
    });

    expect('acCoverage' in buildOffRailReviewStep(redactReview(x))).toBe(false);
  });
});

describe('the comment above redactAcCoverage names only sinks the code reaches', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const reviewSrc = read('packages/mcp-rks/src/server/review.mjs');
  const auditSrc = read('packages/mcp-rks/src/server/guardrails-audit.mjs');
  const storyShipSrc = read('packages/mcp-rks/src/server/story-ship.mjs');

  const fnIdx = reviewSrc.indexOf('function redactAcCoverage(');
  const comment = reviewSrc.slice(reviewSrc.lastIndexOf('/**', fnIdx), fnIdx);

  /**
   * The full review.complete emit — the one written after the reviewer RAN.
   *
   * Keyed on the ABSENCE of llmFailed, which only the degraded emit carries. It used to key
   * on the literal `redactFindings(allFindings)`, which the findings-parity fix removed. It
   * must not key on acCoverage: the MEASURED row below tests this window FOR acCoverage, and
   * a locator keyed on it would make that row tautological.
   */
  const fullEmitWindow = () => {
    let idx = reviewSrc.indexOf("'review.complete'");
    while (idx !== -1) {
      const window = reviewSrc.slice(idx, reviewSrc.indexOf('});', idx));
      if (!window.includes('llmFailed')) return window;
      idx = reviewSrc.indexOf("'review.complete'", idx + 1);
    }
    return '';
  };

  /** Every shipSteps.push call whose step is advance_phase, each sliced to its close. */
  const advancePhasePushRegions = () => {
    const regions = [];
    let idx = auditSrc.indexOf('shipSteps.push(');
    while (idx !== -1) {
      const region = auditSrc.slice(idx, auditSrc.indexOf('});', idx) + 3);
      if (/step:\s*"advance_phase"/.test(region)) regions.push(region);
      idx = auditSrc.indexOf('shipSteps.push(', idx + 1);
    }
    return regions;
  };

  const buildStepBody = () => {
    const start = auditSrc.indexOf('export function buildOffRailReviewStep(');
    return auditSrc.slice(start, auditSrc.indexOf('\n}\n', start));
  };

  /** Each sink name the comment may use, with the measured occurrence that makes it true. */
  const MEASURED = {
    rks_guardrails_on: () => /acCoverage/.test(buildStepBody()) && /redactReview\(reviewResult\)/.test(auditSrc),
    buildOffRailReviewStep: () => /normalizeAcCoverage\(r\.acCoverage\)/.test(buildStepBody()),
    'review.complete': () => /acCoverage/.test(fullEmitWindow()),
    'story-ship': () => /redactReview\(await runReview\(/.test(storyShipSrc),
    advance_phase: () => advancePhasePushRegions().some((r) => /acCoverage/.test(r)),
  };

  it('located the comment and every measurement seam', () => {
    expect(fnIdx).toBeGreaterThan(-1);
    expect(comment.length).toBeGreaterThan(100);
    // The locator found the FULL emit, not the degraded one and not nothing.
    expect(fullEmitWindow().length).toBeGreaterThan(0);
    expect(fullEmitWindow()).toContain('redactFindings(reportedFindings)');
    expect(fullEmitWindow()).not.toContain('llmFailed');
    // Positive control for the advance_phase check below: the regions exist.
    expect(advancePhasePushRegions().length).toBeGreaterThan(0);
  });

  it('every sink the comment names has a measured occurrence', () => {
    const named = Object.keys(MEASURED).filter((name) => comment.includes(name));
    expect(named.length).toBeGreaterThan(0);
    const unmeasured = named.filter((name) => !MEASURED[name]());
    expect(unmeasured).toEqual([]);
  });
});
