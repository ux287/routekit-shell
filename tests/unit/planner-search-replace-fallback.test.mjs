/**
 * Unit tests for planner @@SEARCH/@@REPLACE fallback when RAG is truncated.
 *
 * Tests the two helper functions exported from planner-context.mjs:
 * - hasRagTruncation: detects truncation markers in RAG content
 * - extractSearchReplaceBlocks: parses @@SEARCH/@@REPLACE/@@END blocks from story note
 *
 * Verifies the planner integration invariants:
 * - Truncated RAG → verbatim @@SEARCH/@@REPLACE fallback used (not LLM synthesis)
 * - Truncated RAG + no blocks → rag_truncated_no_fallback error (not create_file)
 * - Complete RAG → fallback NOT triggered (unchanged behavior)
 */
import { describe, it, expect } from 'vitest';
import { hasRagTruncation, extractSearchReplaceBlocks } from '../../packages/mcp-rks/src/server/planner-context.mjs';

// ─── hasRagTruncation ─────────────────────────────────────────────────────────

describe('hasRagTruncation', () => {
  it('detects truncation marker in RAG content', () => {
    const content = 'export function foo() {\n// ... (42 lines omitted) ...\n}';
    expect(hasRagTruncation(content)).toBe(true);
  });

  it('detects truncation marker with any line count', () => {
    expect(hasRagTruncation('// ... (1 lines omitted) ...')).toBe(true);
    expect(hasRagTruncation('// ... (999 lines omitted) ...')).toBe(true);
  });

  it('returns false when no truncation marker', () => {
    const content = 'export function foo() { return 42; }';
    expect(hasRagTruncation(content)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasRagTruncation('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(hasRagTruncation(null)).toBe(false);
    expect(hasRagTruncation(undefined)).toBe(false);
  });

  it('detects truncation embedded in multiline RAG context', () => {
    const content = [
      '### packages/mcp-rks/src/server/exec.mjs',
      'export async function runExec(opts) {',
      '  const result = await plan(opts);',
      '// ... (120 lines omitted) ...',
      '  return result;',
      '}',
    ].join('\n');
    expect(hasRagTruncation(content)).toBe(true);
  });
});

// ─── extractSearchReplaceBlocks ───────────────────────────────────────────────

describe('extractSearchReplaceBlocks — basic extraction', () => {
  const storyNote = [
    '## Target Files',
    '',
    '### packages/mcp-rks/src/server/exec.mjs',
    '@@SEARCH',
    'const OLD_CONSTANT = 1;',
    '@@REPLACE',
    'const OLD_CONSTANT = 2;',
    '@@END',
  ].join('\n');

  it('extracts a single block for the target file', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/exec.mjs');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('const OLD_CONSTANT = 1;');
    expect(blocks[0].replace).toBe('const OLD_CONSTANT = 2;');
  });

  it('returns empty array when target file not in story', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/planner.mjs');
    expect(blocks).toHaveLength(0);
  });

  it('returns empty array for null/empty storyContent', () => {
    expect(extractSearchReplaceBlocks('', 'exec.mjs')).toHaveLength(0);
    expect(extractSearchReplaceBlocks(null, 'exec.mjs')).toHaveLength(0);
  });

  it('returns empty array for null/empty targetFile', () => {
    expect(extractSearchReplaceBlocks(storyNote, '')).toHaveLength(0);
    expect(extractSearchReplaceBlocks(storyNote, null)).toHaveLength(0);
  });
});

describe('extractSearchReplaceBlocks — multiple blocks per file', () => {
  const storyNote = [
    '### src/server/exec.mjs',
    '@@SEARCH',
    'const A = 1;',
    '@@REPLACE',
    'const A = 2;',
    '@@END',
    '@@SEARCH',
    'const B = 3;',
    '@@REPLACE',
    'const B = 4;',
    '@@END',
  ].join('\n');

  it('extracts multiple blocks for the same file', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'src/server/exec.mjs');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe('const A = 1;');
    expect(blocks[1].search).toBe('const B = 3;');
  });
});

describe('extractSearchReplaceBlocks — multi-file story note', () => {
  const storyNote = [
    '### packages/mcp-rks/src/server/exec.mjs',
    '@@SEARCH',
    'exec search pattern',
    '@@REPLACE',
    'exec replace content',
    '@@END',
    '',
    '### packages/mcp-rks/src/server/planner.mjs',
    '@@SEARCH',
    'planner search pattern',
    '@@REPLACE',
    'planner replace content',
    '@@END',
  ].join('\n');

  it('extracts only blocks for the requested file — exec.mjs', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/exec.mjs');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('exec search pattern');
  });

  it('extracts only blocks for the requested file — planner.mjs', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/planner.mjs');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('planner search pattern');
  });

  it('does NOT bleed blocks from one file section into another', () => {
    const blocksExec = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/exec.mjs');
    expect(blocksExec.every(b => b.search !== 'planner search pattern')).toBe(true);
  });
});

