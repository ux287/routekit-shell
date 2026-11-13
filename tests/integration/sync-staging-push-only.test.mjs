/**
 * Real-git behavioural witness for backlog.fix.governed-push-ahead-only-integration-branch.
 *
 * runSyncStaging({ strategy: 'push-only' }) publishes the integration branch ONLY when it is a
 * clean, strictly-ahead, notes-only fast-forward. Every fixture is a temp working clone plus a
 * bare origin created under os.tmpdir(); nothing here runs git against the rks repository, and
 * every spawn carries an explicit timeout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync as _spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runSyncStaging } from '../../packages/mcp-rks/src/server/git/git-release.mjs';

const SPAWN_TIMEOUT_MS = 30000;
const git = (cwd, args) => _spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
const TMP = fs.realpathSync(os.tmpdir());
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** Run a setup git command and fail loudly if it does not succeed. */
function must(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function configure(cwd) {
  must(cwd, ['config', 'user.email', 'test@test.com']);
  must(cwd, ['config', 'user.name', 'Test']);
  must(cwd, ['config', 'commit.gpgsign', 'false']);
}

/**
 * mkdtemp under TMP → bare origin (main) + working clone. main carries README.md, a top-level
 * note and a packages/ file; the integration branch is created from main and pushed.
 */
function makeFixture({ integration = 'staging' } = {}) {
  const base = fs.mkdtempSync(path.join(TMP, 'rks-push-only-'));
  dirs.push(base);
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  must(base, ['init', '--bare', '--initial-branch', 'main', bare]);
  must(base, ['clone', '--quiet', bare, work]);
  configure(work);
  must(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(work, 'README.md'), 'readme\n');
  fs.mkdirSync(path.join(work, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(work, 'notes', 'root.md'), '# root\n');
  fs.mkdirSync(path.join(work, 'packages'), { recursive: true });
  fs.writeFileSync(path.join(work, 'packages', 'keep.mjs'), 'export const keep = 1;\n');
  must(work, ['add', '.']);
  must(work, ['commit', '-q', '-m', 'initial']);
  must(work, ['push', '-q', 'origin', 'main']);
  must(work, ['checkout', '-q', '-b', integration]);
  must(work, ['push', '-q', '-u', 'origin', integration]);
  expect(fs.realpathSync(work).startsWith(TMP + path.sep)).toBe(true);
  return { base, bare, work, integration };
}

function commit(work, files, message, { remove = [] } = {}) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
    must(work, ['add', '--', rel]);
  }
  for (const rel of remove) must(work, ['rm', '-q', '--', rel]);
  must(work, ['commit', '-q', '-m', message]);
  return must(work, ['rev-parse', 'HEAD']);
}

const remoteRef = (bare, branch) => {
  const r = git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.status === 0 ? r.stdout.trim() : null;
};
const allRemoteRefs = (bare) => must(bare, ['for-each-ref', '--format=%(refname) %(objectname)']);
const head = (work) => must(work, ['rev-parse', 'HEAD']);

async function pushOnly(work, extra = {}) {
  // Isolation guard: the root handed to runSyncStaging is always a temp fixture.
  expect(fs.realpathSync(work).startsWith(TMP + path.sep)).toBe(true);
  return runSyncStaging({ projectRoot: work, strategy: 'push-only', ...extra });
}

function expectNoInProgressOperation(work) {
  const gitDir = path.join(work, '.git');
  expect(fs.existsSync(path.join(gitDir, 'rebase-merge'))).toBe(false);
  expect(fs.existsSync(path.join(gitDir, 'rebase-apply'))).toBe(false);
  expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(false);
}

