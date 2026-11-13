/**
 * backlog.fix.ship-review-process-criteria-observed-evidence
 *
 * A criterion is judged from the evidence that can decide it: file-scope criteria from the
 * server-computed changedFiles list, test-pass criteria from an observed SHA-bound run.
 * Only genuinely undecidable uncertainty still suppresses the phase advance.
 *
 * The harness mirrors tests/unit/ship-review-observed-test-evidence.test.mjs: the reviewer LLM,
 * git (child_process), the project registry and the story note are stubbed; runReview,
 * buildReviewPrompt, buildOffRailReviewStep and resolvePhaseAdvanceSuppression are the real
 * ones. No real subprocess runs: every git call goes through the mocked child_process export.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'process-criteria-evidence-nonexistent-root');

const chatMock = vi.fn();
const spawnSyncMock = vi.fn();
const readNoteMock = vi.fn(() => null);

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

// review.mjs imports from 'child_process' (not 'node:child_process').
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawnSync: (...args) => spawnSyncMock(...args),
}));

const { buildReviewPrompt, runReview, redactReview, REVIEW_DIFF_CHAR_CAP } = await import(
  '../../packages/mcp-rks/src/server/review.mjs'
);
const { buildOffRailReviewStep, resolvePhaseAdvanceSuppression } = await import(
  '../../packages/mcp-rks/src/server/guardrails-audit.mjs'
);

const PROJECT_ID = 'routekit-shell-core';
const PROBLEM_ID = 'backlog.fix.process-criteria-fixture';
const DEFAULT_BLOCK_CATEGORIES = ['enforcement_modification', 'security_issue'];
const AC_KEYS = ['assessable', 'assessed', 'covered', 'notCovered', 'uncertain'];
const FULL_EMIT_KEYS = ['blockerCount', 'findingCount', 'findings', 'problemId', 'verdict', 'warningCount'];
const RESULT_KEYS = ['acCoverage', 'changedFiles', 'downgradeReason', 'downgradedFrom', 'findings', 'ok', 'policy', 'summary', 'verdict'];

const UNTOUCHED = 'docs/untouched.md';
const PROCESS_REQ = `[process] ${UNTOUCHED} is not modified by this story`;
const PROCESS_REQ_TESTS = '[process] Every pre-existing test in tests/unit/feature.test.mjs passes';
const PLAIN_REQ = 'feature returns 1 when called';
const UNDECIDABLE = 'The feature is documented clearly enough for a new reader';

const REVIEWED_SHA = 'abc1234def5678abc1234def5678abc1234def56';
const OTHER_SHA = '0000000000000000000000000000000000000000';
const RAN_PATHS = ['tests/unit/feature.test.mjs', 'tests/unit/other.test.mjs'];
const passing = { sha: REVIEWED_SHA, exitCode: 0, passed: 12, failed: 0, testPaths: RAN_PATHS, source: 'observed' };
const failing = { sha: REVIEWED_SHA, exitCode: 1, passed: 11, failed: 1, testPaths: RAN_PATHS, source: 'observed' };
const stale = { ...passing, sha: OTHER_SHA };

const fileDiff = (file) =>
  [
    `diff --git a/${file} b/${file}`,
    '--- a/' + file,
    '+++ b/' + file,
    '@@ -1,1 +1,2 @@',
    ' existing line',
    '+export const feature = 1;',
  ].join('\n') + '\n';

let currentFiles = ['src/feature.mjs'];
let currentHead = { stdout: `${REVIEWED_SHA}\n`, stderr: '', status: 0 };

function gitImpl(_cmd, args = []) {
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return currentHead;
  // No earlier commit for this story: partialDiff is false.
  if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
  if (args.includes('--name-only')) return { stdout: currentFiles.join('\n') + '\n', stderr: '', status: 0 };
  return { stdout: currentFiles.map(fileDiff).join(''), stderr: '', status: 0 };
}

const AC_CONTENT =
  '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n\n## Testing Requirements\n\n- a test\n';

const storyNote = (testRequirements) => ({
  title: 'A story',
  desc: 'A description',
  ...(testRequirements !== undefined ? { testRequirements } : {}),
  content: AC_CONTENT,
});

/** The identifier-tagged line for `text`, read from the prompt actually sent. */
const taggedLine = (prompt, text) => prompt.split('\n').find((l) => /^\[P\d+\] /.test(l) && l.includes(text));

/**
 * A stubbed reviewer whose uncertain entries are built from the prompt it receives:
 * `fromPrompt` names requirement texts whose tagged line is listed as uncertain;
 * `literal` adds entries verbatim.
 */
