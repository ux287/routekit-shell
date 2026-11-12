/**
 * backlog.feat.eval-suite-skeleton — the RAG code walk must not enumerate the
 * repo-root evals/ suite (gold sets must never be retrievable by the system they
 * grade), while a NESTED evals/ directory inside a package is still code.
 * Mirrors tests/unit/rag/rag-code-walk-excludes-notes-tree.test.mjs.
 * Pure filesystem fixtures: no ONNX, no LanceDB, no subprocess.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listRagCodeEmbedCandidates,
  RAG_CODE_IGNORE_DEFAULTS,
} from '../../../packages/rag/src/embed.mjs';

const roots = [];

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'rks-evals-excl-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  return root;
}

async function candidates(root) {
  const got = await listRagCodeEmbedCandidates({ projectRoot: root, codeGlob: '**/*' });
  return got.map((p) => p.split('\\').join('/')).sort();
}

const TREE = {
  'evals/catalog.yaml': 'version: 1\n',
  'evals/x/questions.json': '{}\n',
  'evals/x/run.mjs': 'export const x = 1;\n',
  'src/keep.mjs': 'export const keep = 1;\n',
  'packages/foo/evals/bar.mjs': 'export const bar = 1;\n',
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('code walk excludes the root evals tree', () => {
  it('RAG_CODE_IGNORE_DEFAULTS contains the root-anchored evals/** entry', () => {
    expect(RAG_CODE_IGNORE_DEFAULTS).toContain('evals/**');
  });

  it('listRagCodeEmbedCandidates returns no path under root evals/', async () => {
    const got = await candidates(makeTree(TREE));
    expect(got.filter((p) => p.startsWith('evals/'))).toEqual([]);
    // no over-match: ordinary code outside evals/ is still a candidate
    expect(got).toContain('src/keep.mjs');
  });

  it('a nested packages/foo/evals/ file is still a candidate (root-anchored)', async () => {
    const got = await candidates(makeTree(TREE));
    expect(got).toContain('packages/foo/evals/bar.mjs');
  });
});