describe('runSyncStaging push-only', () => {
  it('AC4 pushes a clean notes-only ahead-only integration branch and reports commits + paths', async () => {
    const fx = makeFixture();
    const c1 = commit(fx.work, { 'notes/backlog.x.md': '# x\n' }, 'docs(backlog): x');
    const c2 = commit(fx.work, { 'notes/research.y.md': '# y\n' }, 'docs(research): y');
    const shaAtCall = head(fx.work);
    const before = remoteRef(fx.bare, 'staging');

    const res = await pushOnly(fx.work);

    expect(res.ok).toBe(true);
    expect(res.action).toBe('pushed');
    expect(res.pushed).toBe(2);
    expect(res.sha).toBe(shaAtCall);
    expect(res.commits).toHaveLength(2);
    expect(res.commits.map(c => c.sha).sort()).toEqual([c1, c2].sort());
    const bySha = Object.fromEntries(res.commits.map(c => [c.sha, c.subject]));
    expect(bySha[c1]).toBe('docs(backlog): x');
    expect(bySha[c2]).toBe('docs(research): y');
    expect([...res.paths].sort()).toEqual(['notes/backlog.x.md', 'notes/research.y.md']);
    // Remote confirmation: ls-remote of the bare origin equals the SHA that was HEAD at call time.
    const ls = must(fx.work, ['ls-remote', 'origin', 'refs/heads/staging']).split(/\s+/)[0];
    expect(ls).toBe(shaAtCall);
    // And the report describes exactly origin/<integration>(before)..<sha>.
    const range = must(fx.work, ['rev-list', `${before}..${shaAtCall}`]).split('\n').filter(Boolean);
    expect(range.sort()).toEqual(res.commits.map(c => c.sha).sort());
  });

  describe('AC5 refusals — offending paths', () => {
    const cases = [
      ['(a) packages/ source file', (w) => commit(w, { 'notes/backlog.a.md': 'a\n', 'packages/mcp-rks/src/foo.mjs': 'x\n' }, 'mixed'), 'packages/mcp-rks/src/foo.mjs', 'notes/backlog.a.md'],
      ['(b) root package.json', (w) => commit(w, { 'notes/backlog.b.md': 'b\n', 'package.json': '{}\n' }, 'mixed'), 'package.json', 'notes/backlog.b.md'],
      ['(c) .rks/project.json', (w) => commit(w, { 'notes/backlog.c.md': 'c\n', '.rks/project.json': '{}\n' }, 'mixed'), '.rks/project.json', 'notes/backlog.c.md'],
      ['(d) CHANGELOG.md', (w) => commit(w, { 'notes/backlog.d.md': 'd\n', 'CHANGELOG.md': '# c\n' }, 'mixed'), 'CHANGELOG.md', 'notes/backlog.d.md'],
      ['(e) packages/ -> notes/ rename (--no-renames)', (w) => {
        commit(w, { 'notes/backlog.e.md': 'e\n' }, 'docs: e');
        must(w, ['mv', 'packages/keep.mjs', 'notes/moved.md']);
        must(w, ['commit', '-q', '-m', 'move keep into notes']);
      }, 'packages/keep.mjs', 'notes/moved.md'],
      ['(f) add-then-remove within the range (per-commit listing)', (w) => {
        commit(w, { 'notes/backlog.f.md': 'f\n', 'packages/tmp.mjs': 't\n' }, 'add tmp');
        commit(w, {}, 'remove tmp', { remove: ['packages/tmp.mjs'] });
      }, 'packages/tmp.mjs', 'notes/backlog.f.md'],
    ];

    it.each(cases)('%s is refused, origin unchanged, offending path named', async (_label, build, offending, notePath) => {
      const fx = makeFixture();
      build(fx.work);
      const before = allRemoteRefs(fx.bare);
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(false);
      expect(res.action).not.toBe('pushed');
      expect(res.error).toBe('non_notes_paths');
      expect(res.offendingPaths).toContain(offending);
      expect(res.offendingPaths).not.toContain(notePath);
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });

    it('(g) a range containing a merge commit is refused as unclassifiable, even when every file is a top-level note', async () => {
      const fx = makeFixture();
      must(fx.work, ['checkout', '-q', '-b', 'side']);
      commit(fx.work, { 'notes/backlog.side.md': 's\n' }, 'docs: side');
      must(fx.work, ['checkout', '-q', 'staging']);
      commit(fx.work, { 'notes/backlog.main.md': 'm\n' }, 'docs: main');
      must(fx.work, ['merge', '-q', '--no-ff', '--no-edit', 'side']);
      const before = allRemoteRefs(fx.bare);
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('merge_commit_in_range');
      expect(res.mergeCommits.length).toBeGreaterThan(0);
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });
  });

  describe('AC5 predicate identity — dedicated notes-only predicate, not isCiIgnored', () => {
    it('a notes/qa.x.md-only range (outside CI_IGNORED_PATH_PREFIXES) is pushed', async () => {
      const fx = makeFixture();
      const sha = commit(fx.work, { 'notes/qa.x.md': '# qa\n' }, 'docs(qa): x');
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(true);
      expect(res.action).toBe('pushed');
      expect(res.paths).toEqual(['notes/qa.x.md']);
      expect(remoteRef(fx.bare, 'staging')).toBe(sha);
    });

    it.each(['notes/sub/x.md', 'notes/x.txt', 'notes/X.MD'])('a range touching only %s is refused, origin unchanged', async (p) => {
      const fx = makeFixture();
      commit(fx.work, { [p]: 'x\n' }, `add ${p}`);
      const before = allRemoteRefs(fx.bare);
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(false);
      expect(res.offendingPaths).toEqual([p]);
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });
  });

  describe('AC6 behind / diverged — no pull, rebase or merge', () => {
    function advanceOrigin(fx, file) {
      const other = path.join(fx.base, 'other');
      must(fx.base, ['clone', '--quiet', '--branch', 'staging', fx.bare, other]);
      configure(other);
      const sha = commit(other, { [file]: 'o\n' }, `remote ${file}`);
      must(other, ['push', '-q', 'origin', 'staging']);
      return sha;
    }

    it('behind-only is refused; local HEAD, origin and the tree are untouched', async () => {
      const fx = makeFixture();
      const originSha = advanceOrigin(fx, 'notes/backlog.remote.md');
      const localBefore = head(fx.work);
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('behind');
      expect(head(fx.work)).toBe(localBefore);
      expect(remoteRef(fx.bare, 'staging')).toBe(originSha);
      expect(must(fx.work, ['status', '--porcelain'])).toBe('');
      expectNoInProgressOperation(fx.work);
    });

    it('diverged is refused; local HEAD and origin both unchanged', async () => {
      const fx = makeFixture();
      const localSha = commit(fx.work, { 'notes/backlog.local.md': 'l\n' }, 'docs: local');
      const originSha = advanceOrigin(fx, 'notes/backlog.remote.md');
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('diverged');
      expect(head(fx.work)).toBe(localSha);
      expect(remoteRef(fx.bare, 'staging')).toBe(originSha);
      expectNoInProgressOperation(fx.work);
    });
  });

  describe('AC7 preconditions', () => {
    it('refuses on a dirty tree (modified tracked file, and separately an untracked file)', async () => {
      for (const dirty of [
        (w) => fs.writeFileSync(path.join(w, 'README.md'), 'changed\n'),
        (w) => fs.writeFileSync(path.join(w, 'untracked.txt'), 'u\n'),
      ]) {
        const fx = makeFixture();
        commit(fx.work, { 'notes/backlog.x.md': 'x\n' }, 'docs: x');
        dirty(fx.work);
        const before = allRemoteRefs(fx.bare);
        const res = await pushOnly(fx.work);
        expect(res.ok).toBe(false);
        expect(res.error).toBe('dirty_tree');
        expect(allRemoteRefs(fx.bare)).toBe(before);
      }
    });

    it('refuses on a feature branch and on the production branch (main)', async () => {
      const fx = makeFixture();
      commit(fx.work, { 'notes/backlog.x.md': 'x\n' }, 'docs: x');
      must(fx.work, ['checkout', '-q', '-b', 'feature/x']);
      const before = allRemoteRefs(fx.bare);
      const onFeature = await pushOnly(fx.work);
      expect(onFeature.ok).toBe(false);
      expect(onFeature.error).toBe('wrong_branch');

      must(fx.work, ['checkout', '-q', 'main']);
      commit(fx.work, { 'notes/backlog.main.md': 'm\n' }, 'docs: on main');
      const onMain = await pushOnly(fx.work);
      expect(onMain.ok).toBe(false);
      expect(onMain.error).toBe('on_production_branch');
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });

    it('refuses when baseBranch main makes integration === production, and for explicit equal branches', async () => {
      const fx = makeFixture();
      must(fx.work, ['checkout', '-q', 'main']);
      commit(fx.work, { 'notes/backlog.x.md': 'x\n' }, 'docs: x');
      const mainBefore = remoteRef(fx.bare, 'main');
      const before = allRemoteRefs(fx.bare);

      const viaBase = await pushOnly(fx.work, { projectRecord: { baseBranch: 'main' } });
      expect(viaBase.ok).toBe(false);
      expect(viaBase.error).toBe('integration_equals_production');
      expect(viaBase.integration).toBe('main');
      expect(viaBase.production).toBe('main');

      const viaExplicit = await pushOnly(fx.work, { projectJson: { branches: { working: 'main', integration: 'main', production: 'main' } } });
      expect(viaExplicit.ok).toBe(false);
      expect(viaExplicit.error).toBe('integration_equals_production');

      expect(remoteRef(fx.bare, 'main')).toBe(mainBefore);
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });
  });

  it('AC8 refuses when fetch fails, even though the stale tracking ref shows ahead-only', async () => {
    const fx = makeFixture();
    commit(fx.work, { 'notes/backlog.x.md': 'x\n' }, 'docs: x');
    const stale = must(fx.work, ['rev-list', '--left-right', '--count', 'staging...origin/staging']).split(/\s+/).map(Number);
    expect(stale[0]).toBeGreaterThan(0);
    expect(stale[1]).toBe(0);
    const before = allRemoteRefs(fx.bare);
    must(fx.work, ['remote', 'set-url', 'origin', path.join(fx.base, 'missing.git')]);
    const res = await pushOnly(fx.work);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('fetch_failed');
    expect(res.action).not.toBe('pushed');
    expect(allRemoteRefs(fx.bare)).toBe(before);
  });

  describe('AC9 integration branch comes from branchConfig', () => {
    const projectRecord = { branches: { working: 'feature', integration: 'dev', production: 'main' } };

    it('3-branch (dev) fixture pushes dev when ahead-only', async () => {
      const fx = makeFixture({ integration: 'dev' });
      const sha = commit(fx.work, { 'notes/backlog.dev.md': 'd\n' }, 'docs: dev');
      const res = await pushOnly(fx.work, { projectRecord });
      expect(res.ok).toBe(true);
      expect(res.action).toBe('pushed');
      expect(res.integration).toBe('dev');
      expect(remoteRef(fx.bare, 'dev')).toBe(sha);
      expect(remoteRef(fx.bare, 'staging')).toBe(null);
    });

    it('3-branch (dev) fixture refuses when checked out on staging', async () => {
      const fx = makeFixture({ integration: 'dev' });
      must(fx.work, ['checkout', '-q', '-b', 'staging']);
      commit(fx.work, { 'notes/backlog.s.md': 's\n' }, 'docs: s');
      const before = allRemoteRefs(fx.bare);
      const res = await pushOnly(fx.work, { projectRecord });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('wrong_branch');
      expect(allRemoteRefs(fx.bare)).toBe(before);
    });

    it('2-branch fixture with no branches config uses staging', async () => {
      const fx = makeFixture();
      const sha = commit(fx.work, { 'notes/backlog.two.md': 't\n' }, 'docs: two');
      const res = await pushOnly(fx.work);
      expect(res.ok).toBe(true);
      expect(res.integration).toBe('staging');
      expect(remoteRef(fx.bare, 'staging')).toBe(sha);
    });
  });

  it('AC10 returns action none when equivalent, with no push', async () => {
    const fx = makeFixture();
    const before = allRemoteRefs(fx.bare);
    const res = await pushOnly(fx.work);
    expect(res.ok).toBe(true);
    expect(res.action).toBe('none');
    expect(res.pushed).toBe(0);
    expect(allRemoteRefs(fx.bare)).toBe(before);
  });

  it('AC12 untokened default strategy still fast-forwards a behind-only fixture', async () => {
    const fx = makeFixture();
    const other = path.join(fx.base, 'other');
    must(fx.base, ['clone', '--quiet', '--branch', 'staging', fx.bare, other]);
    configure(other);
    const originSha = commit(other, { 'src/code.mjs': 'c\n' }, 'feat: code');
    must(other, ['push', '-q', 'origin', 'staging']);

    expect(fs.realpathSync(fx.work).startsWith(TMP + path.sep)).toBe(true);
    const res = await runSyncStaging({ projectRoot: fx.work });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('pulled');
    expect(head(fx.work)).toBe(originSha);
  });
});
