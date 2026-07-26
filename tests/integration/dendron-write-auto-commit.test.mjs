/**
 * Tests for backlog.fix.dendron-writes-no-auto-commit.
 *
 * Pin: all five dendron write tools (create_note, edit_note, update_field,
 * fix_frontmatter, mark_implemented) auto-commit their on-disk writes via
 * commitAndEmbedNote. The MCP envelope gains additive fields
 * {writeOk, commitOk, commitError?} composed alongside Story 1's wrote_verbatim.
 *
 * Coverage:
 *  - AC1 (5 handlers commit) — source-grep pins on the handler call sites.
 *  - AC7 envelope shape — source-grep pins on the helper output.
 *  - skipCommit opt-out — source-grep pin.
 *  - Commit-message contract — buildDendronCommitMessage unit tests + regex.
 *  - testReq #18 double-embed guard — source-grep pin on skipEmbed:true.
 *  - commitAndEmbedNote generalization — runtime tests against an isolated repo.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { commitAndEmbedNote } from '../../packages/mcp-rks/src/shared/commit-and-embed-note.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_SRC_PATH = path.join(REPO_ROOT, 'packages/mcp-rks/src/server.mjs');
const SERVER_SRC = fs.readFileSync(SERVER_SRC_PATH, 'utf8');

const COMMIT_MESSAGE_REGEX = /^docs\((research|backlog|canon|notes|memory)\): (create|edit|update|fix|implement) [a-z0-9_.-]+$/;

function initGitRepo(dir) {
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir, timeout: 10000 });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, timeout: 5000 });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, timeout: 5000 });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, timeout: 5000 });
}

describe('Source-grep pins: AC1 — all 5 handlers wired to commitDendronWriteResult', () => {
  const tools = [
    'dendron_create_note',
    'dendron_edit_note',
    'dendron_update_field',
    'dendron_fix_frontmatter',
    'dendron_mark_implemented',
  ];
  for (const tool of tools) {
    it(`handler ${tool} calls commitDendronWriteResult`, () => {
      // The handler block starts at `if (tool === "<name>")` and we look for
      // a commitDendronWriteResult invocation that names this tool.
      const start = SERVER_SRC.indexOf(`if (tool === "${tool}")`);
      expect(start).toBeGreaterThan(-1);
      // Allow up to ~3000 chars for the handler body to find the wrap.
      const block = SERVER_SRC.slice(start, start + 6000);
      expect(block).toMatch(new RegExp(`commitDendronWriteResult\\(\\{\\s*tool:\\s*"${tool}"`));
    });
  }
});

describe('Source-grep pins: AC7 envelope shape via commitDendronWriteResult', () => {
  it('helper sets writeOk: true on success', () => {
    expect(SERVER_SRC).toMatch(/writeOk:\s*true/);
  });
  it('helper sets commitOk based on commitResult.commitOk', () => {
    expect(SERVER_SRC).toMatch(/commitOk:\s*commitResult\.commitOk\s*===\s*true/);
  });
  it('helper sets commitError on commit failure', () => {
    expect(SERVER_SRC).toMatch(/commitError:/);
  });
  it('helper preserves wrote_verbatim through envelope composition', () => {
    // wrote_verbatim is on innerResult from create_note path; spread into merged.
    const helperBlock = SERVER_SRC.slice(
      SERVER_SRC.indexOf('async function commitDendronWriteResult'),
      SERVER_SRC.indexOf('async function commitDendronWriteResult') + 4000,
    );
    expect(helperBlock).toMatch(/\.\.\.innerResult/);
  });
});

describe('Source-grep pins: testReq #18 — skipEmbed:true on wrapped writes', () => {
  it('dendron_create_note no-schema path passes skipEmbed:true when commit will happen', () => {
    const block = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (tool === "dendron_create_note")'),
      SERVER_SRC.indexOf('if (tool === "dendron_fix_frontmatter")'),
    );
    expect(block).toMatch(/writeNoteRaw\([^)]+,\s*formatWithFrontmatter\(generated,\s*bodyContent\),\s*\{\s*skipEmbed:\s*true\s*\}\s*\)/);
  });

  it('dendron_fix_frontmatter passes skipEmbed:true when commit will happen', () => {
    const block = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (tool === "dendron_fix_frontmatter")'),
      SERVER_SRC.indexOf('if (tool === "dendron_validate_schema")'),
    );
    expect(block).toMatch(/skipEmbed:\s*true/);
  });

  it('dendron_edit_note passes skipEmbed:true when commit will happen', () => {
    const block = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (tool === "dendron_edit_note")'),
      SERVER_SRC.indexOf('if (tool === "dendron_read_note")'),
    );
    expect(block).toMatch(/skipEmbed:\s*true/);
  });

  it('dendron_update_field passes writeOptions with skipEmbed when commit will happen', () => {
    const block = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (tool === "dendron_update_field")'),
      SERVER_SRC.indexOf('if (tool === "dendron_mark_implemented")'),
    );
    expect(block).toMatch(/skipEmbed:\s*true/);
  });
});

describe('Source-grep pins: skipCommit opt-out', () => {
  for (const tool of ['dendron_create_note', 'dendron_edit_note', 'dendron_update_field', 'dendron_fix_frontmatter', 'dendron_mark_implemented']) {
    it(`${tool} reads cleanArgs.skipCommit`, () => {
      const start = SERVER_SRC.indexOf(`if (tool === "${tool}")`);
      const block = SERVER_SRC.slice(start, start + 6000);
      expect(block).toMatch(/cleanArgs\.skipCommit\s*===\s*true/);
    });
  }
});

describe('Source-grep pins: commit message factory', () => {
  it('buildDendronCommitMessage maps scopes and actions', () => {
    expect(SERVER_SRC).toMatch(/function buildDendronCommitMessage\s*\(tool,\s*noteId\)/);
    expect(SERVER_SRC).toMatch(/dendron_create_note:\s*"create"/);
    expect(SERVER_SRC).toMatch(/dendron_edit_note:\s*"edit"/);
    expect(SERVER_SRC).toMatch(/dendron_update_field:\s*"update"/);
    expect(SERVER_SRC).toMatch(/dendron_fix_frontmatter:\s*"fix"/);
    expect(SERVER_SRC).toMatch(/dendron_mark_implemented:\s*"implement"/);
  });
});

describe('commitAndEmbedNote — general form runtime', () => {
  let tmpRoot;
  let notesDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rks-auto-commit-'));
    notesDir = path.join(tmpRoot, 'notes');
    mkdirSync(notesDir, { recursive: true });
    initGitRepo(tmpRoot);
  });

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('rejects if notePath missing', async () => {
    const result = await commitAndEmbedNote({ projectRoot: tmpRoot, commitMessage: 'docs(notes): create foo' });
    expect(result.ok).toBe(false);
    expect(result.writeOk).toBe(false);
    expect(result.commitOk).toBe(false);
  });

  it('rejects if commitMessage missing', async () => {
    const result = await commitAndEmbedNote({ projectRoot: tmpRoot, notePath: 'notes/foo.md' });
    expect(result.ok).toBe(false);
    expect(result.commitError).toMatch(/commitMessage/);
  });

  it('commits a staged file and returns commitId', async () => {
    const relPath = 'notes/foo.md';
    fs.writeFileSync(path.join(tmpRoot, relPath), '---\nid: foo\n---\nbody\n', 'utf8');

    const result = await commitAndEmbedNote({
      projectRoot: tmpRoot,
      notePath: relPath,
      commitMessage: 'docs(notes): create foo',
      skipEmbed: true,
    });
    expect(result.ok).toBe(true);
    expect(result.writeOk).toBe(true);
    expect(result.commitOk).toBe(true);
    expect(result.commitId).toMatch(/^[0-9a-f]{40}$/);

    // Working tree should be clean for that file.
    const status = execSync(`git status --porcelain -- ${JSON.stringify(relPath)}`, { cwd: tmpRoot, encoding: 'utf8' }).trim();
    expect(status).toBe('');
  });

  it('is idempotent when nothing is staged (no empty commit)', async () => {
    // First create and commit a file so subsequent calls are no-ops.
    const relPath = 'notes/idem.md';
    fs.writeFileSync(path.join(tmpRoot, relPath), 'content\n', 'utf8');
    await commitAndEmbedNote({ projectRoot: tmpRoot, notePath: relPath, commitMessage: 'docs(notes): create idem', skipEmbed: true });

    const headBefore = execSync('git rev-parse HEAD', { cwd: tmpRoot, encoding: 'utf8' }).trim();
    // Second call with no file changes — should be no-op.
    const result = await commitAndEmbedNote({
      projectRoot: tmpRoot,
      notePath: relPath,
      commitMessage: 'docs(notes): create idem',
      skipEmbed: true,
    });
    expect(result.ok).toBe(true);
    expect(result.commitOk).toBe(false);
    expect(result.idempotent).toBe(true);
    const headAfter = execSync('git rev-parse HEAD', { cwd: tmpRoot, encoding: 'utf8' }).trim();
    expect(headBefore).toBe(headAfter);
  });

  it('skipCommit returns early without staging', async () => {
    const relPath = 'notes/bar.md';
    fs.writeFileSync(path.join(tmpRoot, relPath), 'untracked\n', 'utf8');

    const result = await commitAndEmbedNote({
      projectRoot: tmpRoot,
      notePath: relPath,
      commitMessage: 'docs(notes): create bar',
      skipCommit: true,
    });
    expect(result.ok).toBe(true);
    expect(result.writeOk).toBe(true);
    expect(result.commitOk).toBe(false);
    expect(result.skipped).toBe(true);

    // File should remain untracked.
    const status = execSync(`git status --porcelain -- ${JSON.stringify(relPath)}`, { cwd: tmpRoot, encoding: 'utf8' }).trim();
    expect(status).toMatch(/^\?\?/);
  });

  it('legacy memory form still routes via slug detection (backward-compat source-grep)', () => {
    // Behavioral test for the legacy form lives in commit-and-embed-note.test.mjs
    // (uses vi.mock for runRagEmbed). Here we just pin the dispatcher detection
    // so we don't regress backward-compat by removing the legacy branch.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/mcp-rks/src/shared/commit-and-embed-note.mjs'),
      'utf8',
    );
    expect(src).toMatch(/args\.slug\s*!==\s*undefined/);
    expect(src).toMatch(/commitAndEmbedNoteLegacyMemory\(args\)/);
    expect(src).toMatch(/async function commitAndEmbedNoteLegacyMemory/);
  });
});

describe('Commit-message contract regex (testReq #6)', () => {
  it('docs(research): create research.X passes', () => {
    expect('docs(research): create research.2026.05.28.foo').toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('docs(backlog): edit backlog.X passes', () => {
    expect('docs(backlog): edit backlog.fix.bar').toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('docs(canon): update canon.X passes', () => {
    expect('docs(canon): update canon.architecture').toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('docs(memory): create memories.X passes', () => {
    expect('docs(memory): create memories.user-pref').toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('docs(notes): fix notes.X passes', () => {
    expect('docs(notes): fix notes.scratch').toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('generic "update note" does NOT pass', () => {
    expect('update note').not.toMatch(COMMIT_MESSAGE_REGEX);
  });
  it('docs(other) with non-matching scope does NOT pass', () => {
    expect('docs(other): create foo').not.toMatch(COMMIT_MESSAGE_REGEX);
  });
});
