/**
 * The no-change early return in embed() must delete rows for stale paths before it saves a
 * manifest that drops them. Otherwise the rows are orphaned: no later run sees the path again.
 *
 * Stub embeddings only. LanceDB is the real module, wrapped to record delete/add calls and to
 * inject a delete failure.
 *
 * Story: backlog.fix.rag-embed-no-change-return-orphans-stale-rows
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spy = vi.hoisted(() => ({
  failDelete: false,
  failOpenTable: false,
  failConnect: false,
  deleteCalls: [],
  addCalls: 0,
}));

vi.mock('@lancedb/lancedb', async (importOriginal) => {
  const actual = await importOriginal();
  const wrapTable = (t) =>
    new Proxy(t, {
      get(target, key) {
        if (key === 'delete') {
          return async (predicate) => {
            spy.deleteCalls.push(predicate);
            if (spy.failDelete) throw new Error('injected delete failure');
            return target.delete(predicate);
          };
        }
        if (key === 'add') {
          return async (...args) => {
            spy.addCalls += 1;
            return target.add(...args);
          };
        }
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const wrapDb = (db) =>
    new Proxy(db, {
      get(target, key) {
        const v = Reflect.get(target, key, target);
        if (key === 'openTable' || key === 'createTable') {
          return async (...args) => {
            if (key === 'openTable' && spy.failOpenTable) throw new Error('injected openTable failure');
            return wrapTable(await v.apply(target, args));
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  return {
    ...actual,
    connect: async (...args) => {
      if (spy.failConnect) throw new Error('injected connect failure');
      return wrapDb(await actual.connect(...args));
    },
  };
});

const { connect } = await import('@lancedb/lancedb');

let embed;
let fixtures = [];
let savedMode;
let savedRksMode;
let savedRoot;

const dbPath = (root) => join(root, '.rks', 'rag', 'fixture.lancedb');
const manifestPath = (root) => join(root, '.rks', 'rag', 'embed-manifest.json');
const readManifest = (root) => JSON.parse(readFileSync(manifestPath(root), 'utf8'));

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'rks-nochange-stale-'));
  fixtures.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'nochange-fixture' }), 'utf8');
  writeFileSync(join(root, 'notes', 'backlog.alpha.md'), '# alpha\n\nalpha body\n', 'utf8');
  writeFileSync(join(root, 'src', 'one.mjs'), 'export const one = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'two.mjs'), 'export const two = 2;\n', 'utf8');
  writeFileSync(join(root, 'src', 'three.mjs'), 'export const three = 3;\n', 'utf8');
  return root;
}

function runEmbed(root) {
  return embed({ projectRoot: root, vault: join(root, 'notes'), db: dbPath(root) });
}

// embed() may report a failure by returning ok:false or by rejecting; both are "not ok: true".
async function settle(promise) {
  try {
    return await promise;
  } catch (err) {
    return { ok: false, thrown: err };
  }
}

async function rowsFor(root, relPath) {
  const db = await connect(dbPath(root));
  const table = await db.openTable('embeddings');
  return (await table.query().toArray()).filter((r) => r.path === relPath);
}

async function allIds(root) {
  const db = await connect(dbPath(root));
  const table = await db.openTable('embeddings');
  return (await table.query().toArray()).map((r) => r.id).sort();
}

function resetSpy() {
  spy.failDelete = false;
  spy.failOpenTable = false;
  spy.failConnect = false;
  spy.deleteCalls = [];
  spy.addCalls = 0;
}

beforeAll(async () => {
  savedMode = process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;
  savedRksMode = process.env.RKS_RAG_EMBEDDINGS_MODE;
  savedRoot = process.env.ROUTEKIT_PROJECT_ROOT;
  // EMBEDDINGS_MODE is read at module load, so the env must be set BEFORE the dynamic import.
  process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = 'stub';
  process.env.RKS_RAG_EMBEDDINGS_MODE = 'stub';
  delete process.env.ROUTEKIT_PROJECT_ROOT;
  ({ embed } = await import('../../packages/rag/src/embed.mjs'));
});

afterAll(() => {
  if (savedMode === undefined) delete process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE;
  else process.env.ROUTEKIT_RAG_EMBEDDINGS_MODE = savedMode;
  if (savedRksMode === undefined) delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  else process.env.RKS_RAG_EMBEDDINGS_MODE = savedRksMode;
  if (savedRoot === undefined) delete process.env.ROUTEKIT_PROJECT_ROOT;
  else process.env.ROUTEKIT_PROJECT_ROOT = savedRoot;
});

afterEach(() => {
  resetSpy();
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures = [];
});

describe('no-change embed — stale rows', { timeout: 120_000 }, () => {
  it('a no-change full walk deletes rows for code files deleted from disk', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    // Positive control: the rows exist, under the same path string the manifest uses.
    expect((await rowsFor(root, 'src/two.mjs')).length).toBeGreaterThan(0);
    expect((await rowsFor(root, 'src/three.mjs')).length).toBeGreaterThan(0);

    rmSync(join(root, 'src', 'two.mjs'));
    rmSync(join(root, 'src', 'three.mjs'));
    const second = await runEmbed(root);

    expect(second.ok).toBe(true);
    expect(second.reason).toBe('no-changes');
    expect(await rowsFor(root, 'src/two.mjs')).toEqual([]);
    expect(await rowsFor(root, 'src/three.mjs')).toEqual([]);
    expect((await rowsFor(root, 'src/one.mjs')).length).toBeGreaterThan(0);
  });

  it('the stale paths leave the manifest and a following run neither re-embeds them nor finds rows for them', async () => {
    const root = makeProject();
    await runEmbed(root);
    rmSync(join(root, 'src', 'two.mjs'));
    await runEmbed(root);

    const hashes = readManifest(root).hashes;
    expect(hashes['src/two.mjs']).toBeUndefined();
    expect(hashes['src/one.mjs']).toBeDefined();

    const third = await runEmbed(root);
    expect(third.ok).toBe(true);
    expect(third.reason).toBe('no-changes');
    expect(third.embeddedNotes ?? 0).toBe(0);
    expect(third.stalePathsSent).toBe(0);
    expect(third.removedEmbeddings).toBe(0);
    expect(await rowsFor(root, 'src/two.mjs')).toEqual([]);
  });

  it('the no-change return reports stalePathsSent equal to the stale paths sent to deleteByPaths, with removedEmbeddings as an equal alias', async () => {
    const root = makeProject();
    await runEmbed(root);
    rmSync(join(root, 'src', 'two.mjs'));
    rmSync(join(root, 'src', 'three.mjs'));
    resetSpy();

    const second = await runEmbed(root);

    expect(second.reason).toBe('no-changes');
    expect(second.stalePathsSent).toBe(2);
    expect(second.removedEmbeddings).toBe(second.stalePathsSent);
    const sent = spy.deleteCalls.join(' ');
    expect(sent).toContain("'src/two.mjs'");
    expect(sent).toContain("'src/three.mjs'");
  });

  it('when the stale delete throws, the manifest is not rewritten and the result is not ok: true', async () => {
    const root = makeProject();
    await runEmbed(root);
    const before = readFileSync(manifestPath(root), 'utf8');
    rmSync(join(root, 'src', 'two.mjs'));
    spy.failDelete = true;

    const second = await settle(runEmbed(root));

    expect(spy.deleteCalls.length).toBeGreaterThan(0);
    expect(second.ok).not.toBe(true);
    expect(readFileSync(manifestPath(root), 'utf8')).toBe(before);
    expect(readManifest(root).hashes['src/two.mjs']).toBeDefined();

    // The kept hash means the next run retries the delete and succeeds.
    spy.failDelete = false;
    const retry = await runEmbed(root);
    expect(retry.ok).toBe(true);
    expect(retry.stalePathsSent).toBe(1);
    expect(retry.removedEmbeddings).toBe(1);
    expect(await rowsFor(root, 'src/two.mjs')).toEqual([]);
  });

  it('a no-change run with no stale paths writes nothing to the table and still saves the manifest', async () => {
    const root = makeProject();
    await runEmbed(root);
    const hashesBefore = readManifest(root).hashes;
    const idsBefore = await allIds(root);
    resetSpy();

    const second = await runEmbed(root);

    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('no-changes');
    expect(second.stalePathsSent).toBe(0);
    expect(second.removedEmbeddings).toBe(0);
    expect(spy.deleteCalls).toEqual([]);
    expect(spy.addCalls).toBe(0);
    expect(await allIds(root)).toEqual(idsBefore);
    expect(readManifest(root).hashes).toEqual(hashesBefore);
  });

  it('with the embeddings table absent, a no-change run saves the manifest and reports stalePathsSent 0', async () => {
    const root = makeProject();
    await runEmbed(root);
    rmSync(dbPath(root), { recursive: true, force: true });
    rmSync(join(root, 'src', 'two.mjs'));

    const second = await settle(runEmbed(root));

    expect(second.ok).toBe(true);
    expect(second.reason).toBe('no-changes');
    expect(second.stalePathsSent).toBe(0);
    expect(second.removedEmbeddings).toBe(0);
    expect(readManifest(root).hashes['src/two.mjs']).toBeUndefined();
  });

  it('a run that embeds something still prunes rows for a file deleted from disk', async () => {
    const root = makeProject();
    await runEmbed(root);
    expect((await rowsFor(root, 'src/two.mjs')).length).toBeGreaterThan(0);

    rmSync(join(root, 'src', 'two.mjs'));
    writeFileSync(join(root, 'src', 'one.mjs'), 'export const one = 111;\n', 'utf8');
    const second = await runEmbed(root);

    expect(second.ok).toBe(true);
    expect(second.reason).not.toBe('no-changes');
    expect(second.stalePathsSent).toBe(1);
    expect(second.removedEmbeddings).toBe(1);
    expect(await rowsFor(root, 'src/two.mjs')).toEqual([]);
    expect(readManifest(root).hashes['src/two.mjs']).toBeUndefined();
  });

  it('when connect or openTable throws during a no-change run with a stale path, the result is ok: false and the manifest is not saved', async () => {
    for (const point of ['connect', 'openTable']) {
      const root = makeProject();
      expect((await runEmbed(root)).ok).toBe(true);
      const before = readFileSync(manifestPath(root), 'utf8');
      rmSync(join(root, 'src', 'two.mjs'));
      resetSpy();
      if (point === 'connect') spy.failConnect = true;
      else spy.failOpenTable = true;

      const second = await settle(runEmbed(root));

      spy.failConnect = false;
      spy.failOpenTable = false;
      // A bare catch that treats the failure as "table absent" would return ok: true and save a
      // manifest without src/two.mjs, orphaning its rows. The error must reach the outer catch.
      expect(second.ok, point).toBe(false);
      expect(spy.deleteCalls, point).toEqual([]);
      expect(readFileSync(manifestPath(root), 'utf8'), point).toBe(before);
      expect(readManifest(root).hashes['src/two.mjs'], point).toBeDefined();
    }
  });
});
