/**
 * backlog.fix.release-resume-ci-gate-lockstep-bump-deadlock
 *
 * On a resume, integration HEAD is the `chore(release): X.Y.Z` bump commit, whose body
 * carries [skip ci], so no CI run exists for it. evaluateCiGate exempts that HEAD when its
 * diff against its first parent P touches only RELEASE_BUMP_COMMIT_FILES or CI-ignored paths
 * (the released story notes runRelease stages into the bump commit), and anchors the candidate
 * walk at P. A denied exemption is reported as bumpCommitExemptDenied, in the no-run error text,
 * and on console.error with the [rks_release] prefix. Every git and gh call goes through the injected spawn
 * argument of evaluateCiGate or the mocked spawnSync that runRelease uses; no real subprocess is started.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })) };
});

vi.mock('../../packages/mcp-rks/src/server/git/git-utils.mjs', () => ({
  runGit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'staging'),
  isProductionBranch: vi.fn(() => false),
}));

vi.mock('../../packages/mcp-rks/src/server/guardrails-audit.mjs', () => ({
  isGuardrailsOffSession: vi.fn(() => true),
}));

const { spawnSync } = await import('child_process');
const { runGit } = await import('../../packages/mcp-rks/src/server/git/git-utils.mjs');
const {
  evaluateCiGate,
  runRelease,
  CI_IGNORED_PATH_PREFIXES,
  RELEASE_BUMP_COMMIT_FILES,
} = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

const FAKE_ROOT = '/tmp/fake-project-bump-exemption';
const HEAD = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const GRAND = 'c'.repeat(40);
const BUMP_SUBJECT = 'chore(release): 1.2.3';
const LOCKSTEP_BUMP = ['package.json', 'packages/mcp-rks/package.json', 'packages/cli/package.json', 'CHANGELOG.md'];
const CODE_FILE = 'packages/mcp-rks/src/server/exec.mjs';
const GH_REMOTE = { stdout: 'origin\thttps://github.com/ux287/routekit-shell-core.git (fetch)\n', stderr: '', status: 0 };
const CI_GATE_ERRORS = /no ci-workflow run was found|CI failed on|CI in progress|could not determine ci status|could not parse ci status/i;

const ok = (stdout) => ({ stdout, stderr: '', status: 0 });
const ghRuns = (runs) => ok(JSON.stringify(runs));
const CI_RUN = (headSha, over = {}) => ({
  databaseId: 1, url: `https://ci.example/${headSha.slice(0, 4)}`, status: 'completed', conclusion: 'success', headSha,
  createdAt: '2026-09-29T00:00:00Z', workflowName: 'CI', event: 'push', ...over,
});

/**
 * One routing table for both harnesses.
 * subject: the `git log --format=%s` subject (a newline is appended, as real git does), or a raw result.
 * diffs:   exact range `${from}..${to}` -> file list, or a raw result. Unlisted ranges are empty.
 * runs:    sha -> runs array returned for `gh run list --commit sha`.
 */
function router({ ancestry = [HEAD, PARENT, GRAND], subject = BUMP_SUBJECT, diffs = {}, runs = {}, calls = [] } = {}) {
  return (cmd, args = []) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args[0] === 'remote') return GH_REMOTE;
    if (cmd === 'git' && args[0] === 'status') return ok('');
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) return ok('0\t0');
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--first-parent')) return ok(ancestry.join('\n') + '\n');
    if (cmd === 'git' && args[0] === 'log' && args.includes('--format=%s')) {
      return typeof subject === 'string' ? ok(subject + '\n') : subject;
    }
    if (cmd === 'git' && args[0] === 'diff' && args.includes('--name-only')) {
      const d = diffs[String(args[args.length - 1])];
      if (Array.isArray(d)) return ok(d.join('\n') + '\n');
      if (d && typeof d === 'object') return d;
      return ok('');
    }
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'list') {
      const sha = args[args.indexOf('--commit') + 1];
      return ghRuns(runs[sha] || []);
    }
    if (cmd === 'gh') return { stdout: '', stderr: 'gh unavailable in this test', status: 1 };
    return ok('');
  };
}

function gate(o = {}) {
  const calls = [];
  const r = evaluateCiGate({ projectRoot: FAKE_ROOT, integration: 'staging', revParse: () => HEAD, spawn: router({ ...o, calls }) });
  const ghShas = calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'list').map((c) => c.args[c.args.indexOf('--commit') + 1]);
  const diffRanges = calls.filter((c) => c.cmd === 'git' && c.args[0] === 'diff').map((c) => String(c.args[c.args.length - 1]));
  return { r, calls, ghShas, diffRanges };
}

