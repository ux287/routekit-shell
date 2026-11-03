/**
 * Tests for reviewer mode heading-format detection and extraction.
 * Covers both the existing colon format (SEARCH: ```) and the
 * PO Governor heading format (#### SEARCH).
 */

import { describe, it, expect } from 'vitest';
import { isImplementationReady, extractExplicitEdits } from '../../packages/mcp-rks/src/llm/reviewer.mjs';
import { checkReviewerMode } from '../../packages/mcp-rks/src/server/planner-llm.mjs';

// -- Test fixtures --

const COLON_FORMAT = `
### Edit 1: Update patterns
File: packages/mcp-rks/src/llm/reviewer.mjs
SEARCH:
\`\`\`javascript
const patterns = [
  // old patterns
];
\`\`\`
REPLACE:
\`\`\`javascript
const patterns = [
  // new patterns
];
\`\`\`
`;

const HEADING_FORMAT = `
### EDIT: packages/mcp-rks/src/llm/reviewer.mjs

#### SEARCH
\`\`\`javascript
const patterns = [
  // old patterns
];
\`\`\`

#### REPLACE
\`\`\`javascript
const patterns = [
  // new patterns
];
\`\`\`
`;

const HEADING_FORMAT_MULTI = `
### EDIT: src/server/planner.mjs

#### SEARCH
\`\`\`javascript
function plan() {
  return null;
}
\`\`\`

#### REPLACE
\`\`\`javascript
function plan(story) {
  return buildPlan(story);
}
\`\`\`

### EDIT: src/llm/reviewer.mjs

#### SEARCH
\`\`\`javascript
const foo = 1;
\`\`\`

#### REPLACE
\`\`\`javascript
const foo = 2;
\`\`\`
`;

const NO_PATTERNS = `
## Problem

The widget is broken.

## Solution

Fix the widget.

## Acceptance Criteria

- [ ] Widget works
`;

// -- isImplementationReady --

describe('isImplementationReady', () => {
  it('returns true for colon format (SEARCH: ```)', () => {
    expect(isImplementationReady(COLON_FORMAT)).toBe(true);
  });

  it('returns true for heading format (#### SEARCH)', () => {
    expect(isImplementationReady(HEADING_FORMAT)).toBe(true);
  });

  it('returns false when no edit patterns present', () => {
    expect(isImplementationReady(NO_PATTERNS)).toBe(false);
  });
});

// -- extractExplicitEdits --

describe('extractExplicitEdits', () => {
  it('extracts file path from ### EDIT: heading', () => {
    const edits = extractExplicitEdits(HEADING_FORMAT);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].file).toBe('packages/mcp-rks/src/llm/reviewer.mjs');
  });

  it('extracts search block from #### SEARCH + code fence', () => {
    const edits = extractExplicitEdits(HEADING_FORMAT);
    expect(edits[0].search).toContain('// old patterns');
  });

  it('extracts replace block from #### REPLACE + code fence', () => {
    const edits = extractExplicitEdits(HEADING_FORMAT);
    expect(edits[0].replace).toContain('// new patterns');
  });

  it('returns correct {file, search, replace} for heading format', () => {
    const edits = extractExplicitEdits(HEADING_FORMAT);
    expect(edits[0]).toMatchObject({
      file: 'packages/mcp-rks/src/llm/reviewer.mjs',
      source: 'search_replace_block',
    });
    expect(edits[0].search).toBeDefined();
    expect(edits[0].replace).toBeDefined();
  });

  it('still works for colon format (regression)', () => {
    const edits = extractExplicitEdits(COLON_FORMAT);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].file).toBe('packages/mcp-rks/src/llm/reviewer.mjs');
    expect(edits[0].search).toContain('// old patterns');
    expect(edits[0].replace).toContain('// new patterns');
  });

  it('handles multiple ### EDIT: blocks in one story', () => {
    const edits = extractExplicitEdits(HEADING_FORMAT_MULTI);
    expect(edits.length).toBe(2);
    expect(edits[0].file).toBe('src/server/planner.mjs');
    expect(edits[1].file).toBe('src/llm/reviewer.mjs');
  });
});

// -- checkReviewerMode --

describe('checkReviewerMode', () => {
  it('hasSearchBlock is true for heading format', () => {
    const { debugInfo } = checkReviewerMode(HEADING_FORMAT);
    expect(debugInfo.hasSearchBlock).toBe(true);
  });

  it('hasReplaceBlock is true for heading format', () => {
    const { debugInfo } = checkReviewerMode(HEADING_FORMAT);
    expect(debugInfo.hasReplaceBlock).toBe(true);
  });

  it('debug flags remain true for colon format (regression)', () => {
    const { debugInfo } = checkReviewerMode(COLON_FORMAT);
    expect(debugInfo.hasSearchBlock).toBe(true);
    expect(debugInfo.hasReplaceBlock).toBe(true);
  });

  it('useReviewerMode is true for heading format', () => {
    const { useReviewerMode } = checkReviewerMode(HEADING_FORMAT);
    expect(useReviewerMode).toBe(true);
  });
});
