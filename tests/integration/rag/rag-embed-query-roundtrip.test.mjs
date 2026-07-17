/**
 * Integration witness for backlog.fix.rag-index-unusable-after-embed.
 *
 * The bug: code rows (processCodeFile) omit `status`; note rows carry it. LanceDB infers the Arrow
 * schema from the records, so a code row landing FIRST created an `embeddings` table with no
 * `status` column, and every reader's `.select([...,'status',...])` then threw "No field named
 * status". The ADD-only mismatch detector never rebuilt it (a code row introduces no new field
 * NAMES), so it survived re-embeds — while embed still reported ok:true (countRows-only gate).
 *
 * This test drives the shared column contract directly against real LanceDB (no model load):
 *  - a table created from rows where the FIRST row is a code-shaped row (no `status`) must still be
 *    queryable through RAG_REQUIRED_COLUMNS after normalizeRagRows() (the write-side guarantee);
 *  - verifyReadContract() must reject a table missing a required column (no silent ok:true);
 *  - selectableProjection() degrades against a legacy/broken table instead of throwing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  RAG_REQUIRED_COLUMNS,
  normalizeRagRows,
  missingRequiredColumns,
  selectableProjection,
  tableFieldNames,
} from '../../../packages/mcp-rks/src/rag/rag-columns.mjs';
import { verifyReadContract } from '../../../scripts/rag/embed.mjs';

// A code-shaped row exactly as processCodeFile builds it: NO `status`, NO `content_type` absent? it
// has content_type but not status. This is the schema-inference seed that used to break the index.
function codeRow(id) {
  return {
    id,
    slug: `src.foo.${id}`,
    title: 'foo.mjs',
    path: 'src/foo.mjs',
    vault: 'roundtrip',
    tags: ['code'],
    updatedAt: new Date(0).toISOString(),
    chunkId: 0,
    text: 'export function foo() {}',
    vector: [0.1, 0.2, 0.3],
    source_class: 'code',
    content_type: 'code',
    // NOTE: no `status` field — this is the bug trigger.
  };
}

function noteRow(id) {
  return {
    id,
    slug: `backlog.feat.${id}`,
    title: 'a note',
    path: `notes/${id}.md`,
    vault: 'roundtrip',
    tags: ['design-system'],
    status: 'open',
    updatedAt: new Date(0).toISOString(),
    chunkId: 0,
    text: 'note body',
    vector: [0.4, 0.5, 0.6],
    heading_path: ['root'],
    content_type: 'backlog',
  };
}

describe('rag embed→query roundtrip: status-column contract (integration)', () => {
  let tmpRoot;
  let connect;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rag-roundtrip-'));
    ({ connect } = await import('@lancedb/lancedb'));
  }, 60_000);

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('CORE: code row first → normalized table is queryable through the full required projection', async () => {
    const rows = normalizeRagRows([codeRow('c1'), noteRow('n1')]);
    const db = await connect(path.join(tmpRoot, 'core'));
    const table = await db.createTable('embeddings', rows);

    // The reader's exact projection must NOT throw "No field named status".
    const out = await table.query().select([...RAG_REQUIRED_COLUMNS]).limit(10).toArray();
    expect(out.length).toBe(2);
    // status materialized on the code row (backfilled) and preserved on the note row.
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(byId.c1.status).toBe('unknown'); // backfilled default
    expect(byId.n1.status).toBe('open');    // preserved
  }, 60_000);

  it('verifyReadContract passes on a contract-satisfying table', async () => {
    const rows = normalizeRagRows([codeRow('c2'), noteRow('n2')]);
    const db = await connect(path.join(tmpRoot, 'ok'));
    const table = await db.createTable('embeddings', rows);
    const res = await verifyReadContract(table);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
  }, 60_000);

  it('ERROR PATH: verifyReadContract fails (no silent ok) on a table missing `status`', async () => {
    // Build a table from UN-normalized code-only rows → LanceDB infers a schema without `status`.
    const db = await connect(path.join(tmpRoot, 'broken'));
    const table = await db.createTable('embeddings', [codeRow('c3'), codeRow('c4')]);

    const fields = await tableFieldNames(table);
    expect(fields).not.toContain('status'); // reproduces the broken index

    const res = await verifyReadContract(table);
    expect(res.ok).toBe(false);
    expect(res.missing).toContain('status');
  }, 60_000);

  it('read-side degrades: selectableProjection drops missing columns instead of throwing', async () => {
    const db = await connect(path.join(tmpRoot, 'degrade'));
    const table = await db.createTable('embeddings', [codeRow('c5')]);
    const fields = await tableFieldNames(table);

    expect(missingRequiredColumns(fields)).toContain('status');
    const projection = selectableProjection(fields);
    expect(projection).not.toContain('status');

    // The degraded projection must not throw.
    const out = await table.query().select(projection).limit(10).toArray();
    expect(out.length).toBe(1);
    expect(out[0].path).toBe('src/foo.mjs');
  }, 60_000);
});
