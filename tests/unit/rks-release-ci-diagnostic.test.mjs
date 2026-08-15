/**
 * Tests for backlog.feat.release-skill-diagnoses-ci-failures.
 *
 * Two-layer coverage:
 *   1. PURE unit tests for the exported helpers stripAnsi / parseGhLogFailedOutput /
 *      fetchCiDiagnostics (with an injected spawn) — exercises parsing, ANSI handling,
 *      line cap, fallback paths.
 *   2. SOURCE-GREP pins for the integration call sites (--log-failed literal, the
 *      FAIL_RE pattern, the 60_000 / 30_000 timeout literals, the databaseId json
 *      field added to the gh run list call). These guard against accidental
 *      removal/rename during future refactors.
 *
 * Maps to testRequirements:
 *   - Source-grep pin (AC1, AC6): --log-failed literal present
 *   - Diagnostics-field shape contract (AC2)
 *   - Failing-test parsing (AC2)
 *   - gh CLI unavailable fallback (AC3): ENOENT
 *   - gh CLI unauthenticated fallback (AC3, ARCH): auth fail returns stderr rawTail
 *   - No-call regression on green CI (AC4): source-grep pin — fetchCiDiagnostics only invoked under conclusion !== "success"
 *   - In-progress CI distinction (AC5): "CI in progress at <runUrl>" literal
 *   - rawTail line cap (AC2): >50 lines → exactly 50
 *   - rawTail ANSI handling pinned (AC2, ARCH): no  bytes in output
 *   - Source-grep secondary pin (AC6): FAIL extraction regex literal present
 *   - Production gh subprocess timeout (ARCH): timeout: 60_000 literal
 *   - All subprocess spawns use explicit timeout: source-grep on the two new spawnSync calls
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripAnsi,
  parseGhLogFailedOutput,
  fetchCiDiagnostics,
} from '../../packages/mcp-rks/src/server/git/git-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GIT_RELEASE_PATH = path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs');
const GIT_RELEASE_SRC = fs.readFileSync(GIT_RELEASE_PATH, 'utf8');

const ESC = '';

describe('stripAnsi — ARCH ask: no \\u001b bytes leak into rawTail', () => {
  it('strips SGR color codes', () => {
    const s = `${ESC}[31mred${ESC}[0m plain`;
    expect(stripAnsi(s)).toBe('red plain');
  });

  it('strips cursor positioning sequences', () => {
    const s = `${ESC}[2J${ESC}[Hcleared`;
    expect(stripAnsi(s)).toBe('cleared');
  });

  it('strips bold + reset', () => {
    const s = `${ESC}[1mFAIL${ESC}[22m tests/unit/foo.test.mjs`;
    expect(stripAnsi(s)).toBe('FAIL tests/unit/foo.test.mjs');
  });

  it('returns "" for non-string input', () => {
    expect(stripAnsi(undefined)).toBe('');
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(42)).toBe('');
  });

  it('passes through clean text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('output contains no ESC bytes for typical vitest-coloured log', () => {
    const coloured = `${ESC}[31m${ESC}[1m ❯ tests/unit/foo.test.mjs (1 test | 1 failed)${ESC}[22m${ESC}[39m`;
    const out = stripAnsi(coloured);
    expect(out).not.toContain('');
    expect(out).not.toContain('');
  });
});

describe('parseGhLogFailedOutput — diagnostics shape and content (AC2)', () => {
  // gh run view --log-failed format: <job>\t<step>\t<timestamp>\t<content>
  const SAMPLE = [
    'unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t FAIL  tests/unit/foo.test.mjs > parses input',
    'unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t  AssertionError: expected 1 to equal 2',
    'unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t   at tests/unit/foo.test.mjs:42:5',
    'unit-tests\tRun unit tests\t2026-06-09T12:34:57Z\t FAIL  tests/unit/bar.test.mjs',
    'unit-tests\tRun unit tests\t2026-06-09T12:34:57Z\t Test files  2 failed, 5 passed (7)',
  ].join('\n');

  it('returns shape with all 4 required helper keys', () => {
    const out = parseGhLogFailedOutput(SAMPLE);
    expect(out).toHaveProperty('failingJob');
    expect(out).toHaveProperty('failingStep');
    expect(out).toHaveProperty('failingTests');
    expect(out).toHaveProperty('rawTail');
  });

  it('extracts failingJob and failingStep from the first record', () => {
    const out = parseGhLogFailedOutput(SAMPLE);
    expect(out.failingJob).toBe('unit-tests');
    expect(out.failingStep).toBe('Run unit tests');
  });

  it('extracts failingTests with file + test description (AC2)', () => {
    const out = parseGhLogFailedOutput(SAMPLE);
    expect(out.failingTests.length).toBeGreaterThanOrEqual(2);
    const fooEntry = out.failingTests.find((t) => t.file === 'tests/unit/foo.test.mjs');
    expect(fooEntry).toBeDefined();
    expect(fooEntry.test).toBe('parses input');
    const barEntry = out.failingTests.find((t) => t.file === 'tests/unit/bar.test.mjs');
    expect(barEntry).toBeDefined();
  });

  it('rawTail strips the gh metadata prefix (returns content only)', () => {
    const out = parseGhLogFailedOutput(SAMPLE);
    for (const line of out.rawTail) {
      // No tab-separated metadata prefix should remain
      expect(line).not.toMatch(/^\w+\t\w+\t\d{4}-/);
    }
  });

  it('handles empty input safely', () => {
    const out = parseGhLogFailedOutput('');
    expect(out.failingJob).toBeNull();
    expect(out.failingStep).toBeNull();
    expect(out.failingTests).toEqual([]);
    expect(out.rawTail).toEqual([]);
  });

  it('handles undefined/null input safely', () => {
    const a = parseGhLogFailedOutput(undefined);
    const b = parseGhLogFailedOutput(null);
    expect(a.failingTests).toEqual([]);
    expect(b.failingTests).toEqual([]);
  });
});

describe('parseGhLogFailedOutput — rawTail line cap (AC2)', () => {
  it('caps rawTail at exactly 50 lines for 100-line input', () => {
    const lines = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\tline ${i}`);
    }
    const out = parseGhLogFailedOutput(lines.join('\n'));
    expect(out.rawTail).toHaveLength(50);
    // Should be the LAST 50 (lines 51-100)
    expect(out.rawTail[0]).toBe('line 51');
    expect(out.rawTail[49]).toBe('line 100');
  });

  it('does not cap when input has fewer than 50 lines', () => {
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\tline ${i}`);
    }
    const out = parseGhLogFailedOutput(lines.join('\n'));
    expect(out.rawTail).toHaveLength(10);
  });

  it('caps at exactly 50 for input with 51 lines (boundary)', () => {
    const lines = [];
    for (let i = 1; i <= 51; i++) {
      lines.push(`unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\tline ${i}`);
    }
    const out = parseGhLogFailedOutput(lines.join('\n'));
    expect(out.rawTail).toHaveLength(50);
    expect(out.rawTail[0]).toBe('line 2');
  });
});

describe('parseGhLogFailedOutput — ANSI handling (ARCH ask)', () => {
  it('strips ANSI from input BEFORE parsing failingTests', () => {
    const coloured = `unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t${ESC}[31mFAIL${ESC}[0m  tests/unit/foo.test.mjs > my test`;
    const out = parseGhLogFailedOutput(coloured);
    expect(out.failingTests).toHaveLength(1);
    expect(out.failingTests[0].file).toBe('tests/unit/foo.test.mjs');
    expect(out.failingTests[0].test).toBe('my test');
  });

  it('rawTail contains no \\u001b bytes', () => {
    const coloured = `unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t${ESC}[31m FAIL  tests/unit/foo.test.mjs${ESC}[0m`;
    const out = parseGhLogFailedOutput(coloured);
    for (const line of out.rawTail) {
      expect(line).not.toContain('');
      expect(line).not.toContain('');
    }
  });
});

describe('fetchCiDiagnostics — fallback paths (AC3, ARCH-added)', () => {
  const RUN_URL = 'https://github.com/owner/repo/actions/runs/12345';

  it('AC3: gh CLI unavailable (ENOENT) → deterministic error with runUrl, no diagnostics fields', () => {
    const fakeSpawn = () => ({ error: { code: 'ENOENT' }, status: null, signal: null, stdout: '', stderr: '' });
    const out = fetchCiDiagnostics({ projectRoot: '/tmp', runId: 12345, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(out).toEqual({ error: `gh CLI unavailable; check the run manually at ${RUN_URL}` });
    expect(out).not.toHaveProperty('failingJob');
    expect(out).not.toHaveProperty('failingTests');
  });

  it('ARCH: gh CLI unauthenticated (non-zero exit + stderr) → error + rawTail from stderr', () => {
    const fakeSpawn = () => ({
      error: null,
      status: 4,
      signal: null,
      stdout: '',
      stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\nUse `gh auth login` to authenticate.',
    });
    const out = fetchCiDiagnostics({ projectRoot: '/tmp', runId: 12345, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(out.error).toContain('gh run view failed');
    expect(out.error).toContain(RUN_URL);
    expect(Array.isArray(out.rawTail)).toBe(true);
    expect(out.rawTail.length).toBeGreaterThan(0);
    expect(out.rawTail.join('\n')).toContain('gh auth login');
  });

  it('ARCH: gh subprocess timeout (SIGTERM) → timeout error message', () => {
    const fakeSpawn = () => ({ error: null, status: null, signal: 'SIGTERM', stdout: '', stderr: '' });
    const out = fetchCiDiagnostics({ projectRoot: '/tmp', runId: 12345, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(out.error).toContain('timed out');
    expect(out.error).toContain('60s');
    expect(out.error).toContain(RUN_URL);
  });

  it('ARCH: gh subprocess timeout (ETIMEDOUT error code) → timeout error message', () => {
    const fakeSpawn = () => ({ error: { code: 'ETIMEDOUT' }, status: null, signal: null, stdout: '', stderr: '' });
    const out = fetchCiDiagnostics({ projectRoot: '/tmp', runId: 12345, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(out.error).toContain('timed out');
  });

  it('success path: returns { runId, runUrl, failingJob, failingStep, failingTests, rawTail }', () => {
    const stdout = [
      'unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t FAIL  tests/unit/foo.test.mjs > parses input',
      'unit-tests\tRun unit tests\t2026-06-09T12:34:56Z\t Test files  1 failed (1)',
    ].join('\n');
    const fakeSpawn = () => ({ error: null, status: 0, signal: null, stdout, stderr: '' });
    const out = fetchCiDiagnostics({ projectRoot: '/tmp', runId: 12345, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(out.runId).toBe(12345);
    expect(out.runUrl).toBe(RUN_URL);
    expect(out.failingJob).toBe('unit-tests');
    expect(out.failingStep).toBe('Run unit tests');
    expect(out.failingTests[0].file).toBe('tests/unit/foo.test.mjs');
    expect(Array.isArray(out.rawTail)).toBe(true);
  });

  it('ARCH: production spawn call passes timeout: 60_000', () => {
    // Capture the options object the spawn fn is called with.
    let capturedOpts = null;
    const fakeSpawn = (_cmd, _args, opts) => {
      capturedOpts = opts;
      return { error: null, status: 0, signal: null, stdout: '', stderr: '' };
    };
    fetchCiDiagnostics({ projectRoot: '/tmp', runId: 1, runUrl: RUN_URL, spawn: fakeSpawn });
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.timeout).toBe(60_000);
  });
});

describe('Source-grep pins (AC1, AC6) — guard against accidental removal in future edits', () => {
  it("AC1: '--log-failed' literal present in git-release.mjs", () => {
    expect(GIT_RELEASE_SRC).toContain('"--log-failed"');
  });

  it('AC1: gh run view subprocess call present', () => {
    expect(GIT_RELEASE_SRC).toMatch(/spawn\(\s*\n?\s*"gh",\s*\[\s*"run",\s*"view"/);
  });

  it('AC6: failing-test extraction regex literal present (FAIL_RE)', () => {
    // Pin the FAIL_RE definition by name + the \bFAIL\b token + .test|.spec branch
    expect(GIT_RELEASE_SRC).toMatch(/const FAIL_RE\s*=/);
    expect(GIT_RELEASE_SRC).toContain('\\bFAIL\\b');
    expect(GIT_RELEASE_SRC).toMatch(/\(\?:test\|spec\)/);
  });

  it('AC6: vitest extension list covers mjs/js/ts/cjs/mts/cts', () => {
    // Confirm we don't accidentally narrow to just .test.mjs and miss .ts/.cts in TS projects.
    expect(GIT_RELEASE_SRC).toMatch(/\(\?:mjs\|js\|ts\|cjs\|mts\|cts\)/);
  });

  it('AC5: "CI in progress at" literal present (in-progress distinction)', () => {
    expect(GIT_RELEASE_SRC).toContain('CI in progress at');
  });

  it('AC4: diagnostics is added ONLY in the conclusion !== success branch (not on success)', () => {
    // Source-grep style: confirm `diagnostics:` appears inside an if-conclusion-success block,
    // not at top level of the success return. Verify by counting `diagnostics:` occurrences and
    // by location: it should appear only after the `if (latest.conclusion !== "success")` check.
    const diagOccurrences = (GIT_RELEASE_SRC.match(/\bdiagnostics\b/g) || []).length;
    expect(diagOccurrences).toBeGreaterThan(0);
    const conclusionGate = GIT_RELEASE_SRC.indexOf('latest.conclusion !== "success"');
    const firstDiagInReturn = GIT_RELEASE_SRC.indexOf('diagnostics,');
    expect(conclusionGate).toBeGreaterThan(0);
    expect(firstDiagInReturn).toBeGreaterThan(conclusionGate);
  });

  it('ARCH: production timeout literal `timeout: 60_000` present', () => {
    expect(GIT_RELEASE_SRC).toContain('timeout: 60_000');
  });

  it('ARCH: shorter ciCheck timeout literal `timeout: 30_000` present (gh run list)', () => {
    expect(GIT_RELEASE_SRC).toContain('timeout: 30_000');
  });

  it('ARCH: databaseId added to gh run list --json field (needed for runUrl/runId)', () => {
    expect(GIT_RELEASE_SRC).toContain('databaseId,url,status,conclusion,headSha');
  });
});

describe('Subprocess timeout rule for new spawn sites (ARCH ask)', () => {
  it('every spawnSync call ADDED for the diagnostic feature has an explicit timeout option', () => {
    // Find every spawn() / spawnSync() invocation that occurs INSIDE or directly
    // adjacent to the new helpers (fetchCiDiagnostics) or the modified ciCheck.
    // Scope by extracting the relevant slices and asserting `timeout:` appears in each.
    const fetchHelperStart = GIT_RELEASE_SRC.indexOf('export function fetchCiDiagnostics');
    const fetchHelperEnd = GIT_RELEASE_SRC.indexOf('export async function runStagingMerge');
    expect(fetchHelperStart).toBeGreaterThan(-1);
    expect(fetchHelperEnd).toBeGreaterThan(fetchHelperStart);
    const fetchHelperSrc = GIT_RELEASE_SRC.slice(fetchHelperStart, fetchHelperEnd);
    expect(fetchHelperSrc).toContain('timeout: 60_000');

    const ciCheckIdx = GIT_RELEASE_SRC.indexOf('const ciCheck = spawnSync');
    expect(ciCheckIdx).toBeGreaterThan(-1);
    const ciCheckBlock = GIT_RELEASE_SRC.slice(ciCheckIdx, ciCheckIdx + 800);
    expect(ciCheckBlock).toContain('timeout: 30_000');
  });
});

// Subprocess timeout rule: N/A — this test file calls a pure exported function with
// an injected fake spawn and does NOT itself spawn subprocesses. Documented here per
// QA's standard subprocess-timeout testReq.