function replyFromPrompt({ fromPrompt = [], literal = [] } = {}) {
  return async (args) => {
    const prompt = args.prompt;
    const uncertain = [...fromPrompt.map((t) => taggedLine(prompt, t)).filter(Boolean), ...literal];
    return JSON.stringify({
      verdict: 'pass',
      summary: 'stubbed review',
      findings: [],
      acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: [], uncertain },
    });
  };
}

const review = (extra = {}) =>
  runReview({ projectId: PROJECT_ID, problemId: PROBLEM_ID, branch: 'staging', targetBranch: 'abc1234', ...extra });

const promptSent = () => chatMock.mock.calls.at(-1)[0].prompt;
const suppression = (result) =>
  resolvePhaseAdvanceSuppression(buildOffRailReviewStep(redactReview(result)), { blockCategories: DEFAULT_BLOCK_CATEGORIES });
const reasonOf = (s) => (s && typeof s.reason === 'string' ? s.reason : '');

const completePayloads = () =>
  ensureTelemetryStorage(FAKE_ROOT)
    .emit.mock.calls.filter(([type, , payload]) => type === 'review.complete' && payload?.problemId === PROBLEM_ID)
    .map(([, , payload]) => payload);

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockImplementation(replyFromPrompt());
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation(gitImpl);
  readNoteMock.mockReset();
  readNoteMock.mockImplementation(() => storyNote([PROCESS_REQ, PLAIN_REQ, PROCESS_REQ_TESTS]));
  currentFiles = ['src/feature.mjs'];
  currentHead = { stdout: `${REVIEWED_SHA}\n`, stderr: '', status: 0 };
  contextRoot = FAKE_ROOT;
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

// ---------------------------------------------------------------------------

describe('buildReviewPrompt Changed Files statement', () => {
  const CHANGED = ['src/feature.mjs', 'tests/unit/feature.test.mjs', 'docs/a.md'];
  const prompt = (story) =>
    buildReviewPrompt({ diff: CHANGED.map(fileDiff).join(''), story, ragContext: [], changedFiles: CHANGED });

  it('states the Changed Files list is complete and decides file-modification criteria', () => {
    const raw = prompt(storyNote());
    const block = raw.slice(raw.indexOf('## Changed Files')).split('\n\n')[0];
    expect(block).toMatch(/complete/i);
    expect(block).toMatch(/server-computed/i);
    expect(block).toMatch(/modified in the reviewed range/i);
    expect(block).toMatch(/is or is not modified/i);
    expect(block).toMatch(/judged from this list/i);
  });

  it('keeps every changed path in the first block under the Changed Files heading', () => {
    for (const story of [storyNote(), storyNote([PROCESS_REQ]), null]) {
      const raw = prompt(story);
      const block = raw.slice(raw.indexOf('## Changed Files')).split('\n\n')[0];
      for (const p of CHANGED) expect(block).toContain(p);
    }
  });

  it('carries the statement exactly once when no story is provided', () => {
    const raw = prompt(null);
    expect(raw.split('complete, server-computed set of files modified in the reviewed range')).toHaveLength(2);
    expect(raw).toContain('## Story: Not provided');
  });
});

