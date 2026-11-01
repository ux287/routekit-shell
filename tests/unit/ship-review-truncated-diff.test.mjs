/**
 * backlog.fix.ship-review-truncated-diff-absence-findings
 *
 * The ship reviewer is shown at most REVIEW_DIFF_CHAR_CAP characters of the diff.
 * A finding that asserts something is ABSENT cannot be issued at block severity
 * from a view that could not contain the evidence. Findings about content the
 * reviewer DID see, and server-side pattern findings computed from the FULL diff,
 * keep their severity. Truncation is reported as its own signal (diffTruncation),
 * derived server-side, never from the model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'truncated-diff-nonexistent-root');

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
    // No earlier commit for this story: partialDiff is false, so truncation is isolated.
    if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
    if (args.includes('--name-only')) return { stdout: currentNames, stderr: '', status: 0 };
    return { stdout: currentDiff, stderr: '', status: 0 };
  };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const { runReview, buildReviewPrompt, computeDiffTruncation, REVIEW_DIFF_CHAR_CAP } = await import(
  '../../packages/mcp-rks/src/server/review.mjs'
);
const { resolvePhaseAdvanceSuppression, buildOffRailReviewStep, blockSeverityFindingCount, resolveOffRailHalt } =
  await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');
const { buildReviewStepEntry } = await import('../../packages/mcp-rks/src/server/story-ship.mjs');
const { loadContext } = await import('../../packages/mcp-rks/src/server/project.mjs');

const CAP = 50000;
// review.mjs default policy blockCategories (option C binds rule 1 to this list in production).
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

const MID_LINES = Array.from({ length: 600 }, () => 'a'.repeat(99)); // ~60,600 chars: the cut lands inside

function makeDiff({ big, secrets }) {
  const early = fileDiff('src/early.mjs', [
    'export const x = 1;',
    ...(secrets ? ['const password = "fixture-not-a-secret";'] : []),
  ]);
  const mid = fileDiff('docs/a.md', big ? MID_LINES : ['short']);
  const late = fileDiff('src/late.mjs', [
    'export const LATE_ONLY_MARKER = 1;',
    ...(secrets ? ['const password = "fixture-late-not-a-secret";'] : []),
  ]);
  return early + mid + late;
}

const NAMES = 'src/early.mjs\ndocs/a.md\nsrc/late.mjs\n';

// Independent oracle: the new-side number of the last docs/a.md line WHOLLY inside the cap.
function oracleLastIncludedLine(diff, file) {
  const included = diff.slice(0, CAP);
  const start = included.indexOf(`+++ b/${file}\n`);
  const hunkBody = included.indexOf('\n', included.indexOf('@@ ', start)) + 1;
  const parts = included.slice(hunkBody).split('\n');
  parts.pop(); // the cut (or empty) remainder is not a whole line
  return parts.length; // every body line is an addition starting at new-side line 1
}

const storyWithAc = () => ({
  title: 'A story',
  desc: 'A description',
  content:
    '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n\n' +
    '## Testing Requirements\n\n- a test\n',
});

const AC_COVERAGE = { assessed: true, covered: ['AC1 does a thing'], notCovered: ['AC2 does another'], uncertain: [] };

const MIXED_CLAIM = {
  verdict: 'block',
  summary: 'reviewer saw a cut diff',
  findings: [
    { category: 'ac_coverage', severity: 'block', message: 'AC2 is not implemented' },
    { category: 'test_coverage', severity: 'block', file: 'docs/a.md', message: 'diff cut mid-file; impossible to verify the last assertion' },
    { category: 'other', severity: 'block', file: 'src/late.mjs', message: 'late.mjs does not export the handler' },
    { category: 'missing_error_handling', severity: 'block', file: 'src/early.mjs', message: 'early.mjs swallows an error on an included line' },
  ],
  acCoverage: AC_COVERAGE,
};

// The third occurrence: the ONLY block finding is about a test cut mid-statement.
// verdict 'warn' (ARCH round 1, Item 3a): with 'block', the default verdictMode 'warn' sets a
// downgradeReason that rule 1 of resolvePhaseAdvanceSuppression returns verbatim, so the
// converse could never read block_severity_finding. The verdict cap (decision (i)) is pinned
// by its own block-verdict fixture, not by this one.
const CUT_TEST_CLAIM = {
  verdict: 'warn',
  summary: 'truncated at expect(ne',
  findings: [
    { category: 'test_coverage', severity: 'block', file: 'docs/a.md', message: 'The diff is truncated at expect(ne' },
  ],
  acCoverage: AC_COVERAGE,
};

const runReviewUnderTest = () =>
  runReview({ projectId: 'routekit-shell-core', problemId: 'backlog.fix.some-story', branch: 'staging', targetBranch: 'abc1234' });

const byFile = (result, category, file) =>
  result.findings.filter((f) => f.category === category && (file === undefined || f.file === file));

beforeEach(() => {
  chatMock.mockReset();
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyWithAc());
  currentNames = NAMES;
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

describe('computeDiffTruncation — server-derived, never from the model', () => {
  it('the cap is the 50,000-character prompt cap', () => {
    expect(REVIEW_DIFF_CHAR_CAP).toBe(CAP);
  });

  it('returns null at or under the cap', () => {
    expect(computeDiffTruncation('x'.repeat(CAP))).toBeNull();
    expect(computeDiffTruncation(makeDiff({ big: false, secrets: true }))).toBeNull();
  });

  it('names the unseen files and the file cut mid-hunk with its last wholly included line', () => {
    const diff = makeDiff({ big: true, secrets: true });
    const t = computeDiffTruncation(diff);
    expect(t.truncated).toBe(true);
    expect(t.originalChars).toBe(diff.length);
    expect(t.includedChars).toBe(CAP);
    expect(t.unseenFiles).toEqual(['src/late.mjs']);
    expect(t.partialFile).toEqual({ file: 'docs/a.md', lastIncludedLine: oracleLastIncludedLine(diff, 'docs/a.md') });
    expect(t.reason).toMatch(/\bdiff_truncated\b/);
    expect(t.reason).toContain(String(diff.length));
    expect(t.reason).toContain(String(CAP));
  });

  it('a cut exactly on a file boundary has no partial file', () => {
    const base = Array.from({ length: 400 }, () => 'a'.repeat(99));
    const probe = fileDiff('docs/a.md', [...base, '']);
    const exact = fileDiff('docs/a.md', [...base, 'b'.repeat(CAP - probe.length)]);
    expect(exact.length).toBe(CAP);
    const diff = exact + fileDiff('src/late.mjs', ['export const LATE_ONLY_MARKER = 1;']);
    const t = computeDiffTruncation(diff);
    expect(t.partialFile).toBeNull();
    expect(t.unseenFiles).toEqual(['src/late.mjs']);
  });
});

describe('buildReviewPrompt discloses truncation', () => {
  it('states DIFF TRUNCATED, the sizes and the unseen files, and carries nothing past the cut', () => {
    const diff = makeDiff({ big: true, secrets: false });
    const prompt = buildReviewPrompt({ diff, story: storyWithAc(), ragContext: [], changedFiles: NAMES.trim().split('\n') });
    expect(prompt).toContain('DIFF TRUNCATED');
    // ARCH round 1, Item 3b: `## Changed Files` already lists every path, so assert inside the
    // notice paragraph, not anywhere in the prompt.
    const notice = prompt.slice(prompt.indexOf('DIFF TRUNCATED')).split('\n\n')[0];
    expect(notice).toContain(String(diff.length));
    expect(notice).toContain('src/late.mjs');
    expect(notice).toContain('docs/a.md');
    expect(prompt).not.toContain('LATE_ONLY_MARKER');
  });

  it('an untruncated diff carries no truncation notice and is included whole', () => {
    const diff = makeDiff({ big: false, secrets: false });
    const prompt = buildReviewPrompt({ diff, story: storyWithAc(), ragContext: [], changedFiles: NAMES.trim().split('\n') });
    expect(prompt).not.toContain('DIFF TRUNCATED');
    expect(prompt).toContain('LATE_ONLY_MARKER');
  });
});

describe('runReview on a truncated diff', () => {
  it('records the signal, makes coverage unassessable, and downgrades only absence findings', async () => {
    currentDiff = makeDiff({ big: true, secrets: true });
    chatMock.mockResolvedValue(JSON.stringify(MIXED_CLAIM));
    const result = await runReviewUnderTest();

    expect(result.ok).toBe(true);
    expect(result.diffTruncation).toEqual(computeDiffTruncation(currentDiff));
    expect(chatMock.mock.calls[0][0].prompt).toContain('DIFF TRUNCATED');

    expect(result.acCoverage.assessable).toBe(false);
    expect(result.acCoverage.assessed).toBe(false);

    // Absence findings: downgraded, and the message names the truncation.
    for (const [category, file] of [['ac_coverage', undefined], ['test_coverage', 'docs/a.md'], ['other', 'src/late.mjs']]) {
      const [f] = byFile(result, category, file);
      expect(f.severity, category).toBe('warn');
      expect(f.message, category).toMatch(/\bdiff_truncated\b/);
    }

    // Included content keeps its severity: an LLM finding on a wholly seen file...
    expect(byFile(result, 'missing_error_handling', 'src/early.mjs')[0].severity).toBe('block');
    // ...and server-side pattern findings, which are computed from the FULL diff.
    const security = byFile(result, 'security_issue');
    expect(security.length).toBeGreaterThan(0);
    for (const f of security) expect(f.severity).toBe('block');
  });

  it('THE CONVERSE — under the cap nothing changes', async () => {
    currentDiff = makeDiff({ big: false, secrets: true });
    chatMock.mockResolvedValue(JSON.stringify(MIXED_CLAIM));
    const result = await runReviewUnderTest();

    expect('diffTruncation' in result).toBe(false);
    expect(chatMock.mock.calls[0][0].prompt).not.toContain('DIFF TRUNCATED');
    expect(result.acCoverage.assessable).toBe(true);
    expect(byFile(result, 'ac_coverage')[0].severity).toBe('block');
    expect(byFile(result, 'test_coverage', 'docs/a.md')[0].severity).toBe('block');
    expect(byFile(result, 'other', 'src/late.mjs')[0].severity).toBe('block');
    for (const f of result.findings) expect(f.message || '').not.toMatch(/\bdiff_truncated\b/);
  });
});

describe('the signal reaches both ship paths and the phase-advance gate', () => {
  it('THE REPRODUCTION — a test cut mid-statement no longer suppresses the advance, and the reason names truncation', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const result = await runReviewUnderTest();

    const step = buildOffRailReviewStep(result);
    expect(step.diffTruncation).toEqual(result.diffTruncation);
    expect(blockSeverityFindingCount(step)).toBe(0);
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: step, scopeStep: { ok: true } })).toBeNull();

    const outcome = resolvePhaseAdvanceSuppression(step);
    expect(outcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(outcome.reason).not.toMatch(/\bac_coverage_partial_diff\b/);
    expect(outcome.suppress).toBe(false);

    expect(buildReviewStepEntry(result).diffTruncation).toEqual(result.diffTruncation);
  });

  it('THE CONVERSE — the same finding on an untruncated diff keeps block severity (option C, v0.66.0)', async () => {
    currentDiff = makeDiff({ big: false, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const result = await runReviewUnderTest();

    const step = buildOffRailReviewStep(result);
    expect('diffTruncation' in step).toBe(false);
    expect('diffTruncation' in buildReviewStepEntry(result)).toBe(false);
    expect(blockSeverityFindingCount(step)).toBe(1);
    // The production discriminator that survives option C: posture block still halts on
    // a block finding in ANY category (resolveOffRailHalt is unchanged by option C).
    expect(resolveOffRailHalt({ posture: 'block', reviewStep: step, scopeStep: { ok: true } })).toBe('review_block_finding');
    // Fail-closed posture (no blockCategories passed): rule 1 honours every block finding.
    expect(resolvePhaseAdvanceSuppression(step).reason).toMatch(/\bblock_severity_finding\b/);
    // Production posture (the gate passes policy.blockCategories): option C does NOT honour a
    // test_coverage block, so rule 1 is not the reason; the fixture's notCovered AC decides.
    const prod = resolvePhaseAdvanceSuppression(step, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(prod.reason).not.toMatch(/\bblock_severity_finding\b/);
    expect(prod.reason).not.toMatch(/\bac_coverage_truncated_diff\b/);
    expect(prod.reason).toMatch(/\bac_not_covered\b/);
  });

  it('THE REPRODUCTION under the production blockCategories — still ac_coverage_truncated_diff, and a surviving non-honoured block is named', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const cut = buildOffRailReviewStep(await runReviewUnderTest());
    const cutOutcome = resolvePhaseAdvanceSuppression(cut, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(cutOutcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(cutOutcome.suppress).toBe(false);

    // MIXED_CLAIM keeps a missing_error_handling block on the wholly seen src/early.mjs. It is
    // not in blockCategories, so rule 1 skips it, and the truncated branch must carry the
    // option-C notice the same way the partial-diff branch does.
    chatMock.mockResolvedValue(JSON.stringify(MIXED_CLAIM));
    const mixed = buildOffRailReviewStep(await runReviewUnderTest());
    const mixedOutcome = resolvePhaseAdvanceSuppression(mixed, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(mixedOutcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(mixedOutcome.reason).toMatch(/\bblock_severity_finding_not_honoured\b/);
    expect(mixedOutcome.suppress).toBe(false);
  });

  it('the partial-diff reason is unchanged when there is no truncation', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: { assessed: false, assessable: false, covered: [], notCovered: [], uncertain: [] },
    });
    expect(resolvePhaseAdvanceSuppression(step).reason).toMatch(/\bac_coverage_partial_diff\b/);
  });
});

// Decision (i): only downgradable block findings, and a model verdict of block.
const ABSENCE_ONLY_BLOCK = {
  ...MIXED_CLAIM,
  findings: MIXED_CLAIM.findings.filter((f) => f.category !== 'missing_error_handling'),
};

describe('verdict cap, decision (i) — a truncated view cannot yield a block verdict on absence alone', () => {
  let tmpRoots = [];

  /** A real .rks/review-policy.yaml under a per-test temp root; loadReviewPolicy is not mocked. */
  function useVerdictMode(mode) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'truncated-diff-policy-'));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rks', 'review-policy.yaml'), `verdictMode: ${mode}\n`);
    loadContext.mockResolvedValueOnce({ record: { root } });
  }

  afterEach(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
    tmpRoots = [];
  });

  it('caps block to warn under the default verdictMode warn, naming diff_truncated', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(ABSENCE_ONLY_BLOCK));
    const result = await runReviewUnderTest();

    expect(result.policy.verdictMode).toBe('warn');
    expect(result.findings.some((f) => f.severity === 'block')).toBe(false);
    expect(result.verdict).toBe('warn');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toMatch(/\bdiff_truncated\b/);
  });

  it('caps block to warn under verdictMode block, naming diff_truncated', async () => {
    useVerdictMode('block');
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(ABSENCE_ONLY_BLOCK));
    const result = await runReviewUnderTest();

    expect(result.policy.verdictMode).toBe('block');
    expect(result.verdict).toBe('warn');
    expect(result.downgradedFrom).toBe('block');
    expect(result.downgradeReason).toMatch(/\bdiff_truncated\b/);
    // The step the off-rail gate reads carries the reason through.
    expect(buildOffRailReviewStep(result).downgradeReason).toMatch(/\bdiff_truncated\b/);
  });

  it('no cap when a block survives — a security_issue pattern finding keeps the verdict at block', async () => {
    useVerdictMode('block');
    currentDiff = makeDiff({ big: true, secrets: true });
    chatMock.mockResolvedValue(JSON.stringify(ABSENCE_ONLY_BLOCK));
    const result = await runReviewUnderTest();

    expect(result.policy.verdictMode).toBe('block');
    expect(result.findings.some((f) => f.category === 'security_issue' && f.severity === 'block')).toBe(true);
    expect(result.verdict).toBe('block');
    expect(result.downgradeReason || '').not.toMatch(/\bdiff_truncated\b/);
  });

  it('THE CONVERSE — on an untruncated diff no downgradeReason names diff_truncated', async () => {
    for (const mode of ['warn', 'block']) {
      if (mode === 'block') useVerdictMode('block');
      currentDiff = makeDiff({ big: false, secrets: false });
      chatMock.mockResolvedValue(JSON.stringify(ABSENCE_ONLY_BLOCK));
      const result = await runReviewUnderTest();
      expect(result.policy.verdictMode, mode).toBe(mode);
      expect(result.downgradeReason || '', mode).not.toMatch(/\bdiff_truncated\b/);
    }
  });
});

describe('telemetry R9 — review.prompt.assembled records the truncation', () => {
  const assembled = () =>
    ensureTelemetryStorage(FAKE_ROOT)
      .emit.mock.calls.filter((c) => c[0] === 'review.prompt.assembled')
      .map((c) => c[2]);

  it('carries diffTruncation equal to the result on a truncated diff', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const result = await runReviewUnderTest();

    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].diffTruncation).toEqual(result.diffTruncation);
    expect(payloads[0].diffTruncation.truncated).toBe(true);
  });

  it('has no diffTruncation key on an untruncated diff', async () => {
    currentDiff = makeDiff({ big: false, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    await runReviewUnderTest();

    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect('diffTruncation' in payloads[0]).toBe(false);
  });
});
