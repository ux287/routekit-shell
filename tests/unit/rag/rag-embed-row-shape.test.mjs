/**
 * Tests for backlog.fix.rag-embed-classifier-output-not-reaching-lancedb.
 *
 * In-process exercise of the per-note row builder. No subprocess. No model
 * load. Verifies AC1, AC2, AC4 (additive content_type values), and a subset
 * of testReqs covering the classification → row push pipeline.
 *
 * Pin: when classifyContentType returns 'implemented' for a backlog.z_implemented.*
 * path, the resulting row object MUST have content_type='implemented'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildEmbeddingRows } from '@routekit/rag/embed';
import { getNamespaceBoost, NAMESPACE_BOOST } from '@routekit/rag/query-intent';
import { classifyContentType, CONTENT_TYPES } from '@routekit/rag/source-classifier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EMBED_SRC_PATH = path.join(REPO_ROOT, 'packages/rag/src/embed.mjs');
const EMBED_SRC = readFileSync(EMBED_SRC_PATH, 'utf8');

const STUB_VECTOR = [0.1, 0.2, 0.3];
const stubEmbedder = async () => STUB_VECTOR;

describe('buildEmbeddingRows — in-process row builder', () => {
  let tmpRoot;
  let vaultDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rag-rowshape-'));
    vaultDir = path.join(tmpRoot, 'notes');
    mkdirSync(vaultDir, { recursive: true });
    // Project root sentinel so getShouldEmbed doesn't bail on missing project context.
    mkdirSync(path.join(tmpRoot, '.rks'), { recursive: true });
    writeFileSync(path.join(tmpRoot, '.rks', 'project.json'), JSON.stringify({ id: 'row-shape-test' }), 'utf8');
    process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('AC1 + testReq #1 — backlog.z_implemented.* path produces content_type=implemented (load-bearing)', async () => {
    const filePath = path.join(vaultDir, 'backlog.z_implemented.feat.shipped.md');
    writeFileSync(filePath, '---\ntitle: shipped story\n---\n# Shipped\n\nbody for a shipped story.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
      embedderFn: stubEmbedder,
    });

    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.content_type).toBe('implemented');
    }
  });

  it('AC4 regression — backlog.* (unshipped) path produces content_type=backlog', async () => {
    const filePath = path.join(vaultDir, 'backlog.feat.unshipped.md');
    writeFileSync(filePath, '---\ntitle: unshipped story\n---\n# Plan\n\nbody for an unshipped story.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
      embedderFn: stubEmbedder,
    });

    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.content_type).toBe('backlog');
    }
  });

  it('AC4 regression — notes/research.*.md produces content_type=note', async () => {
    const filePath = path.join(vaultDir, 'research.2026.05.28.foo.md');
    writeFileSync(filePath, '---\ntitle: research note\n---\n# R\n\nresearch body.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
      embedderFn: stubEmbedder,
    });

    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.content_type).toBe('note');
    }
  });

  it('deeply nested backlog.z_implemented.fix.deep.path also classifies as implemented', async () => {
    const filePath = path.join(vaultDir, 'backlog.z_implemented.fix.deep.nested.path.md');
    writeFileSync(filePath, '---\ntitle: nested fix\n---\n# x\n\nnested.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
      embedderFn: stubEmbedder,
    });

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.content_type).toBe('implemented');
  });

  it('row contains vector from embedderFn (verifies the DI hook works)', async () => {
    const filePath = path.join(vaultDir, 'backlog.feat.x.md');
    writeFileSync(filePath, '---\ntitle: x\n---\n# x\n\nbody.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
      embedderFn: stubEmbedder,
    });

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.vector).toEqual(STUB_VECTOR);
    }
  });

  it('row contains vector=null when no embedderFn supplied', async () => {
    const filePath = path.join(vaultDir, 'backlog.feat.y.md');
    writeFileSync(filePath, '---\ntitle: y\n---\n# y\n\nbody.\n', 'utf8');

    const result = await buildEmbeddingRows(filePath, {
      vaultPath: vaultDir,
      projectSlug: 'row-shape-test',
    });

    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.vector).toBeNull();
  });
});

describe('Source-grep pins', () => {
  it('AC6 — buildEmbeddingRows is the single content_type assignment site in packages/rag/src/embed.mjs (excluding code-file path)', () => {
    // Count content_type assignments in the file. Expected: one in buildEmbeddingRows
    // (notes path) + one in processCodeFile (code-file path) = 2 total. No others.
    const assignments = EMBED_SRC.match(/(?:^|\s)content_type\s*=/gm) || [];
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    // And both come from classifyContentType — search for the call pattern.
    const fromClassifier = EMBED_SRC.match(/content_type\s*=\s*classifyContentType\(/g) || [];
    expect(fromClassifier.length).toBe(assignments.length);
  });

  it('AC6 — content_type is the FINAL property in the embedding row push (no spread/mutation after it)', () => {
    // In buildEmbeddingRows, the rows.push({...}) literal must end with `content_type,` (final property).
    const buildBlock = EMBED_SRC.slice(
      EMBED_SRC.indexOf('export async function buildEmbeddingRows'),
      EMBED_SRC.indexOf('async function processNote'),
    );
    expect(buildBlock).toMatch(/source_class,\s*content_type,?\s*\}\)\s*;/);
  });

  it('CLI entry point reads RKS_RAG_SCOPE_MODE and RKS_RAG_RESET env vars (root cause for reset-doesn\'t-reset)', () => {
    const cliBlock = EMBED_SRC.slice(EMBED_SRC.indexOf('if (import.meta.url ==='));
    expect(cliBlock).toMatch(/process\.env\.RKS_RAG_SCOPE_MODE/);
    expect(cliBlock).toMatch(/process\.env\.RKS_RAG_RESET/);
    expect(cliBlock).toMatch(/mode:\s*cliMode/);
    expect(cliBlock).toMatch(/reset:\s*cliReset/);
  });

  it('notes-chunker.mjs does not set content_type on chunks (chunker non-interference)', () => {
    const chunkerSrc = readFileSync(path.join(REPO_ROOT, 'packages/rag/src/notes-chunker.mjs'), 'utf8');
    expect(chunkerSrc).not.toMatch(/content_type\s*[:=]/);
  });

  it('source-classifier.mjs IMPLEMENTED branch precedes BACKLOG branch (precedence guard)', () => {
    const classifierSrc = readFileSync(path.join(REPO_ROOT, 'packages/rag/src/source-classifier.mjs'), 'utf8');
    const implIdx = classifierSrc.indexOf('CONTENT_TYPES.IMPLEMENTED');
    const backlogIdx = classifierSrc.indexOf('CONTENT_TYPES.BACKLOG');
    expect(implIdx).toBeGreaterThan(-1);
    expect(backlogIdx).toBeGreaterThan(-1);
    expect(implIdx).toBeLessThan(backlogIdx);
  });
});

// backlog.fix.rag-note-slug-and-type-from-filename-not-frontmatter-id
// The note-row slug comes from the vault-relative FILENAME (dot-name), never from the frontmatter id
// and never from the project-root-relative row path. The frontmatter id is kept in dendron_id.
describe('buildEmbeddingRows — note slug is filename-derived, not frontmatter-id-derived', () => {
  const NANOID = 'z2f64qf8uln035e60ti0brt';
  let tmpRoot;
  let vaultDir;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'rag-rowslug-'));
    vaultDir = path.join(tmpRoot, 'notes');
    mkdirSync(vaultDir, { recursive: true });
    mkdirSync(path.join(tmpRoot, '.rks'), { recursive: true });
    writeFileSync(path.join(tmpRoot, '.rks', 'project.json'), JSON.stringify({ id: 'row-shape-test' }), 'utf8');
    process.env.ROUTEKIT_PROJECT_ROOT = tmpRoot;
  });

  afterEach(() => {
    delete process.env.ROUTEKIT_PROJECT_ROOT;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  const writeNote = (name, frontmatterLines, body = '# Heading\n\nsome body text.\n') => {
    const filePath = path.join(vaultDir, name);
    writeFileSync(filePath, ['---', ...frontmatterLines, '---', body].join('\n'), 'utf8');
    return filePath;
  };

  const build = (filePath, extra = {}) =>
    buildEmbeddingRows(filePath, { vaultPath: vaultDir, projectSlug: 'row-shape-test', embedderFn: stubEmbedder, ...extra });

  it('nanoid frontmatter id: slug is the filename dot-name, not the nanoid', async () => {
    const filePath = writeNote('backlog.feat.nanoid-note.md', [`id: ${NANOID}`, 'title: nanoid note']);
    const result = await build(filePath);
    expect(result.skipped).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.slug).toBe('backlog.feat.nanoid-note');
      expect(row.slug).not.toBe(NANOID);
    }
  });

  it('dot-name frontmatter id that DISAGREES with the filename: slug is filename-derived', async () => {
    const filePath = writeNote('research.topic.actual-file.md', ['id: backlog.feat.something-else', 'title: disagreeing']);
    const result = await build(filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.slug).toBe('research.topic.actual-file');
      expect(row.dendron_id).toBe('backlog.feat.something-else');
    }
  });

  it('no frontmatter id: slug is the same filename-derived dot-name as before', async () => {
    const filePath = writeNote('canon.no-id-note.md', ['title: no id']);
    const result = await build(filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.slug).toBe('canon.no-id-note');
  });

  it('dendron_id still carries the frontmatter id verbatim while slug is filename-derived', async () => {
    const filePath = writeNote('canon.phase-state-machine.md', [`id: ${NANOID}`, 'title: canon']);
    const result = await build(filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.dendron_id).toBe(NANOID);
      expect(row.slug).toBe('canon.phase-state-machine');
    }
  });

  it('with projectRoot = tmpRoot and the note at <projectRoot>/notes/backlog.feat.example.md: slug has no notes segment, path does', async () => {
    const filePath = writeNote('backlog.feat.example.md', [`id: ${NANOID}`, 'title: example']);
    const result = await build(filePath, { projectRoot: tmpRoot });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.slug).toBe('backlog.feat.example');
      expect(row.path).toBe('notes/backlog.feat.example.md');
    }
  });

  it('two files sharing ONE frontmatter id produce distinct slugs, each its own filename dot-name', async () => {
    const a = writeNote('research.alpha.copy-one.md', [`id: ${NANOID}`, 'title: one']);
    const b = writeNote('research.beta.copy-two.md', [`id: ${NANOID}`, 'title: two']);
    const ra = await build(a);
    const rb = await build(b);
    expect(ra.rows.length).toBeGreaterThan(0);
    expect(rb.rows.length).toBeGreaterThan(0);
    for (const row of ra.rows) expect(row.slug).toBe('research.alpha.copy-one');
    for (const row of rb.rows) expect(row.slug).toBe('research.beta.copy-two');
    const slugsA = new Set(ra.rows.map((r) => r.slug));
    const slugsB = new Set(rb.rows.map((r) => r.slug));
    for (const s of slugsA) expect(slugsB.has(s)).toBe(false);
  });

  it('getNamespaceBoost on a research.* nanoid-id row slug returns NAMESPACE_BOOST.research, not 1.0', async () => {
    const filePath = writeNote('research.2026.10.02.topic.md', [`id: ${NANOID}`, 'title: r']);
    const result = await build(filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(NAMESPACE_BOOST.research).not.toBe(1.0);
    for (const row of result.rows) {
      expect(getNamespaceBoost(row.slug, true)).toBe(NAMESPACE_BOOST.research);
    }
  });

  it('getNamespaceBoost on a backlog.z_implemented.* nanoid-id row slug returns NAMESPACE_BOOST.z_implemented, not 1.0', async () => {
    const filePath = writeNote('backlog.z_implemented.feat.shipped-nanoid.md', [`id: ${NANOID}`, 'title: z']);
    const result = await build(filePath);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(NAMESPACE_BOOST.z_implemented).not.toBe(1.0);
    for (const row of result.rows) {
      expect(getNamespaceBoost(row.slug, true)).toBe(NAMESPACE_BOOST.z_implemented);
    }
  });

  it('content_type for a nanoid-id backlog note resolves to BACKLOG before and after (path branch precedes noteType)', async () => {
    const filePath = writeNote('backlog.feat.nanoid-backlog.md', [`id: ${NANOID}`, 'title: b']);
    const result = await build(filePath, { projectRoot: tmpRoot });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.content_type).toBe(CONTENT_TYPES.BACKLOG);
      expect(row.note_type).toBe('backlog');
    }
    // Before the change a nanoid id gave note_type ''; after, 'backlog'. Both classify as BACKLOG.
    expect(classifyContentType('backlog.feat.nanoid-backlog.md', '')).toBe(CONTENT_TYPES.BACKLOG);
    expect(classifyContentType('backlog.feat.nanoid-backlog.md', 'backlog')).toBe(CONTENT_TYPES.BACKLOG);
  });

  it('source guard — embed.mjs no longer overrides the note slug with chunk.dendron_id and still derives the code-walk slug from relPath', () => {
    expect(EMBED_SRC).not.toContain('slug: chunk.dendron_id');
    expect(EMBED_SRC).toContain('slug: relPath.replace(');
  });
});
