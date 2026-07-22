import { describe, it, expect } from 'vitest';
import { extractExplicitEdits, isImplementationReady } from '../../packages/mcp-rks/src/llm/reviewer.mjs';

const TARGET_FILE = 'services/sqliteService.ts';

function makeBody(marker, content) {
  return `## Some Section\n\n${marker}\n\n${content}`;
}

describe('isImplementationReady', () => {
  it('returns true for a note containing @@SEARCH marker', () => {
    const body = `## Code Changes\n\n@@SEARCH\nsome code\n@@REPLACE\nnew code\n@@END\n`;
    expect(isImplementationReady(body)).toBe(true);
  });

  it('returns true for legacy heading-based SEARCH/REPLACE format (backward compat)', () => {
    const body = `### Edit: src/foo.mjs\n\nSEARCH:\n\`\`\`javascript\nold code\n\`\`\`\nREPLACE:\n\`\`\`javascript\nnew code\n\`\`\`\n`;
    expect(isImplementationReady(body)).toBe(true);
  });

  it('returns true for code-fence SEARCH: format (backward compat)', () => {
    const body = `SEARCH:\`\`\`\nfoo\n\`\`\`\nREPLACE:\`\`\`\nbar\n\`\`\``;
    expect(isImplementationReady(body)).toBe(true);
  });

  it('returns false when no SEARCH markers present', () => {
    const body = `## Problem\n\nSome description without any search blocks.\n`;
    expect(isImplementationReady(body)).toBe(false);
  });
});

describe('extractExplicitEdits — @@SEARCH/@@REPLACE/@@END', () => {
  it('parses a single @@SEARCH/@@REPLACE/@@END block with File: line', () => {
    const body = `File: ${TARGET_FILE}\n@@SEARCH\nold code here\n@@REPLACE\nnew code here\n@@END\n`;
    const edits = extractExplicitEdits(body);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const edit = edits.find(e => e.source === 'at_marker_block');
    expect(edit).toBeDefined();
    expect(edit.search).toBe('old code here');
    expect(edit.replace).toBe('new code here');
    expect(edit.file).toBe(TARGET_FILE);
  });

  it('returns empty array when no @@SEARCH blocks present', () => {
    const body = `## Problem\n\nNo search blocks here.\n`;
    const edits = extractExplicitEdits(body);
    const atMarkerEdits = edits.filter(e => e.source === 'at_marker_block');
    expect(atMarkerEdits).toHaveLength(0);
  });

  it('parses multiple @@SEARCH/@@REPLACE/@@END blocks returning one edit per block', () => {
    const body = [
      `File: ${TARGET_FILE}`,
      `@@SEARCH`,
      `first search`,
      `@@REPLACE`,
      `first replace`,
      `@@END`,
      ``,
      `File: ${TARGET_FILE}`,
      `@@SEARCH`,
      `second search`,
      `@@REPLACE`,
      `second replace`,
      `@@END`,
    ].join('\n');

    const edits = extractExplicitEdits(body);
    const atMarkerEdits = edits.filter(e => e.source === 'at_marker_block');
    expect(atMarkerEdits.length).toBeGreaterThanOrEqual(2);
    expect(atMarkerEdits.some(e => e.search === 'first search' && e.replace === 'first replace')).toBe(true);
    expect(atMarkerEdits.some(e => e.search === 'second search' && e.replace === 'second replace')).toBe(true);
  });

  it('infers file from ### heading when heading looks like a file path', () => {
    const body = `### ${TARGET_FILE}\n\n@@SEARCH\ncode\n@@REPLACE\nnew\n@@END\n`;
    const edits = extractExplicitEdits(body);
    const edit = edits.find(e => e.source === 'at_marker_block');
    expect(edit).toBeDefined();
    expect(edit.file).toBe(TARGET_FILE);
  });
});
