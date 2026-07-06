/**
 * Integration: end-to-end classification of backlog.z_implemented.* notes.
 *
 * This is a classification-boundary integration test: it exercises the
 * classifier with realistic path fixtures (as they would be produced by
 * `rks_rag_embed` scanning a real project's notes/ tree) and asserts that
 * shipped-story notes resolve to IMPLEMENTED.
 *
 * Why boundary-only: standing up a full LanceDB embed harness for one
 * classification check would balloon test runtime. The classifier is the
 * decision point the embed pipeline calls, so exercising it with realistic
 * inputs covers the contract. A future full-pipeline harness can subsume
 * this spec when introduced.
 *
 * Story: backlog.fix.rag-classifier-wrong-implemented-namespace
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyContentType,
  CONTENT_TYPES,
} from '../../../packages/mcp-rks/src/rag/source-classifier.mjs';

describe('rag-embed implemented classification (integration boundary)', () => {
  let tmpRoot;
  let implementedFixture;
  let backlogFixture;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rks-rag-impl-classify-'));
    const notesDir = join(tmpRoot, 'notes');
    mkdirSync(notesDir, { recursive: true });

    implementedFixture = join(
      notesDir,
      'backlog.z_implemented.feat.test-shipped-story.md'
    );
    writeFileSync(
      implementedFixture,
      '---\ntitle: shipped story fixture\nnote_type: backlog\n---\n\n# shipped\n',
      'utf8'
    );

    backlogFixture = join(notesDir, 'backlog.feat.unshipped-story.md');
    writeFileSync(
      backlogFixture,
      '---\ntitle: backlog fixture\nnote_type: backlog\n---\n\n# planned\n',
      'utf8'
    );
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('classifies notes/backlog.z_implemented.* fixture as IMPLEMENTED', () => {
    // Mimic how the embed pipeline produces relative paths: drop the temp
    // root and feed the relative form into the classifier.
    const relPath = implementedFixture.slice(tmpRoot.length + 1);
    expect(relPath.startsWith('notes/backlog.z_implemented.')).toBe(true);
    expect(classifyContentType(relPath, 'backlog')).toBe(
      CONTENT_TYPES.IMPLEMENTED
    );
  });

  it('still classifies sibling notes/backlog.* (non-shipped) as BACKLOG', () => {
    const relPath = backlogFixture.slice(tmpRoot.length + 1);
    expect(relPath.startsWith('notes/backlog.')).toBe(true);
    expect(classifyContentType(relPath, 'backlog')).toBe(CONTENT_TYPES.BACKLOG);
  });

  it('IMPLEMENTED precedence beats BACKLOG even when noteType is "backlog"', () => {
    // Shipped stories retain note_type: backlog in frontmatter — the path
    // pattern must win so query-time re-ranking can downweight historical
    // planning docs without sweeping shipped work into the same bucket.
    const relPath = implementedFixture.slice(tmpRoot.length + 1);
    expect(classifyContentType(relPath, 'backlog')).toBe(
      CONTENT_TYPES.IMPLEMENTED
    );
  });
});
