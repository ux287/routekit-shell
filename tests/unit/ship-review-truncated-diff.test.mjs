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
const {
  resolvePhaseAdvanceSuppression,
  buildOffRailReviewStep,
  blockSeverityFindingCount,
  resolveOffRailHalt,
  runOffRailEnforcementGate,
} =
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
    // backlog.feat.ship-review-covers-diff-past-char-cap: the over-cap diff is reviewed in
    // several calls split at file boundaries. Only docs/a.md (longer than the cap on its own)
    // is still cut; src/late.mjs now reaches a later call.
    expect(result.diffTruncation).toMatchObject({ truncated: true, unseenFiles: [], partialFile: { file: 'docs/a.md' } });
    expect(chatMock.mock.calls.some((c) => c[0].prompt.includes('DIFF TRUNCATED'))).toBe(true);

    expect(result.acCoverage.assessable).toBe(false);
    expect(result.acCoverage.assessed).toBe(false);

    // Absence findings: downgraded, and the message names the truncation.
    for (const [category, file] of [['ac_coverage', undefined], ['test_coverage', 'docs/a.md']]) {
      const [f] = byFile(result, category, file);
      expect(f.severity, category).toBe('warn');
      expect(f.message, category).toMatch(/\bdiff_truncated\b/);
    }

    // Included content keeps its severity: an LLM finding on a wholly seen file...
    expect(byFile(result, 'missing_error_handling', 'src/early.mjs')[0].severity).toBe('block');
    // ...including src/late.mjs, which a later call now sees whole.
    expect(byFile(result, 'other', 'src/late.mjs')[0].severity).toBe('block');
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
  it('THE REPRODUCTION — a test cut mid-statement suppresses the advance (backlog.fix.offrail-ship-advances-on-truncated-review), the reason names truncation, and the remedy is operable', async () => {
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
    expect(outcome).toBeTruthy();
    expect(outcome.suppress).not.toBe(false);
    // The remedy is operable from this branch: rks_phase_repair, not the rule-5 flag.
    expect(typeof outcome.remedy).toBe('string');
    expect(outcome.remedy.length).toBeGreaterThan(0);
    expect(outcome.remedy).toContain('rks_phase_repair');
    expect(outcome.remedy).not.toContain('advancePhaseOnUnassessedAC');
    // A re-ship is truncated again while the diff exceeds the review character cap.
    expect(outcome.remedy).toContain('truncat');

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

  it('THE REPRODUCTION under the production blockCategories — suppresses as ac_coverage_truncated_diff, and a surviving non-honoured block is named', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const cut = buildOffRailReviewStep(await runReviewUnderTest());
    const cutOutcome = resolvePhaseAdvanceSuppression(cut, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(cutOutcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(cutOutcome.suppress).not.toBe(false);

    // MIXED_CLAIM keeps a missing_error_handling block on the wholly seen src/early.mjs. It is
    // not in blockCategories, so rule 1 skips it, and the truncated branch must carry the
    // option-C notice the same way the partial-diff branch does.
    chatMock.mockResolvedValue(JSON.stringify(MIXED_CLAIM));
    const mixed = buildOffRailReviewStep(await runReviewUnderTest());
    const mixedOutcome = resolvePhaseAdvanceSuppression(mixed, { blockCategories: DEFAULT_BLOCK_CATEGORIES });
    expect(mixedOutcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(mixedOutcome.reason).toMatch(/\bblock_severity_finding_not_honoured\b/);
    expect(mixedOutcome).toBeTruthy();
    expect(mixedOutcome.suppress).not.toBe(false);
  });

  it('advanceOnUnassessedAC true does NOT permit a truncated review (user decision at QA)', async () => {
    currentDiff = makeDiff({ big: true, secrets: false });
    chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
    const step = buildOffRailReviewStep(await runReviewUnderTest());
    const outcome = resolvePhaseAdvanceSuppression(step, { advanceOnUnassessedAC: true });
    expect(outcome).toBeTruthy();
    expect(outcome.suppress).not.toBe(false);
    expect(outcome.reason).toMatch(/\bac_coverage_truncated_diff\b/);
    expect(outcome.remedy).toContain('rks_phase_repair');
  });

  describe('through the real off-rail gate (runOffRailEnforcementGate)', () => {
    let gateRoots = [];
    afterEach(() => {
      for (const root of gateRoots) fs.rmSync(root, { recursive: true, force: true });
      gateRoots = [];
    });

    /**
     * Drives the real gate. The projectRoot is an empty temp dir, so loadReviewPolicy (not
     * mocked) returns the production defaults (enabled, advancePhaseOnUnassessedAC false,
     * blockCategories [enforcement_modification, security_issue]). runReview is the real one,
     * on the mocked diff. allowedFiles is empty, so no commit manifest is read.
     */
    async function runGate() {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truncated-diff-gate-'));
      gateRoots.push(projectRoot);
      return runOffRailEnforcementGate({
        projectRoot,
        projectId: 'routekit-shell-core',
        activeSession: { problemId: 'backlog.fix.some-story', branch: 'staging', headCommit: 'abc1234' },
        changedFiles: NAMES.trim().split('\n'),
        allowedFiles: [],
        gate: 'gate_beta',
        override: null,
      });
    }

    // guardrailsOn takes the suppressed arm (no reconcileToIntegrated) exactly when
    // gateBeta.phaseAdvanceSuppression is truthy. Driving guardrailsOn itself needs a real git
    // repo and off-rail session, which this file's module-wide child_process mock rules out;
    // those harnesses live in the integration tier.
    it('a truncated review yields a truthy phaseAdvanceSuppression naming truncation and a null notice', async () => {
      currentDiff = makeDiff({ big: true, secrets: false });
      chatMock.mockResolvedValue(JSON.stringify(CUT_TEST_CLAIM));
      const result = await runGate();

      // Three reviewer calls: src/early.mjs, the cut docs/a.md, src/late.mjs.
      expect(chatMock).toHaveBeenCalledTimes(3);
      const reviewStep = result.steps[0];
      expect(reviewStep.diffTruncation?.truncated).toBe(true);
      expect(result.haltReason).toBeNull();

      expect(result.phaseAdvanceSuppression).toBeTruthy();
      expect(result.phaseAdvanceSuppression.reason).toMatch(/\bac_coverage_truncated_diff\b/);
      expect(result.phaseAdvanceSuppression.remedy).toContain('rks_phase_repair');
      expect(result.phaseAdvanceNotice).toBeNull();
    });

    it('both narrowing expressions in runOffRailEnforcementGate are unchanged (full-source toContain, no slice)', () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');
      expect(src).toContain(
        'phaseAdvanceSuppression: phaseAdvanceOutcome?.suppress === false ? null : phaseAdvanceOutcome,',
      );
      expect(src).toContain(
        'phaseAdvanceNotice: phaseAdvanceOutcome?.suppress === false ? phaseAdvanceOutcome.reason : null,',
      );
    });

    it('POSITIVE CONTROL — an untruncated, assessed review with every criterion covered publishes a null phaseAdvanceSuppression', async () => {
      currentDiff = makeDiff({ big: false, secrets: false });
      chatMock.mockResolvedValue(
        JSON.stringify({
          verdict: 'pass',
          summary: 'all criteria covered',
          findings: [],
          acCoverage: { assessed: true, covered: ['AC1 does a thing', 'AC2 does another'], notCovered: [], uncertain: [] },
        }),
      );
      const result = await runGate();

      expect(chatMock).toHaveBeenCalledTimes(1);
      expect('diffTruncation' in result.steps[0]).toBe(false);
      expect(result.steps[0].acCoverage?.assessable).not.toBe(false);
      expect(result.phaseAdvanceSuppression).toBeNull();
      expect(result.phaseAdvanceNotice).toBeNull();
    });
  });

  it('the truncated-branch comments cite the reversal of decision 2P', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');
    expect(src).toContain('backlog.fix.offrail-ship-advances-on-truncated-review');
    expect(src).not.toContain('Same decision as the partial branch below');
  });

  it('THE CONVERSE (untruncated) — an assessed review with every criterion covered and no skipped block finding permits', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: { assessed: true, assessable: true, covered: ['AC1 does a thing', 'AC2 does another'], notCovered: [], uncertain: [] },
    });
    expect('diffTruncation' in step).toBe(false);
    expect(resolvePhaseAdvanceSuppression(step, { blockCategories: DEFAULT_BLOCK_CATEGORIES })).toBeNull();
  });

  it('the partial-diff reason is unchanged when there is no truncation', () => {
    const step = buildOffRailReviewStep({
      ok: true,
      verdict: 'pass',
      findings: [],
      acCoverage: { assessed: false, assessable: false, covered: [], notCovered: [], uncertain: [] },
    });
    const outcome = resolvePhaseAdvanceSuppression(step);
    expect(outcome.reason).toMatch(/\bac_coverage_partial_diff\b/);
    expect(outcome.suppress).toBe(false);
    expect(outcome.remedy).toBeUndefined();
  });
});

