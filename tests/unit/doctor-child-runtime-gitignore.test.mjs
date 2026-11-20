/**
 * Witness for backlog.fix.doctor-child-runtime-gitignore-repair-and-tracked-audit.
 *
 * Check 9a repairs a child .gitignore append-only and idempotently with the six traders-46
 * runtime paths. Check 9b REPORTS, and never untracks, runtime artifacts already in a
 * child's git index. Every fixture lives under os.tmpdir() (test-fixture containment), and
 * every git child's toplevel is asserted to be the fixture itself before it is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runDoctor,
  CHILD_RUNTIME_GITIGNORE_RULES,
  inspectChildGitignore,
  listTrackedRuntimeArtifacts,
} from '../../packages/cli/src/project/doctor.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const HOOK_MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8'),
);
const GIT_TIMEOUT = 15_000;
const SIX = [
  '.rks/runs/',
  '.rks/session/',
  '.rks/fetch-cache/',
  '.rks/state/interventions.jsonl',
  '.rks/test-runner-debug.json',
  '.rks/test-runner-full-output.txt',
];

const made = [];
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
// Deterministic git (same contract as isolatedGitEnv() in tests/integration/project-doctor.test.mjs).
// runDoctor runs in-process here and its default runGit spawns git with process.env, so the
// isolation is applied to process.env for each test and fully restored afterwards: every
// inherited GIT_* variable except GIT_EXEC_PATH is removed, discovery stops at os.tmpdir(), and
// system/global git config is ignored. A host TMPDIR inside a work tree, or an inherited GIT_DIR,
// therefore cannot decide any assertion below, and fixture git writes cannot reach another repo.
let envSnapshot;
beforeEach(() => {
  envSnapshot = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GIT_') && k !== 'GIT_EXEC_PATH') delete process.env[k];
  }
  process.env.GIT_CEILING_DIRECTORIES = [os.tmpdir(), fs.realpathSync(os.tmpdir())].join(path.delimiter);
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
});
afterEach(() => {
  vi.restoreAllMocks();
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in envSnapshot)) delete process.env[k];
  Object.assign(process.env, envSnapshot);
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.error ? r.error.message : r.stderr}`);
  }
  return r.stdout;
}

// Non-git status is established by the isolation above and MEASURED here, never assumed from the
// fixture living under os.tmpdir().
function expectNotAGitWorkTree(dir) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT });
  expect(r.error, 'git must be installed and runnable for this witness').toBeUndefined();
  expect(fs.existsSync(path.join(dir, '.git')), 'fixture must not carry its own .git').toBe(false);
  expect(r.status, `precondition: ${dir} must not be inside a git work tree (stdout ${r.stdout})`).not.toBe(0);
}

function makeShellRoot() {
  const root = tmp('doctor9-shell-');
  fs.mkdirSync(path.join(root, 'packages', 'hooks', 'write'), { recursive: true });
  fs.mkdirSync(path.join(root, 'templates', 'generic', '.routekit', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/hooks/write/sample.mjs'), '// canonical\n');
  fs.mkdirSync(path.join(root, '.routekit'), { recursive: true });
  fs.writeFileSync(path.join(root, '.routekit', 'hooks-manifest.json'), JSON.stringify(HOOK_MANIFEST, null, 2));
  return root;
}

function makeChild({ gitignore = null, contentOnly = false } = {}) {
  const root = tmp('doctor9-child-');
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  const pj = contentOnly ? { id: 'child-x', vcs: { contentOnly: true } } : { id: 'child-x' };
  fs.writeFileSync(path.join(root, '.rks/project.json'), JSON.stringify(pj, null, 2));
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { rks: { command: 'node', args: ['/some/shell/packages/mcp-rks/bin/mcp-rks.mjs'], env: {} } } }, null, 2),
  );
  if (gitignore !== null) fs.writeFileSync(path.join(root, '.gitignore'), gitignore);
  return root;
}

function makeGitChild() {
  const root = makeChild({ gitignore: 'node_modules/\n' });
  git(root, ['init', '-q']);
  expect(fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim())).toBe(fs.realpathSync(root));
  fs.mkdirSync(path.join(root, '.rks/session/governor'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rks/session/governor/abc.json'), '{"token":"t"}\n');
  fs.mkdirSync(path.join(root, '.rks/prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rks/prompts/x.md'), '# prompt\n');
  git(root, ['add', '-f', '.rks/session/governor/abc.json', '.rks/project.json', '.rks/prompts/x.md', '.gitignore']);
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', 'seed']);
  return root;
}

function deps(child) {
  return {
    syncHooks: vi.fn(),
    checkDrift: vi.fn(() => ({ ok: true, issues: [], srcCount: 0, destCount: 0 })),
    syncProject: vi.fn(() => []),
    repinMcpServer: vi.fn(() => ({ ok: true, changed: true })),
    migrateConfig: vi.fn(() => ({ ok: true, applied: [], noOp: true, fromVersion: 1, currentVersion: 1 })),
    upsertProject: vi.fn(),
    loadProjects: vi.fn(() => [{ id: 'child-x', root: child }]),
    isPinned: vi.fn(() => false),
  };
}

const read = (child) => fs.readFileSync(path.join(child, '.gitignore'), 'utf8');
const check9Fixers = (r) => r.findings.appliedFixers.filter((f) => f.check === 9);
const check9NonRecoverable = (r) => r.findings.nonRecoverable.filter((n) => n.check === 9);
const entry9a = (r) => r.findings.childRuntimeGitignore.find((e) => e.id === 'child-x');
const entry9b = (r) => r.findings.childTrackedRuntimeArtifacts.find((e) => e.id === 'child-x');

describe('Check 9 constant', () => {
  it('exports exactly the six runtime paths in order, with no catch-all', () => {
    expect(CHILD_RUNTIME_GITIGNORE_RULES).toEqual(SIX);
    for (const bad of ['.rks/', '.rks/*', '.rks', '*']) {
      expect(CHILD_RUNTIME_GITIGNORE_RULES).not.toContain(bad);
    }
  });
});

describe('Check 9a: inspectChildGitignore coverage', () => {
  it('an existing .rks/state/ covers .rks/state/interventions.jsonl', () => {
    const child = makeChild({ gitignore: '.rks/state/\n' });
    const r = inspectChildGitignore(child);
    expect(r.missing).not.toContain('.rks/state/interventions.jsonl');
    expect(r.missing).toContain('.rks/runs/');
  });

  it('an existing .rks/ or .rks/* covers all six', () => {
    for (const rule of ['.rks/\n', '.rks/*\n']) {
      const child = makeChild({ gitignore: rule });
      const r = inspectChildGitignore(child);
      expect(r.missing).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  it('/.rks/runs (leading slash, no trailing slash) counts as present', () => {
    const child = makeChild({ gitignore: '/.rks/runs\n' });
    expect(inspectChildGitignore(child).missing).not.toContain('.rks/runs/');
  });
});

describe('Check 9a: repair through runDoctor', () => {
  it('appends exactly the missing rules; pre-run bytes are a prefix (LF)', async () => {
    const before = 'node_modules/\n.rks/runs/\n.rks/session/\n';
    const child = makeChild({ gitignore: before });
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    const after = read(child);
    expect(after.startsWith(before)).toBe(true);
    const addedLines = after.slice(before.length).split('\n').filter((l) => l && !l.startsWith('#'));
    expect(addedLines).toEqual(SIX.filter((p) => !before.includes(p)));
    expect(check9Fixers(r)).toHaveLength(1);
    expect(check9Fixers(r)[0].fixer).toBe('repairChildGitignore');
    expect(check9NonRecoverable(r)).toEqual([]);
  });

  it('CRLF file without trailing newline: prefix preserved, CRLF separator added', async () => {
    const before = 'node_modules/\r\ndist';
    const child = makeChild({ gitignore: before });
    await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    const after = read(child);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length).startsWith('\r\n')).toBe(true);
    for (const p of SIX) expect(after.split(/\r?\n/)).toContain(p);
  });

  it('a child with no .gitignore gets one containing all six', async () => {
    const child = makeChild();
    await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    const lines = read(child).split(/\r?\n/);
    for (const p of SIX) expect(lines).toContain(p);
  });

  it('a child with .rks/state/ is not given interventions.jsonl; one with .rks/* is given nothing', async () => {
    const a = makeChild({ gitignore: '.rks/state/\n' });
    await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(a) });
    expect(read(a).split(/\r?\n/)).not.toContain('.rks/state/interventions.jsonl');

    const b = makeChild({ gitignore: '.rks/*\n' });
    const rb = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(b) });
    expect(read(b)).toBe('.rks/*\n');
    expect(check9Fixers(rb)).toEqual([]);
  });

  it('second run makes no .gitignore write and records no Check 9 fixer', async () => {
    const child = makeChild({ gitignore: 'node_modules/\n' });
    const shellRoot = makeShellRoot();
    await runDoctor({ shellRoot, dryRun: false, deps: deps(child) });
    const afterFirst = read(child);
    const giPath = path.join(child, '.gitignore');
    const writes = vi.spyOn(fs, 'writeFileSync');
    const appends = vi.spyOn(fs, 'appendFileSync');
    const r2 = await runDoctor({ shellRoot, dryRun: false, deps: deps(child) });
    const touched = [...writes.mock.calls, ...appends.mock.calls].filter((c) => String(c[0]) === giPath);
    expect(touched).toEqual([]);
    expect(read(child)).toBe(afterFirst);
    expect(check9Fixers(r2)).toEqual([]);
    expect(entry9a(r2).ok).toBe(true);
  });

  it('dryRun leaves .gitignore byte-identical and records a dryRun Check 9 entry', async () => {
    const before = 'node_modules/\n';
    const child = makeChild({ gitignore: before });
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: true, deps: deps(child) });
    expect(read(child)).toBe(before);
    expect(r.findings.appliedFixers).toContainEqual({ check: 9, id: 'child-x', fixer: 'repairChildGitignore', dryRun: true });
  });

  it('content-only child: .gitignore never written, reason content-only, not a Check 9 failure', async () => {
    const before = 'client-rule\n';
    const child = makeChild({ gitignore: before, contentOnly: true });
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    expect(read(child)).toBe(before);
    expect(entry9a(r).reason).toBe('content-only');
    expect(entry9a(r).ok).toBe(true);
    expect(check9Fixers(r)).toEqual([]);
    expect(check9NonRecoverable(r)).toEqual([]);
  });
});

describe('Check 9b: tracked runtime-artifact audit (report, never untrack)', () => {
  it('a committed .rks/session/governor/abc.json is reported by name, exit 1, index and HEAD untouched', async () => {
    const child = makeGitChild();
    const headBefore = git(child, ['rev-parse', 'HEAD']).trim();
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    expect(r.exitCode).toBe(1);
    const nr = check9NonRecoverable(r).find((n) => Array.isArray(n.files));
    expect(nr).toBeDefined();
    expect(nr.id).toBe('child-x');
    expect(nr.files).toContain('.rks/session/governor/abc.json');
    expect(entry9b(r).files).toContain('.rks/session/governor/abc.json');
    // Tracked config is not a runtime artifact.
    expect(nr.files).not.toContain('.rks/project.json');
    expect(nr.files).not.toContain('.rks/prompts/x.md');
    // Nothing untracked, nothing staged, no commit made.
    expect(git(child, ['ls-files']).split('\n')).toContain('.rks/session/governor/abc.json');
    expect(git(child, ['diff', '--cached', '--name-only']).trim()).toBe('');
    expect(git(child, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('dry run also reports tracked artifacts and mutates nothing', async () => {
    const child = makeGitChild();
    const headBefore = git(child, ['rev-parse', 'HEAD']).trim();
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: true, deps: deps(child) });
    expect(entry9b(r).files).toContain('.rks/session/governor/abc.json');
    expect(git(child, ['ls-files']).split('\n')).toContain('.rks/session/governor/abc.json');
    expect(git(child, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
  });

  it('content-only git child is still audited', async () => {
    const child = makeGitChild();
    fs.writeFileSync(path.join(child, '.rks/project.json'), JSON.stringify({ id: 'child-x', vcs: { contentOnly: true } }, null, 2));
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    expect(entry9b(r).files).toContain('.rks/session/governor/abc.json');
  });

  it('a non-git child yields a skipped 9b entry with a reason and no Check 9 nonRecoverable', async () => {
    const child = makeChild({ gitignore: SIX.join('\n') + '\n' });
    expectNotAGitWorkTree(child);
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    expect(entry9b(r).skipped).toBe(true);
    expect(typeof entry9b(r).reason).toBe('string');
    expect(entry9b(r).reason.length).toBeGreaterThan(0);
    expect(entry9b(r).reason).toMatch(/^not a git work tree: \S/);
    expect(check9NonRecoverable(r)).toEqual([]);
  });
});

describe('Check 9b: git ls-files failure inside a real git work tree (ARCH Item 10)', () => {
  async function nonGitSkipEntry() {
    const child = makeChild({ gitignore: SIX.join('\n') + '\n' });
    expectNotAGitWorkTree(child);
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: deps(child) });
    return entry9b(r);
  }

  it('an injected ls-files failure yields { id, error: true, reason }, no files key, a Check 9 nonRecoverable, exit 1', async () => {
    const child = makeGitChild();
    const d = deps(child);
    d.listTrackedRuntimeArtifacts = vi.fn(() => ({ error: true, reason: 'git ls-files failed: exit 128: fatal: simulated' }));
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: d });
    expect(d.listTrackedRuntimeArtifacts).toHaveBeenCalled();
    const e = entry9b(r);
    expect(e.error).toBe(true);
    expect(e.reason).toMatch(/^git ls-files failed: /);
    expect('files' in e).toBe(false);
    expect('skipped' in e).toBe(false);
    expect(check9NonRecoverable(r)).toContainEqual({ check: 9, id: 'child-x', reason: e.reason });
    expect(r.exitCode).toBe(1);
    // Distinct from the non-git skip entry.
    const skip = await nonGitSkipEntry();
    expect(skip.skipped).toBe(true);
    expect('error' in skip).toBe(false);
    expect(e).not.toEqual(skip);
  });

  it('an injected audit that throws is booked as the error shape, never a clean audit or a skip', async () => {
    const child = makeGitChild();
    const d = deps(child);
    d.listTrackedRuntimeArtifacts = vi.fn(() => {
      throw new Error('simulated spawn failure');
    });
    const r = await runDoctor({ shellRoot: makeShellRoot(), dryRun: false, deps: d });
    const e = entry9b(r);
    expect(e.error).toBe(true);
    expect(e.reason).toMatch(/^git ls-files failed: .*simulated spawn failure/);
    expect('files' in e).toBe(false);
    expect('skipped' in e).toBe(false);
    expect(check9NonRecoverable(r)).toContainEqual({ check: 9, id: 'child-x', reason: e.reason });
    expect(r.exitCode).toBe(1);
  });

  // Deterministic: the git runner is injected into the REAL listTrackedRuntimeArtifacts, so no
  // real git failure mode (e.g. a corrupt index) is assumed. No real git is spawned below.
  const REV_PARSE_OK = { status: 0, signal: null, stdout: 'true\n', stderr: '' };
  function fakeGit(lsFiles, revParse = REV_PARSE_OK) {
    return vi.fn((args) => {
      if (args[0] === 'rev-parse') return revParse;
      if (typeof lsFiles === 'function') return lsFiles();
      return lsFiles;
    });
  }
  function expectErrorShape(res) {
    expect(res.error).toBe(true);
    expect(res.reason).toMatch(/^git ls-files failed: /);
    expect('files' in res).toBe(false);
    expect('skipped' in res).toBe(false);
  }

  it('real listTrackedRuntimeArtifacts: ls-files non-zero exit is the error shape with exit status and stderr', () => {
    const runGit = fakeGit({ status: 128, signal: null, stdout: '', stderr: 'fatal: index file corrupt\n' });
    const res = listTrackedRuntimeArtifacts(makeChild(), { runGit });
    expectErrorShape(res);
    expect(res.reason).toBe('git ls-files failed: exit 128: fatal: index file corrupt');
    expect(runGit.mock.calls[0][0]).toEqual(['rev-parse', '--is-inside-work-tree']);
    expect(runGit.mock.calls[1][0][0]).toBe('ls-files');
  });

  it('real listTrackedRuntimeArtifacts: ls-files killed by a signal is the error shape', () => {
    const res = listTrackedRuntimeArtifacts(makeChild(), {
      runGit: fakeGit({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
    });
    expectErrorShape(res);
    expect(res.reason).toBe('git ls-files failed: killed by SIGTERM');
  });

  it('real listTrackedRuntimeArtifacts: an ls-files spawn error or a throwing runner is the error shape, never a throw', () => {
    const spawnErr = listTrackedRuntimeArtifacts(makeChild(), {
      runGit: fakeGit({ status: null, signal: null, stdout: '', stderr: '', error: new Error('spawn git EAGAIN') }),
    });
    expectErrorShape(spawnErr);
    expect(spawnErr.reason).toContain('spawn git EAGAIN');

    let thrown;
    expect(() => {
      thrown = listTrackedRuntimeArtifacts(makeChild(), {
        runGit: fakeGit(() => {
          throw new Error('runner exploded');
        }),
      });
    }).not.toThrow();
    expectErrorShape(thrown);
    expect(thrown.reason).toContain('runner exploded');
  });

  it('real listTrackedRuntimeArtifacts: a failing rev-parse is the skipped shape and ls-files is never run', () => {
    const runGit = fakeGit(
      { status: 0, signal: null, stdout: '', stderr: '' },
      { status: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository\n' },
    );
    const res = listTrackedRuntimeArtifacts(makeChild(), { runGit });
    expect(res.skipped).toBe(true);
    expect(typeof res.reason).toBe('string');
    expect(res.reason.length).toBeGreaterThan(0);
    expect('error' in res).toBe(false);
    expect('files' in res).toBe(false);
    expect(runGit.mock.calls.map((c) => c[0][0])).toEqual(['rev-parse']);
  });
});

// ARCH Item 10 / R8: the 9b result is reported against the child, so the DEFAULT runner must not
// follow an inherited GIT_DIR (git exports it to hooks; users export it too). No runGit is injected.
describe('Check 9b: default runner ignores inherited git redirect env (ARCH Item 10 / R8)', () => {
  it('with process.env.GIT_DIR aimed at another repo, the real default runner audits the child', () => {
    const child = makeGitChild();
    // Second fixture repo that tracks a DIFFERENT runtime file. All fixture git calls happen here,
    // under the beforeEach isolation and BEFORE GIT_DIR is set.
    const other = tmp('doctor9-other-');
    git(other, ['init', '-q']);
    expect(fs.realpathSync(git(other, ['rev-parse', '--show-toplevel']).trim())).toBe(fs.realpathSync(other));
    fs.mkdirSync(path.join(other, '.rks/runs'), { recursive: true });
    fs.writeFileSync(path.join(other, '.rks/runs/other.json'), '{}\n');
    git(other, ['add', '-f', '.rks/runs/other.json']);
    git(other, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-qm', 'seed']);

    // Set after the beforeEach isolation; the finally below and afterEach both restore process.env.
    process.env.GIT_DIR = path.join(other, '.git');
    try {
      // Positive control (read-only): the redirect is live, so a runner that inherited process.env
      // WOULD read the other repository's index. Without this, a green result below proves nothing.
      const probe = spawnSync('git', ['ls-files', '--', '.rks/runs', '.rks/session'], {
        cwd: child, encoding: 'utf8', timeout: GIT_TIMEOUT,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.split('\n')).toContain('.rks/runs/other.json');
      expect(probe.stdout.split('\n')).not.toContain('.rks/session/governor/abc.json');

      const res = listTrackedRuntimeArtifacts(child); // NO injected runGit: the default runner.
      expect('error' in res, JSON.stringify(res)).toBe(false);
      expect('skipped' in res, JSON.stringify(res)).toBe(false);
      expect(res.files).toContain('.rks/session/governor/abc.json');
      expect(res.files).not.toContain('.rks/runs/other.json');
    } finally {
      delete process.env.GIT_DIR;
    }
    expect(process.env.GIT_DIR).toBeUndefined();
  });
});
