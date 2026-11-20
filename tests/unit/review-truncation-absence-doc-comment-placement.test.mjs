/**
 * backlog.fix.review-truncation-absence-doc-comment-placement
 * Source-text test: the TRUNCATION_ABSENCE_CATEGORIES doc comment sits directly
 * above its constant, not above the PLAN_ARCHIVE_PATH_RE JSDoc. Line-relative
 * assertions over the full source; no fixed-size source windows, no line numbers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LINES = readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/review.mjs'), 'utf8').split('\n');

const COMMENT = '/** The absence-claim categories a truncated view cannot support at block severity. */';
const CONST_LINE = "const TRUNCATION_ABSENCE_CATEGORIES = ['ac_coverage', 'test_coverage'];";

describe('review.mjs TRUNCATION_ABSENCE_CATEGORIES doc comment placement', () => {
  it('AC1: the comment appears exactly once and the next line is the constant', () => {
    const idxs = LINES.map((l, i) => (l === COMMENT ? i : -1)).filter((i) => i >= 0);
    expect(idxs).toHaveLength(1);
    expect(LINES[idxs[0] + 1]).toBe(CONST_LINE);
  });

  it('AC1: the constant is declared exactly once', () => {
    expect(LINES.filter((l) => l === CONST_LINE)).toHaveLength(1);
  });

  it('AC2: the line before the PLAN_ARCHIVE_PATH_RE JSDoc opener is not the comment', () => {
    const exportIdx = LINES.findIndex((l) => l.startsWith('export const PLAN_ARCHIVE_PATH_RE ='));
    expect(exportIdx).toBeGreaterThan(0);
    let open = exportIdx - 1;
    while (open >= 0 && LINES[open].trim() !== '/**') open--;
    expect(open).toBeGreaterThan(0);
    expect(LINES[open + 1]).toContain('Exec plan-archive paths');
    expect(LINES[open - 1]).not.toBe(COMMENT);
    expect(LINES[open - 1].trim()).toBe('');
  });
});
