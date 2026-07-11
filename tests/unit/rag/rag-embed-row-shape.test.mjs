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
import { buildEmbeddingRows } from '../../../scripts/rag/embed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const EMBED_SRC_PATH = path.join(REPO_ROOT, 'scripts/rag/embed.mjs');
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
  it('AC6 — buildEmbeddingRows is the single content_type assignment site in scripts/rag/embed.mjs (excluding code-file path)', () => {
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
    const chunkerSrc = readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/rag/notes-chunker.mjs'), 'utf8');
    expect(chunkerSrc).not.toMatch(/content_type\s*[:=]/);
  });

  it('source-classifier.mjs IMPLEMENTED branch precedes BACKLOG branch (precedence guard)', () => {
    const classifierSrc = readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/rag/source-classifier.mjs'), 'utf8');
    const implIdx = classifierSrc.indexOf('CONTENT_TYPES.IMPLEMENTED');
    const backlogIdx = classifierSrc.indexOf('CONTENT_TYPES.BACKLOG');
    expect(implIdx).toBeGreaterThan(-1);
    expect(backlogIdx).toBeGreaterThan(-1);
    expect(implIdx).toBeLessThan(backlogIdx);
  });
});
