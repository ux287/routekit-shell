/**
 * Tests for backlog.fix.ship-review-lockfile-crowds-out-diff.
 *
 * A lockfile diff at the head of the branch diff used to fill the 50,000-character
 * prompt window, so the reviewer never saw src/ and tests/ and reported them absent.
 * Lockfile sections are now omitted from the PROMPT diff only, and disclosed.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTelemetryStorage } from '@routekit/telemetry';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const FAKE_ROOT = path.join(REPO_ROOT, 'tests', '.tmp', 'lockfile-omission-nonexistent-root');

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

const { runReview, filterLockfilesFromDiff, LOCKFILE_BASENAMES, REVIEW_DIFF_CHAR_CAP } =
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

const bigLock = (file = 'package-lock.json') =>
  section(
    file,
    Array.from({ length: 2000 }, (_, i) => `    "node_modules/LOCKONLY_TOKEN_${i}": { "version": "1.0.${i}" },`),
  );
const SRC = section('src/app.mjs', ['export const SRC_MARKER_LATE = 1;']);
const TEST = section('tests/unit/app.test.mjs', ['// TEST_MARKER_LATE']);

const MODEL_REPLY = {
  verdict: 'pass',
  summary: 'ok',
  findings: [],
  acCoverage: { assessed: true, covered: ['AC1 does a thing'], notCovered: [], uncertain: [] },
};

const promptSent = () => JSON.stringify(chatMock.mock.calls.at(-1));
/** The raw prompt string: callReviewer passes { client, model, prompt, signal }. */
const rawPrompt = () => chatMock.mock.calls.at(-1)[0].prompt;

const run = (diff, names) => {
  currentDiff = diff;
  currentNames = names.join('\n') + '\n';
  return runReview({
    projectId: 'routekit-shell-core',
    problemId: 'backlog.fix.some-story',
    branch: 'staging',
    targetBranch: 'staging',
  });
};

beforeEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue(JSON.stringify(MODEL_REPLY));
  ensureTelemetryStorage(FAKE_ROOT).emit.mockClear();
});

describe('LOCKFILE_BASENAMES', () => {
  it('is one frozen array holding the JS-ecosystem lockfiles', () => {
    expect(Object.isFrozen(LOCKFILE_BASENAMES)).toBe(true);
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']) {
      expect(LOCKFILE_BASENAMES).toContain(name);
    }
  });
});

describe('filterLockfilesFromDiff', () => {
  it('removes lockfile sections at any depth and keeps source sections in order', () => {
    const lockA = bigLock();
    const lockB = section('packages/x/package-lock.json', ['LOCKONLY_NESTED']);
    const lockC = section('apps/web/yarn.lock', ['LOCKONLY_YARN']);
    const input = lockA + lockB + SRC + lockC + TEST;
    const out = filterLockfilesFromDiff(input);
    expect(out.diff).toBe(SRC + TEST);
    expect(out.diff).not.toContain('LOCKONLY');
    expect(out.omittedLockfiles.map((o) => o.path)).toEqual([
      'package-lock.json',
      'packages/x/package-lock.json',
      'apps/web/yarn.lock',
    ]);
    expect(out.omittedLockfiles.map((o) => o.chars)).toEqual([lockA.length, lockB.length, lockC.length]);
    const omitted = out.omittedLockfiles.reduce((n, o) => n + o.chars, 0);
    expect(out.diff.length + omitted).toBe(input.length);
  });

  it('does not omit a file whose name merely contains lock', () => {
    const input =
      section('src/lock.ts', ['KEEP_1']) +
      section('src/package-lock.json.md', ['KEEP_2']) +
      section('docs/yarn.lock.notes', ['KEEP_3']);
    const out = filterLockfilesFromDiff(input);
    expect(out.diff).toBe(input);
    expect(out.omittedLockfiles).toEqual([]);
  });

  it('returns a no-lockfile diff strictly unchanged, headerless included', () => {
    for (const input of [SRC + TEST, '+function hello() {}', '']) {
      const out = filterLockfilesFromDiff(input);
      expect(out.diff).toBe(input);
      expect(out.omittedLockfiles).toEqual([]);
    }
  });
});

