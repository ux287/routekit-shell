/**
 * Integration test for backlog.fix.rag-embed-classifier-output-not-reaching-lancedb.
 *
 * Exercises the row-building → LanceDB write/read roundtrip against a tmpdir
 * fixture vault. Uses buildEmbeddingRows() + a stub embedderFn (no model
 * load) — keeps the load-bearing AC1 assertion (z_implemented rows have
 * content_type='implemented' in actual LanceDB rows) while running in <1s
 * on CI.
 *
 * Why not the full embed() path: that loads @xenova/transformers which downloads
 * ~90MB model + takes 10-30s on a cold CI runner — exceeded the job timeout
 * (exit 124). The model is orthogonal to the load-bearing assertion (content_type
 * classification is purely path-based; vector content has no bearing on AC1).
 *
 * Story: backlog.fix.rag-embed-classifier-output-not-reaching-lancedb
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('rag-embed content_type roundtrip (integration)', () => {
  let tmpRoot;
  let vaultDir;
  let rows;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rag-embed-roundtrip-'));
    vaultDir = path.join(tmpRoot, 'notes');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(path.join(tmpRoot, '.rks', 'rag'), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, '.rks', 'project.json'),
      JSON.stringify({ id: 'roundtrip-test', projectSlug: 'roundtrip-test' }),
      'utf8',
    );

    const implFile = path.join(vaultDir, 'backlog.z_implemented.feat.shipped.md');
    const backlogFile = path.join(vaultDir, 'backlog.feat.unshipped.md');
    writeFileSync(implFile, '---\ntitle: shipped story fixture\nstatus: implemented\n---\n# Shipped\n\nbody for shipped story\n', 'utf8');
    writeFileSync(backlogFile, '---\ntitle: unshipped story fixture\nstatus: open\n---\n# Unshipped\n\nbody for unshipped story\n', 'utf8');

    process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;

    const { buildEmbeddingRows } = await import('../../../scripts/rag/embed.mjs');
    const STUB_VECTOR = [0.1, 0.2, 0.3];
    const stubEmbedder = async () => STUB_VECTOR;

    const implResult = await buildEmbeddingRows(implFile, {
      vaultPath: vaultDir,
      projectSlug: 'roundtrip-test',
      embedderFn: stubEmbedder,
    });
    const backlogResult = await buildEmbeddingRows(backlogFile, {
      vaultPath: vaultDir,
      projectSlug: 'roundtrip-test',
      embedderFn: stubEmbedder,
    });

    const allRows = [...implResult.rows, ...backlogResult.rows];

    // Pre-seed schema inference: LanceDB can't infer Utf8 type from an empty
    // array. Match embed.mjs's pre-write normalization (see lines ~635-640).
    if (!allRows[0].tags || allRows[0].tags.length === 0) allRows[0].tags = ['design-system'];
    if (!allRows[0].heading_path || allRows[0].heading_path.length === 0) allRows[0].heading_path = ['root'];

    const { connect } = await import('@lancedb/lancedb');
    const dbPath = path.join(tmpRoot, '.rks', 'rag', 'lancedb');
    const db = await connect(dbPath);
    const tbl = await db.createTable('embeddings', allRows);
    rows = await tbl.query().select(['path', 'content_type']).toArray();
  }, 60_000);

  afterAll(() => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('AC1 (load-bearing) — backlog.z_implemented.* row has content_type=implemented in LanceDB', () => {
    const implRows = rows.filter((r) => r.path.startsWith('backlog.z_implemented.'));
    expect(implRows.length).toBeGreaterThan(0);
    for (const row of implRows) {
      expect(row.content_type).toBe('implemented');
    }
  });

  it('AC4 — backlog.feat.* (unshipped) row has content_type=backlog in LanceDB', () => {
    const backlogRows = rows.filter(
      (r) => r.path.startsWith('backlog.feat.') && !r.path.includes('z_implemented'),
    );
    expect(backlogRows.length).toBeGreaterThan(0);
    for (const row of backlogRows) {
      expect(row.content_type).toBe('backlog');
    }
  });

  it('AC2 (regression canary) — zero-row-implemented guard: at least one implemented row exists in the table', () => {
    const implCount = rows.filter((r) => r.content_type === 'implemented').length;
    expect(implCount).toBeGreaterThan(0);
  });

  it('No row has content_type=backlog for a backlog.z_implemented.* path (precedence pin)', () => {
    const misclassified = rows.filter(
      (r) => r.path.startsWith('backlog.z_implemented.') && r.content_type === 'backlog',
    );
    expect(misclassified).toEqual([]);
  });
});
