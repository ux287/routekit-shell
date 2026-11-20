// backlog.fix.rks-init-post-attach-commit-refused-by-gitleaks-gate
// Real-git coverage of runInitTool after attachProject has armed a pre-commit hook. execSync `git`
// calls run real git (15s timeout) and every call is recorded with its options; `which gh` /
// `gh auth status` throw unless a case sets ghReady, and `gh repo create` / `git push` are stubbed.
// attachProject calls the real exported ensureGitBootstrap, installs a pre-commit hook in
// .git/hooks (the fail-closed shim, or a foreign hook that always refuses) and resolves
// { secretScan }. Every real spawn carries a timeout; temp parents are removed in afterEach.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const GIT_TIMEOUT_MS = 15_000;
const state = vi.hoisted(() => ({ calls: [], ghReady: false, allUndefined: false }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: (cmd, opts = {}) => {
      const c = String(cmd);
      if (state.allUndefined) {
        state.calls.push({ cmd: c, opts });
        return undefined;
      }
      // headAtCall: the real checked-out branch when a gh/push call is made.
      let headAtCall;
      if (/^gh repo create|^git push/.test(c) && opts.cwd) {
        headAtCall = String(actual.execSync('git rev-parse --abbrev-ref HEAD', { cwd: opts.cwd, encoding: 'utf8', timeout: 15_000 })).trim();
      }
      state.calls.push({ cmd: c, opts, headAtCall });
      if (/^which gh|^gh auth status/.test(c)) { if (state.ghReady) return ''; throw new Error('gh: not found'); }
      if (/^gh repo create/.test(c) || /^git push/.test(c)) return '';
      if (/^\s*git\s/.test(c)) return actual.execSync(c, { timeout: 15_000, ...opts });
      return '';
    },
  };
});

const attachState = vi.hoisted(() => ({ hook: 'shim', secretScan: { armed: false, reason: 'provision_failed' }, bootstrap: true }));
vi.mock('../../packages/cli/src/project/bootstrap.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    attachProject: vi.fn(async ({ projectRoot, branchModel }) => {
      if (!attachState.bootstrap) return undefined;
      const branches = branchModel === '2-branch'
        ? { working: 'main', integration: 'main', production: 'main' }
        : { working: 'dev', integration: 'staging', production: 'main' };
      actual.ensureGitBootstrap({ projectRoot, branches });
      const body = attachState.hook === 'shim'
        ? '#!/bin/sh\n[ "${RKS_ALLOW_UNSCANNED_COMMIT:-}" = "1" ] && exit 0\nexit 1\n'
        : '#!/bin/sh\nexit 1\n';
      const hookPath = path.join(projectRoot, '.git', 'hooks', 'pre-commit');
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, body, { mode: 0o755 });
      return { secretScan: attachState.secretScan };
    }),
  };
});

vi.mock('../../packages/cli/src/project/index.js', () => ({
  upsertProject: vi.fn(),
  getProjectById: vi.fn((id) => ({ id })),
}));

const { runInitTool } = await import('../../packages/mcp-rks/src/server/init.mjs');

const INIT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/mcp-rks/src/server/init.mjs');
const OVERRIDE = 'RKS_ALLOW_UNSCANNED_COMMIT=1';
const SETUP_FAILED = /git\/GitHub setup failed/;
const NAME = 'post-attach-fixture';

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
}
const out = (dir, args) => String(git(dir, args).stdout || '').trim();
const headBranch = (dir) => out(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
const branchExists = (dir, b) => git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).status === 0;
const isAncestor = (dir, a, b) => git(dir, ['merge-base', '--is-ancestor', a, b]).status === 0;
const hasPackageJson = (dir, ref) => out(dir, ['ls-tree', '--name-only', ref, 'package.json']) === 'package.json';
// The commit that introduced package.json (the rks_init initial commit), or '' when none.
const pkgCommit = (dir) => out(dir, ['log', '--all', '--format=%H', '--diff-filter=A', '--', 'package.json']);