describe('runReview — lockfile omission', () => {
  it('THE REPRODUCTION — a >50k lockfile no longer crowds src/ and tests/ out of the prompt', async () => {
    const lock = bigLock();
    expect(lock.length).toBeGreaterThan(50000);
    const result = await run(lock + SRC + TEST, ['package-lock.json', 'src/app.mjs', 'tests/unit/app.test.mjs']);
    expect(result.ok).toBe(true);
    const prompt = promptSent();
    expect(prompt).toContain('SRC_MARKER_LATE');
    expect(prompt).toContain('TEST_MARKER_LATE');
    expect(prompt).not.toContain('LOCKONLY_TOKEN_');
    const raw = chatMock.mock.calls.at(-1)[0].prompt;
    expect(raw).toContain('LOCKFILE DIFFS OMITTED');
    expect(raw.split('LOCKFILE DIFFS OMITTED')).toHaveLength(2);
    const notice = raw.slice(raw.indexOf('LOCKFILE DIFFS OMITTED')).split('\n\n')[0];
    expect(notice).toMatch(/generated dependency state/i);
    expect(notice).toContain('package-lock.json');
    expect(raw.slice(raw.indexOf('## Changed Files')).split('\n\n')[0]).toContain('package-lock.json');
    expect(result.lockfileOmission).toEqual({ paths: ['package-lock.json'], omittedChars: lock.length });
  });

  it('THE CONVERSE — no lockfile: no notice, no field, diff embedded as before', async () => {
    const result = await run(SRC + TEST, ['src/app.mjs', 'tests/unit/app.test.mjs']);
    expect(result).not.toHaveProperty('lockfileOmission');
    const prompt = promptSent();
    expect(prompt).not.toContain('LOCKFILE DIFFS OMITTED');
    expect(prompt).not.toMatch(/generated dependency state/i);
    expect(prompt).toContain(JSON.stringify(SRC + TEST).slice(1, -1));
  });

  it('runPatternChecks still sees the lockfile: a secret inside it is still a security_issue', async () => {
    const secretLine = 'pass' + 'word = "x-not-a-real-credential"';
    const lock = section('package-lock.json', [secretLine]);
    const result = await run(lock + SRC, ['package-lock.json', 'src/app.mjs']);
    const sec = result.findings.filter((f) => f.category === 'security_issue' && f.file === 'package-lock.json');
    expect(sec.length).toBeGreaterThan(0);
    expect(promptSent()).not.toContain('x-not-a-real-credential');
  });

  it('a lockfile-only branch diff still runs the review and carries the notice', async () => {
    const lock = section('package-lock.json', ['LOCKONLY_SOLE']);
    const result = await run(lock, ['package-lock.json']);
    expect(chatMock).toHaveBeenCalled();
    expect(rawPrompt()).toContain('LOCKFILE DIFFS OMITTED');
    expect(promptSent()).toMatch(/generated dependency state/i);
    expect(result.lockfileOmission.paths).toEqual(['package-lock.json']);
  });
});

describe('interaction — computeDiffTruncation runs on the lockfile-filtered diff', () => {
  it('a raw diff over the cap only because of a lockfile is not truncated', async () => {
    const raw = bigLock() + SRC + TEST;
    expect(raw.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    expect((SRC + TEST).length).toBeLessThanOrEqual(REVIEW_DIFF_CHAR_CAP);
    const result = await run(raw, ['package-lock.json', 'src/app.mjs', 'tests/unit/app.test.mjs']);
    expect(result).not.toHaveProperty('diffTruncation');
    expect(rawPrompt()).not.toContain('DIFF TRUNCATED');
  });

  it('a filtered diff still over the cap is measured as filtered and never names an omitted lockfile', async () => {
    const lock = bigLock();
    const bigSrc = section(
      'src/big.mjs',
      Array.from({ length: 2500 }, (_, i) => `export const BIG_SRC_${i} = ${i};`),
    );
    expect(bigSrc.length).toBeGreaterThan(REVIEW_DIFF_CHAR_CAP);
    const result = await run(lock + bigSrc + TEST, ['package-lock.json', 'src/big.mjs', 'tests/unit/app.test.mjs']);
    const t = result.diffTruncation;
    expect(t.truncated).toBe(true);
    expect(t.originalChars).toBe((bigSrc + TEST).length);
    expect(t.unseenFiles).toContain('tests/unit/app.test.mjs');
    expect(t.unseenFiles).not.toContain('package-lock.json');
    expect(t.partialFile?.file).toBe('src/big.mjs');
    expect(rawPrompt()).toContain('LOCKFILE DIFFS OMITTED');
    expect(result.lockfileOmission).toEqual({ paths: ['package-lock.json'], omittedChars: lock.length });
  });
});

describe('telemetry R9 — review.prompt.assembled records the omission', () => {
  const assembled = () =>
    ensureTelemetryStorage(FAKE_ROOT)
      .emit.mock.calls.filter((c) => c[0] === 'review.prompt.assembled')
      .map((c) => c[2]);

  it('carries lockfileOmission equal to the result, and diffBytes of the UNFILTERED diff', async () => {
    const raw = bigLock() + SRC + TEST;
    const result = await run(raw, ['package-lock.json', 'src/app.mjs', 'tests/unit/app.test.mjs']);
    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].lockfileOmission).toEqual(result.lockfileOmission);
    expect(payloads[0].lockfileOmission.paths).toEqual(['package-lock.json']);
    expect(payloads[0].diffBytes).toBe(raw.length);
  });

  it('has no lockfileOmission key when nothing was omitted', async () => {
    await run(SRC + TEST, ['src/app.mjs', 'tests/unit/app.test.mjs']);
    const payloads = assembled();
    expect(payloads).toHaveLength(1);
    expect('lockfileOmission' in payloads[0]).toBe(false);
    expect(payloads[0].diffBytes).toBe((SRC + TEST).length);
  });
});
