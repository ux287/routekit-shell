// backlog.feat.exec-plan-commit-linkage — AC15: ship review omits .rks/plans/<runId>.json diff sections.
// Modeled on tests/unit/ship-review-lockfile-omission.test.mjs (same mock wiring).
// This file must contain no spawn-family call (unit-tier purity guard).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'plan-archive-omission-nonexistent-root');

const chatMock = vi.fn();
let currentDiff = '';
let currentNames = '';

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
  readNote: vi.fn(() => ({
    title: 'A story',
    desc: 'A description',
    content: '# A story\n\n## Acceptance Criteria\n\n- [ ] AC1 does a thing\n\n## Testing Requirements\n\n- a test\n',
  })),
}));
vi.mock('@routekit/rag', () => ({ runRagQuery: vi.fn(async () => ({ ok: false, matches: [] })) }));
vi.mock('child_process', () => {
  const impl = (_cmd, args = []) => {
    if (args[0] === 'log') return { stdout: '', stderr: '', status: 0 };
    if (args.includes('--name-only')) return { stdout: currentNames, stderr: '', status: 0 };
    return { stdout: currentDiff, stderr: '', status: 0 };
  };
  return { spawnSync: impl, default: { spawnSync: impl } };
});

const { runReview, filterPlanArchivesFromDiff, PLAN_ARCHIVE_PATH_RE, REVIEW_DIFF_CHAR_CAP, buildReviewPrompt } =
  await import('../../packages/mcp-rks/src/server/review.mjs');

