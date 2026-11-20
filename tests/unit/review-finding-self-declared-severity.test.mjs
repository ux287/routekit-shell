/**
 * backlog.fix.review-finding-severity-contradicts-own-text
 *
 * A reviewer finding declared severity block while its own text said it was
 * downgraded to info, and the pipeline treated it as a genuine block. The
 * finding is reconciled at the source (reportedFindings), DOWNGRADED not
 * dropped, never for a pattern finding and never for a policy blockCategories
 * finding. The harness mirrors tests/unit/ship-review-truncated-diff.test.mjs:
 * the reviewer LLM, git and the story note are stubbed; runReview is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'self-declared-severity-nonexistent-root');

const chatMock = vi.fn();
const readNoteMock = vi.fn(() => null);

let currentDiff = '';
let currentNames = '';

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' })),
  createAnthropicClient: vi.fn(() => ({ stub: true })),
  callAnthropicChat: (...args) => chatMock(...args),
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async () => ({ record: { root: FAKE_ROOT } })),
}));

vi.mock('../../packages/mcp-rks/src/dendron.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveNotesDir: vi.fn(() => path.join(FAKE_ROOT, 'notes')),
  readNote: (...args) => readNoteMock(...args),
}));

vi.mock('@routekit/rag', () => ({ runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })) }));

vi.mock('child_process', () => {
  const impl = (_cmd, args = []) => {
    // No earlier commit for this story: partialDiff is false, so only this story's softener acts.
    if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
    if (args.includes('--name-only')) return { stdout: currentNames, stderr: '', status: 0 };
    return { stdout: currentDiff, stderr: '', status: 0 };
  };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const { runReview, buildReviewPrompt, reconcileSelfDeclaredSeverity } = await import(
  '../../packages/mcp-rks/src/server/review.mjs'
);
const { buildOffRailReviewStep, blockSeverityFindingCount, resolveOffRailHalt } =
  await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');
const { loadContext } = await import('../../packages/mcp-rks/src/server/project.mjs');

const DEFAULT_BLOCK_CATEGORIES = ['enforcement_modification', 'security_issue'];

function fileDiff(file, bodyLines) {
  return (
    [
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${bodyLines.length} @@`,
      ...bodyLines.map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

const DIFF =
  fileDiff('src/feature.mjs', ['export const feature = 1;']) +
  fileDiff('tests/unit/feature.test.mjs', ["import { feature } from '../../src/feature.mjs';"]);
const NAMES = 'src/feature.mjs\ntests/unit/feature.test.mjs\n';

const storyWithAc = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n\n' +
    '## Testing Requirements\n\n- a test\n',
});

const AC_COVERAGE = { assessed: true, covered: ['AC1 does a thing', 'AC2 does another'], notCovered: [], uncertain: [] };

// The reported shape: severity block, text that disclaims its own block severity.
const SELF_DOWNGRADED = {
  category: 'ac_coverage',
  severity: 'block',
  file: 'src/feature.mjs',
  message: 'AC2 coverage looks thin, but on reflection I am downgrading this to info',
  suggestion: 'none needed',
};
const GENUINE_BLOCK = {
  category: 'missing_error_handling',
  severity: 'block',
  file: 'src/feature.mjs',
  message: 'feature.mjs swallows an error on line 1',
  suggestion: 'rethrow the error',
};

const claim = (findings, verdict = 'block') => ({ verdict, summary: 'a review', findings, acCoverage: AC_COVERAGE });

const runReviewUnderTest = () =>
  runReview({ projectId: 'routekit-shell-core', problemId: 'backlog.fix.some-story', branch: 'staging', targetBranch: 'abc1234' });

const reviewCompletePayloads = () =>
  ensureTelemetryStorage(FAKE_ROOT)
    .emit.mock.calls.filter((c) => c[0] === 'review.complete')
    .map((c) => c[2]);

const byCategory = (findings, category) => findings.filter((f) => f.category === category);

beforeEach(() => {
  chatMock.mockReset();
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyWithAc());
  currentDiff = DIFF;
  currentNames = NAMES;
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

describe('reconcileSelfDeclaredSeverity — pure, text-grounded, downgrade not drop', () => {
  it('is a named export', () => {
    expect(typeof reconcileSelfDeclaredSeverity).toBe('function');
  });

  it('THE REPRODUCTION — "downgrading this to info" reconciles a block finding to info', () => {
    const [f] = reconcileSelfDeclaredSeverity([SELF_DOWNGRADED], { patternCount: 0, blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(f.severity).toBe('info');
    expect(f.message).toContain(SELF_DOWNGRADED.message);
    expect(f.message).toMatch(/\bself_declared_severity\b/);
    expect(f.category).toBe('ac_coverage');
    expect(f.file).toBe('src/feature.mjs');
  });

  it('closed set — every enumerated phrase shape reconciles to its level, case-insensitively', () => {
    const cases = [
      ['Downgrade this to warn, it is a style point', 'warn'],
      ['I am downgrading this to info', 'info'],
      ['downgraded this to warn after re-reading', 'warn'],
      ['downgrade this finding to info', 'info'],
      ['downgrading  this\nfinding to warn', 'warn'],
      ['DOWNGRADED THIS FINDING TO INFO', 'info'],
      ['On balance this finding is informational', 'info'],
      ['this finding is non-blocking; the helper could be clearer', 'warn'],
    ];
    for (const [message, level] of cases) {
      const [f] = reconcileSelfDeclaredSeverity([{ ...SELF_DOWNGRADED, message }], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
      expect(f.severity, message).toBe(level);
      expect(f.message, message).toContain(message);
      expect(f.message, message).toMatch(/\bself_declared_severity\b/);
    }
  });

  it('a finding declaring both info and warn reconciles to warn', () => {
    const input = { ...SELF_DOWNGRADED, message: 'downgrading this to info', suggestion: 'or downgrade this to warn' };
    const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(f.severity).toBe('warn');
  });

  it('NEGATIVE — a block finding describing CODE as non-blocking stays block with an unchanged message', () => {
    const message = 'the non-blocking read swallows the error';
    const input = { ...GENUINE_BLOCK, message };
    const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(f.severity).toBe('block');
    expect(f.message).toBe(message);
  });

  it("NEGATIVE — a block finding quoting code that contains severity: 'info' stays block with an unchanged message", () => {
    const message = "emitFailure() hard-codes { severity: 'info' } so the failure is never surfaced";
    const input = { ...GENUINE_BLOCK, message };
    const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(f.severity).toBe('block');
    expect(f.message).toBe(message);
  });

  it('NEGATIVE — nothing outside the closed set reconciles', () => {
    const outside = [
      'This is non-blocking; the helper could be clearer',
      'this is informational only',
      'severity: info',
      'downgrade to warn',
      'downgrading this to a warning',
      'downgrading this to information',
    ];
    for (const message of outside) {
      const input = { ...GENUINE_BLOCK, message, suggestion: 'rethrow the error' };
      const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
      expect(f.severity, message).toBe('block');
      expect(f.message, message).toBe(message);
    }
  });

  it('a self-declaration in the suggestion field is honoured too', () => {
    const input = { ...SELF_DOWNGRADED, message: 'AC2 coverage looks thin', suggestion: 'downgrade this to warn; it is not a blocker' };
    const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(f.severity).toBe('warn');
  });

  it('THE CONVERSE — no self-declaration, and hedged prose, keep block and an unchanged message', () => {
    for (const message of ['feature.mjs swallows an error on line 1', 'this might be minor, but AC2 is missing']) {
      const input = { ...GENUINE_BLOCK, message };
      const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
      expect(f.severity, message).toBe('block');
      expect(f.message, message).toBe(message);
    }
  });

  it('pattern findings (index below patternCount) are never reconciled, whatever their text', () => {
    const pattern = { ...SELF_DOWNGRADED, category: 'other' };
    const out = reconcileSelfDeclaredSeverity([pattern, SELF_DOWNGRADED], { patternCount: 1, blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(out[0].severity).toBe('block');
    expect(out[0].message).toBe(pattern.message);
    expect(out[1].severity).toBe('info');
  });

  it('a policy blockCategories finding keeps block even when its text says "downgrading this to info"', () => {
    for (const category of DEFAULT_BLOCK_CATEGORIES) {
      const input = { ...SELF_DOWNGRADED, category };
      const [f] = reconcileSelfDeclaredSeverity([input], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
      expect(f.severity, category).toBe('block');
      expect(f.message, category).toBe(SELF_DOWNGRADED.message);
    }
  });

  it('only block findings are touched; warn and info findings pass through unchanged', () => {
    const warn = { ...SELF_DOWNGRADED, severity: 'warn' };
    const info = { ...SELF_DOWNGRADED, severity: 'info' };
    const out = reconcileSelfDeclaredSeverity([warn, info], { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(out).toEqual([warn, info]);
  });

  it('does not mutate its input, never throws, and returns a non-array unchanged', () => {
    const input = [{ ...SELF_DOWNGRADED }];
    const snapshot = JSON.parse(JSON.stringify(input));
    reconcileSelfDeclaredSeverity(input, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(input).toEqual(snapshot);
    expect(reconcileSelfDeclaredSeverity(null)).toBeNull();
    expect(reconcileSelfDeclaredSeverity(undefined)).toBeUndefined();
    expect(() => reconcileSelfDeclaredSeverity([null, { severity: 'block' }, {}])).not.toThrow();
  });
});

describe('runReview — one reconciled array reaches the return value and the emit', () => {
  it('returned findings and the review.complete emit both carry info; blockerCount excludes it', async () => {
    chatMock.mockResolvedValue(JSON.stringify(claim([SELF_DOWNGRADED])));
    const result = await runReviewUnderTest();

    expect(result.ok).toBe(true);
    const [returned] = byCategory(result.findings, 'ac_coverage');
    expect(returned.severity).toBe('info');
    expect(returned.message).toMatch(/\bself_declared_severity\b/);

    const payloads = reviewCompletePayloads();
    expect(payloads).toHaveLength(1);
    const [emitted] = byCategory(payloads[0].findings, 'ac_coverage');
    expect(emitted.severity).toBe('info');
    expect(payloads[0].blockerCount).toBe(0);
  });
});

describe('verdict cap — a block verdict resting only on self-disclaimed findings is capped to warn', () => {
  let tmpRoots = [];

  /** A real .rks/review-policy.yaml under a per-test temp root; loadReviewPolicy is not mocked. */
  function useVerdictMode(mode) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-declared-severity-policy-'));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rks', 'review-policy.yaml'), `verdictMode: ${mode}\n`);
    loadContext.mockResolvedValueOnce({ record: { root } });
  }

  afterEach(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
    tmpRoots = [];
  });

  it('caps under the default verdictMode warn, naming self_declared_severity', async () => {
    chatMock.mockResolvedValue(JSON.stringify(claim([SELF_DOWNGRADED])));
    const result = await runReviewUnderTest();

    expect(result.policy.verdictMode).toBe('warn');
    expect(result.verdict).toBe('warn');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toMatch(/\bself_declared_severity\b/);
  });

  it('caps under verdictMode block, naming self_declared_severity', async () => {
    useVerdictMode('block');
    chatMock.mockResolvedValue(JSON.stringify(claim([SELF_DOWNGRADED])));
    const result = await runReviewUnderTest();

    expect(result.policy.verdictMode).toBe('block');
    expect(result.findings.some((f) => f.severity === 'block')).toBe(false);
    expect(result.verdict).toBe('warn');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toMatch(/\bself_declared_severity\b/);
  });

  it('no cap when a genuine block finding survives', async () => {
    useVerdictMode('block');
    chatMock.mockResolvedValue(JSON.stringify(claim([SELF_DOWNGRADED, GENUINE_BLOCK])));
    const result = await runReviewUnderTest();

    expect(byCategory(result.findings, 'ac_coverage')[0].severity).toBe('info');
    expect(byCategory(result.findings, 'missing_error_handling')[0].severity).toBe('block');
    expect(result.verdict).toBe('block');
    expect(result.downgradeReason || '').not.toMatch(/\bself_declared_severity\b/);
  });

  it('THE CONVERSE — without a self-declaration the block verdict stands', async () => {
    useVerdictMode('block');
    chatMock.mockResolvedValue(JSON.stringify(claim([GENUINE_BLOCK])));
    const result = await runReviewUnderTest();

    expect(result.verdict).toBe('block');
    expect(result.downgradeReason || '').not.toMatch(/\bself_declared_severity\b/);
  });

  it('off-rail consequence — posture block does not halt on a self-disclaimed finding, and still halts on a genuine one', async () => {
    useVerdictMode('block');
    chatMock.mockResolvedValue(JSON.stringify(claim([SELF_DOWNGRADED])));
    const reconciled = buildOffRailReviewStep(await runReviewUnderTest());
    expect(blockSeverityFindingCount(reconciled)).toBe(0);
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: reconciled, scopeStep: { ok: true } })).toBeNull();

    useVerdictMode('block');
    chatMock.mockResolvedValue(JSON.stringify(claim([GENUINE_BLOCK])));
    const genuine = buildOffRailReviewStep(await runReviewUnderTest());
    expect(blockSeverityFindingCount(genuine)).toBe(1);
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: genuine, scopeStep: { ok: true } })).not.toBeNull();
  });
});

describe('buildReviewPrompt — prevention', () => {
  it('tells the reviewer the severity field is authoritative and must agree with the finding text', () => {
    const prompt = buildReviewPrompt({ diff: DIFF, story: storyWithAc(), ragContext: [], changedFiles: NAMES.trim().split('\n') });
    expect(prompt).toMatch(/severity[^\n]*authoritative/i);
    expect(prompt).toMatch(/must agree with/i);
  });
});