describe('runReview changedFiles reconciliation', () => {
  it('moves a not-modified criterion for an unchanged path from uncertain to covered', async () => {
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ] }));
    const result = await review();
    expect(result.ok).toBe(true);
    const entry = taggedLine(promptSent(), PROCESS_REQ);
    expect(entry).toBeTruthy();
    expect(entry).toContain(PROCESS_REQ);
    expect(currentFiles).not.toContain(UNTOUCHED);
    expect(result.acCoverage.uncertain).not.toContain(entry);
    expect(result.acCoverage.covered).toContain(entry);
    expect(result.acCoverage.notCovered).not.toContain(entry);
  });

  it('the reconciled review does not suppress with ac_coverage_uncertain', async () => {
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ] }));
    const result = await review();
    const entry = taggedLine(promptSent(), PROCESS_REQ);
    expect(entry).toBeTruthy();
    expect(result.acCoverage.covered).toContain(entry);
    expect(result.acCoverage.uncertain).toEqual([]);
    expect(reasonOf(suppression(result))).not.toContain('ac_coverage_uncertain');
    // Positive control: the same reply with reconciliation impossible (no [process] entry rendered)
    readNoteMock.mockImplementation(() => storyNote([PLAIN_REQ]));
    chatMock.mockImplementation(replyFromPrompt({ literal: [`[P1] ${PROCESS_REQ}`] }));
    const control = await review();
    expect(reasonOf(suppression(control))).toContain('ac_coverage_uncertain');
  });

  it('reports a not-modified criterion for a changed path as notCovered, never covered', async () => {
    currentFiles = ['src/feature.mjs', UNTOUCHED];
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ] }));
    const result = await review();
    const entry = taggedLine(promptSent(), PROCESS_REQ);
    expect(entry).toBeTruthy();
    expect(result.acCoverage.notCovered).toContain(entry);
    expect(result.acCoverage.covered).not.toContain(entry);
    expect(result.acCoverage.uncertain).not.toContain(entry);
    expect(reasonOf(suppression(result))).toContain('ac_not_covered');
  });

  it('leaves an undecidable uncertain criterion uncertain and still suppresses', async () => {
    // Names no path, and the [process] test-pass entry names a test file but asserts no non-modification.
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ_TESTS], literal: [UNDECIDABLE] }));
    const result = await review();
    const testsEntry = taggedLine(promptSent(), PROCESS_REQ_TESTS);
    expect(testsEntry).toBeTruthy();
    expect(result.acCoverage.uncertain).toEqual([testsEntry, UNDECIDABLE]);
    expect(result.acCoverage.covered).not.toContain(UNDECIDABLE);
    expect(result).not.toHaveProperty('acCoverageReconciliation');
    expect(reasonOf(suppression(result))).toContain('ac_coverage_uncertain');
  });

  it('records each reconciled entry with the observation on the result and on review.complete', async () => {
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ], literal: [UNDECIDABLE] }));
    const result = await review();
    const entry = taggedLine(promptSent(), PROCESS_REQ);
    const expected = [
      {
        criterion: entry,
        requirement: PROCESS_REQ,
        identifier: 'P1',
        from: 'uncertain',
        to: 'covered',
        observation: { source: 'changedFiles', path: UNTOUCHED, inChangedFiles: false },
      },
    ];
    expect(result.acCoverageReconciliation).toEqual(expected);
    const payloads = completePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].acCoverageReconciliation).toEqual(expected);
    // The record is its own key, not inside acCoverage.
    expect(Object.keys(payloads[0].acCoverage).sort()).toEqual(AC_KEYS);

    // The changed-path direction records the observation that decided it.
    ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
    currentFiles = ['src/feature.mjs', UNTOUCHED];
    const changed = await review();
    expect(changed.acCoverageReconciliation).toEqual([
      { ...expected[0], to: 'notCovered', observation: { source: 'changedFiles', path: UNTOUCHED, inChangedFiles: true } },
    ]);
    expect(completePayloads()[0].acCoverageReconciliation).toEqual(changed.acCoverageReconciliation);
  });

  it('adds no key to the result or review.complete when nothing is reconciled', async () => {
    chatMock.mockImplementation(replyFromPrompt({ literal: [UNDECIDABLE] }));
    const result = await review();
    const diff = currentFiles.map(fileDiff).join('');
    expect(diff.length).toBeLessThan(REVIEW_DIFF_CHAR_CAP);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('reviewCalls');
    expect(Object.keys(result).sort()).toEqual(RESULT_KEYS);
    expect(Object.keys(result.acCoverage).sort()).toEqual(AC_KEYS);
    const payloads = completePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty('reviewCalls');
    expect(Object.keys(payloads[0]).sort()).toEqual([...FULL_EMIT_KEYS, 'acCoverage'].sort());
    expect(Object.keys(payloads[0].acCoverage).sort()).toEqual(AC_KEYS);
  });
});

