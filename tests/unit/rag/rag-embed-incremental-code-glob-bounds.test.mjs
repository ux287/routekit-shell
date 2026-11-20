/**
 * Incremental embeds must bound the CODE glob, and must not treat unvisited files as stale.
 *
 * Two defects, one root cause. `incrementalFiles` filtered notes only, after the full glob
 * had already run, and never touched code — so a one-note commit still walked and hashed
 * every code file (3406 in this repo, observed in CI run 31462012004). Bounding that walk
 * naively is worse than the cost it saves: `newHashes` only holds files the run VISITED, and
 * the old stale computation classified everything else as deleted and sent it to
 * deleteByPaths. The bound and the manifest merge have to land together.
 *
 * These exercise the two exported helpers directly — no LanceDB, no ONNX model.
 *
 * Story: backlog.fix.rag-incremental-embed-bounds-code-glob
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  resolveCodeFileSet,
  computeManifestUpdate,
  RAG_CODE_IGNORE_DEFAULTS,
} from '../../../packages/rag/src/embed.mjs';

const CATCH_ALL = ['**/*'];

let fixtures = [];

/** Build a project tree; returns its root. */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'rks-incr-'));
  fixtures.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

const abs = (root, ...rels) => rels.map((r) => join(root, r));

afterEach(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
});

describe('resolveCodeFileSet — bounding by the changed set', () => {
  it('returns exactly the changed paths, not the whole tree', async () => {
    const root = makeTree({
      'a.mjs': 'a', 'b.mjs': 'b', 'c.mjs': 'c', 'src/d.mjs': 'd',
    });

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'a.mjs'),
    });

    expect(got).toEqual(abs(root, 'a.mjs'));
  });

  it('does not enumerate the full tree when bounded', async () => {
    // The observable form of "no unbounded walk": a tree far larger than the changed set
    // yields a result the size of the changed set.
    const files = {};
    for (let i = 0; i < 50; i += 1) files[`gen/f${i}.mjs`] = `x${i}`;
    const root = makeTree(files);

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'gen/f7.mjs', 'gen/f42.mjs'),
    });

    expect(got).toHaveLength(2);
    expect(new Set(got)).toEqual(new Set(abs(root, 'gen/f7.mjs', 'gen/f42.mjs')));
  });

  it('still applies RAG_CODE_IGNORE_DEFAULTS to every incremental path', async () => {
    const root = makeTree({
      'keep.mjs': 'k',
      'node_modules/pkg/index.mjs': 'ignored',
    });

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'keep.mjs', 'node_modules/pkg/index.mjs'),
    });

    expect(got).toEqual(abs(root, 'keep.mjs'));
  });

  it('still applies a CUSTOM codeGlobs to every incremental path', async () => {
    const root = makeTree({ 'keep.mjs': 'k', 'skip.txt': 's' });

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: ['**/*.mjs'],
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'keep.mjs', 'skip.txt'),
    });

    expect(got).toEqual(abs(root, 'keep.mjs'));
  });

  it('is never a superset of the full walk', async () => {
    const root = makeTree({
      'a.mjs': 'a', 'b.txt': 'b', 'node_modules/x/i.mjs': 'x', 'src/c.mjs': 'c',
    });
    const full = await resolveCodeFileSet({
      projectRoot: root, codeGlobs: CATCH_ALL, ignore: RAG_CODE_IGNORE_DEFAULTS,
    });

    // Ask for literally everything, including paths the full walk excludes.
    const bounded = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'a.mjs', 'b.txt', 'node_modules/x/i.mjs', 'src/c.mjs'),
    });

    expect(new Set(bounded)).toEqual(new Set(full));
  });

  it('drops a path that no longer exists on disk without throwing', async () => {
    const root = makeTree({ 'present.mjs': 'p' });

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: abs(root, 'present.mjs', 'deleted.mjs'),
    });

    expect(got).toEqual(abs(root, 'present.mjs'));
  });

  it('ignores changed paths that fall outside the project root', async () => {
    const root = makeTree({ 'in.mjs': 'i' });

    const got = await resolveCodeFileSet({
      projectRoot: root,
      codeGlobs: CATCH_ALL,
      ignore: RAG_CODE_IGNORE_DEFAULTS,
      incrementalFiles: [join(root, 'in.mjs'), join(tmpdir(), 'somewhere-else.mjs')],
    });

    expect(got).toEqual(abs(root, 'in.mjs'));
  });
});