// Decision (i): only downgradable block findings, and a model verdict of block.
// src/late.mjs now reaches a later reviewer call, so its 'other' finding is no longer
// downgradable and is left out (backlog.feat.ship-review-covers-diff-past-char-cap).
const ABSENCE_ONLY_BLOCK = {
  ...MIXED_CLAIM,
  findings: MIXED_CLAIM.findings.filter((f) => f.category !== 'missing_error_handling' && f.file !== 'src/late.mjs'),
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

// backlog.feat.ship-review-covers-diff-past-char-cap: an over-cap diff is reviewed in
// several calls split at file boundaries, up to REVIEW_MAX_CALLS, so every file within that
// bound reaches a reviewer; only content past the bound (or a file over the cap on its own)
// stays unreviewed and is disclosed.
const { REVIEW_MAX_CALLS } = await import('../../packages/mcp-rks/src/server/review.mjs');

describe('multi-call review covers diffs past the cap', () => {
  const LINE = 'b'.repeat(99);
  const sizedFile = (name, lines, extra = []) => fileDiff(name, [...extra, ...Array.from({ length: lines }, () => LINE)]);
  const PASS = (summary = 'ok', over = {}) => JSON.stringify({ verdict: 'pass', summary, findings: [], ...over });
  const headerFiles = (prompt) => [...prompt.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const prompts = () => chatMock.mock.calls.map((c) => c[0].prompt);
  const completes = () =>
    ensureTelemetryStorage(FAKE_ROOT).emit.mock.calls.filter((c) => c[0] === 'review.complete').map((c) => c[2]);
  let tmpRoots = [];
  const useVerdictMode = (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-call-policy-'));
    tmpRoots.push(root);
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rks', 'review-policy.yaml'), `verdictMode: ${mode}\n`);
    loadContext.mockResolvedValueOnce({ record: { root } });
  };
  afterEach(() => {
    for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
    tmpRoots = [];
  });
  // Three ~30k files: over the cap together, each under it, three calls.
  const useThreeFiles = () => {
    const files = ['src/one.mjs', 'src/two.mjs', 'src/three.mjs'];
    currentDiff = files.map((f) => sizedFile(f, 300)).join('');
    currentNames = files.join('\n') + '\n';
    return files;
  };
  // Six ~40k files: one per call, so the last two lie past the bound.
  const useSixFiles = (extraLast = []) => {
    const files = Array.from({ length: 6 }, (_, i) => `src/part${i + 1}.mjs`);
    const sections = files.map((f, i) => sizedFile(f, 400, i === 5 ? extraLast : []));
    currentDiff = sections.join('');
    currentNames = files.join('\n') + '\n';
    return { files, sections };
  };

  it('every changed file of an over-cap diff reaches at least one reviewer call', async () => {
    const files = useThreeFiles();
    expect(currentDiff.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(chatMock.mock.calls.length).toBeGreaterThan(1);
    const seen = new Set(prompts().flatMap(headerFiles));
    for (const f of files) expect(seen.has(f), f).toBe(true);
    expect('diffTruncation' in result).toBe(false);
  });

  it('a diff needing more calls than the bound makes exactly the bound and discloses only the files no call saw', async () => {
    expect(Number.isInteger(REVIEW_MAX_CALLS) && REVIEW_MAX_CALLS > 0).toBe(true);
    const { files, sections } = useSixFiles();
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(chatMock).toHaveBeenCalledTimes(REVIEW_MAX_CALLS);
    const seen = new Set(prompts().flatMap(headerFiles));
    const unseen = files.filter((f) => !seen.has(f));
    expect(unseen.length).toBeGreaterThan(0);
    const t = result.diffTruncation;
    expect(t.truncated).toBe(true);
    expect([...t.unseenFiles].sort()).toEqual([...unseen].sort());
    expect(t.originalChars).toBe(currentDiff.length);
    expect(t.includedChars).toBe(sections.slice(0, REVIEW_MAX_CALLS).reduce((n, x) => n + x.length, 0));
  });

  it('a single file over the cap is cut in a call of its own and named as partialFile', async () => {
    const big = sizedFile('docs/huge.md', 600);
    expect(big.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    currentDiff = sizedFile('src/a.mjs', 10) + big + sizedFile('src/b.mjs', 10);
    currentNames = 'src/a.mjs\ndocs/huge.md\nsrc/b.mjs\n';
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    const own = prompts().filter((p) => headerFiles(p).includes('docs/huge.md'));
    expect(own).toHaveLength(1);
    expect(headerFiles(own[0])).toEqual(['docs/huge.md']);
    expect(result.diffTruncation.partialFile.file).toBe('docs/huge.md');
    expect(result.diffTruncation.partialFile.lastIncludedLine).toBe(computeDiffTruncation(big).partialFile.lastIncludedLine);
    expect(result.diffTruncation.unseenFiles).toEqual([]);
  });

  it('absence findings on unseen files are softened and findings on files seen in a later call keep their severity', async () => {
    const { files } = useSixFiles();
    chatMock
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'block', summary: 'c1', findings: [
        { category: 'ac_coverage', severity: 'block', message: 'AC2 is not implemented' },
        { category: 'other', severity: 'block', file: files[5], message: 'part6 lacks the handler' },
      ] }))
      .mockResolvedValueOnce(PASS('c2'))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'block', summary: 'c3', findings: [
        { category: 'missing_error_handling', severity: 'block', file: files[2], message: 'part3 swallows an error' },
      ] }))
      .mockResolvedValueOnce(PASS('c4'));
    const result = await runReviewUnderTest();
    const [unseenFinding] = byFile(result, 'other', files[5]);
    expect(unseenFinding.severity).toBe('warn');
    expect(unseenFinding.message).toMatch(/\bdiff_truncated\b/);
    const [ac] = byFile(result, 'ac_coverage');
    expect(ac.severity).toBe('warn');
    expect(ac.message).toMatch(/\bdiff_truncated\b|\bmulti_call_partial_view\b/);
    expect(byFile(result, 'missing_error_handling', files[2])[0].severity).toBe('block');
  });

  it('findings from all calls are merged and the verdict follows the existing rules over the merged set', async () => {
    const files = useThreeFiles();
    useVerdictMode('block');
    chatMock
      .mockResolvedValueOnce(PASS('S1'))
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'block', summary: 'S2', findings: [
        { category: 'missing_error_handling', severity: 'block', file: files[1], message: 'two.mjs swallows an error' },
      ] }))
      .mockResolvedValueOnce(PASS('S3'));
    const a = await runReviewUnderTest();
    expect(byFile(a, 'missing_error_handling', files[1])).toHaveLength(1);
    expect(a.verdict).toBe('block');
    for (const s of ['S1', 'S2', 'S3']) expect(a.summary).toContain(s);

    useVerdictMode('block');
    chatMock.mockReset();
    chatMock.mockResolvedValue(PASS());
    const b = await runReviewUnderTest();
    expect(b.verdict).not.toBe('block');

    // A multi-call review that saw everything: the only block is an absence finding from one call.
    useVerdictMode('block');
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'block', summary: 'x', findings: [
        { category: 'ac_coverage', severity: 'block', message: 'AC2 is not implemented' },
      ] }))
      .mockResolvedValue(PASS());
    const c = await runReviewUnderTest();
    expect('diffTruncation' in c).toBe(false);
    expect(byFile(c, 'ac_coverage')[0].message).toMatch(/\bmulti_call_partial_view\b/);
    expect(c.verdict).toBe('warn');
    expect(c.downgradeReason).toMatch(/\bmulti_call_partial_view\b/);
  });

  it('acCoverage is merged across calls by entry string before binding', async () => {
    useThreeFiles();
    chatMock
      .mockResolvedValueOnce(PASS('a', { acCoverage: { assessed: true, covered: [], notCovered: [], uncertain: ['AC1 does a thing'] } }))
      .mockResolvedValueOnce(PASS('b', { acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: ['AC2 does another'], uncertain: [] } }))
      .mockResolvedValueOnce(PASS('c', { acCoverage: { assessed: false, covered: [], notCovered: [], uncertain: ['AC3 left open'] } }));
    const r = await runReviewUnderTest();
    expect(r.acCoverage.covered).toContain('AC1 does a thing');
    expect(r.acCoverage.uncertain).not.toContain('AC1 does a thing');
    expect(r.acCoverage.notCovered).toContain('AC2 does another');
    expect(r.acCoverage.uncertain).toContain('AC3 left open');
    expect(r.acCoverage.assessed).toBe(false);

    chatMock.mockReset();
    chatMock.mockResolvedValue(PASS('d', { acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: [], uncertain: [] } }));
    const all = await runReviewUnderTest();
    expect(all.acCoverage.assessed).toBe(true);
  });

  it('a diff at or under the cap takes exactly one call with a prompt identical to buildReviewPrompt', async () => {
    currentDiff = makeDiff({ big: false, secrets: false });
    currentNames = NAMES;
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(prompts()[0]).toBe(buildReviewPrompt({ diff: currentDiff, story: storyWithAc(), ragContext: [], changedFiles: NAMES.trim().split('\n') }));
    expect('reviewCalls' in result).toBe(false);
    expect('reviewCalls' in completes()[0]).toBe(false);
  });

  it('the result and review.complete record the call count and the files each call covered', async () => {
    useThreeFiles();
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(result.reviewCalls).toHaveLength(chatMock.mock.calls.length);
    result.reviewCalls.forEach((entry, i) => {
      expect(entry).toMatchObject({ index: i, ok: true });
      expect(entry.files).toEqual(headerFiles(prompts()[i]));
    });
    expect(completes()[0].reviewCalls).toEqual(result.reviewCalls);
  });

  it('a failed later call leaves its files unseen and is reported in reviewCalls and diffTruncation', async () => {
    const files = useThreeFiles();
    chatMock
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'warn', summary: 'one', findings: [
        { category: 'missing_error_handling', severity: 'warn', file: files[0], message: 'one.mjs logs too much' },
      ] }))
      .mockRejectedValueOnce(new Error('simulated reviewer outage'))
      .mockResolvedValueOnce(PASS('three'));
    const result = await runReviewUnderTest();
    expect(result.reviewCalls[1]).toMatchObject({ index: 1, ok: false });
    expect(result.reviewCalls[1].cause).toBeTruthy();
    const okFiles = result.reviewCalls.filter((e) => e.ok).flatMap((e) => e.files);
    expect(okFiles).not.toContain(files[1]);
    expect(result.diffTruncation.unseenFiles).toContain(files[1]);
    expect(result.diffTruncation.reason).toMatch(/\breview_call_failed\b/);
    expect(result.diffTruncation.reason).toContain('call index 1');
    expect(completes()[0].reviewCalls).toEqual(result.reviewCalls);
    expect(byFile(result, 'missing_error_handling', files[0])).toHaveLength(1);
  });

  it('a failed first call keeps the fail-closed result with no further call', async () => {
    useThreeFiles();
    chatMock.mockRejectedValueOnce(new Error('simulated reviewer outage')).mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result.reviewerUnavailable).toBe(true);
    expect(result.llmFailed).toBe(true);
    const payload = completes()[0];
    expect(Object.keys(payload).sort()).toEqual(
      ['problemId', 'verdict', 'findingCount', 'blockerCount', 'warningCount', 'llmFailed', 'reviewerUnavailable', 'cause', 'findings'].sort(),
    );
  });

  it('pattern checks still scan the full diff including files no call saw', async () => {
    useSixFiles(['const password = "fixture-beyond-not-a-secret";']);
    chatMock.mockResolvedValue(PASS());
    const result = await runReviewUnderTest();
    expect(result.diffTruncation.unseenFiles).toContain('src/part6.mjs');
    const security = byFile(result, 'security_issue');
    expect(security.length).toBeGreaterThan(0);
    for (const f of security) expect(f.severity).toBe('block');
  });
});

