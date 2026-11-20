/**
 * backlog.fix.ship-review-ignores-observed-test-results
 *
 * Observed, SHA-bound test evidence downgrades (never deletes) LLM block findings that
 * assert a test/import/runtime failure a passing run on the same SHA already disproves.
 * The harness mirrors tests/unit/ship-review-truncated-diff.test.mjs: the reviewer LLM,
 * git (child_process spawnSync), the project registry and the story note are stubbed;
 * runReview and runOffRailEnforcementGate are the real ones. No real subprocess runs:
 * every git call goes through the spawnSync mock, and the test runner the gate calls is
 * an injected vi.fn().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'observed-test-evidence-nonexistent-root');

const chatMock = vi.fn();
const spawnSyncMock = vi.fn();
const readNoteMock = vi.fn(() => null);
const runReviewSpy = vi.fn();

let contextRoot = FAKE_ROOT;

vi.mock('../../packages/mcp-rks/src/llm/clients.mjs', () => ({
  loadEnv: vi.fn(() => ({ anthropicKey: 'test-key-not-a-real-credential' })),
  createAnthropicClient: vi.fn(() => ({ stub: true })),
  callAnthropicChat: (...args) => chatMock(...args),
  DEFAULT_LLM_TIMEOUT_MS: 30_000,
}));

vi.mock('../../packages/mcp-rks/src/server/project.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async () => ({ record: { root: contextRoot } })),
}));

vi.mock('../../packages/mcp-rks/src/dendron.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveNotesDir: vi.fn((root) => path.join(root, 'notes')),
  readNote: (...args) => readNoteMock(...args),
}));

vi.mock('@routekit/rag', () => ({ runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })) }));

// review.mjs:9 and guardrails-audit.mjs:12 import from 'child_process' (not 'node:child_process').
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: (...args) => spawnSyncMock(...args),
}));

// The gate resolves review.mjs by dynamic import; this wrapper records the arguments the
// gate hands runReview and then runs the REAL runReview.
vi.mock('../../packages/mcp-rks/src/server/review.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runReview: (...args) => {
      runReviewSpy(...args);
      return actual.runReview(...args);
    },
  };
});

const reviewMod = await import('../../packages/mcp-rks/src/server/review.mjs');
const { runReview, redactReview } = reviewMod;
// Resolved at call time, so a missing export fails the tests that use it, not the whole file.
const softenTestEvidenceContradictedFindings = (...args) => reviewMod.softenTestEvidenceContradictedFindings(...args);
const auditMod = await import('../../packages/mcp-rks/src/server/guardrails-audit.mjs');
const { buildOffRailReviewStep, blockSeverityFindingCount, resolveOffRailHalt, resolvePhaseAdvanceSuppression, runOffRailEnforcementGate } =
  auditMod;
// Resolved at call time, so a missing export fails the tests that use it, not the whole file.
const runObservedTests = (...args) => auditMod.runObservedTests(...args);
const { parseVitestJsonReport, UNAVAILABLE } = await import('../../packages/mcp-rks/src/exec/test-results.mjs');

const AUDIT_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'), 'utf8');

const REVIEWED_SHA = 'abc1234def5678abc1234def5678abc1234def56';
const OTHER_SHA = '0000000000000000000000000000000000000000';
const RAN_PATHS = ['tests/unit/plan-ready-pattern-unique.test.mjs'];
const passing = { sha: REVIEWED_SHA, exitCode: 0, passed: 12, failed: 0, testPaths: RAN_PATHS, source: 'observed' };
const failing = { sha: REVIEWED_SHA, exitCode: 1, passed: 11, failed: 1, testPaths: RAN_PATHS, source: 'observed' };
const stale = { ...passing, sha: OTHER_SHA };
const DEFAULT_BLOCK_CATEGORIES = ['enforcement_modification', 'security_issue'];
const STEP_APPLY = 'packages/mcp-rks/src/server/step-apply.mjs';

// Verbatim from the ship of backlog.fix.plan-ready-pattern-unique-indentation-and-locations.
const COUNT_OCCURRENCES_FINDING = {
  severity: 'block',
  category: 'other',
  file: 'tests/unit/plan-ready-pattern-unique.test.mjs',
  message:
    'The test imports `countOccurrences` from reviewer.mjs, but that symbol is not exported ... ' +
    'This will cause the test file to fail at import time.',
};
const DOES_NOT_THROW_FINDING = {
  severity: 'block',
  category: 'other',
  file: STEP_APPLY,
  message: 'applySearchReplace does not throw; it returns a failure object.',
};
const NO_RUNTIME_CLAIM_FINDING = {
  severity: 'block',
  category: 'other',
  file: 'tests/unit/plan-ready-pattern-unique.test.mjs',
  message: 'This change hardcodes the reviewer model name instead of reading it from policy.',
};

// ---------------------------------------------------------------------------
// Fixtures for the runReview / gate harness
// ---------------------------------------------------------------------------

let currentHead = { stdout: `${REVIEWED_SHA}\n`, stderr: '', status: 0 };
const currentDiff =
  [
    'diff --git a/src/feature.mjs b/src/feature.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/feature.mjs',
    '@@ -0,0 +1,1 @@',
    '+export const feature = 1;',
  ].join('\n') + '\n';
const currentNames = 'src/feature.mjs\n';

function gitImpl(_cmd, args = []) {
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return currentHead;
  // No earlier commit for this story: partialDiff is false.
  if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
  if (args.includes('--name-only')) return { stdout: currentNames, stderr: '', status: 0 };
  return { stdout: currentDiff, stderr: '', status: 0 };
}

const AC_COVERAGE = { assessed: true, covered: ['AC1 does a thing', 'AC2 does another'], notCovered: [], uncertain: [] };

const storyNote = (targetFiles) => ({
  title: 'A story',
  desc: 'A description',
  ...(targetFiles ? { targetFiles } : {}),
  content:
    '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n- [ ] AC2 does another\n\n' +
    '## Testing Requirements\n\n- a test\n',
});

const reply = (verdict, findings) => JSON.stringify({ verdict, summary: 'stubbed review', findings, acCoverage: AC_COVERAGE });

const review = (extra = {}) =>
  runReview({ projectId: 'routekit-shell-core', problemId: 'backlog.fix.some-story', branch: 'staging', targetBranch: 'abc1234', ...extra });

const pick = (r) => JSON.stringify({ findings: r.findings, verdict: r.verdict, downgradedFrom: r.downgradedFrom, downgradeReason: r.downgradeReason });

const revParseCalls = () => spawnSyncMock.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'rev-parse' && c[1][1] === 'HEAD');

const byFile = (r, file) => r.findings.find((f) => f.file === file);

beforeEach(() => {
  chatMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(gitImpl);
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyNote());
  runReviewSpy.mockReset();
  currentHead = { stdout: `${REVIEWED_SHA}\n`, stderr: '', status: 0 };
  contextRoot = FAKE_ROOT;
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

// ---------------------------------------------------------------------------

describe('softenTestEvidenceContradictedFindings', () => {
  const soften = (findings, opts = {}) =>
    softenTestEvidenceContradictedFindings(findings, {
      testEvidence: passing,
      reviewedSha: REVIEWED_SHA,
      patternCount: 0,
      blockCategories: DEFAULT_BLOCK_CATEGORIES,
      targetFiles: [],
      ...opts,
    });

  it('downgrades a runtime-failure block finding to warn under passing same-SHA evidence', () => {
    const [out] = soften([COUNT_OCCURRENCES_FINDING]);
    expect(out.severity).toBe('warn');
  });

  it('keeps the downgraded finding and records test_evidence_contradicted with the evidence SHA', () => {
    const input = [COUNT_OCCURRENCES_FINDING, NO_RUNTIME_CLAIM_FINDING];
    const out = soften(input);
    expect(out).toHaveLength(input.length);
    expect(out[0].category).toBe(COUNT_OCCURRENCES_FINDING.category);
    expect(out[0].file).toBe(COUNT_OCCURRENCES_FINDING.file);
    expect(out[0].message.startsWith(COUNT_OCCURRENCES_FINDING.message)).toBe(true);
    const note = out[0].message.slice(COUNT_OCCURRENCES_FINDING.message.length);
    expect(note).toMatch(/\[downgraded: test_evidence_contradicted[^\]]*\]$/);
    expect(note).toContain(REVIEWED_SHA);
    for (const p of RAN_PATHS) expect(note).toContain(p);
  });

  it('leaves a block finding with no runtime-failure claim at block', () => {
    const [out] = soften([NO_RUNTIME_CLAIM_FINDING]);
    expect(out.severity).toBe('block');
    expect(out).toBe(NO_RUNTIME_CLAIM_FINDING);
  });

  it('never softens a finding in policy blockCategories', () => {
    for (const category of DEFAULT_BLOCK_CATEGORIES) {
      const f = { ...COUNT_OCCURRENCES_FINDING, category, message: 'This will throw a TypeError at runtime when the token is missing.' };
      const [out] = soften([f]);
      expect(out.severity, category).toBe('block');
      expect(out, category).toBe(f);
    }
  });

  it('never softens a pattern finding', () => {
    const pattern = { ...COUNT_OCCURRENCES_FINDING, category: 'anti_patterns', message: 'This will fail at import time.' };
    const out = soften([pattern, COUNT_OCCURRENCES_FINDING], { patternCount: 1 });
    expect(out[0]).toBe(pattern);
    expect(out[0].severity).toBe('block');
    // Positive control: the LLM finding at index patternCount is softened.
    expect(out[1].severity).toBe('warn');
  });

  it('returns findings unchanged for absent, failing or different-SHA evidence', () => {
    const input = [COUNT_OCCURRENCES_FINDING, DOES_NOT_THROW_FINDING, NO_RUNTIME_CLAIM_FINDING];
    const cases = {
      undefined: { testEvidence: undefined },
      null: { testEvidence: null },
      nonZeroExit: { testEvidence: { ...passing, exitCode: 1 } },
      failedCount: { testEvidence: { ...passing, failed: 1 } },
      failing: { testEvidence: failing },
      differentSha: { testEvidence: stale },
      nullReviewedSha: { reviewedSha: null },
    };
    for (const [name, opts] of Object.entries(cases)) {
      const out = soften(input, { targetFiles: [STEP_APPLY], ...opts });
      expect(out, name).toHaveLength(input.length);
      out.forEach((f, i) => expect(f, `${name}[${i}]`).toBe(input[i]));
    }
  });

  it('leaves a finding on a file the run did not cover at block', () => {
    const uncovered = { ...COUNT_OCCURRENCES_FINDING, file: 'packages/mcp-rks/src/llm/reviewer.mjs' };
    const [out] = soften([uncovered], { targetFiles: [STEP_APPLY] });
    expect(out.severity).toBe('block');
    expect(out).toBe(uncovered);
  });

  it('treats a targetFiles path string as coverage', () => {
    // step-apply.mjs is not in testEvidence.testPaths; only targetFiles can cover it.
    expect(RAN_PATHS).not.toContain(STEP_APPLY);
    const [covered] = soften([DOES_NOT_THROW_FINDING], { targetFiles: [STEP_APPLY] });
    expect(covered.severity).toBe('warn');
    expect(covered.message).toMatch(/test_evidence_contradicted/);
    for (const targetFiles of [undefined, []]) {
      const [out] = soften([DOES_NOT_THROW_FINDING], { targetFiles });
      expect(out.severity).toBe('block');
    }
  });
});

// ---------------------------------------------------------------------------

describe('runReview test evidence', () => {
  beforeEach(() => {
    chatMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(gitImpl);
  });

  it('absent, failing or different-SHA evidence leaves the review byte-identical', async () => {
    readNoteMock.mockImplementation(() => storyNote([{ path: STEP_APPLY, op: 'edit' }]));
    chatMock.mockResolvedValue(reply('block', [COUNT_OCCURRENCES_FINDING, DOES_NOT_THROW_FINDING]));
    const baseline = pick(await review());
    // Positive control: the baseline does carry block findings that passing evidence would soften.
    expect(JSON.parse(baseline).findings.filter((f) => f.severity === 'block')).toHaveLength(2);
    for (const [name, testEvidence] of Object.entries({ undefined: undefined, null: null, failing, stale })) {
      expect(pick(await review({ testEvidence })), name).toBe(baseline);
    }
  });

  it('replays the countOccurrences block finding without halt or phase-advance suppression', async () => {
    chatMock.mockResolvedValue(reply('warn', [COUNT_OCCURRENCES_FINDING]));
    const result = await review({ testEvidence: passing });
    expect(byFile(result, COUNT_OCCURRENCES_FINDING.file).severity).toBe('warn');

    const reviewStep = buildOffRailReviewStep(redactReview(result));
    expect(blockSeverityFindingCount(reviewStep)).toBe(0);
    const halt = resolveOffRailHalt({ posture: 'block', reviewStep, scopeStep: { ok: true }, overrideApplied: false });
    expect(halt).not.toBe('review_block');
    expect(halt).toBeNull();
    const suppression = resolvePhaseAdvanceSuppression(reviewStep, {
      advanceOnUnassessedAC: false,
      blockCategories: DEFAULT_BLOCK_CATEGORIES,
    });
    expect(suppression?.reason ?? '').not.toMatch(/block_severity_finding/);
  });

  it('downgrades the applySearchReplace does-not-throw block finding', async () => {
    readNoteMock.mockImplementation(() => storyNote([{ path: STEP_APPLY, op: 'edit' }]));
    chatMock.mockResolvedValue(reply('warn', [DOES_NOT_THROW_FINDING]));
    const result = await review({ testEvidence: passing });
    const f = byFile(result, STEP_APPLY);
    expect(f.severity).toBe('warn');
    expect(f.message).toMatch(/\[downgraded: test_evidence_contradicted/);
  });

  it('caps a block verdict that rested only on contradicted findings', async () => {
    // verdictMode 'block' so the verdict is not already softened by policy.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-evidence-policy-'));
    try {
      fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rks', 'review-policy.yaml'), 'verdictMode: block\n');
      contextRoot = root;
      chatMock.mockResolvedValue(reply('block', [COUNT_OCCURRENCES_FINDING]));
      const without = await review();
      // Positive control: without evidence the verdict stays block.
      expect(without.verdict).toBe('block');
      const result = await review({ testEvidence: passing });
      expect(result.verdict).toBe('warn');
      expect(result.downgradedFrom).toBe('block');
      expect(result.downgradeReason).toMatch(/test_evidence_contradicted/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('review.complete telemetry counts the contradicted finding as a warning', async () => {
    chatMock.mockResolvedValue(reply('warn', [COUNT_OCCURRENCES_FINDING]));
    const emitted = () =>
      ensureTelemetryStorage(FAKE_ROOT)
        .emit.mock.calls.filter((c) => c[0] === 'review.complete' && c[2]?.problemId === 'backlog.fix.some-story')
        .map((c) => c[2]);
    // Baseline without evidence: the same reply, the finding counted as a blocker.
    await review();
    const [base] = emitted();
    expect(base.blockerCount).toBe(1);
    ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();

    await review({ testEvidence: passing });
    const payloads = emitted();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].findingCount).toBe(base.findingCount);
    expect(payloads[0].blockerCount).toBe(0);
    expect(payloads[0].warningCount).toBe(base.warningCount + 1);
    const recorded = payloads[0].findings.find((f) => f.file === COUNT_OCCURRENCES_FINDING.file);
    expect(recorded.severity).toBe('warn');
    expect(recorded.message).toMatch(/test_evidence_contradicted/);
  });

  it('reads HEAD itself with a timeout of at least 120000 ms', async () => {
    chatMock.mockResolvedValue(reply('warn', [COUNT_OCCURRENCES_FINDING]));
    const result = await review({ testEvidence: passing });
    const calls = revParseCalls();
    expect(calls).toHaveLength(1);
    const [cmd, args, opts] = calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['rev-parse', 'HEAD']);
    expect(opts.cwd).toBe(FAKE_ROOT);
    expect(typeof opts.timeout).toBe('number');
    expect(opts.timeout).toBeGreaterThanOrEqual(120000);
    // The trimmed stdout ('<sha>\n' -> '<sha>') is the reviewed SHA: same-SHA evidence softens.
    expect(byFile(result, COUNT_OCCURRENCES_FINDING.file).severity).toBe('warn');
  });

  it('softens nothing when evidence sha differs from its own HEAD reading', async () => {
    chatMock.mockResolvedValue(reply('block', [COUNT_OCCURRENCES_FINDING]));
    const baseline = pick(await review());
    // HEAD reads OTHER_SHA; the forwarded evidence names REVIEWED_SHA.
    currentHead = { stdout: `${OTHER_SHA}\n`, stderr: '', status: 0 };
    const result = await review({ testEvidence: passing });
    expect(revParseCalls()).toHaveLength(1);
    expect(pick(result)).toBe(baseline);
  });

  it('softens nothing when its HEAD read fails', async () => {
    chatMock.mockResolvedValue(reply('block', [COUNT_OCCURRENCES_FINDING]));
    const baseline = pick(await review());
    const bad = {
      error: { head: { stdout: '', stderr: '', status: null, error: new Error('spawn git ENOENT') }, evidence: passing },
      nonZero: { head: { stdout: `${REVIEWED_SHA}\n`, stderr: 'fatal', status: 128 }, evidence: passing },
      notHex: { head: { stdout: 'not-a-sha\n', stderr: '', status: 0 }, evidence: { ...passing, sha: 'not-a-sha' } },
      shortSha: { head: { stdout: 'abc1234\n', stderr: '', status: 0 }, evidence: { ...passing, sha: 'abc1234' } },
    };
    for (const [name, { head, evidence }] of Object.entries(bad)) {
      currentHead = head;
      expect(pick(await review({ testEvidence: evidence })), name).toBe(baseline);
    }
  });

  it('makes no rev-parse spawn without testEvidence', async () => {
    chatMock.mockResolvedValue(reply('block', [COUNT_OCCURRENCES_FINDING]));
    await review();
    expect(spawnSyncMock).toHaveBeenCalled(); // positive control: the git mock is the seat
    expect(revParseCalls()).toHaveLength(0);
  });

  it('derives targetFiles path strings from the loaded story', async () => {
    const OTHER_TARGET = 'packages/mcp-rks/src/server/other-target.mjs';
    readNoteMock.mockImplementation(() => storyNote([{ path: OTHER_TARGET, op: 'edit' }, STEP_APPLY]));
    const objectEntryFinding = { ...DOES_NOT_THROW_FINDING, file: OTHER_TARGET, message: 'This will fail at runtime with a TypeError.' };
    chatMock.mockResolvedValue(reply('warn', [DOES_NOT_THROW_FINDING, objectEntryFinding]));
    const result = await review({ testEvidence: passing });
    expect(byFile(result, STEP_APPLY).severity).toBe('warn'); // bare string entry
    expect(byFile(result, OTHER_TARGET).severity).toBe('warn'); // { path } entry
    // Converse: no story targetFiles, no coverage for either.
    readNoteMock.mockImplementation(() => storyNote());
    const without = await review({ testEvidence: passing });
    expect(byFile(without, STEP_APPLY).severity).toBe('block');
    expect(byFile(without, OTHER_TARGET).severity).toBe('block');
  });
});

// ---------------------------------------------------------------------------

/** The `{ ... }` argument text that follows `opener`, brace-balanced. */
function argObject(src, opener) {
  const start = src.indexOf(opener);
  if (start === -1) return '';
  let i = start + opener.length - 1; // the opening brace
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

describe('runOffRailEnforcementGate test evidence', () => {
  const STORY_ID = 'backlog.fix.some-story';
  const TEST_FILES = ['tests/unit/a-witness.test.mjs', 'tests/unit/b-witness.test.mjs'];
  let roots = [];

  beforeEach(() => {
    chatMock.mockResolvedValue(reply('pass', []));
  });
  afterEach(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots = [];
  });

  /** A temp project root whose notes/<STORY_ID>.md carries the given frontmatter testFiles. */
  function makeRoot({ testFiles = TEST_FILES, note = true, policy = null } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-evidence-gate-'));
    roots.push(root);
    if (note) {
      fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
      // testFiles null: the key is absent; [] : present and empty.
      const fm =
        testFiles === null
          ? ''
          : testFiles.length === 0
            ? 'testFiles: []\n'
            : `testFiles:\n${testFiles.map((t) => `  - ${t}`).join('\n')}\n`;
      fs.writeFileSync(path.join(root, 'notes', `${STORY_ID}.md`), `---\nid: "${STORY_ID}"\n${fm}---\n\nbody\n`);
    }
    if (policy) {
      fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rks', 'review-policy.yaml'), policy);
    }
    return root;
  }

  const gate = (projectRoot, extra = {}) =>
    runOffRailEnforcementGate({
      projectRoot,
      projectId: 'routekit-shell-core',
      activeSession: { problemId: STORY_ID, branch: 'staging', headCommit: 'abc1234' },
      changedFiles: ['src/feature.mjs'],
      allowedFiles: [],
      gate: 'gate_beta',
      override: null,
      ...extra,
    });

  const forwarded = () => {
    expect(runReviewSpy).toHaveBeenCalledTimes(1);
    return runReviewSpy.mock.calls[0][0];
  };

  const nonGitSpawns = () => spawnSyncMock.mock.calls.filter((c) => c[0] !== 'git');

  it('forwards an observed SHA-bound run to runReview', async () => {
    const root = makeRoot();
    const runner = vi.fn(() => ({ passed: 12, failed: 0, exitCode: 0, skipped: false }));
    await gate(root, { runner });
    expect(forwarded().testEvidence).toEqual({
      sha: REVIEWED_SHA,
      exitCode: 0,
      passed: 12,
      failed: 0,
      testPaths: TEST_FILES,
      source: 'observed',
    });
  });

  it('never forwards a caller-supplied test claim', async () => {
    const root = makeRoot();
    await gate(root, { testEvidence: passing, testResults: 'tests passed', testsPassed: 'tests passed' });
    const args = forwarded();
    expect('testEvidence' in args).toBe(false);
    expect(JSON.stringify(args)).not.toContain('tests passed');
  });

  it('gate alpha call passes no runner', () => {
    const alpha = argObject(AUDIT_SRC, 'const gateAlpha = await runOffRailEnforcementGate({');
    expect(alpha).toContain('gate: "gate_alpha"');
    expect(alpha).not.toMatch(/\brunner\b/);
    expect(alpha).not.toMatch(/\brunProjectTests\b/);
    expect(alpha).not.toMatch(/\btestEvidence\b/);
  });

  it('gate beta call passes runProjectTests as the runner', () => {
    const beta = argObject(AUDIT_SRC, 'const gateBeta = await runOffRailEnforcementGate({');
    expect(beta).toContain('gate: "gate_beta"');
    // The runner is runObservedTests: runProjectTests with per-test result collection, so the
    // run yields numeric counts (runProjectTests alone returns a boolean passed and no failed).
    expect(beta).toMatch(/\brunner: runObservedTests\b/);
    expect(beta).not.toMatch(/\brunner: runProjectTests\b/);
    // runObservedTests defaults to the real command-runner export.
    expect(AUDIT_SRC).toMatch(/export function runObservedTests\([^)]*\{ runTests = runProjectTests \} = \{\}\)/);
    expect(AUDIT_SRC).toMatch(/import \{[^}]*\brunProjectTests\b[^}]*\} from "\.\.\/exec\/command-runner\.mjs";/);
  });

  it('forwards no evidence when no observed run exists for HEAD', async () => {
    const root = makeRoot();
    await gate(root); // gate_beta, no runner injected
    expect('testEvidence' in forwarded()).toBe(false);
    expect(nonGitSpawns()).toHaveLength(0);
    expect(spawnSyncMock.mock.calls.some((c) => JSON.stringify(c).includes('vitest'))).toBe(false);

    // With a runner but an unreadable HEAD: nothing is observed for HEAD, so no evidence.
    runReviewSpy.mockReset();
    currentHead = { stdout: '', stderr: 'fatal', status: 128 };
    const runner = vi.fn(() => ({ passed: 12, failed: 0, exitCode: 0 }));
    await gate(root, { runner });
    expect('testEvidence' in forwarded()).toBe(false);
  });

  it('calls the runner once with story testFiles and a timeout of at least 120000 ms', async () => {
    const root = makeRoot();
    const runner = vi.fn(() => ({ passed: 3, failed: 0, exitCode: 0 }));
    await gate(root, { runner });
    expect(runner).toHaveBeenCalledTimes(1);
    const [rootArg, opts] = runner.mock.calls[0];
    expect(rootArg).toBe(root);
    expect(Object.keys(opts).sort()).toEqual(['testPaths', 'timeout']);
    expect(opts.testPaths).toEqual(TEST_FILES);
    expect(typeof opts.timeout).toBe('number');
    expect(opts.timeout).toBeGreaterThanOrEqual(120000);
  });

  it('reads HEAD before invoking the runner', async () => {
    const root = makeRoot();
    const runner = vi.fn(() => ({ passed: 3, failed: 0, exitCode: 0 }));
    await gate(root, { runner });
    const order = spawnSyncMock.mock.calls
      .map((c, i) => ({ c, order: spawnSyncMock.mock.invocationCallOrder[i] }))
      .filter(({ c }) => c[0] === 'git' && c[1]?.[0] === 'rev-parse' && c[1]?.[1] === 'HEAD' && c[2]?.cwd === root);
    expect(order.length).toBeGreaterThanOrEqual(1);
    expect(order[0].order).toBeLessThan(runner.mock.invocationCallOrder[0]);
  });

  it('forwards no evidence for missing testFiles or an unusable runner result', async () => {
    const noRunCases = {
      noStory: makeRoot({ note: false }),
      testFilesMissing: makeRoot({ testFiles: null }),
      testFilesEmpty: makeRoot({ testFiles: [] }),
    };
    for (const [name, root] of Object.entries(noRunCases)) {
      runReviewSpy.mockReset();
      const runner = vi.fn(() => ({ passed: 3, failed: 0, exitCode: 0 }));
      await gate(root, { runner });
      expect(runner, name).not.toHaveBeenCalled();
      expect('testEvidence' in forwarded(), name).toBe(false);
    }

    const root = makeRoot();
    const unusable = {
      throws: () => {
        throw new Error('runner exploded');
      },
      nonObjectString: () => 'tests passed',
      nonObjectNull: () => null,
      skipped: () => ({ passed: true, skipped: true, reason: 'no test runner detected' }),
      booleanCounts: () => ({ passed: true, exitCode: 0, summary: 'all tests passed' }),
      missingFailed: () => ({ passed: 3, exitCode: 0 }),
    };
    for (const [name, impl] of Object.entries(unusable)) {
      runReviewSpy.mockReset();
      const runner = vi.fn(impl);
      await gate(root, { runner });
      expect(runner, name).toHaveBeenCalledTimes(1);
      expect('testEvidence' in forwarded(), name).toBe(false);
    }
  });

  it('does not invoke the runner when the review is skipped', async () => {
    const runner = vi.fn(() => ({ passed: 3, failed: 0, exitCode: 0 }));
    const disabled = await gate(makeRoot({ policy: 'enabled: false\n' }), { runner });
    expect(disabled.steps[0]).toMatchObject({ skipped: true, reason: 'policy_disabled' });
    const noContext = await gate(makeRoot(), { runner, projectId: 'unknown' });
    expect(noContext.steps[0]).toMatchObject({ skipped: true, reason: 'no_project_context' });
    expect(runner).not.toHaveBeenCalled();
    expect(runReviewSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('runObservedTests — gate beta runner yields numeric counts', () => {
  const ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'observed-tests-adapter-root');
  const TEST_PATHS = ['tests/unit/a-witness.test.mjs'];

  // The real vitest JSON report shape, parsed by the real parser runProjectTests uses.
  const vitestReport = (statuses) => ({
    testResults: [
      {
        name: 'tests/unit/a-witness.test.mjs',
        status: statuses.includes('failed') ? 'failed' : 'passed',
        assertionResults: statuses.map((status, i) => ({ ancestorTitles: ['suite'], title: `t${i}`, status })),
      },
    ],
  });
  // The shape spawnTestRun returns when collectTestResults is set.
  const runResult = ({ exitCode, testResults }) => ({
    passed: exitCode === 0,
    skipped: false,
    output: 'vitest output',
    summary: exitCode === 0 ? 'all tests passed' : 'tests failed',
    exitCode,
    spawnError: null,
    executedCount: null,
    command: { cmd: 'node', args: ['scripts/vitest-runner.mjs'] },
    testResults,
  });

  it('runs the paths with per-test collection and returns integer counts from the report', () => {
    const runTests = vi.fn(() => runResult({ exitCode: 0, testResults: parseVitestJsonReport(vitestReport(['passed', 'passed', 'passed']), ROOT) }));
    const out = runObservedTests(ROOT, { testPaths: TEST_PATHS, timeout: 300000 }, { runTests });
    expect(runTests).toHaveBeenCalledTimes(1);
    const [rootArg, opts] = runTests.mock.calls[0];
    expect(rootArg).toBe(ROOT);
    expect(opts.testPaths).toEqual(TEST_PATHS);
    expect(opts.timeout).toBe(300000);
    expect(opts.collectTestResults).toBeTruthy();
    expect(out).toMatchObject({ exitCode: 0, passed: 3, failed: 0 });
    expect(Number.isInteger(out.passed) && Number.isInteger(out.failed)).toBe(true);

    const red = vi.fn(() => runResult({ exitCode: 1, testResults: parseVitestJsonReport(vitestReport(['passed', 'failed']), ROOT) }));
    expect(runObservedTests(ROOT, { testPaths: TEST_PATHS, timeout: 300000 }, { runTests: red })).toMatchObject({ exitCode: 1, passed: 1, failed: 1 });
  });

  it('returns no counts when the per-test results are unavailable or contradict the run', () => {
    const cases = {
      reportMissing: runResult({ exitCode: 0, testResults: { ...UNAVAILABLE('report_missing'), runner: 'vitest' } }),
      noTestResults: runResult({ exitCode: 0, testResults: undefined }),
      skipped: { passed: true, skipped: true, reason: 'no test runner detected' },
      noTestsFound: { ...runResult({ exitCode: 0, testResults: parseVitestJsonReport(vitestReport([]), ROOT) }), passed: false, noTestsFound: true },
      verdictDisagrees: runResult({ exitCode: 1, testResults: parseVitestJsonReport(vitestReport(['passed']), ROOT) }),
    };
    for (const [name, result] of Object.entries(cases)) {
      const out = runObservedTests(ROOT, { testPaths: TEST_PATHS, timeout: 300000 }, { runTests: () => result });
      expect('passed' in out, name).toBe(false);
      expect('failed' in out, name).toBe(false);
    }
  });

  it('through the gate, a real-shape passing run becomes forwarded evidence; an unavailable one does not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observed-evidence-adapter-gate-'));
    try {
      fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(root, 'notes', 'backlog.fix.some-story.md'), `---\nid: "backlog.fix.some-story"\ntestFiles:\n  - ${TEST_PATHS[0]}\n---\n\nbody\n`);
      chatMock.mockResolvedValue(reply('pass', []));
      const callGate = (underlying) =>
        runOffRailEnforcementGate({
          projectRoot: root,
          projectId: 'routekit-shell-core',
          activeSession: { problemId: 'backlog.fix.some-story', branch: 'staging', headCommit: 'abc1234' },
          changedFiles: ['src/feature.mjs'],
          allowedFiles: [],
          gate: 'gate_beta',
          override: null,
          runner: (r, opts) => runObservedTests(r, opts, { runTests: () => underlying }),
        });

      await callGate(runResult({ exitCode: 0, testResults: parseVitestJsonReport(vitestReport(['passed', 'passed']), root) }));
      expect(runReviewSpy.mock.calls[0][0].testEvidence).toEqual({
        sha: REVIEWED_SHA, exitCode: 0, passed: 2, failed: 0, testPaths: TEST_PATHS, source: 'observed',
      });

      runReviewSpy.mockReset();
      await callGate(runResult({ exitCode: 0, testResults: { ...UNAVAILABLE('report_missing'), runner: 'vitest' } }));
      expect('testEvidence' in runReviewSpy.mock.calls[0][0]).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