/** The bump commit's own diff, plus a CI-relevant change between GRAND and PARENT that closes the walk at PARENT. */
const bumpDiffs = (bump) => ({
  [`${PARENT}..${HEAD}`]: bump,
  [`${GRAND}..${PARENT}`]: [CODE_FILE],
  [`${GRAND}..${HEAD}`]: [...bump, CODE_FILE],
});
const greenParent = { [PARENT]: [CI_RUN(PARENT)] };

describe('constants', () => {
  it('RELEASE_BUMP_COMMIT_FILES is the exact five-file set', () => {
    expect(RELEASE_BUMP_COMMIT_FILES).toEqual([
      'package.json', 'packages/mcp-rks/package.json', 'packages/cli/package.json', 'CHANGELOG.md', 'package-lock.json',
    ]);
  });

  it('CI_IGNORED_PATH_PREFIXES is unchanged: no lockfile, no packages/ entry', () => {
    expect(CI_IGNORED_PATH_PREFIXES).toEqual([
      'package.json', 'CHANGELOG.md',
      'notes/research.', 'notes/backlog.', 'notes/canon.', 'notes/how-to.',
      'notes/scratch.', 'notes/ideas.', 'notes/design.', 'notes/notes.',
      '.rks/project.json', '.rks/active-scope.json',
    ]);
    expect(CI_IGNORED_PATH_PREFIXES).not.toContain('package-lock.json');
    expect(CI_IGNORED_PATH_PREFIXES.some((p) => p.startsWith('packages/'))).toBe(false);
  });
});

describe('an exempt bump HEAD passes on its green parent', () => {
  const cases = [
    ['lockstep bump', LOCKSTEP_BUMP],
    ['lockstep bump with lockfile', [...LOCKSTEP_BUMP, 'package-lock.json']],
    ['no sub-packages, lockfile only', ['package.json', 'CHANGELOG.md', 'package-lock.json']],
    ['lockstep bump with a released-story note (CI-ignored)', [...LOCKSTEP_BUMP, 'notes/backlog.x.md']],
  ];
  for (const [name, bump] of cases) {
    it(`${name}: ok, runSha is the parent, exemption reported with the measured files`, () => {
      const { r, ghShas } = gate({ diffs: bumpDiffs(bump), runs: greenParent });
      expect(r.ok).toBe(true);
      expect(r.headSha).toBe(HEAD);
      expect(r.runSha).toBe(PARENT);
      expect(r.bumpCommitExempt).toBe(true);
      expect(r.bumpCommitFiles).toEqual(bump);
      expect(r).not.toHaveProperty('bumpCommitExemptDenied');
      expect(ghShas).toEqual([HEAD, PARENT]);
    });
  }

  it('a run on HEAD itself still decides first', () => {
    const { r, ghShas } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: { [HEAD]: [CI_RUN(HEAD)], ...greenParent } });
    expect(r.ok).toBe(true);
    expect(r.runSha).toBe(HEAD);
    expect(ghShas).toEqual([HEAD]);
  });

  it('the walk beyond the parent diffs against the parent, never against HEAD', () => {
    const { diffRanges } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: {} });
    expect(diffRanges).toContain(`${GRAND}..${PARENT}`);
    expect(diffRanges).not.toContain(`${GRAND}..${HEAD}`);
  });
});

describe('no exemption: the gate refuses as today and adds no exemption keys', () => {
  for (const extra of [CODE_FILE, 'packages/other/package.json']) {
    it(`bump subject, but the diff also holds ${extra}`, () => {
      const { r, ghShas } = gate({ diffs: bumpDiffs([...LOCKSTEP_BUMP, extra]), runs: greenParent });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/no ci-workflow run was found/i);
      expect(r).not.toHaveProperty('bumpCommitExempt');
      expect(r).not.toHaveProperty('bumpCommitFiles');
      expect(r.bumpCommitExemptDenied).toEqual({ reason: 'files_outside_set', files: [extra] });
      expect(ghShas).toEqual([HEAD]);
    });
  }

  it('bump subject, a CI-ignored note AND a code file: denied, files names only the code file', () => {
    const { r } = gate({ diffs: bumpDiffs([...LOCKSTEP_BUMP, 'notes/backlog.x.md', CODE_FILE]), runs: greenParent });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('bumpCommitExempt');
    expect(r.bumpCommitExemptDenied).toEqual({ reason: 'files_outside_set', files: [CODE_FILE] });
  });

  for (const file of ['packages/cli/package.json', 'package-lock.json']) {
    it(`non-bump subject touching only ${file}`, () => {
      const { r } = gate({ subject: 'chore(deps): bump left-pad', diffs: bumpDiffs([file]), runs: greenParent });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/no ci-workflow run was found/i);
      expect(r).not.toHaveProperty('bumpCommitExempt');
      expect(r).not.toHaveProperty('bumpCommitExemptDenied');
    });
  }

  it('a bump HEAD with no first parent in the ancestry', () => {
    const { r, diffRanges } = gate({ ancestry: [HEAD], diffs: bumpDiffs(LOCKSTEP_BUMP), runs: greenParent });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci-workflow run was found/i);
    expect(r).not.toHaveProperty('bumpCommitExempt');
    expect(r.bumpCommitExemptDenied).toEqual({ reason: 'no_first_parent' });
    expect(diffRanges).toEqual([]);
  });

  it('an empty parent..HEAD diff grants no exemption', () => {
    const { r } = gate({ diffs: { [`${PARENT}..${HEAD}`]: { stdout: '', stderr: '', status: 0 } }, runs: greenParent });
    expect(r).not.toHaveProperty('bumpCommitExempt');
    expect(r).not.toHaveProperty('bumpCommitFiles');
    expect(r.bumpCommitExemptDenied).toEqual({ reason: 'empty_diff' });
  });
});

