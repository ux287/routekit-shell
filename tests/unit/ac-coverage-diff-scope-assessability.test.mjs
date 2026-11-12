/**
 * backlog.fix.ac-coverage-assessability-bound-to-diff-scope.
 *
 * THE DEFECT. The off-rail reviewer is handed `targetBranch: activeSession.headCommit`
 * — deliberately, one guardrails-off session. On an amendment ship, or a story
 * built across two sessions, the diff therefore contains only the latest
 * increment, and the reviewer reports criteria satisfied by the earlier commits
 * as NOT COVERED, at block severity. Observed in production on commit 5f1218d5:
 * five "AC N is not implemented" block findings against a story whose 649-line
 * implementation sat in the immediately preceding commit 4d1a5152.
 *
 * `assessed` was conjoined only with whether the NOTE had criteria. Nothing ever
 * observed whether the DIFF could bear on them — a genuine measurement of the
 * wrong quantity.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'diff-scope-nonexistent-root');

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

const { runReview, isDiffPartialForStory } = await import('../../packages/mcp-rks/src/server/review.mjs');
const { buildOffRailReviewStep, resolvePhaseAdvanceSuppression } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);

/** The suite-wide idiom: route coverage through the REAL producer, not a literal. */
const stepWithCoverage = (acCoverage) =>
  buildOffRailReviewStep({ ok: true, verdict: 'pass', findings: [], acCoverage });

const storyWithAc = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n\n' +
    '## Testing Requirements\n\n- a test\n',
});

/** The model held constant: claims assessed, reports the criteria as missing. */
const MODEL_CLAIM = {
  verdict: 'warn',
  summary: 'amendment',
  findings: [
    { category: 'ac_coverage', severity: 'block', message: 'AC 1 is not implemented' },
    { category: 'security_issue', severity: 'block', message: 'a real security problem' },
  ],
  acCoverage: { assessed: true, covered: [], notCovered: ['AC1 does a thing'], uncertain: [] },
};

const runReviewUnderTest = () =>
  runReview({
    projectId: 'routekit-shell-core',
    problemId: 'backlog.fix.some-story',
    branch: 'staging',
    targetBranch: 'abc1234',
  });

beforeEach(() => {
  chatMock.mockReset();
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyWithAc());
  chatMock.mockResolvedValue(JSON.stringify(MODEL_CLAIM));
  priorStoryCommit = null;
});

describe('assessability is measured against the DIFF, not the note', () => {
  it('THE REPRODUCTION — an amendment shape does not report the earlier session as not-covered', async () => {
    // The story's work already exists behind the diff base.
    priorStoryCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const result = await runReviewUnderTest();

    expect(result.ok).toBe(true);
    // The model's claim is held constant; the DERIVED values are what move.
    expect(result.acCoverage.assessed).toBe(false);
    expect(result.acCoverage.assessable).toBe(false);

    // AC 5: the findings array flows through the real pipeline — no hand-scrub.
    // The ac_coverage block finding is downgraded; the security one is NOT.
    const ac = result.findings.find((f) => f.category === 'ac_coverage');
    const sec = result.findings.find((f) => f.category === 'security_issue');
    expect(ac.severity).toBe('warn');
    expect(sec.severity).toBe('block');

    // And the gate therefore reaches the coverage rules at all.
    const outcome = resolvePhaseAdvanceSuppression(
      stepWithCoverage(result.acCoverage),
    );
    expect(outcome.reason).toMatch(/\bac_coverage_partial_diff\b/);
    expect(outcome.suppress).toBe(false);
  });

  it('THE CONVERSE — a whole-story diff still assesses, so this is not just "always false"', async () => {
    priorStoryCommit = null; // no earlier commit for this story
    const result = await runReviewUnderTest();
    expect(result.acCoverage.assessed).toBe(true);
    expect(result.acCoverage.assessable).toBe(true);
    // A genuine single-session gap still suppresses under the original token.
    const outcome = resolvePhaseAdvanceSuppression(stepWithCoverage(result.acCoverage));
    expect(outcome.reason).toMatch(/\bac_not_covered\b/);
    expect(outcome.suppress).toBeUndefined();
  });

  it('block findings are NOT softened when the diff is whole', async () => {
    priorStoryCommit = null;
    const result = await runReviewUnderTest();
    expect(result.findings.find((f) => f.category === 'ac_coverage').severity).toBe('block');
  });
});