describe('runReview observed test-run summary', () => {
  const summaryOf = (prompt) => {
    const at = prompt.indexOf('## Observed Test Run');
    return at === -1 ? null : prompt.slice(at).split('\n## ')[0];
  };

  it('renders the passing same-SHA run summary into the prompt', async () => {
    await review({ testEvidence: passing });
    const summary = summaryOf(promptSent());
    expect(summary).not.toBeNull();
    for (const p of RAN_PATHS) expect(summary).toContain(p);
    expect(summary).toContain(REVIEWED_SHA);
    expect(summary).toContain('12 passed');
    expect(summary).toContain('0 failed');
  });

  it('absent or different-SHA evidence leaves the prompt and suppression outcome byte-identical', async () => {
    chatMock.mockImplementation(replyFromPrompt({ literal: [UNDECIDABLE] }));
    const baseline = await review();
    const baselinePrompt = promptSent();
    const baselineSuppression = JSON.stringify(suppression(baseline));
    expect(summaryOf(baselinePrompt)).toBeNull();

    for (const testEvidence of [undefined, null, stale]) {
      const r = await review({ testEvidence });
      expect(promptSent()).toBe(baselinePrompt);
      expect(JSON.stringify(suppression(r))).toBe(baselineSuppression);
    }
    // Unreadable HEAD: the reviewed SHA is null and no evidence matches it.
    currentHead = { stdout: '', stderr: 'fatal', status: 128 };
    const r = await review({ testEvidence: passing });
    expect(promptSent()).toBe(baselinePrompt);
    expect(JSON.stringify(suppression(r))).toBe(baselineSuppression);
  });

  it('failing or different-SHA evidence never moves an uncertain criterion to covered', async () => {
    chatMock.mockImplementation(replyFromPrompt({ fromPrompt: [PROCESS_REQ_TESTS] }));
    for (const testEvidence of [failing, { ...passing, exitCode: 1 }, { ...passing, failed: 2 }, stale]) {
      const r = await review({ testEvidence });
      const entry = taggedLine(promptSent(), PROCESS_REQ_TESTS);
      expect(entry).toBeTruthy();
      expect(r.acCoverage.uncertain).toContain(entry);
      expect(r.acCoverage.covered).not.toContain(entry);
      expect(r).not.toHaveProperty('acCoverageReconciliation');
      expect(reasonOf(suppression(r))).toContain('ac_coverage_uncertain');
    }
  });
});

describe('buildReviewPrompt Process Requirements section', () => {
  let tmpRoot = null;
  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  const CHANGED = ['src/feature.mjs'];
  const prompt = (story) =>
    buildReviewPrompt({ diff: CHANGED.map(fileDiff).join(''), story, ragContext: [], changedFiles: CHANGED });
  const sectionOf = (raw) => {
    const at = raw.indexOf('### Process Requirements');
    return at === -1 ? null : raw.slice(at).split('\n\n')[0];
  };

  it('renders each [process] testRequirement verbatim under a stable identifier and nothing for a story without them', () => {
    const raw = prompt(storyNote([PLAIN_REQ, PROCESS_REQ, 'another plain one', PROCESS_REQ_TESTS]));
    const section = sectionOf(raw);
    expect(section).not.toBeNull();
    expect(raw.split('### Process Requirements')).toHaveLength(2);
    const lines = section.split('\n').filter((l) => /^\[P\d+\] /.test(l));
    expect(lines).toEqual([`[P1] ${PROCESS_REQ}`, `[P2] ${PROCESS_REQ_TESTS}`]);
    expect(section).not.toContain(PLAIN_REQ);
    expect(section).not.toContain('another plain one');
    // Inside the story section, after Testing Requirements.
    const story = raw.slice(raw.indexOf('## Story Being Implemented'));
    expect(story.indexOf('### Process Requirements')).toBeGreaterThan(story.indexOf('### Testing Requirements'));
    expect(raw.indexOf('### Process Requirements')).toBeLessThan(raw.indexOf('## Diff to Review'));

    const without = (() => {
      const s = storyNote([]);
      delete s.testRequirements;
      return prompt(s);
    })();
    expect(sectionOf(without)).toBeNull();
    expect(prompt(storyNote([PLAIN_REQ, 'another plain one']))).toBe(without);
    expect(prompt(storyNote([]))).toBe(without);
  });

  it('the real readNote supplies frontmatter testRequirements that reach the prompt runReview sends', async () => {
    const { readNote: realReadNote } = await vi.importActual('../../packages/mcp-rks/src/dendron.mjs');
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-criteria-evidence-'));
    fs.mkdirSync(path.join(tmpRoot, 'notes'));
    const note = [
      '---',
      `id: "${PROBLEM_ID}"`,
      'title: "A fixture story"',
      'desc: "A fixture description"',
      'testRequirements:',
      `  - "${PLAIN_REQ}"`,
      `  - "${PROCESS_REQ}"`,
      '---',
      '',
      AC_CONTENT,
    ].join('\n');
    fs.writeFileSync(path.join(tmpRoot, 'notes', `${PROBLEM_ID}.md`), note);
    readNoteMock.mockImplementation((...args) => realReadNote(...args));
    contextRoot = tmpRoot;

    const loaded = realReadNote(path.join(tmpRoot, 'notes'), PROBLEM_ID);
    expect(loaded.testRequirements).toEqual([PLAIN_REQ, PROCESS_REQ]);

    const result = await review();
    expect(result.ok).toBe(true);
    expect(readNoteMock).toHaveBeenCalledWith(path.join(tmpRoot, 'notes'), PROBLEM_ID);
    expect(promptSent()).toContain(`[P1] ${PROCESS_REQ}`);
    expect(sectionOf(promptSent())).not.toContain(PLAIN_REQ);
  });
});
