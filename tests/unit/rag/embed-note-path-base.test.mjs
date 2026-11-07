/**
 * backlog.fix.embed-note-path-base-normalization
 *
 * Note rows must store a PROJECT-ROOT-relative `path` (the same base as code rows and as the
 * embed manifest / stale keys), while slug and content_type stay keyed on the vault-relative
 * note name.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEmbeddingRows } from '@routekit/rag/embed';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stubEmbedder = async () => [0.1, 0.2, 0.3];

describe('note rows share the project-root path base', () => {
  let tmpRoot;
  let vaultDir;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rag-note-base-'));
    vaultDir = path.join(tmpRoot, 'notes');
    mkdirSync(vaultDir, { recursive: true });
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function rowsFor(name, body = '---\ntitle: T\n---\n\n# Heading\n\ncontent here\n') {
    const filePath = path.join(vaultDir, name);
    writeFileSync(filePath, body, 'utf8');
    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectRoot: tmpRoot,
      projectSlug: 'note-base-test',
      embedderFn: stubEmbedder,
    });
    return { filePath, result };
  }

  it('stores a note at notes/<name>.md as notes/<name>.md on every row', async () => {
    const { result } = await rowsFor('backlog.feat.foo.md');
    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.path).toBe('notes/backlog.feat.foo.md');
  });

  it('row path equals the manifest / stale key relative(projectRoot, noteFile)', async () => {
    const { filePath, result } = await rowsFor('backlog.fix.bar.md');
    const manifestKey = path.relative(tmpRoot, filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.path).toBe(manifestKey);
  });

  it('no row path is double-prefixed with notes/', async () => {
    const { result } = await rowsFor('research.2026.10.01.baz.md');
    for (const row of result.rows) expect(row.path.startsWith('notes/notes/')).toBe(false);
  });

  it('fallback slug stays vault-relative (no notes. prefix) when frontmatter has no id', async () => {
    const { result } = await rowsFor('backlog.feat.slugcheck.md');
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.slug).toBe('backlog.feat.slugcheck');
  });

  it('content_type classification is unchanged by the new base', async () => {
    const { result } = await rowsFor('backlog.z_implemented.feat.shipped.md');
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.content_type).toBe('implemented');
  });

  it('falls back to the vault-relative path when projectRoot is omitted (test-only callers)', async () => {
    const filePath = path.join(vaultDir, 'backlog.feat.nofallback.md');
    writeFileSync(filePath, '---\ntitle: T\n---\n\n# Heading\n\ncontent here\n', 'utf8');
    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'note-base-test',
      embedderFn: stubEmbedder,
    });
    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.path).toBe('backlog.feat.nofallback.md');
  });

  it('slug, source_class and content_type are identical with and without projectRoot (only path changes)', async () => {
    const filePath = path.join(vaultDir, 'backlog.z_implemented.feat.invariant.md');
    writeFileSync(filePath, '---\ntitle: T\n---\n\n# Heading\n\ncontent here\n', 'utf8');
    const opts = { vaultPath: vaultDir, projectSlug: 'note-base-test', embedderFn: stubEmbedder };
    const withRoot = await buildEmbeddingRows(filePath, { ...opts, projectRoot: tmpRoot });
    const without = await buildEmbeddingRows(filePath, opts);
    expect(withRoot.rows.length).toBeGreaterThan(0);
    expect(withRoot.rows.length).toBe(without.rows.length);
    withRoot.rows.forEach((row, i) => {
      expect(row.slug).toBe(without.rows[i].slug);
      expect(row.source_class).toBe(without.rows[i].source_class);
      expect(row.content_type).toBe(without.rows[i].content_type);
      expect(row.path).toBe('notes/backlog.z_implemented.feat.invariant.md');
      expect(without.rows[i].path).toBe('backlog.z_implemented.feat.invariant.md');
    });
  });

  it('the embed pipeline threads projectRoot into buildEmbeddingRows', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'packages/rag/src/embed.mjs'), 'utf8');
    expect(src).toMatch(/buildEmbeddingRows\(filePath,\s*\{[^}]*projectRoot/);
  });
});