// backlog.fix.ship-review-multi-call-followups: multi-call downgrade wording, per-call prompt
// telemetry, cross-call finding dedupe, and the same-path header parse.
const { planReviewCalls, mergeReviewCallResults } = await import('../../packages/mcp-rks/src/server/review.mjs');
const crypto = await import('node:crypto');
const hash16 = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const FU_LINE = 'c'.repeat(99);
const fuFile = (name, lines) => fileDiff(name, Array.from({ length: lines }, () => FU_LINE));
const fuPass = (over = {}) => JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [], ...over });
const fuAssembled = () => ensureTelemetryStorage(FAKE_ROOT).emit.mock.calls.filter((c) => c[0] === 'review.prompt.assembled').map((c) => c[2]);
// Six ~40k files: one per call, the last two past the bound.
const fuSix = () => {
  const files = Array.from({ length: 6 }, (_, i) => `src/f${i + 1}.mjs`);
  currentDiff = files.map((f) => fuFile(f, 400)).join('');
  currentNames = files.join('\n') + '\n';
  return files;
};
// One small file, one file over the cap (cut), one small file: three calls, everything reached.
const fuCut = () => {
  currentDiff = fuFile('src/a.mjs', 10) + fuFile('docs/huge.md', 600) + fuFile('src/b.mjs', 10);
  currentNames = 'src/a.mjs\ndocs/huge.md\nsrc/b.mjs\n';
};

