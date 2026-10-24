/**
 * backlog.fix.rag-reembed-leaves-superseded-chunks — re-embedding a changed file must REPLACE
 * all of that file's rows (replace-by-path), not merely upsert the ids of its new rows.
 * Self-contained: temp fixture project, stub embeddings mode, real LanceDB read-back.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';

let embed;
let savedMode;
let savedRksMode;
let savedRoot;
const fixtures = [];

const NOTE = (id, title, body, extra = '') =>
  `---\nid: ${id}\ntitle: ${title}\n${extra}---\n\n${body}\n`;

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'rks-reembed-'));
  fixtures.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reembed-fixture' }), 'utf8');
  writeFileSync(
    join(root, 'notes', 'backlog.alpha.md'),
    NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-KEEP body text that stays.\n\n## Doomed Section\n\nALPHA-DOOMED body text that will be removed.'),
    'utf8',
  );
  writeFileSync(
    join(root, 'notes', 'backlog.beta.md'),
    NOTE('beta-id', 'Beta', '## Beta Section\n\nBETA-STABLE body text never edited.'),
    'utf8',
  );
  writeFileSync(join(root, 'src', 'small.mjs'), 'export const small = 1;\n', 'utf8');
  return root;
}

function dbPath(root) {
  return join(root, '.rks', 'rag', 'fixture.lancedb');
}

function runEmbed(root) {
  return embed({ projectRoot: root, vault: join(root, 'notes'), db: dbPath(root) });
}

async function allRows(root) {
  const db = await connect(dbPath(root));
  const table = await db.openTable('embeddings');
  return table.query().toArray();
}

async function rowsFor(root, relPath) {
  return (await allRows(root)).filter((r) => r.path === relPath);
}

function bigCode(paragraphs) {
  const parts = [];
  for (let i = 0; i < paragraphs; i++) {
    parts.push(`export const value${i} = "${'x'.repeat(400)} paragraph ${i}.";`);
  }
  return parts.join('\n\n') + '\n';
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
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('re-embed replaces a changed file\'s rows (replace-by-path)', { timeout: 120_000 }, () => {
  it('AC1: editing a chunk\'s opening text leaves no row carrying the pre-edit text', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    const before = await rowsFor(root, 'notes/backlog.alpha.md');
    expect(before.some((r) => String(r.text).includes('ALPHA-KEEP'))).toBe(true);

    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-EDITED replacement opening text.\n\n## Doomed Section\n\nALPHA-DOOMED body text that will be removed.'),
      'utf8',
    );
    expect((await runEmbed(root)).ok).toBe(true);

    const after = await rowsFor(root, 'notes/backlog.alpha.md');
    expect(after.some((r) => String(r.text).includes('ALPHA-EDITED'))).toBe(true);
    expect(after.filter((r) => String(r.text).includes('ALPHA-KEEP'))).toEqual([]);
  });

  it('AC2: removing a heading leaves no row for the removed section', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    expect((await rowsFor(root, 'notes/backlog.alpha.md')).some((r) => String(r.text).includes('ALPHA-DOOMED'))).toBe(true);

    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-KEEP body text that stays.'),
      'utf8',
    );
    expect((await runEmbed(root)).ok).toBe(true);

    const after = await rowsFor(root, 'notes/backlog.alpha.md');
    expect(after.filter((r) => String(r.text).includes('ALPHA-DOOMED'))).toEqual([]);
    expect(after.some((r) => String(r.text).includes('ALPHA-KEEP'))).toBe(true);
  });

  it('AC3: a code file shortened to fewer chunks holds exactly the new chunk count for its path', async () => {
    const root = makeProject();
    writeFileSync(join(root, 'src', 'big.mjs'), bigCode(40), 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);
    const before = await rowsFor(root, 'src/big.mjs');
    expect(before.length).toBeGreaterThan(1);

    writeFileSync(join(root, 'src', 'big.mjs'), 'export const shrunk = 1;\n', 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);

    const after = await rowsFor(root, 'src/big.mjs');
    expect(after.length).toBe(1);
    expect(String(after[0].text)).toContain('shrunk');
  });

  it('AC4: after a frontmatter id change every row for the path carries the new dendron_id', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    expect((await rowsFor(root, 'notes/backlog.alpha.md')).some((r) => r.dendron_id === 'alpha-id')).toBe(true);

    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-renamed-id', 'Alpha', '## Keep Section\n\nALPHA-KEEP body text that stays.\n\n## Doomed Section\n\nALPHA-DOOMED body text that will be removed.'),
      'utf8',
    );
    expect((await runEmbed(root)).ok).toBe(true);

    const after = await rowsFor(root, 'notes/backlog.alpha.md');
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((r) => r.dendron_id === 'alpha-id')).toEqual([]);
    expect(after.every((r) => r.dendron_id === 'alpha-renamed-id')).toBe(true);
  });

  it('AC5: re-embedding one file never deletes rows belonging to a different path', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    const betaBefore = (await rowsFor(root, 'notes/backlog.beta.md')).map((r) => r.id).sort();
    const codeBefore = (await rowsFor(root, 'src/small.mjs')).map((r) => r.id).sort();
    expect(betaBefore.length).toBeGreaterThan(0);
    expect(codeBefore.length).toBeGreaterThan(0);

    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-EDITED replacement opening text.'),
      'utf8',
    );
    expect((await runEmbed(root)).ok).toBe(true);

    expect((await rowsFor(root, 'notes/backlog.beta.md')).map((r) => r.id).sort()).toEqual(betaBefore);
    expect((await rowsFor(root, 'src/small.mjs')).map((r) => r.id).sort()).toEqual(codeBefore);
  });

  it('AC6: a file that produced zero rows this run keeps the rows an earlier run wrote', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    const betaBefore = (await rowsFor(root, 'notes/backlog.beta.md')).map((r) => r.id).sort();
    expect(betaBefore.length).toBeGreaterThan(0);

    // beta now yields zero rows (opted out); alpha also changes so the run reaches the write branch.
    writeFileSync(
      join(root, 'notes', 'backlog.beta.md'),
      NOTE('beta-id', 'Beta', '## Beta Section\n\nBETA-STABLE body text never edited.', 'rag: false\n'),
      'utf8',
    );
    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-EDITED replacement opening text.'),
      'utf8',
    );
    expect((await runEmbed(root)).ok).toBe(true);

    expect((await rowsFor(root, 'notes/backlog.beta.md')).map((r) => r.id).sort()).toEqual(betaBefore);
  });

  it('AC7: a run in which no file changed takes the no-change path and leaves the row set identical', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);
    const idsBefore = (await allRows(root)).map((r) => r.id).sort();

    const second = await runEmbed(root);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('no-changes');

    expect((await allRows(root)).map((r) => r.id).sort()).toEqual(idsBefore);
  });

  it('replace-by-path escapes a path containing a single quote', async () => {
    const root = makeProject();
    const quoted = join(root, 'notes', "backlog.o'neil.md");
    writeFileSync(quoted, NOTE('oneil-id', 'ONeil', '## Q Section\n\nQUOTE-OLD body text.'), 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);

    writeFileSync(quoted, NOTE('oneil-id', 'ONeil', '## Q Section\n\nQUOTE-NEW body text.'), 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);

    const after = await rowsFor(root, "notes/backlog.o'neil.md");
    expect(after.some((r) => String(r.text).includes('QUOTE-NEW'))).toBe(true);
    expect(after.filter((r) => String(r.text).includes('QUOTE-OLD'))).toEqual([]);
  });

  it('AC5/AC8: two notes sharing a frontmatter id and identical text: re-embedding one never deletes the other\'s rows (no id-keyed delete)', async () => {
    const root = makeProject();
    const twinBody = '## Shared Section\n\nSHARED-TWIN identical body text in both notes.';
    writeFileSync(
      join(root, 'notes', 'backlog.twin-a.md'),
      NOTE('twin-id', 'Twin', '## Shared Section\n\nTWIN-A-ORIGINAL body text before the edit.'),
      'utf8',
    );
    writeFileSync(join(root, 'notes', 'backlog.twin-b.md'), NOTE('twin-id', 'Twin', twinBody), 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);
    const twinBBefore = (await rowsFor(root, 'notes/backlog.twin-b.md')).map((r) => r.id).sort();
    expect(twinBBefore.length).toBeGreaterThan(0);

    // twin-a is edited to the exact content of twin-b, so its new chunk ids equal twin-b's ids.
    writeFileSync(join(root, 'notes', 'backlog.twin-a.md'), NOTE('twin-id', 'Twin', twinBody), 'utf8');
    expect((await runEmbed(root)).ok).toBe(true);

    // Precondition: the fixture really produces colliding ids across the two paths.
    const twinAIds = (await rowsFor(root, 'notes/backlog.twin-a.md')).map((r) => r.id);
    expect(twinAIds).toEqual(expect.arrayContaining(twinBBefore));

    const twinBAfter = await rowsFor(root, 'notes/backlog.twin-b.md');
    expect(twinBAfter.map((r) => r.id).sort()).toEqual(twinBBefore);
    expect(twinBAfter.some((r) => String(r.text).includes('SHARED-TWIN'))).toBe(true);
  });

  it('AC9: the write-path log reports only the number of unique paths sent, with no row count and no (by id)', async () => {
    const root = makeProject();
    expect((await runEmbed(root)).ok).toBe(true);

    // alpha (two heading sections, so more than one row) and the code file both change: 2 unique paths.
    writeFileSync(
      join(root, 'notes', 'backlog.alpha.md'),
      NOTE('alpha-id', 'Alpha', '## Keep Section\n\nALPHA-EDITED replacement opening text.\n\n## Doomed Section\n\nALPHA-DOOMED body text that will be removed.'),
      'utf8',
    );
    writeFileSync(join(root, 'src', 'small.mjs'), 'export const small = 2;\n', 'utf8');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines;
    try {
      expect((await runEmbed(root)).ok).toBe(true);
      lines = spy.mock.calls.map((args) => args.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }

    expect(lines.filter((l) => l.includes('(by id)'))).toEqual([]);
    expect(lines.filter((l) => /deleted \d+ existing rows/.test(l))).toEqual([]);
    const replaced = lines.filter((l) => /replaced rows for \d+ path/.test(l));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatch(/replaced rows for 2 path/);
  });
});