describe('resolveCodeFileSet — full-walk behaviour is preserved', () => {
  it('walks the full tree when incrementalFiles is absent', async () => {
    const root = makeTree({ 'a.mjs': 'a', 'src/b.mjs': 'b' });

    const got = await resolveCodeFileSet({
      projectRoot: root, codeGlobs: CATCH_ALL, ignore: RAG_CODE_IGNORE_DEFAULTS,
    });

    expect(new Set(got)).toEqual(new Set(abs(root, 'a.mjs', 'src/b.mjs')));
  });

  it('walks the full tree when incrementalFiles is an empty array', async () => {
    const root = makeTree({ 'a.mjs': 'a', 'src/b.mjs': 'b' });

    const absent = await resolveCodeFileSet({
      projectRoot: root, codeGlobs: CATCH_ALL, ignore: RAG_CODE_IGNORE_DEFAULTS,
    });
    const empty = await resolveCodeFileSet({
      projectRoot: root, codeGlobs: CATCH_ALL, ignore: RAG_CODE_IGNORE_DEFAULTS, incrementalFiles: [],
    });

    expect(new Set(empty)).toEqual(new Set(absent));
  });
});

describe('computeManifestUpdate — unvisited files are not stale', () => {
  const prior = { 'a.mjs': 'h-a', 'b.mjs': 'h-b', 'notes/n.md': 'h-n' };

  it('CRITICAL: a bounded run carries forward hashes for files it did not visit', () => {
    const { hashes, stale } = computeManifestUpdate({
      priorHashes: prior,
      newHashes: { 'a.mjs': 'h-a2' },
      visitedScope: new Set(['a.mjs']),
    });

    expect(hashes).toEqual({ 'a.mjs': 'h-a2', 'b.mjs': 'h-b', 'notes/n.md': 'h-n' });
    expect(stale).toEqual([]);
  });

  it('CRITICAL: a bounded run does not classify out-of-scope files as stale', () => {
    const { stale } = computeManifestUpdate({
      priorHashes: prior,
      newHashes: { 'a.mjs': 'h-a2' },
      visitedScope: new Set(['a.mjs']),
    });

    // Before the fix this returned ['b.mjs', 'notes/n.md'] and deleteByPaths removed them.
    expect(stale).not.toContain('b.mjs');
    expect(stale).not.toContain('notes/n.md');
  });

  it('a requested path that produced no hash IS stale — that is a real deletion', () => {
    const { hashes, stale } = computeManifestUpdate({
      priorHashes: prior,
      newHashes: {},
      visitedScope: new Set(['b.mjs']),
    });

    expect(stale).toEqual(['b.mjs']);
    expect(hashes).toEqual({ 'a.mjs': 'h-a', 'notes/n.md': 'h-n' });
  });

  it('a full walk still prunes everything it did not re-hash', () => {
    const { hashes, stale } = computeManifestUpdate({
      priorHashes: prior,
      newHashes: { 'a.mjs': 'h-a' },
      visitedScope: null,
    });

    expect(new Set(stale)).toEqual(new Set(['b.mjs', 'notes/n.md']));
    expect(hashes).toEqual({ 'a.mjs': 'h-a' });
  });

  it('accepts an array visitedScope as well as a Set', () => {
    const { stale } = computeManifestUpdate({
      priorHashes: prior,
      newHashes: {},
      visitedScope: ['b.mjs'],
    });

    expect(stale).toEqual(['b.mjs']);
  });
});