describe('multi-call follow-ups - downgrade wording', () => {
  it('single-call truncated review keeps the shown-only-the-first message byte-identical', async () => {
    // A single section over the cap is still one call with today's truncation.
    currentDiff = fuFile('docs/solo.md', 600);
    currentNames = 'docs/solo.md\n';
    chatMock.mockResolvedValue(JSON.stringify({ verdict: 'warn', summary: 's', findings: [
      { category: 'ac_coverage', severity: 'block', message: 'AC2 is not implemented' },
    ] }));
    const r = await runReviewUnderTest();
    expect(chatMock).toHaveBeenCalledTimes(1);
    const t = r.diffTruncation;
    expect(byFile(r, 'ac_coverage')[0].message).toBe(
      `AC2 is not implemented [downgraded: diff_truncated — the reviewer was shown only the first ${t.includedChars} of ${t.originalChars} characters of the review diff, so this cannot be asserted at block severity from it]`,
    );
  });

  it('multi-call finding on an unseen file says no successful call saw it', async () => {
    const files = fuSix();
    chatMock.mockResolvedValue(fuPass({ findings: [{ category: 'other', severity: 'block', file: files[5], message: 'f6 lacks it' }] }));
    const r = await runReviewUnderTest();
    const [f] = byFile(r, 'other', files[5]);
    expect(f.message).toMatch(/\bdiff_truncated\b/);
    expect(f.message).not.toContain('shown only the first');
    expect(f.message).toContain(files[5]);
    expect(f.message).toContain('no successful review call saw');
  });

  it('multi-call finding on a cut file says it was cut at the per-call cap', async () => {
    fuCut();
    chatMock.mockResolvedValue(fuPass({ findings: [{ category: 'other', severity: 'block', file: 'docs/huge.md', message: 'huge is incomplete' }] }));
    const r = await runReviewUnderTest();
    const [f] = byFile(r, 'other', 'docs/huge.md');
    expect(f.message).toMatch(/\bdiff_truncated\b/);
    expect(f.message).not.toContain('shown only the first');
    expect(f.message).toContain('docs/huge.md');
    expect(f.message).toContain('cut at the per-call character cap');
  });

  it('multi-call absence finding on a seen file names the unseen and cut file lists', async () => {
    const files = fuSix();
    chatMock.mockResolvedValue(fuPass({ findings: [{ category: 'test_coverage', severity: 'block', file: files[0], message: 'no test' }] }));
    const r = await runReviewUnderTest();
    const [f] = byFile(r, 'test_coverage', files[0]);
    expect(f.message).toMatch(/\bdiff_truncated\b/);
    expect(f.message).not.toContain('shown only the first');
    expect(f.message).toContain(`files no successful call saw: ${files[4]}, ${files[5]}`);
    expect(f.message).toContain('cut files: none');
  });

  it('multi-call downgrade set, severity and downgradeReason are unchanged', async () => {
    const files = fuSix();
    chatMock.mockResolvedValue(JSON.stringify({ verdict: 'block', summary: 's', findings: [
      { category: 'other', severity: 'block', file: files[5], message: 'f6 lacks it' },
      { category: 'missing_error_handling', severity: 'block', file: files[1], message: 'f2 swallows' },
    ] }));
    const r = await runReviewUnderTest();
    expect(byFile(r, 'other', files[5])[0].severity).toBe('warn');
    expect(byFile(r, 'missing_error_handling', files[1])[0].severity).toBe('block');
    // With only the downgradable finding, the verdict cap fires and names the truncation.
    chatMock.mockReset();
    chatMock.mockResolvedValue(JSON.stringify({ verdict: 'block', summary: 's', findings: [
      { category: 'other', severity: 'block', file: files[5], message: 'f6 lacks it' },
    ] }));
    const capped = await runReviewUnderTest();
    expect(capped.verdict).toBe('warn');
    expect(capped.downgradeReason).toMatch(/\bdiff_truncated\b/);
  });

  it('multi-call runReview dedupes a repeated LLM finding and leaves pattern findings unchanged', async () => {
    fuSix();
    currentDiff = fileDiff('src/secret.mjs', ['const password = "fixture-dedupe-not-a-secret";']) + currentDiff;
    currentNames = 'src/secret.mjs\n' + currentNames;
    const repeated = { category: 'missing_error_handling', severity: 'warn', file: 'src/f1.mjs', line: 3, message: 'same everywhere' };
    chatMock.mockResolvedValue(fuPass({ findings: [repeated] }));
    const r = await runReviewUnderTest();
    expect(r.findings.filter((f) => f.message === 'same everywhere')).toHaveLength(1);
    const patterns = r.findings.filter((f) => f.category === 'security_issue');
    expect(patterns.length).toBeGreaterThan(0);
    expect(r.findings.slice(0, patterns.length)).toEqual(patterns);
  });
});