describe('the parent must itself be verified', () => {
  it('parent has no run and the nearest green ancestor is past a CI-relevant change: refuse', () => {
    const { r, ghShas } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: { [GRAND]: [CI_RUN(GRAND)] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci-workflow run was found/i);
    expect(ghShas).not.toContain(GRAND);
  });

  it('parent run in progress: refuse with the in-progress error', () => {
    const { r } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: { [PARENT]: [CI_RUN(PARENT, { status: 'in_progress', conclusion: null })] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CI in progress/);
  });

  it('parent run failed: refuse with the failed error', () => {
    const { r } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: { [PARENT]: [CI_RUN(PARENT, { conclusion: 'failure' })] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CI failed on staging/);
  });
});

describe('fails closed on reads it could not complete', () => {
  const failures = [
    ['subject read exits non-zero', 'subject_read_failed', { subject: { stdout: '', stderr: 'fatal', status: 1 } }],
    ['subject read times out (status null)', 'subject_read_failed', { subject: { stdout: null, stderr: '', status: null } }],
    ['parent..HEAD diff exits non-zero', 'diff_read_failed', { diffs: { ...bumpDiffs(LOCKSTEP_BUMP), [`${PARENT}..${HEAD}`]: { stdout: '', stderr: 'fatal', status: 1 } } }],
    ['parent..HEAD diff times out (status null)', 'diff_read_failed', { diffs: { ...bumpDiffs(LOCKSTEP_BUMP), [`${PARENT}..${HEAD}`]: { stdout: null, stderr: '', status: null } } }],
  ];
  for (const [name, reason, o] of failures) {
    it(`${name}: no exemption, never ok on the strength of the bump commit, denial reason ${reason}`, () => {
      const { r } = gate({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: greenParent, ...o });
      expect(r.ok).toBe(false);
      expect(r).not.toHaveProperty('bumpCommitExempt');
      expect(r.bumpCommitExemptDenied).toEqual({ reason });
    });
  }
});

