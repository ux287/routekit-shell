/**
 * Source-pin guard for packages/mcp-rks/src/rag/source-classifier.mjs.
 *
 * This file reads the classifier source as a string and asserts that the
 * IMPLEMENTED detection regex targets the actual namespace convention
 * (notes/backlog.z_implemented.*), not the non-existent top-level form
 * (notes/z_implemented.*).
 *
 * Purpose: build-time guard. If the broken pattern ever returns (refactor,
 * revert, copy-paste error), this spec turns red before any classifier
 * change makes it to production.
 *
 * Story: backlog.fix.rag-classifier-wrong-implemented-namespace
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLASSIFIER_PATH = resolve(
  __dirname,
  '../../../packages/mcp-rks/src/rag/source-classifier.mjs'
);

describe('source-classifier source-pin', () => {
  const source = readFileSync(CLASSIFIER_PATH, 'utf8');

  it('does NOT contain the broken pattern "notes/z_implemented" (without backlog. prefix)', () => {
    // The broken pattern would silently classify backlog.z_implemented.*
    // notes as BACKLOG. This guard exists so that pattern cannot regress.
    // We search for the exact substring "notes/z_implemented" and ensure
    // it never appears unescaped or escaped in the classifier source.
    const broken = /notes\\?\/z_implemented/;
    expect(source).not.toMatch(broken);
  });

  it('contains the correct pattern "notes/backlog.z_implemented" matching real namespace', () => {
    // The correct convention: z_implemented is a namespace extension under
    // backlog, so shipped stories live at notes/backlog.z_implemented.*.md.
    // The classifier must reference this exact path form.
    const correct = /notes\\?\/backlog\\?\.z_implemented/;
    expect(source).toMatch(correct);
  });
});
