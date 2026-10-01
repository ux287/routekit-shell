// backlog.fix.git-workflow-hook-ignores-project-test-command
// Commit and merge gates resolve the project's .rks/project.json command and run it as argv.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProjectCommand, readProjectTestCommand, readProjectCommitTestCommand, resolveGateCommand, commitIsGateExempt } from '../../packages/hooks/lib/project-test-command.mjs';
import { loadProjectAllowConfig } from '../../packages/hooks/read/redirect-read-bash-to-agent.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_HOOK = path.join(ROOT, 'packages', 'hooks', 'write', 'enforce-git-workflow.mjs');
const BRANCH_HOOK = path.join(ROOT, 'packages', 'hooks', 'write', 'enforce-branch-workflow.mjs');
const READ_HOOK = path.join(ROOT, 'packages', 'hooks', 'read', 'redirect-read-bash-to-agent.mjs');

const tmps = [];
afterAll(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
}

function mkRunner(dir, name) {
  const runner = path.join(dir, 'bin', name);
  fs.writeFileSync(runner, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync('${name}-argv.json',JSON.stringify(process.argv.slice(2)));process.exit(fs.existsSync('${name}-fail')?1:0);\n`);
  fs.chmodSync(runner, 0o755);
  return runner;
}

// A git repo on `branch` with optional project.json (object, raw string, or 'DIR'), policy files
// and package.json, plus two executable fake runners that record their argv to <name>-argv.json
// and exit 1 when <name>-fail exists.
function repo({ projectJson, gitPolicy, branchPolicy, pkg, branch = 'feature/x' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-gate-'));
  tmps.push(d);
  git(d, 'init', '-q', '-b', branch);
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(d, 'bin'));
  const runner = mkRunner(d, 'runner');
  const runnerB = mkRunner(d, 'runnerB');
  fs.mkdirSync(path.join(d, '.rks'), { recursive: true });
  const pj = path.join(d, '.rks', 'project.json');
  const pjv = typeof projectJson === 'function' ? projectJson({ runner, runnerB }) : projectJson;
  if (pjv === 'DIR') fs.mkdirSync(pj);
  else if (typeof pjv === 'string') fs.writeFileSync(pj, pjv);
  else if (pjv !== undefined) fs.writeFileSync(pj, JSON.stringify(pjv));
  fs.mkdirSync(path.join(d, '.routekit'), { recursive: true });
  if (gitPolicy) fs.writeFileSync(path.join(d, '.routekit', 'git-policy.yaml'), typeof gitPolicy === 'function' ? gitPolicy({ runner }) : gitPolicy);
  if (branchPolicy) fs.writeFileSync(path.join(d, '.routekit', 'branch-policy.yaml'), branchPolicy);
  if (pkg) fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
  return { root: d, runner, runnerB };
}

function stage(root, rel, content = 'x') {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
  git(root, 'add', '-f', rel);
}

function runHook(hook, command, root, env = {}) {
  const merged = { ...process.env, CLAUDE_PROJECT_DIR: root, RKS_GUARDRAILS: '', ...env };
  const r = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env: merged,
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const ran = (root, name = 'runner') => fs.existsSync(path.join(root, `${name}-argv.json`))
  ? JSON.parse(fs.readFileSync(path.join(root, `${name}-argv.json`), 'utf8')) : null;
const npmRan = (root) => fs.existsSync(path.join(root, 'npm-ran'));
const NPM_MARKER_PKG = { scripts: { test: "node -e \"require('fs').writeFileSync('npm-ran','1')\"" } };
const SEEDED_GIT_POLICY = 'require_tests:\n  before_commit: true\n  test_command: "npm test"\n';
const SEEDED_BRANCH_POLICY = 'require_tests_before_merge: true\nmerge_test_command: "npm test"\nblock_direct_commits_to: []\n';
const ARGS = ['-q', '--no-cov', '--color=no'];
const MALFORMED_KEYS = ['pytest', ['pytest'], { args: [] }, { cmd: '   ' }, { cmd: 'x', args: 'y' }];

describe('commit gate resolves .rks/project.json testCommand', () => {
  it('runs the declared cmd with its args and never npm test', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner, args: ARGS } }), pkg: NPM_MARKER_PKG });
    stage(r0.root, 'a.py');
    const r = runHook(GIT_HOOK, 'git commit -m "x"', r0.root);
    expect(r.status).toBe(0);
    expect(ran(r0.root)).toEqual(ARGS);
    expect(npmRan(r0.root)).toBe(false);
  });

  it('D2 precedence: project.json beats the template-seeded npm test policy', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner, args: ARGS } }), gitPolicy: SEEDED_GIT_POLICY, pkg: NPM_MARKER_PKG });
    stage(r0.root, 'a.py');
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual(ARGS);
    expect(npmRan(r0.root)).toBe(false);
  });

  it('a failing runner blocks and names the rendered command, not npm test', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner, args: ARGS } }) });
    fs.writeFileSync(path.join(r0.root, 'runner-fail'), '');
    stage(r0.root, 'a.py');
    const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Tests must pass before committing');
    expect(r.stderr).toContain(`${r0.runner} -q --no-cov --color=no`);
    expect(r.stderr).not.toContain('npm test');
  });

  it('no shell (project.json): a metacharacter cmd cannot start and creates nothing', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: `${runner}; touch pwned` } }) });
    stage(r0.root, 'a.py');
    const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not start');
    expect(r.stderr).not.toContain('Hook error');
    expect(fs.existsSync(path.join(r0.root, 'pwned'))).toBe(false);
  });

  it('no shell (policy file): a metacharacter policy string is refused', () => {
    const r0 = repo({ gitPolicy: 'require_tests:\n  before_commit: true\n  test_command: "npm test && touch pwned"\n' });
    stage(r0.root, 'a.py');
    const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/shell metacharacter/);
    expect(fs.existsSync(path.join(r0.root, 'pwned'))).toBe(false);
  });

  it('a policy string runs as argv', () => {
    const r0 = repo({ gitPolicy: ({ runner }) => `require_tests:\n  before_commit: true\n  test_command: "${runner} --from-policy"\n` });
    stage(r0.root, 'a.py');
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual(['--from-policy']);
  });

  it('D3 nothing declared: skips with a visible notice and never runs npm', () => {
    for (const pkg of [undefined, { scripts: {} }]) {
      const r0 = repo({ pkg });
      stage(r0.root, 'a.py');
      const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/no test command is declared/);
      expect(r.stderr).toMatch(/skipped/);
    }
  });

  it('D3 package.json fallback: runs npm test only when scripts.test exists', () => {
    const r0 = repo({ pkg: NPM_MARKER_PKG });
    stage(r0.root, 'a.py');
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(npmRan(r0.root)).toBe(true);
  });

  it('D3 malformed testCommand blocks with the reason and never falls through', () => {
    const cases = [['{not json', 'malformed'], ['DIR', 'unreadable'], ...MALFORMED_KEYS.map((v) => [{ testCommand: v }, 'malformed'])];
    for (const [pj, reason] of cases) {
      const r0 = repo({ projectJson: pj, gitPolicy: SEEDED_GIT_POLICY, pkg: NPM_MARKER_PKG });
      stage(r0.root, 'a.py');
      const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain('Hook error');
      expect(r.stderr).toContain('.rks/project.json testCommand');
      expect(r.stderr).toContain(reason);
      expect(npmRan(r0.root)).toBe(false);
    }
  });
});

describe('commit gate scope (D4)', () => {
  const failing = () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner } }) });
    fs.writeFileSync(path.join(r0.root, 'runner-fail'), '');
    return r0;
  };

  it("traders' exact form: a .rks/project.json-only commit skips the gate", () => {
    const r0 = failing();
    const r = runHook(GIT_HOOK, 'git commit -m "chore(rks): bump rksVersion to 0.59.11" -- .rks/project.json', r0.root);
    expect(r.status).toBe(0);
    expect(ran(r0.root)).toBeNull();
    expect(r.stderr).toMatch(/skipped: every path/);
  });

  it('index form: notes and .rks only skips; adding src/ runs the gate', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner } }) });
    stage(r0.root, 'notes/a.md');
    stage(r0.root, '.rks/project.json', fs.readFileSync(path.join(r0.root, '.rks', 'project.json'), 'utf8'));
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toBeNull();
    stage(r0.root, 'src/a.py');
    runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(ran(r0.root)).toEqual([]);
  });

  it('fails closed: unclassifiable forms run the gate', () => {
    const forms = ['git commit -am x', 'git commit --all -m x', 'git commit -m x -- .rks/project.json src/a.py',
      'git commit -m x -- .rks/prompts/governor-qa.md', 'git commit -m x notes/a.md', 'git commit -m x'];
    for (const cmd of forms) {
      const r0 = repo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner } }) });
      runHook(GIT_HOOK, cmd, r0.root);
      expect(ran(r0.root), cmd).toEqual([]);
    }
  });

  it('the exemption is evaluated before resolution, so a broken config can be repaired', () => {
    const r0 = repo({ projectJson: '{not json' });
    expect(runHook(GIT_HOOK, 'git commit -m fix -- .rks/project.json', r0.root).status).toBe(0);
  });
});

describe('commitTestCommand (A1)', () => {
  const both = ({ runner, runnerB }) => ({ commitTestCommand: { cmd: runner, args: ['--subset'] }, testCommand: { cmd: runnerB, args: ARGS } });

  it('wins over testCommand, the seeded policy and npm test; a failure names its Source', () => {
    const r0 = repo({ projectJson: both, gitPolicy: SEEDED_GIT_POLICY, pkg: NPM_MARKER_PKG });
    stage(r0.root, 'a.py');
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual(['--subset']);
    expect(ran(r0.root, 'runnerB')).toBeNull();
    expect(npmRan(r0.root)).toBe(false);
    fs.writeFileSync(path.join(r0.root, 'runner-fail'), '');
    const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Tests must pass before committing');
    expect(r.stderr).toContain(`${r0.runner} --subset`);
    expect(r.stderr).toContain('commitTestCommand');
  });

  it('a malformed commitTestCommand blocks and never falls back', () => {
    for (const bad of MALFORMED_KEYS) {
      const r0 = repo({ projectJson: ({ runnerB }) => ({ commitTestCommand: bad, testCommand: { cmd: runnerB } }), pkg: NPM_MARKER_PKG });
      stage(r0.root, 'a.py');
      const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('.rks/project.json commitTestCommand');
      expect(r.stderr).toContain('malformed');
      expect(r.stderr).not.toContain('Hook error');
      expect(ran(r0.root, 'runnerB')).toBeNull();
      expect(npmRan(r0.root)).toBe(false);
    }
  });

  it('a file-level failure names both keys', () => {
    for (const [pj, reason] of [['{not json', 'malformed'], ['DIR', 'unreadable']]) {
      const r0 = repo({ projectJson: pj });
      stage(r0.root, 'a.py');
      const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('testCommand and commitTestCommand');
      expect(r.stderr).toContain(reason);
      expect(r.stderr).toContain('.rks/project.json testCommand');
    }
  });

  it('a valid commitTestCommand runs even when testCommand is malformed', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ commitTestCommand: { cmd: runner, args: ['--subset'] }, testCommand: 'pytest' }) });
    stage(r0.root, 'a.py');
    expect(runHook(GIT_HOOK, 'git commit -m x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual(['--subset']);
  });

  it('no shell for commitTestCommand either', () => {
    const r0 = repo({ projectJson: ({ runner }) => ({ commitTestCommand: { cmd: `${runner}; touch pwned` } }) });
    stage(r0.root, 'a.py');
    const r = runHook(GIT_HOOK, 'git commit -m x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not start');
    expect(r.stderr).not.toContain('Hook error');
    expect(fs.existsSync(path.join(r0.root, 'pwned'))).toBe(false);
  });

  it('a malformed commitTestCommand can still be repaired by a project.json-only commit', () => {
    const r0 = repo({ projectJson: { commitTestCommand: 'bad' } });
    expect(runHook(GIT_HOOK, 'git commit -m fix -- .rks/project.json', r0.root).status).toBe(0);
    expect(ran(r0.root)).toBeNull();
  });

  it('project-level only: HOME declarations never influence the gate', () => {
    for (const key of ['testCommand', 'commitTestCommand']) {
      const r0 = repo({});
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-gate-home-'));
      tmps.push(home);
      fs.mkdirSync(path.join(home, '.rks'), { recursive: true });
      fs.writeFileSync(path.join(home, '.rks', 'project.json'), JSON.stringify({ [key]: { cmd: r0.runner } }));
      stage(r0.root, 'a.py');
      const r = runHook(GIT_HOOK, 'git commit -m x', r0.root, { HOME: home });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/no test command is declared/);
      expect(ran(r0.root)).toBeNull();
    }
  });
});

describe('merge gate (D5, A3)', () => {
  function devRepo(opts) {
    const r0 = repo({ ...opts, branch: 'dev' });
    stage(r0.root, 'README.md');
    git(r0.root, 'commit', '-q', '-m', 'init');
    return r0;
  }

  it('runs the project testCommand, not npm test; a failure names the command', () => {
    const r0 = devRepo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner, args: ARGS } }), pkg: NPM_MARKER_PKG });
    expect(runHook(BRANCH_HOOK, 'git merge feature/x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual(ARGS);
    expect(npmRan(r0.root)).toBe(false);
    fs.writeFileSync(path.join(r0.root, 'runner-fail'), '');
    const r = runHook(BRANCH_HOOK, 'git merge feature/x', r0.root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Tests must pass before merging to dev');
    expect(r.stderr).toContain(`${r0.runner} -q --no-cov --color=no`);
  });

  it('project.json beats the seeded policy; nothing declared skips', () => {
    const r0 = devRepo({ projectJson: ({ runner }) => ({ testCommand: { cmd: runner } }), branchPolicy: SEEDED_BRANCH_POLICY, pkg: NPM_MARKER_PKG });
    expect(runHook(BRANCH_HOOK, 'git merge feature/x', r0.root).status).toBe(0);
    expect(ran(r0.root)).toEqual([]);
    expect(npmRan(r0.root)).toBe(false);
    const r1 = devRepo({});
    const r = runHook(BRANCH_HOOK, 'git merge feature/x', r1.root);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/no test command is declared/);
  });

  it('A3: never consults commitTestCommand', () => {
    const a = devRepo({ projectJson: ({ runner, runnerB }) => ({ commitTestCommand: { cmd: runnerB }, testCommand: { cmd: runner } }) });
    runHook(BRANCH_HOOK, 'git merge feature/x', a.root);
    expect(ran(a.root)).toEqual([]);
    expect(ran(a.root, 'runnerB')).toBeNull();
    const b = devRepo({ projectJson: ({ runnerB }) => ({ commitTestCommand: { cmd: runnerB } }) });
    const rb = runHook(BRANCH_HOOK, 'git merge feature/x', b.root);
    expect(rb.status).toBe(0);
    expect(rb.stderr).toMatch(/no test command is declared/);
    expect(ran(b.root, 'runnerB')).toBeNull();
    const c = devRepo({ projectJson: ({ runner }) => ({ commitTestCommand: 'bad', testCommand: { cmd: runner } }) });
    expect(runHook(BRANCH_HOOK, 'git merge feature/x', c.root).status).toBe(0);
    expect(ran(c.root)).toEqual([]);
  });
});

describe('A2: the Bash allowlist reads testCommand only', () => {
  it('a commitTestCommand never adds an allow token or an ignored notice', () => {
    const only = repo({ projectJson: { commitTestCommand: { cmd: 'pytest' } } });
    const cfg = loadProjectAllowConfig(only.root);
    expect(cfg.tokens.size).toBe(0);
    expect(cfg.ignored).toBeNull();
    const out = runHook(READ_HOOK, 'pytest -q', only.root).stdout;
    expect(out).toContain('"permissionDecision":"deny"');
    const withBad = repo({ projectJson: { testCommand: { cmd: 'venv/bin/pytest' }, commitTestCommand: 'bad' } });
    const plain = repo({ projectJson: { testCommand: { cmd: 'venv/bin/pytest' } } });
    const a = loadProjectAllowConfig(withBad.root);
    const b = loadProjectAllowConfig(plain.root);
    expect([...a.tokens]).toEqual([...b.tokens]);
    expect(a.ignored).toEqual(b.ignored);
  });
});

describe('lib unit', () => {
  const dir = (pj) => repo({ projectJson: pj }).root;

  it('readProjectTestCommand: verbatim cmd, copied args, null when undeclared, reasons when broken', () => {
    expect(readProjectTestCommand(dir({ testCommand: { cmd: 'venv/bin/pytest -x', args: ['-q'] } })))
      .toEqual({ command: { cmd: 'venv/bin/pytest -x', args: ['-q'] }, ignored: null });
    expect(readProjectTestCommand(dir(undefined))).toEqual({ command: null, ignored: null });
    expect(readProjectTestCommand(dir({ id: 'x' }))).toEqual({ command: null, ignored: null });
    expect(readProjectTestCommand(dir('{not json')).ignored.reason).toBe('malformed');
    expect(readProjectTestCommand(dir('DIR')).ignored.reason).toBe('unreadable');
    expect(readProjectTestCommand(dir({ commitTestCommand: { cmd: 'x' } }))).toEqual({ command: null, ignored: null });
  });

  it('readProjectCommand: fileLevel only for whole-file failures', () => {
    for (const pj of ['{not json', '[1]', 'DIR']) expect(readProjectCommand(dir(pj), 'testCommand').fileLevel).toBe(true);
    expect(readProjectCommand(dir({ testCommand: 'x' }), 'testCommand').fileLevel).toBe(false);
    expect(readProjectCommitTestCommand(dir({ commitTestCommand: { cmd: 'x' } })).command).toEqual({ cmd: 'x', args: [] });
  });

  it('resolveGateCommand: precedence, sources, and no refusal of interpreters in the gate', () => {
    const d = repo({ projectJson: { testCommand: { cmd: 'python', args: ['-m', 'pytest'] }, commitTestCommand: { cmd: 'sub' } } }).root;
    expect(resolveGateCommand(d, 'npm test')).toMatchObject({ action: 'run', cmd: 'python', args: ['-m', 'pytest'], source: 'project.json' });
    expect(resolveGateCommand(d, undefined, 'merge').source).toBe('project.json');
    expect(resolveGateCommand(d, undefined, 'commit')).toMatchObject({ action: 'run', cmd: 'sub', source: 'project.json#commitTestCommand' });
    expect(resolveGateCommand(dir({ commitTestCommand: 'bad' }), undefined, 'commit')).toMatchObject({ action: 'block' });
    expect(resolveGateCommand(dir({ commitTestCommand: 'bad' }), undefined, 'commit').reason).toContain('commitTestCommand');
    expect(resolveGateCommand(dir({ testCommand: 'bad' }), 'npm test').action).toBe('block');
    expect(resolveGateCommand(dir(undefined), 'x --y')).toMatchObject({ action: 'run', cmd: 'x', args: ['--y'], source: 'policy' });
    const withPkg = repo({ pkg: NPM_MARKER_PKG }).root;
    expect(resolveGateCommand(withPkg, undefined)).toMatchObject({ action: 'run', cmd: 'npm', args: ['test'], source: 'package.json' });
    expect(resolveGateCommand(dir(undefined), undefined).action).toBe('skip');
  });

  it('commitIsGateExempt never throws outside a git repository', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-gate-norepo-'));
    tmps.push(notRepo);
    expect(commitIsGateExempt('git commit -m x', notRepo)).toBe(false);
  });
});

describe('hook copies stay byte-identical to canonical', () => {
  const files = ['write/enforce-git-workflow.mjs', 'write/enforce-branch-workflow.mjs', 'read/redirect-read-bash-to-agent.mjs', 'lib/project-test-command.mjs'];
  for (const f of files) {
    it(`template copy of ${f} matches canonical`, () => {
      const canonical = fs.readFileSync(path.join(ROOT, 'packages', 'hooks', f));
      expect(fs.readFileSync(path.join(ROOT, 'templates', 'generic', '.routekit', 'hooks', f)).equals(canonical)).toBe(true);
    });
    const deployed = path.join(ROOT, '.routekit', 'hooks', f);
    it.skipIf(!fs.existsSync(deployed))(`deployed copy of ${f} matches canonical (skipped while tiers are relocated during guardrails-off)`, () => {
      expect(fs.readFileSync(deployed).equals(fs.readFileSync(path.join(ROOT, 'packages', 'hooks', f)))).toBe(true);
    });
  }
});