describe('multi-call follow-ups - per-call prompt telemetry', () => {
  it('multi-call emit carries reviewCallPrompts matching each sent prompt and top-level pair equals call 0', async () => {
    fuSix();
    chatMock.mockResolvedValue(fuPass());
    await runReviewUnderTest();
    const [p] = fuAssembled();
    const sent = chatMock.mock.calls.map((c) => c[0].prompt);
    expect(p.reviewCallPrompts).toEqual(sent.map((t, index) => ({ index, promptLength: t.length, promptHash: hash16(t) })));
    expect(p.promptLength).toBe(p.reviewCallPrompts[0].promptLength);
    expect(p.promptHash).toBe(p.reviewCallPrompts[0].promptHash);
  });

  it('single-call emit has no reviewCallPrompts and describes the single prompt sent', async () => {
    currentDiff = makeDiff({ big: false, secrets: false });
    currentNames = NAMES;
    chatMock.mockResolvedValue(fuPass());
    await runReviewUnderTest();
    const [p] = fuAssembled();
    const sent = chatMock.mock.calls[0][0].prompt;
    expect('reviewCallPrompts' in p).toBe(false);
    expect(p.promptLength).toBe(sent.length);
    expect(p.promptHash).toBe(hash16(sent));
  });
});

describe('mergeReviewCallResults - pure', () => {
  const ok = (findings, over = {}) => ({ ok: true, verdict: 'pass', summary: '', findings, ...over });
  it('dedupes equal findings across calls keeping the first', () => {
    const a = { category: 'other', file: 'x', line: 1, message: 'm', severity: 'warn' };
    const b = { category: 'other', file: 'y', line: 2, message: 'n', severity: 'warn' };
    const r = mergeReviewCallResults([ok([a, b]), ok([{ ...a, severity: 'block' }])]);
    expect(r.findings).toEqual([a, b]);
  });

  it('keeps findings that differ in one of category, file, line or message', () => {
    const base = { category: 'other', file: 'x', line: 1, message: 'm' };
    const variants = [{ ...base, category: 'test_coverage' }, { ...base, file: 'z' }, { ...base, line: 2 }, { ...base, message: 'n' }];
    const noFile = { category: 'other', line: 1, message: 'm' };
    const r = mergeReviewCallResults([ok([base]), ok([...variants, noFile])]);
    expect(r.findings).toHaveLength(6);
  });

  it('ignores failed calls, takes the most severe verdict and joins summaries in order', () => {
    const r = mergeReviewCallResults([
      ok([], { verdict: 'warn', summary: 'one' }),
      { ok: false, verdict: 'block', summary: 'failed', findings: [{ category: 'other', message: 'lost' }] },
      ok([], { verdict: 'pass', summary: 'three' }),
    ]);
    expect(r.verdict).toBe('warn');
    expect(r.summary).toBe('one three');
    expect(r.findings).toEqual([]);
  });

  it('merges acCoverage by the covered, notCovered, uncertain and assessed rules', () => {
    const r = mergeReviewCallResults([
      ok([], { acCoverage: { assessed: true, covered: ['A'], notCovered: ['B', 'A'], uncertain: ['C', 'A'] } }),
      ok([], { acCoverage: { assessed: true, covered: [], notCovered: ['D'], uncertain: ['D', 'E'] } }),
    ]);
    expect(r.acCoverage).toEqual({ covered: ['A'], notCovered: ['B', 'D'], uncertain: ['C', 'E'], assessed: true });
    const partial = mergeReviewCallResults([ok([], { acCoverage: { assessed: true, covered: [] } }), ok([])]);
    expect(partial.acCoverage.assessed).toBe(false);
  });

  it('omits acCoverage when no successful call supplied one', () => {
    expect('acCoverage' in mergeReviewCallResults([ok([]), ok([], { acCoverage: ['not', 'an', 'object'] })])).toBe(false);
  });
});

