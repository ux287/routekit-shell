/**
 * backlog.fix.rag-code-walk-excludes-notes-tree
 *
 * The code walk (DEFAULT_CODE_GLOBS = the catch-all glob, cwd projectRoot) must not enumerate
 * the notes tree: every note it sweeps becomes a degraded duplicate row
 * (tags ['code'], status 'unknown', notes.-prefixed slug).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import {
  resolveCodeFileSet,
  computeManifestUpdate,
  RAG_CODE_IGNORE_DEFAULTS,
} from '../../../packages/rag/src/embed.mjs';

const CATCH_ALL = ['**/*'];
const roots = [];

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'rks-notes-excl-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

async function walk(root, incrementalFiles = null) {
  const got = await resolveCodeFileSet({
    projectRoot: root,
    codeGlobs: CATCH_ALL,
    ignore: RAG_CODE_IGNORE_DEFAULTS,
    incrementalFiles,
  });
  return got.map((p) => relative(root, p).split('\\').join('/')).sort();
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('code walk excludes the notes tree', () => {
  const TREE = {
    'notes/backlog.fix.x.md': '---\nstatus: draft\n---\n# X\n',
    'notes/research.2026.01.01.y.md': '# Y\n',
    'notes/sub/deep.md': '# deep\n',
    'src/keep.mjs': 'export const k = 1;\n',
    'keep-root.mjs': 'export const r = 1;\n',
    'z_archive.old.md': '# archived\n',
  };

  it('full walk returns no path under notes/', async () => {
    const got = await walk(makeTree(TREE));
    expect(got.filter((p) => p.startsWith('notes/'))).toEqual([]);
  });

  it('full walk still returns code files outside notes/ (no over-match)', async () => {
    const got = await walk(makeTree(TREE));
    expect(got).toContain('src/keep.mjs');
    expect(got).toContain('keep-root.mjs');
  });

  it('z_archive exclusion does not regress', async () => {
    const got = await walk(makeTree(TREE));
    expect(got.some((p) => p.includes('z_archive'))).toBe(false);
    expect(RAG_CODE_IGNORE_DEFAULTS).toContain('**/z_archive*');
  });

  it('incremental (bounded) walk also drops a changed notes/ file', async () => {
    const root = makeTree(TREE);
    const got = await walk(root, [
      join(root, 'notes/backlog.fix.x.md'),
      join(root, 'src/keep.mjs'),
    ]);
    expect(got).toEqual(['src/keep.mjs']);
  });

  it('pins the chosen pattern shape for a NESTED notes/ directory', async () => {
    // Root-anchored exclusion: a non-root directory named notes is still code.
    const got = await walk(makeTree({ 'packages/foo/notes/helper.mjs': 'x\n' }));
    expect(got).toEqual(['packages/foo/notes/helper.mjs']);
  });
});

describe('prior code-walk rows for notes are pruned, not left behind', () => {
  it('a full walk classifies previously-hashed notes/ code paths as stale', () => {
    const priorHashes = { 'src/keep.mjs': 'h-k', 'notes/backlog.fix.x.md': 'h-n' };
    const { hashes, stale } = computeManifestUpdate({
      priorHashes,
      newHashes: { 'src/keep.mjs': 'h-k' },
    });
    expect(stale).toContain('notes/backlog.fix.x.md');
    expect(hashes).not.toHaveProperty('notes/backlog.fix.x.md');
    expect(hashes).toHaveProperty('src/keep.mjs');
  });
});
