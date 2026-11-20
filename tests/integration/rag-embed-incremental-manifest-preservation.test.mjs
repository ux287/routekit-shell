/**
 * An incremental embed must not destroy the index for files it did not visit.
 *
 * `newHashes` only ever holds files a run visited, and the manifest was written as a full
 * REPLACEMENT of it while `staleFiles` was computed as "everything in the prior manifest
 * that isn't in newHashes". Bounding the walk therefore turned every out-of-scope file into
 * a deletion. This drives the real exported embed() end to end — a full embed, then an
 * incremental embed of one file — and asserts the rest of the manifest survives.
 *
 * Stub embeddings only: no ONNX model is loaded. LanceDB writes go to a temp fixture.
 *
 * Story: backlog.fix.rag-incremental-embed-bounds-code-glob
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { embed } from '../../packages/rag/src/embed.mjs';

let fixtures = [];
let savedMode;
let savedRoot;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'rks-incr-e2e-'));
  fixtures.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'incr-fixture' }), 'utf8');
  writeFileSync(join(root, 'notes', 'backlog.alpha.md'), '# alpha\n\nalpha body\n', 'utf8');
  writeFileSync(join(root, 'notes', 'backlog.beta.md'), '# beta\n\nbeta body\n', 'utf8');
  writeFileSync(join(root, 'src', 'one.mjs'), 'export const one = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'two.mjs'), 'export const two = 2;\n', 'utf8');
  return root;
}

const manifestPath = (root) => join(root, '.rks', 'rag', 'embed-manifest.json');
const readManifest = (root) => JSON.parse(readFileSync(manifestPath(root), 'utf8'));

function runEmbed(root, extra = {}) {
  return embed({
    projectRoot: root,
    vault: join(root, 'notes'),
    db: join(root, '.rks', 'rag', 'fixture.lancedb'),
    ...extra,
  });
}

beforeEach(() => {
  savedMode = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;
  savedRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = 'stub';
  delete process.env.ROUTEKIT_PROJECT_ROOT;
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;
  else process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = savedMode;
  if (savedRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = savedRoot;

  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
});

describe('incremental embed — manifest preservation', () => {
  it('a full embed indexes the whole fixture', async () => {
    const root = makeProject();

    const result = await runEmbed(root);

    expect(result.ok).toBe(true);
    const hashes = readManifest(root).hashes;
    expect(Object.keys(hashes)).toEqual(
      expect.arrayContaining([
        'notes/backlog.alpha.md',
        'notes/backlog.beta.md',
        'src/one.mjs',
        'src/two.mjs',
      ]),
    );
  });

  it('CRITICAL: an incremental embed keeps hashes for every file it did not visit', async () => {
    const root = makeProject();
    await runEmbed(root);
    const before = readManifest(root).hashes;

    writeFileSync(join(root, 'src', 'one.mjs'), 'export const one = 111;\n', 'utf8');
    const result = await runEmbed(root, { files: ['src/one.mjs'] });

    expect(result.ok).toBe(true);
    const after = readManifest(root).hashes;

    // The visited file was re-hashed...
    expect(after['src/one.mjs']).not.toBe(before['src/one.mjs']);
    // ...and everything else survived untouched. Before the fix these were dropped from the
    // manifest AND their embeddings deleted from the table.
    expect(after['src/two.mjs']).toBe(before['src/two.mjs']);
    expect(after['notes/backlog.alpha.md']).toBe(before['notes/backlog.alpha.md']);
    expect(after['notes/backlog.beta.md']).toBe(before['notes/backlog.beta.md']);
  });

  it('CRITICAL: the skip oracle still fires on the next full run', async () => {
    const root = makeProject();
    await runEmbed(root);

    writeFileSync(join(root, 'src', 'one.mjs'), 'export const one = 111;\n', 'utf8');
    await runEmbed(root, { files: ['src/one.mjs'] });

    // If the incremental run had truncated the manifest, this full walk would re-embed
    // everything. It should re-embed nothing — no file changed since the incremental run.
    const third = await runEmbed(root);

    expect(third.ok).toBe(true);
    expect(third.embeddedNotes ?? 0).toBe(0);
  });

  it('an incremental embed of a note bounds itself to that note', async () => {
    const root = makeProject();
    await runEmbed(root);
    const before = readManifest(root).hashes;

    writeFileSync(join(root, 'notes', 'backlog.alpha.md'), '# alpha\n\nchanged\n', 'utf8');
    const result = await runEmbed(root, { files: ['notes/backlog.alpha.md'] });

    expect(result.ok).toBe(true);
    const after = readManifest(root).hashes;

    // Notes arrive project-root-relative from git. Resolving them against the vault instead
    // is what made the old filter match nothing — CI logged "filtered 1840 → 0 notes" — so
    // every note became unvisited and was pruned.
    expect(after['notes/backlog.alpha.md']).not.toBe(before['notes/backlog.alpha.md']);
    expect(after['notes/backlog.beta.md']).toBe(before['notes/backlog.beta.md']);
    expect(after['src/one.mjs']).toBe(before['src/one.mjs']);
  });

  it('a file deleted from disk and named in files IS pruned', async () => {
    const root = makeProject();
    await runEmbed(root);

    rmSync(join(root, 'src', 'two.mjs'));
    const result = await runEmbed(root, { files: ['src/two.mjs'] });

    expect(result.ok).toBe(true);
    const after = readManifest(root).hashes;

    expect(after['src/two.mjs']).toBeUndefined();
    expect(after['src/one.mjs']).toBeDefined();
  });

  it('writes no manifest outside the fixture root', async () => {
    const root = makeProject();
    await runEmbed(root, { files: ['src/one.mjs'] });

    expect(existsSync(manifestPath(root))).toBe(true);
  });
});
