/**
 * Tests for parseTargetsFromMarkdown in targets.mjs
 *
 * Covers:
 * 1. Em-dash (—) separator stripped: "`path` — EDIT — desc" → "path"
 * 2. En-dash (–) separator stripped: "`path` – EDIT – desc" → "path"
 * 3. Spaced hyphen (-) separator stripped: "`path` - EDIT - desc" → "path"
 * 4. Paren format still works: "path (description)" → "path"
 * 5. Plain path with no suffix: "path/to/file.ts" → "path/to/file.ts"
 * 6. Backtick-wrapped path with no suffix: "`path/to/file.ts`" → "path/to/file.ts"
 * 7. Embedded hyphen in filename unaffected: "my-file.ts — EDIT — desc" → "my-file.ts"
 * 8. Full PO Governor standard format: backtick + em-dash + op + em-dash + desc
 */
import { describe, it, expect } from 'vitest';
import { parseTargetsFromMarkdown } from '../../packages/mcp-rks/src/llm/targets.mjs';

function makeBody(bullets) {
  return `## Target Files\n${bullets.map(b => `- ${b}`).join('\n')}\n`;
}

describe('parseTargetsFromMarkdown — em-dash stripping', () => {
  it('strips em-dash (—) separator: path — EDIT — desc', () => {
    const body = makeBody(['`services/sqliteService.ts` — EDIT — Add releaseDiscrepancyToNRC method']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['services/sqliteService.ts']);
  });

  it('strips en-dash (–) separator: path – EDIT – desc', () => {
    const body = makeBody(['`src/foo.mjs` – EDIT – Update foo logic']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/foo.mjs']);
  });

  it('strips spaced hyphen (-) separator: path - EDIT - desc', () => {
    const body = makeBody(['`src/bar.mjs` - CREATE FILE - New bar module']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/bar.mjs']);
  });

  it('handles full PO Governor standard format with CREATE FILE op', () => {
    const body = makeBody([
      '`src/components/Calculator.tsx` — CREATE FILE — Main calculator component',
      '`package.json` — EDIT — Add React dependencies',
    ]);
    expect(parseTargetsFromMarkdown(body)).toEqual([
      'src/components/Calculator.tsx',
      'package.json',
    ]);
  });
});

describe('parseTargetsFromMarkdown — no regressions', () => {
  it('still strips paren trailing description: path (description)', () => {
    const body = makeBody(['packages/cli/src/project/index.js (project subsystem: init and helpers)']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['packages/cli/src/project/index.js']);
  });

  it('plain path with no suffix is returned as-is', () => {
    const body = makeBody(['src/utils/helper.mjs']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/utils/helper.mjs']);
  });

  it('backtick-wrapped path with no suffix strips backticks', () => {
    const body = makeBody(['`src/utils/helper.mjs`']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/utils/helper.mjs']);
  });

  it('embedded hyphen in filename is NOT stripped', () => {
    const body = makeBody(['`my-file.ts` — EDIT — Update hyphenated file']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['my-file.ts']);
  });

  it('path with multiple directory hyphens is NOT stripped', () => {
    const body = makeBody(['`packages/mcp-rks/src/llm/plan-ready.mjs` — EDIT — Fix check']);
    expect(parseTargetsFromMarkdown(body)).toEqual(['packages/mcp-rks/src/llm/plan-ready.mjs']);
  });

  it('returns empty array when no ## Target Files section', () => {
    const body = '## Problem\nSome description\n';
    expect(parseTargetsFromMarkdown(body)).toEqual([]);
  });

  it('deduplicates repeated paths', () => {
    const body = makeBody([
      '`src/foo.mjs` — EDIT — First mention',
      '`src/foo.mjs` — EDIT — Second mention',
    ]);
    expect(parseTargetsFromMarkdown(body)).toEqual(['src/foo.mjs']);
  });
});