const ENV_KEYS = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'RKS_ALLOW_UNSCANNED_COMMIT', 'RKS_INIT_TEST_SENTINEL'];
let saved;
const dirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.RKS_ALLOW_UNSCANNED_COMMIT;
  // Isolate from the user's global git config (core.hooksPath, gpgsign, init.defaultBranch).
  const cfg = path.join(tmp('init-post-attach-cfg-'), 'gitconfig');
  fs.writeFileSync(cfg, '[commit]\n\tgpgsign = false\n');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@test.invalid',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@test.invalid',
    GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1',
  });
  state.calls.length = 0;
  state.ghReady = false;
  state.allUndefined = false;
  attachState.hook = 'shim';
  attachState.secretScan = { armed: false, reason: 'provision_failed' };
  attachState.bootstrap = true;
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (dirs.length) { try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ } }
});

async function init(opts = {}) {
  const parent = tmp('init-post-attach-');
  const res = await runInitTool({ projectName: NAME, parentDir: parent, ...opts });
  return { res, dir: path.join(parent, NAME) };
}
const commitCalls = () => state.calls.filter((c) => c.cmd === 'git commit -F -');

describe('rks_init post-attach initial commit', { timeout: 60_000 }, () => {
  it('fail-closed shim with no scanner: the package.json commit lands and no git/GitHub setup failed warning', async () => {
    const { res, dir } = await init();
    expect(hasPackageJson(dir, 'HEAD'), JSON.stringify(res)).toBe(true);
    expect(pkgCommit(dir)).not.toBe('');
    expect(res.warnings.some((w) => SETUP_FAILED.test(w)), JSON.stringify(res.warnings)).toBe(false);
  });

  it('the git commit -F - call carries RKS_ALLOW_UNSCANNED_COMMIT=1 on top of the inherited process.env', async () => {
    process.env.RKS_INIT_TEST_SENTINEL = 'sentinel-value';
    await init();
    const commits = commitCalls();
    expect(commits).toHaveLength(1);
    const env = commits[0].opts.env;
    expect(env).toBeDefined();
    expect(env.RKS_ALLOW_UNSCANNED_COMMIT).toBe('1');
    expect(env.RKS_INIT_TEST_SENTINEL).toBe('sentinel-value');
  });

  it('no execSync call other than git commit -F - carries RKS_ALLOW_UNSCANNED_COMMIT', async () => {
    state.ghReady = true;
    await init();
    const others = state.calls.filter((c) => c.cmd !== 'git commit -F -');
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) {
      expect(c.opts?.env?.RKS_ALLOW_UNSCANNED_COMMIT, c.cmd).toBeUndefined();
    }
  });

  it('init.mjs source does not contain --no-verify', () => {
    expect(fs.readFileSync(INIT_SRC, 'utf8')).not.toContain('--no-verify');
  });

  it('a foreign pre-commit hook still refuses the commit: warning, no initCommitScanned, no override mention, success true', async () => {
    attachState.hook = 'foreign';
    attachState.secretScan = { armed: true };
    const { res, dir } = await init();
    expect(pkgCommit(dir)).toBe('');
    expect(hasPackageJson(dir, 'HEAD')).toBe(false);
    expect(res.warnings.some((w) => SETUP_FAILED.test(w)), JSON.stringify(res.warnings)).toBe(true);
    expect(res.initCommitScanned).toBeUndefined();
    expect(res.warnings.some((w) => w.includes(OVERRIDE)), JSON.stringify(res.warnings)).toBe(false);
    expect(res.success).toBe(true);
  });

  it('an observed commit sets initCommitScanned false and exactly one warning names its short sha and the override', async () => {
    attachState.secretScan = { armed: true };
    const { res, dir } = await init();
    const sha = pkgCommit(dir);
    expect(sha).not.toBe('');
    const shortSha = out(dir, ['rev-parse', '--short', sha]);
    expect(shortSha).not.toBe('');
    expect(res.initCommitScanned).toBe(false);
    const matches = res.warnings.filter((w) => w.includes(shortSha) && w.includes(OVERRIDE));
    expect(matches, JSON.stringify(res.warnings)).toHaveLength(1);
  });

  it('execSync returning undefined everywhere is not an observed commit: no initCommitScanned, no override or setup-failed warning', async () => {
    state.allUndefined = true;
    attachState.bootstrap = false;
    const { res } = await init();
    expect(res.initCommitScanned).toBeUndefined();
    expect(res.warnings.some((w) => w.includes(OVERRIDE)), JSON.stringify(res.warnings)).toBe(false);
    expect(res.warnings.some((w) => SETUP_FAILED.test(w)), JSON.stringify(res.warnings)).toBe(false);
  });

  it('secretScan { armed: false, reason } is returned and its reason appears in a warning', async () => {
    const scan = { armed: false, reason: 'scanner_provision_failed_xyz' };
    attachState.secretScan = scan;
    const { res } = await init();
    expect(res.secretScan).toEqual(scan);
    expect(res.warnings.some((w) => w.includes('scanner_provision_failed_xyz')), JSON.stringify(res.warnings)).toBe(true);
  });

  it('secretScan { armed: true } pushes no not-armed warning', async () => {
    attachState.secretScan = { armed: true };
    const { res } = await init();
    expect(res.warnings.some((w) => w.includes('secret scan NOT armed')), JSON.stringify(res.warnings)).toBe(false);
  });

  it('attachProject resolving undefined: no not-armed warning and no secretScan field', async () => {
    attachState.bootstrap = false;
    const { res } = await init();
    expect(res.warnings.some((w) => w.includes('secret scan NOT armed')), JSON.stringify(res.warnings)).toBe(false);
    expect(res.secretScan).toBeUndefined();
  });

  it('3-branch after the real bootstrap: main, staging, dev all contain the package.json commit and dev is checked out', async () => {
    const { res, dir } = await init({ branchModel: '3-branch' });
    const sha = pkgCommit(dir);
    expect(sha, JSON.stringify(res)).not.toBe('');
    for (const b of ['main', 'staging', 'dev']) {
      expect(branchExists(dir, b), b).toBe(true);
      expect(isAncestor(dir, sha, b), b).toBe(true);
    }
    expect(headBranch(dir)).toBe('dev');
    expect(res.warnings.some((w) => SETUP_FAILED.test(w)), JSON.stringify(res.warnings)).toBe(false);
  });

  it('2-branch after the real bootstrap: main contains the package.json commit and is checked out', async () => {
    const { res, dir } = await init({ branchModel: '2-branch' });
    const sha = pkgCommit(dir);
    expect(sha, JSON.stringify(res)).not.toBe('');
    expect(isAncestor(dir, sha, 'main')).toBe(true);
    expect(headBranch(dir)).toBe('main');
    expect(res.warnings.some((w) => SETUP_FAILED.test(w)), JSON.stringify(res.warnings)).toBe(false);
  });

  it('3-branch with no repository from attachProject: main, staging, dev all contain the initial commit and dev is checked out', async () => {
    attachState.bootstrap = false;
    const { res, dir } = await init({ branchModel: '3-branch' });
    const sha = pkgCommit(dir);
    expect(sha, JSON.stringify(res)).not.toBe('');
    for (const b of ['main', 'staging', 'dev']) {
      expect(branchExists(dir, b), b).toBe(true);
      expect(isAncestor(dir, sha, b), b).toBe(true);
    }
    expect(headBranch(dir)).toBe('dev');
  });

  it('gh ready, 3-branch: gh repo create --push and git push -u origin staging are issued', async () => {
    state.ghReady = true;
    await init({ branchModel: '3-branch' });
    const cmds = state.calls.map((c) => c.cmd);
    expect(cmds).toContain(`gh repo create ${NAME} --private --source=. --push`);
    expect(cmds).toContain('git push -u origin staging');
  });

  it('gh ready, 3-branch after the real bootstrap: main is what reaches the remote, and dev ends checked out', async () => {
    state.ghReady = true;
    const { dir } = await init({ branchModel: '3-branch' });
    const create = state.calls.find((c) => c.cmd === `gh repo create ${NAME} --private --source=. --push`);
    expect(create).toBeDefined();
    const pushedMain = create.headAtCall === 'main' || state.calls.some((c) => c.cmd === 'git push -u origin main');
    expect(pushedMain, JSON.stringify(state.calls.map((c) => [c.cmd, c.headAtCall]))).toBe(true);
    expect(headBranch(dir)).toBe('dev');
  });
});