/** One file section, in the shape `git diff --unified=5` emits. */
const section = (file, added) =>
  [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${added.length + 1} @@`,
    ' unchanged',
    ...added.map((l) => `+${l}`),
  ].join('\n') + '\n';

/** A deleted-file section: the b-side is /dev/null. */
const deletedSection = (file) =>
  [
    `diff --git a/${file} b/${file}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${file}`,
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-ARCHIVE_DELETED_CONTENT',
  ].join('\n') + '\n';

const RUN_ID = 'run-20261024-abc';
const ARCHIVE_PATH = `.rks/plans/${RUN_ID}.json`;
const bigArchive = (file = ARCHIVE_PATH) =>
  section(file, Array.from({ length: 2000 }, (_, i) => `    { "step": ${i}, "content": "ARCHIVEONLY_TOKEN_${i}" },`));
const SRC = section('src/app.mjs', ['export const SRC_MARKER_LATE = 1;']);
const TEST = section('tests/unit/app.test.mjs', ['// TEST_MARKER_LATE']);
const LOCK = section('package-lock.json', ['LOCKONLY_TOKEN']);

const MODEL_REPLY = {
  verdict: 'pass',
  summary: 'ok',
  findings: [],
  acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: [], uncertain: [] },
};

/** The raw prompt string: callReviewer passes { client, model, prompt, signal }. */
const rawPrompt = () => chatMock.mock.calls.at(-1)[0].prompt;
const promptSent = () => JSON.stringify(chatMock.mock.calls.at(-1));
const occurrences = (s, needle) => s.split(needle).length - 1;

const run = (diff, names) => {
  currentDiff = diff;
  currentNames = names.join('\n') + '\n';
  return runReview({
    projectId: 'routekit-shell-core',
    problemId: 'backlog.feat.some-story',
    branch: 'staging',
    targetBranch: 'staging',
  });
};

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue(JSON.stringify(MODEL_REPLY));
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

describe('filterPlanArchivesFromDiff (pure)', () => {
  it('removes an added .rks/plans/<runId>.json section between two src sections, keeps others verbatim and in order', () => {
    const SRC_A = section('src/a.mjs', ['A_MARKER']);
    const SRC_B = section('src/b.mjs', ['B_MARKER']);
    const archive = section('.rks/plans/run-a.json', ['"ARCHIVE_A"']);
    const input = SRC_A + archive + SRC_B;
    const out = filterPlanArchivesFromDiff(input);
    expect(out.diff).toBe(SRC_A + SRC_B);
    expect(out.diff).not.toContain('run-a.json');
    expect(out.omittedPlanArchives).toEqual([{ path: '.rks/plans/run-a.json', chars: archive.length }]);
    expect(out.diff.length + out.omittedPlanArchives.reduce((n, o) => n + o.chars, 0)).toBe(input.length);
  });

  it('omits a deleted archive section, named by its a-side path', () => {
    const del = deletedSection('.rks/plans/run-d.json');
    const input = SRC + del;
    const out = filterPlanArchivesFromDiff(input);
    expect(out.diff).toBe(SRC);
    expect(out.omittedPlanArchives).toEqual([{ path: '.rks/plans/run-d.json', chars: del.length }]);
  });

  it('keeps .rks/plans/sub/x.json, docs/.rks/plans/x.json, .rks/plans/x.yaml and .rks/planning.json', () => {
    const input =
      section('.rks/plans/sub/x.json', ['KEEP_1']) +
      section('docs/.rks/plans/x.json', ['KEEP_2']) +
      section('.rks/plans/x.yaml', ['KEEP_3']) +
      section('.rks/planning.json', ['KEEP_4']);
    const out = filterPlanArchivesFromDiff(input);
    expect(out.diff).toBe(input);
    expect(out.omittedPlanArchives).toEqual([]);
  });

  it('returns a no-archive diff, a headerless diff and an empty string strictly unchanged with omittedPlanArchives []', () => {
    for (const input of [SRC + TEST, '+function hello() {}', '']) {
      const out = filterPlanArchivesFromDiff(input);
      expect(out.diff).toBe(input);
      expect(out.omittedPlanArchives).toEqual([]);
    }
  });

  it('PLAN_ARCHIVE_PATH_RE matches .rks/plans/run-x.json and none of the non-match paths', () => {
    expect(PLAN_ARCHIVE_PATH_RE).toBeInstanceOf(RegExp);
    expect(PLAN_ARCHIVE_PATH_RE.test('.rks/plans/run-x.json')).toBe(true);
    for (const p of ['.rks/plans/sub/x.json', 'docs/.rks/plans/x.json', '.rks/plans/x.yaml', '.rks/planning.json']) {
      expect(PLAN_ARCHIVE_PATH_RE.test(p), p).toBe(false);
    }
  });
});

describe('buildReviewPrompt — omittedPlanArchives is optional', () => {
  it('absent and empty both leave the prompt identical to the call without the parameter', () => {
    const base = { diff: SRC + TEST, story: null, ragContext: [], changedFiles: ['src/app.mjs', 'tests/unit/app.test.mjs'] };
    const without = buildReviewPrompt(base);
    expect(buildReviewPrompt({ ...base, omittedPlanArchives: undefined })).toBe(without);
    expect(buildReviewPrompt({ ...base, omittedPlanArchives: [] })).toBe(without);
    expect(without).not.toContain('PLAN ARCHIVE DIFFS OMITTED');
    // Positive control: a non-empty list does change the prompt.
    expect(buildReviewPrompt({ ...base, omittedPlanArchives: [{ path: ARCHIVE_PATH, chars: 10 }] })).toContain('PLAN ARCHIVE DIFFS OMITTED');
  });
});

describe('runReview omits plan archives from the prompt diff', () => {
  it('REPRODUCTION: a >REVIEW_DIFF_CHAR_CAP archive section ahead of src/ and tests/ leaves both markers in the prompt, not the archive content, one notice naming the path, Changed Files still listing it, and no diffTruncation', async () => {
    const archive = bigArchive();
    expect(archive.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    const result = await run(archive + SRC + TEST, [ARCHIVE_PATH, 'src/app.mjs', 'tests/unit/app.test.mjs']);
    expect(result.ok).toBe(true);
    const prompt = promptSent();
    expect(prompt).toContain('SRC_MARKER_LATE');
    expect(prompt).toContain('TEST_MARKER_LATE');
    expect(prompt).not.toContain('ARCHIVEONLY_TOKEN_');
    const raw = rawPrompt();
    expect(occurrences(raw, 'PLAN ARCHIVE DIFFS OMITTED')).toBe(1);
    const notice = raw.slice(raw.indexOf('PLAN ARCHIVE DIFFS OMITTED')).split('\n\n')[0];
    expect(notice).toContain(ARCHIVE_PATH);
    expect(raw.slice(raw.indexOf('## Changed Files')).split('\n\n')[0]).toContain(ARCHIVE_PATH);
    expect(result.diffTruncation ?? null).toBeNull();
    expect(raw).not.toContain('DIFF TRUNCATED');
    expect(result.planArchiveOmission).toEqual({ paths: [ARCHIVE_PATH], omittedChars: archive.length });
  });

  it('a filtered diff still over the cap never names the archive in unseenFiles or partialFile', async () => {
    const archive = bigArchive();
    const bigSrc = section('src/big.mjs', Array.from({ length: 2500 }, (_, i) => `export const BIG_SRC_${i} = ${i};`));
    expect(bigSrc.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    const result = await run(archive + bigSrc + TEST, [ARCHIVE_PATH, 'src/big.mjs', 'tests/unit/app.test.mjs']);
    const t = result.diffTruncation;
    expect(t).toBeTruthy();
    expect(t.truncated).toBe(true);
    expect(t.originalChars).toBe((bigSrc + TEST).length);
    expect(t.unseenFiles).toContain('tests/unit/app.test.mjs');
    expect(t.unseenFiles).not.toContain(ARCHIVE_PATH);
    expect(t.partialFile?.file).not.toBe(ARCHIVE_PATH);
    expect(t.partialFile?.file).toBe('src/big.mjs');
  });

  it('a lockfile plus an archive yields both notices once each, lockfileOmission and planArchiveOmission each naming only its own paths', async () => {
    const archive = section(ARCHIVE_PATH, ['"ARCHIVE_SMALL"']);
    const result = await run(archive + LOCK + SRC, [ARCHIVE_PATH, 'package-lock.json', 'src/app.mjs']);
    const raw = rawPrompt();
    expect(occurrences(raw, 'LOCKFILE DIFFS OMITTED')).toBe(1);
    expect(occurrences(raw, 'PLAN ARCHIVE DIFFS OMITTED')).toBe(1);
    expect(result.lockfileOmission.paths).toEqual(['package-lock.json']);
    expect(result.planArchiveOmission.paths).toEqual([ARCHIVE_PATH]);
    expect(result.planArchiveOmission.omittedChars).toBe(archive.length);
  });

  it('a secret inside an archive section is still a security_issue pattern finding', async () => {
    const secretLine = 'pass' + 'word = "x-not-a-real-credential"';
    const archive = section(ARCHIVE_PATH, [secretLine]);
    const result = await run(archive + SRC, [ARCHIVE_PATH, 'src/app.mjs']);
    const sec = result.findings.filter((f) => f.category === 'security_issue' && f.file === ARCHIVE_PATH);
    expect(sec.length).toBeGreaterThan(0);
    expect(promptSent()).not.toContain('x-not-a-real-credential');
  });
});

describe('telemetry R9 — review.prompt.assembled records the plan-archive omission', () => {
  const assembled = () =>
    ensureTelemetryStorage(FAKE_ROOT)
      .emit.mock.calls.filter((c) => c[0] === 'review.prompt.assembled')
      .map((c) => c[2]);

  it('carries planArchiveOmission equal to the result, and diffBytes of the UNFILTERED diff', async () => {
    const archive = bigArchive();
    const raw = archive + SRC + TEST;
    const result = await run(raw, [ARCHIVE_PATH, 'src/app.mjs', 'tests/unit/app.test.mjs']);
    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].planArchiveOmission).toEqual(result.planArchiveOmission);
    expect(payloads[0].planArchiveOmission).toEqual({ paths: [ARCHIVE_PATH], omittedChars: archive.length });
    expect(payloads[0].diffBytes).toBe(raw.length);
  });

  it('has no planArchiveOmission key on the payload or the result, and no notice, when nothing was omitted', async () => {
    const result = await run(SRC + TEST, ['src/app.mjs', 'tests/unit/app.test.mjs']);
    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect('planArchiveOmission' in payloads[0]).toBe(false);
    expect(result).not.toHaveProperty('planArchiveOmission');
    expect(rawPrompt()).not.toContain('PLAN ARCHIVE DIFFS OMITTED');
  });
});
