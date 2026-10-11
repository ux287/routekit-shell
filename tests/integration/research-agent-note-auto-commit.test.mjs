// backlog.fix.research-agent-note-writes-uncommitted
//
// The research agent's in-agent dendron_create_note / dendron_edit_note /
// dendron_update_field tools commit exactly the note they wrote, via the same
// commitAndEmbedNote path and commit subject as the MCP-level dendron tools.
// Every git-backed case runs in its own temp repo under os.tmpdir(); no git
// command here ever runs with cwd equal to the real repository.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createResearchAgent } from '../../packages/mcp-rks/src/agents/research.mjs';
import { buildDendronCommitMessage } from '../../packages/mcp-rks/src/shared/dendron-commit-message.mjs';
import { assertCleanWorkingTree } from '../../packages/mcp-rks/src/utils/git.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages/mcp-rks/src');

const SPAWN_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

function git(cwd, args) {
  if (path.resolve(cwd) === REPO_ROOT) {
    throw new Error('refusing to run git against the real repository');
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function makeRepo(branch = 'feature/research-note-commit') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-note-commit-'));
  git(root, ['init', '--initial-branch', branch]);
  git(root, ['config', 'user.email', 'test@test.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rks', 'project.json'), JSON.stringify({ id: 'test' }));
  fs.writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function tool(projectRoot, name) {
  const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
  return agent.tools.find(t => t.name === name);
}

const head = (root) => git(root, ['rev-parse', 'HEAD']).out;
const subject = (root) => git(root, ['log', '-1', '--format=%s']).out;
const status = (root) => git(root, ['status', '--porcelain']).out;
const filesIn = (root, sha) => git(root, ['show', '--name-only', '--format=', sha]).out;

async function seed(root, filename) {
  const res = await tool(root, 'dendron_create_note').execute({ filename, title: 'Seed', body: 'seed' });
  expect(res.commitOk).toBe(true);
  return res;
}

function listSrcFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSrcFiles(p));
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('research agent in-agent note writes auto-commit', () => {
  let root;
  beforeEach(() => { root = makeRepo(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('create commits exactly the written note and leaves the tree clean', async () => {
    const res = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-create', title: 'Probe', body: 'x' });
    expect(fs.existsSync(path.join(root, 'notes', 'research.qa-probe-create.md'))).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(true);
    expect(status(root)).toBe('');
    expect(res.commitId).toBe(head(root));
    expect(filesIn(root, res.commitId)).toBe('notes/research.qa-probe-create.md');
    expect(subject(root).startsWith('docs(research)')).toBe(true);
    expect(subject(root).endsWith('create research.qa-probe-create')).toBe(true);
    expect(subject(root)).toBe(buildDendronCommitMessage('dendron_create_note', 'research.qa-probe-create'));
  }, TEST_TIMEOUT_MS);

  it('edit on an already-committed research note commits it and leaves the tree clean', async () => {
    await seed(root, 'research.qa-probe-edit');
    const res = await tool(root, 'dendron_edit_note').execute({ filename: 'research.qa-probe-edit', body: 'edited body' });
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(true);
    expect(status(root)).toBe('');
    expect(subject(root).endsWith('edit research.qa-probe-edit')).toBe(true);
    expect(subject(root)).toBe(buildDendronCommitMessage('dendron_edit_note', 'research.qa-probe-edit'));
    expect(filesIn(root, res.commitId)).toBe('notes/research.qa-probe-edit.md');
  }, TEST_TIMEOUT_MS);

  it('update_field on an already-committed research note commits it and keeps filename and field', async () => {
    await seed(root, 'research.qa-probe-update');
    const res = await tool(root, 'dendron_update_field').execute({ filename: 'research.qa-probe-update', field: 'title', value: 'Updated' });
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(true);
    expect(res.filename).toBe('research.qa-probe-update');
    expect(res.field).toBe('title');
    expect(status(root)).toBe('');
    expect(subject(root).endsWith('update research.qa-probe-update')).toBe(true);
    expect(subject(root)).toBe(buildDendronCommitMessage('dendron_update_field', 'research.qa-probe-update'));
  }, TEST_TIMEOUT_MS);

  it('a non-research id gets the same scope the MCP-level tool derives', async () => {
    const res = await tool(root, 'dendron_create_note').execute({ filename: 'design.arch.qa-probe', body: 'x' });
    expect(res.commitOk).toBe(true);
    expect(subject(root)).toBe(buildDendronCommitMessage('dendron_create_note', 'design.arch.qa-probe'));
    expect(subject(root)).toBe('docs(notes): create design.arch.qa-probe');
  }, TEST_TIMEOUT_MS);

  it('buildDendronCommitMessage is defined in exactly one module that server.mjs and research.mjs both import', () => {
    const definers = listSrcFiles(SRC_ROOT).filter(f => /function\s+buildDendronCommitMessage\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(definers.map(f => path.relative(REPO_ROOT, f))).toEqual(['packages/mcp-rks/src/shared/dendron-commit-message.mjs']);
    const importRe = /import\s*\{[^}]*\bbuildDendronCommitMessage\b[^}]*\}\s*from\s*["'][./]+(?:shared\/)?dendron-commit-message\.mjs["']/;
    expect(fs.readFileSync(path.join(SRC_ROOT, 'server.mjs'), 'utf8')).toMatch(importRe);
    expect(fs.readFileSync(path.join(SRC_ROOT, 'agents/research.mjs'), 'utf8')).toMatch(importRe);
  });

  it('write-set scoping: unrelated staged and untracked files are left alone', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');
    git(root, ['add', 'README.md']);
    fs.writeFileSync(path.join(root, 'notes', 'research.unrelated.md'), 'unrelated\n');

    const res = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-scoped', body: 'x' });
    expect(res.commitOk).toBe(true);
    expect(filesIn(root, res.commitId)).toBe('notes/research.qa-probe-scoped.md');
    expect(git(root, ['diff', '--cached', '--name-only']).out.split('\n')).toContain('README.md');
    expect(git(root, ['show', 'HEAD:README.md']).out).toBe('# test');
    expect(git(root, ['ls-files', '--others', '--exclude-standard']).out.split('\n')).toContain('notes/research.unrelated.md');
  }, TEST_TIMEOUT_MS);

  it('a library refusal (array shrink) makes no commit and keeps the library payload', async () => {
    await seed(root, 'research.qa-probe-shrink');
    const t = tool(root, 'dendron_update_field');
    const grow = await t.execute({ filename: 'research.qa-probe-shrink', field: 'testFiles', value: ['a', 'b', 'c'] });
    expect(grow.commitOk).toBe(true);
    const before = head(root);
    const shrink = await t.execute({ filename: 'research.qa-probe-shrink', field: 'testFiles', value: ['a'] });
    expect(shrink.ok).toBe(false);
    expect(shrink.error).toBe('array_entries_removed');
    expect(shrink.removed).toEqual(['b', 'c']);
    expect(head(root)).toBe(before);
    expect(shrink.commitOk).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  for (const id of ['backlog.feat.qa-probe', 'z_archive.qa-probe']) {
    it(`denied namespace ${id}: create, edit and update are refused before any write or commit`, async () => {
      // A pre-existing committed file so edit/update would otherwise have a target.
      const existing = path.join(root, 'notes', `${id}.md`);
      fs.writeFileSync(existing, '---\nid: "x"\ntitle: "x"\n---\n\nbody\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'seed denied']);
      const before = head(root);
      const beforeStatus = status(root);
      const beforeBytes = fs.readFileSync(existing, 'utf8');

      const create = await tool(root, 'dendron_create_note').execute({ filename: `${id}.new`, body: 'x' });
      const edit = await tool(root, 'dendron_edit_note').execute({ filename: id, body: 'changed' });
      const update = await tool(root, 'dendron_update_field').execute({ filename: id, field: 'title', value: 'changed' });
      for (const res of [create, edit, update]) {
        expect(res.error).toMatch(/cannot write to backlog\.\* or z_archive\.\*/);
        expect(res.ok).toBeUndefined();
      }
      expect(fs.existsSync(path.join(root, 'notes', `${id}.new.md`))).toBe(false);
      expect(fs.readFileSync(existing, 'utf8')).toBe(beforeBytes);
      expect(head(root)).toBe(before);
      expect(status(root)).toBe(beforeStatus);
    }, TEST_TIMEOUT_MS);
  }

  it('index.lock contention reports commitOk false with a reason and leaves the lock in place', async () => {
    const lock = path.join(root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const before = head(root);
    const started = Date.now();
    const res = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-locked', body: 'x' });
    expect(Date.now() - started).toBeLessThan(TEST_TIMEOUT_MS);
    expect(fs.existsSync(path.join(root, 'notes', 'research.qa-probe-locked.md'))).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(false);
    expect(String(res.commitError || '')).not.toBe('');
    expect(res.idempotent).toBeUndefined();
    expect(head(root)).toBe(before);
    expect(fs.existsSync(lock)).toBe(true);

    // Lock recovery: once the other writer's lock is gone, the next write commits.
    fs.rmSync(lock);
    const edit = await tool(root, 'dendron_edit_note').execute({ filename: 'research.qa-probe-locked', body: 'after lock' });
    expect(edit.ok).toBe(true);
    expect(edit.commitOk).toBe(true);
    expect(status(root)).toBe('');
  }, TEST_TIMEOUT_MS);

  it('concurrent creates either commit their own note or report a reason; repo stays sound', async () => {
    const ids = ['research.qa-probe-concurrent-a', 'research.qa-probe-concurrent-b'];
    const t = tool(root, 'dendron_create_note');
    const results = await Promise.all(ids.map(filename => t.execute({ filename, body: filename })));
    results.forEach((res, i) => {
      expect(res.ok).toBe(true);
      if (res.commitOk === true) {
        expect(filesIn(root, res.commitId).split('\n')).toContain(`notes/${ids[i]}.md`);
      } else {
        expect(res.commitOk).toBe(false);
        expect(String(res.commitError || '')).not.toBe('');
      }
    });
    expect(git(root, ['fsck']).code).toBe(0);
    expect(fs.existsSync(path.join(root, '.git', 'index.lock'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('release precondition: assertCleanWorkingTree without notesOk does not throw after a create', async () => {
    const res = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-release', body: 'x' });
    expect(res.commitOk).toBe(true);
    expect(() => assertCleanWorkingTree(root)).not.toThrow();
  }, TEST_TIMEOUT_MS);
});

describe('research agent in-agent note writes on a protected branch', () => {
  let root;
  beforeEach(() => { root = makeRepo('main'); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('writes the note but reports commitOk false naming the protected branch', async () => {
    const before = head(root);
    const res = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-protected', body: 'x' });
    expect(fs.existsSync(path.join(root, 'notes', 'research.qa-probe-protected.md'))).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.commitOk).toBe(false);
    expect(String(res.commitError || '')).toMatch(/main/);
    expect(head(root)).toBe(before);
  }, TEST_TIMEOUT_MS);
});

describe('research agent in-agent note writes in a non-git projectRoot', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-note-nogit-'));
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(root, '.rks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rks', 'project.json'), JSON.stringify({ id: 'test' }));
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('create, edit and update still write and return ok true with commitOk false and a reason', async () => {
    const create = await tool(root, 'dendron_create_note').execute({ filename: 'research.qa-probe-nogit', body: 'x' });
    const edit = await tool(root, 'dendron_edit_note').execute({ filename: 'research.qa-probe-nogit', body: 'y' });
    const update = await tool(root, 'dendron_update_field').execute({ filename: 'research.qa-probe-nogit', field: 'title', value: 'T' });
    for (const res of [create, edit, update]) {
      expect(res.ok).toBe(true);
      expect(res.commitOk).toBe(false);
      expect(String(res.commitError || '')).not.toBe('');
    }
    expect(fs.readFileSync(path.join(root, 'notes', 'research.qa-probe-nogit.md'), 'utf8')).toMatch(/title: "?T"?/);
  }, TEST_TIMEOUT_MS);
});