describe('extractSearchReplaceBlocks — path suffix matching', () => {
  const storyNote = [
    '### packages/mcp-rks/src/server/exec.mjs',
    '@@SEARCH',
    'search text',
    '@@REPLACE',
    'replace text',
    '@@END',
  ].join('\n');

  it('matches by full path', () => {
    const blocks = extractSearchReplaceBlocks(storyNote, 'packages/mcp-rks/src/server/exec.mjs');
    expect(blocks).toHaveLength(1);
  });

  it('matches when header is a suffix of targetFile', () => {
    // header = "exec.mjs", targetFile = ".../exec.mjs"
    const shortNote = '### exec.mjs\n@@SEARCH\nfoo\n@@REPLACE\nbar\n@@END';
    const blocks = extractSearchReplaceBlocks(shortNote, 'packages/mcp-rks/src/server/exec.mjs');
    expect(blocks).toHaveLength(1);
  });

  it('matches when targetFile is a suffix of header', () => {
    // header = "packages/.../exec.mjs", targetFile = "exec.mjs"
    const blocks = extractSearchReplaceBlocks(storyNote, 'exec.mjs');
    expect(blocks).toHaveLength(1);
  });
});

// ─── Planner fallback integration invariants ─────────────────────────────────

describe('planner fallback invariants (simulation)', () => {
  /**
   * Simulates the planner's fallback decision logic (planProblem in planner.mjs).
   * Returns: { type: 'verbatim_plan', steps } | { type: 'error', error } | { type: 'llm_path' }
   */
  function simulatePlannerFallback(ragContext, storyNote, targets) {
    if (!hasRagTruncation(ragContext)) {
      return { type: 'llm_path' };
    }
    const allSteps = [];
    const missingBlocks = [];
    for (const tp of targets) {
      const blocks = extractSearchReplaceBlocks(storyNote, tp);
      if (blocks.length > 0) {
        for (const b of blocks) {
          allSteps.push({ action: 'search_replace', path: tp, search: b.search, replace: b.replace, source: 'search_replace_block' });
        }
      } else {
        missingBlocks.push(tp);
      }
    }
    if (allSteps.length > 0) {
      return { type: 'verbatim_plan', steps: allSteps };
    }
    return { type: 'error', error: 'rag_truncated_no_fallback', files: missingBlocks };
  }

  const truncatedRag = 'export function foo() {\n// ... (42 lines omitted) ...\n}';
  const completeRag = 'export function foo() { return 42; }';

  const storyNoteWithBlocks = [
    '### src/server/exec.mjs',
    '@@SEARCH',
    'const OLD = 1;',
    '@@REPLACE',
    'const OLD = 2;',
    '@@END',
  ].join('\n');

  const storyNoteWithoutBlocks = '## Problem\n\nNo @@SEARCH/@@REPLACE blocks here.';

  it('truncated RAG + blocks → verbatim plan with search_replace steps (not LLM synthesis)', () => {
    const result = simulatePlannerFallback(truncatedRag, storyNoteWithBlocks, ['src/server/exec.mjs']);
    expect(result.type).toBe('verbatim_plan');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].action).toBe('search_replace');
    expect(result.steps[0].source).toBe('search_replace_block');
  });

  it('truncated RAG + no blocks → rag_truncated_no_fallback error (not create_file)', () => {
    const result = simulatePlannerFallback(truncatedRag, storyNoteWithoutBlocks, ['src/server/exec.mjs']);
    expect(result.type).toBe('error');
    expect(result.error).toBe('rag_truncated_no_fallback');
    expect(result.files).toContain('src/server/exec.mjs');
  });

  it('complete RAG (no truncation) → LLM path — fallback is NOT triggered', () => {
    const result = simulatePlannerFallback(completeRag, storyNoteWithBlocks, ['src/server/exec.mjs']);
    expect(result.type).toBe('llm_path');
  });

  it('verbatim plan steps are attributed with source: search_replace_block', () => {
    const result = simulatePlannerFallback(truncatedRag, storyNoteWithBlocks, ['src/server/exec.mjs']);
    expect(result.type).toBe('verbatim_plan');
    expect(result.steps.every(s => s.source === 'search_replace_block')).toBe(true);
  });
});