describe('isDiffPartialForStory — the observation itself', () => {
  it('requires a COMMIT HASH, not merely non-empty output', () => {
    priorStoryCommit = 'not-a-sha-just-some-text';
    expect(isDiffPartialForStory(FAKE_ROOT, 'abc1234', 'backlog.fix.x')).toBe(false);
    priorStoryCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(isDiffPartialForStory(FAKE_ROOT, 'abc1234', 'backlog.fix.x')).toBe(true);
  });

  it('no problemId means no earlier session could exist — not partial', () => {
    priorStoryCommit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(isDiffPartialForStory(FAKE_ROOT, 'abc1234', null)).toBe(false);
    expect(isDiffPartialForStory(FAKE_ROOT, null, 'backlog.fix.x')).toBe(false);
  });
});

describe('the FOUR states are pairwise distinct, by token', () => {
  it('all four reason tokens mutually non-matching', () => {
    const partial = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ assessed: false, assessable: false, covered: [], notCovered: [], uncertain: [] }),
    ).reason;
    const notCovered = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ assessed: true, covered: ['a'], notCovered: ['b'], uncertain: [] }),
    ).reason;
    const uncertain = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ assessed: true, covered: ['a'], notCovered: [], uncertain: ['c'] }),
    ).reason;
    const notAssessed = resolvePhaseAdvanceSuppression(undefined).reason;

    const tokens = {
      partial: [partial, /\bac_coverage_partial_diff\b/],
      notCovered: [notCovered, /\bac_not_covered\b/],
      uncertain: [uncertain, /\bac_coverage_uncertain\b/],
      notAssessed: [notAssessed, /\bac_coverage_not_assessed\b/],
    };

    // Each reason matches its OWN token and none of the other three. Four states
    // collapsing to two booleans is the failure this exists to prevent.
    for (const [name, [reason, own]] of Object.entries(tokens)) {
      expect(reason, name).toMatch(own);
      for (const [other, [, otherRe]] of Object.entries(tokens)) {
        if (other === name) continue;
        expect(reason, `${name} matched ${other}`).not.toMatch(otherRe);
      }
    }
    expect(new Set(Object.values(tokens).map(([r]) => r)).size).toBe(4);
  });

  it('ONLY the partial state permits — the other three suppress', () => {
    const permit = resolvePhaseAdvanceSuppression(
      stepWithCoverage({ assessed: false, assessable: false, covered: [], notCovered: [], uncertain: [] }),
    );
    expect(permit.suppress).toBe(false);
    for (const step of [
      stepWithCoverage({ assessed: true, covered: ['a'], notCovered: ['b'], uncertain: [] }),
      stepWithCoverage({ assessed: true, covered: ['a'], notCovered: [], uncertain: ['c'] }),
      undefined,
    ]) {
      expect(resolvePhaseAdvanceSuppression(step).suppress).not.toBe(false);
    }
  });

  it('the permit does NOT consult advancePhaseOnUnassessedAC', () => {
    const step = stepWithCoverage({ assessed: false, assessable: false, covered: [], notCovered: [], uncertain: [] });
    const a = resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: false });
    const b = resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true });
    expect(a.reason).toBe(b.reason);
    expect(a.suppress).toBe(false);
    expect(b.suppress).toBe(false);
  });
});

describe('the signal survives the two allowlists between producer and gate', () => {
  it('assessable PROPAGATES through the real producer, not a hand-built literal', () => {
    // A literal-fed witness bypasses normalizeAcCoverage and would be green
    // while production stayed broken. This routes through it.
    const step = stepWithCoverage({ assessed: true, assessable: false, covered: ['a'], notCovered: [], uncertain: [] });
    expect(step.acCoverage.assessable).toBe(false);
  });

  it('THE CONVERSE — an unknown key is still STRIPPED, so the fix is not a raw spread', () => {
    const step = stepWithCoverage({
      assessed: true, assessable: true, covered: [], notCovered: [], uncertain: [],
      somethingElse: 'must not survive',
    });
    expect('somethingElse' in step.acCoverage).toBe(false);
    expect(Object.keys(step.acCoverage).sort()).toEqual(
      ['assessable', 'assessed', 'covered', 'notCovered', 'uncertain'],
    );
  });

  it('assessable defaults TRUE when absent — the permit requires a positive signal', () => {
    const step = stepWithCoverage({ assessed: true, covered: ['a'], notCovered: [], uncertain: [] });
    expect(step.acCoverage.assessable).toBe(true);
    expect(resolvePhaseAdvanceSuppression(step)).toBeNull();
  });
});

describe('defensive inputs fail closed', () => {
  it('degenerate steps never throw and never yield a permit', () => {
    for (const step of [undefined, null, {}, 7, 'x', [], { acCoverage: 'x' }, { acCoverage: [] }]) {
      let out;
      expect(() => { out = resolvePhaseAdvanceSuppression(step); }).not.toThrow();
      expect(out?.suppress).not.toBe(false);
    }
  });
});