describe('planReviewCalls - pure', () => {
  it('returns null at or under the cap and for a single section', () => {
    expect(planReviewCalls(makeDiff({ big: false, secrets: false }))).toBeNull();
    expect(planReviewCalls(fuFile('docs/solo.md', 600))).toBeNull();
  });

  it('keeps text before the first header in the first call', () => {
    const pre = 'PREAMBLE LINE\n';
    const diff = pre + fuFile('src/one.mjs', 300) + fuFile('src/two.mjs', 300) + fuFile('src/three.mjs', 300);
    const plan = planReviewCalls(diff);
    expect(plan.calls[0].diff.startsWith(pre)).toBe(true);
  });

  it('treats a header-only section as its own section', () => {
    const headerOnly = 'diff --git a/bin/tool b/bin/tool\nold mode 100644\nnew mode 100755\n';
    const diff = fuFile('src/one.mjs', 300) + headerOnly + fuFile('src/two.mjs', 300) + fuFile('src/three.mjs', 300);
    const plan = planReviewCalls(diff);
    const files = [...plan.calls, ...plan.beyond].flatMap((c) => c.files);
    expect(files).toEqual(['src/one.mjs', 'bin/tool', 'src/two.mjs', 'src/three.mjs']);
  });

  it('puts an over-cap section in its own chunk with cut true', () => {
    const diff = fuFile('src/a.mjs', 10) + fuFile('docs/huge.md', 600) + fuFile('src/b.mjs', 10);
    const plan = planReviewCalls(diff);
    const huge = plan.calls.find((c) => c.files.includes('docs/huge.md'));
    expect(huge.files).toEqual(['docs/huge.md']);
    expect(huge.cut).toBe(true);
  });

  it('puts chunks past REVIEW_MAX_CALLS in beyond', () => {
    const diff = Array.from({ length: 6 }, (_, i) => fuFile(`src/p${i}.mjs`, 400)).join('');
    const plan = planReviewCalls(diff);
    expect(plan.calls).toHaveLength(REVIEW_MAX_CALLS);
    expect(plan.beyond.flatMap((c) => c.files)).toEqual(['src/p4.mjs', 'src/p5.mjs']);
  });

  it('concatenated calls and beyond diffs equal the input', () => {
    const diff = 'PRE\n' + Array.from({ length: 6 }, (_, i) => fuFile(`src/q${i}.mjs`, i === 2 ? 600 : 300)).join('');
    const plan = planReviewCalls(diff);
    expect([...plan.calls, ...plan.beyond].map((c) => c.diff).join('')).toBe(diff);
  });
});