describe('a denied exemption says why (R9)', () => {
  let errSpy;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  const logged = (reason) => errSpy.mock.calls.some((args) => {
    const msg = args.map(String).join(' ');
    return msg.startsWith('[rks_release]') && msg.includes(reason);
  });

  // NO_RUN rows end at the :540 no-run refusal, whose text must name the reason. The
  // diff_read_failed row ends earlier: the walk's own read of the same parent..HEAD range
  // fails too, so the existing 'Could not read the diff' refusal (git-release.mjs:452-455)
  // is returned. That refusal is already truthful; it still carries the field and the log.
  const NO_RUN = /no ci-workflow run was found/i;
  const denials = [
    ['subject_read_failed', undefined, NO_RUN, { subject: { stdout: '', stderr: 'fatal', status: 1 }, diffs: bumpDiffs(LOCKSTEP_BUMP) }],
    ['no_first_parent', undefined, NO_RUN, { ancestry: [HEAD], diffs: bumpDiffs(LOCKSTEP_BUMP) }],
    ['diff_read_failed', undefined, /could not read the diff/i, { diffs: { ...bumpDiffs(LOCKSTEP_BUMP), [`${PARENT}..${HEAD}`]: { stdout: '', stderr: 'fatal', status: 1 } } }],
    ['empty_diff', undefined, NO_RUN, { diffs: { [`${PARENT}..${HEAD}`]: { stdout: '', stderr: '', status: 0 }, [`${GRAND}..${HEAD}`]: [CODE_FILE] } }],
    ['files_outside_set', [CODE_FILE], NO_RUN, { diffs: bumpDiffs([...LOCKSTEP_BUMP, 'notes/backlog.x.md', CODE_FILE]) }],
  ];
  for (const [reason, files, errorPattern, o] of denials) {
    it(`${reason}: the field and the [rks_release] log name the reason, and so does a no-run refusal`, () => {
      const { r } = gate({ runs: {}, ...o });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(errorPattern);
      if (errorPattern === NO_RUN) expect(r.error).toMatch(new RegExp(`exemption denied: ${reason}`, 'i'));
      if (files) expect(r.error).toContain(files.join(', '));
      expect(r.bumpCommitExemptDenied).toEqual(files ? { reason, files } : { reason });
      expect(r).not.toHaveProperty('bumpCommitExempt');
      expect(logged(reason)).toBe(true);
    });
  }

  it('a non-bump HEAD carries no bumpCommitExemptDenied key and logs no denial', () => {
    const { r } = gate({ subject: 'feat: x', diffs: bumpDiffs([CODE_FILE]), runs: {} });
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('bumpCommitExemptDenied');
    expect(r.error).not.toMatch(/exemption denied/i);
    expect(errSpy.mock.calls.some((args) => args.map(String).join(' ').includes('exemption denied'))).toBe(false);
  });

  it('an exempt bump HEAD logs no denial', () => {
    const { r } = gate({ diffs: bumpDiffs([...LOCKSTEP_BUMP, 'notes/backlog.x.md']), runs: greenParent });
    expect(r.bumpCommitExempt).toBe(true);
    expect(r).not.toHaveProperty('bumpCommitExemptDenied');
    expect(errSpy.mock.calls.some((args) => args.map(String).join(' ').includes('exemption denied'))).toBe(false);
  });
});

describe('fresh path unchanged', () => {
  it('a non-bump HEAD with a notes-only tail passes on its parent with no exemption keys', () => {
    const { r } = gate({ subject: 'docs(backlog): edit a story', diffs: { [`${PARENT}..${HEAD}`]: ['notes/backlog.x.md'] }, runs: greenParent });
    expect(r.ok).toBe(true);
    expect(r.runSha).toBe(PARENT);
    expect(r).not.toHaveProperty('bumpCommitExempt');
    expect(r).not.toHaveProperty('bumpCommitFiles');
    expect(r).not.toHaveProperty('bumpCommitExemptDenied');
  });

  it('a non-bump HEAD reads the parent..HEAD range only once (the walk itself), with no exemption read', () => {
    const { r, diffRanges } = gate({ subject: 'feat: x', runs: { [HEAD]: [CI_RUN(HEAD)] } });
    expect(r.ok).toBe(true);
    expect(r.runSha).toBe(HEAD);
    expect(r).not.toHaveProperty('bumpCommitExempt');
    expect(r).not.toHaveProperty('bumpCommitExemptDenied');
    expect(diffRanges.filter((x) => x === `${PARENT}..${HEAD}`)).toHaveLength(1);
  });
});

describe('runRelease on a resume', () => {
  let ledger;
  beforeEach(() => {
    vi.clearAllMocks();
    ledger = [];
    fs.mkdirSync(`${FAKE_ROOT}/notes`, { recursive: true });
    fs.writeFileSync(`${FAKE_ROOT}/package.json`, JSON.stringify({ name: 't', version: '1.2.3' }, null, 2));
    runGit.mockImplementation((root, args) => {
      if (args[0] === 'rev-parse') return HEAD;
      if (args[0] === 'merge-base') return HEAD;
      if (args[0] === 'branch') return 'staging';
      if (args[0] === 'log') return BUMP_SUBJECT;
      return '';
    });
  });

  const release = () => runRelease({ projectRoot: FAKE_ROOT, version: 'patch', projectId: 'test' });
  const merged = () => ledger.some((c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args.includes('--ff-only'));

  it('an exempt bump HEAD gets past the CI gate without enforcementOverride and attempts the ff-merge', async () => {
    spawnSync.mockImplementation(router({ diffs: bumpDiffs(LOCKSTEP_BUMP), runs: greenParent, calls: ledger }));
    const r = await release();
    expect(r.error ?? '').not.toMatch(CI_GATE_ERRORS);
    expect(merged()).toBe(true);
  });

  it('control: the same resume with a code file in the bump diff is blocked by the gate and does not merge', async () => {
    spawnSync.mockImplementation(router({ diffs: bumpDiffs([...LOCKSTEP_BUMP, CODE_FILE]), runs: greenParent, calls: ledger }));
    const r = await release();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no ci-workflow run was found/i);
    expect(merged()).toBe(false);
  });
});