describe('same-path header parse', () => {
  const spaced = 'docs/a b/c.md';
  it('planReviewCalls records the full path for a same-path header containing b/', () => {
    const diff = fuFile('src/one.mjs', 300) + fuFile(spaced, 300) + fuFile('src/two.mjs', 300);
    expect(fuFile(spaced, 1)).toContain(`diff --git a/${spaced} b/${spaced}`);
    const plan = planReviewCalls(diff);
    expect([...plan.calls, ...plan.beyond].flatMap((c) => c.files)).toContain(spaced);
  });

  it('computeDiffTruncation records the full path for a same-path header containing b/', () => {
    const t = computeDiffTruncation(fuFile('src/one.mjs', 300) + fuFile(spaced, 300));
    expect([...t.unseenFiles, t.partialFile?.file]).toContain(spaced);
  });

  it('non-same-path headers parse as before in both helpers', () => {
    const renamed = 'diff --git a/old/name.md b/new/name.md\nsimilarity index 90%\n' + 'x'.repeat(30000) + '\n';
    const diff = fuFile('src/one.mjs', 300) + renamed + fuFile('src/two.mjs', 300);
    const plan = planReviewCalls(diff);
    expect([...plan.calls, ...plan.beyond].flatMap((c) => c.files)).toContain('new/name.md');
    const t = computeDiffTruncation(fuFile('src/one.mjs', 400) + fuFile('src/pad.mjs', 100) + renamed);
    expect([...t.unseenFiles, t.partialFile?.file]).toContain('new/name.md');
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
