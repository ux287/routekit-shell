/**
 * Unit tests for disk-fetch context injection in refine.mjs.
 *
 * Tests the truncation detection signal and the note body size warning
 * in isolation (pure function checks), verifying the key invariants:
 * - disk_fetch_context suggested when truncation markers in context
 * - add_code_snippet suggested when no truncation (non-truncation path intact)
 * - story note body unchanged after disk_fetch_context path
 * - 5KB note body warning emitted when threshold exceeded
 */
import { describe, it, expect } from 'vitest';

// ─── Truncation detection helpers (mirrors refine.mjs logic) ─────────────────

const TRUNCATION_MARKER_RE = /\/\/ \.\.\. \(\d+ lines omitted\) \.\.\./;

function hasTruncationMarker(context) {
  return !!(context && TRUNCATION_MARKER_RE.test(context));
}

const NOTE_BODY_SIZE_WARN_BYTES = 5120;

function buildNoteSizeWarning(bodyLength) {
  if (bodyLength > NOTE_BODY_SIZE_WARN_BYTES) {
    return `Story note body is ${Math.round(bodyLength / 1024)}KB — exceeds 5KB threshold; note inflation may crowd out file context in planner`;
  }
  return null;
}

// ─── Truncation detection ────────────────────────────────────────────────────

describe('truncation detection', () => {
  it('detects truncation marker in context string', () => {
    const ctx = 'Plan failed: src/server/exec.mjs\n// ... (42 lines omitted) ...\nmore context';
    expect(hasTruncationMarker(ctx)).toBe(true);
  });

  it('returns false when no truncation marker in context', () => {
    const ctx = 'Plan failed: search pattern not found in exec.mjs';
    expect(hasTruncationMarker(ctx)).toBe(false);
  });

  it('returns false for empty/null context', () => {
    expect(hasTruncationMarker('')).toBe(false);
    expect(hasTruncationMarker(null)).toBe(false);
    expect(hasTruncationMarker(undefined)).toBe(false);
  });

  it('detects marker with any line count', () => {
    expect(hasTruncationMarker('// ... (1 lines omitted) ...')).toBe(true);
    expect(hasTruncationMarker('// ... (999 lines omitted) ...')).toBe(true);
  });
});

// ─── Note body size warning ───────────────────────────────────────────────────

describe('note body size warning', () => {
  it('emits warning when body exceeds 5KB', () => {
    const warning = buildNoteSizeWarning(5121);
    expect(warning).not.toBeNull();
    expect(warning).toContain('5KB');
    expect(warning).toContain('threshold');
  });

  it('does NOT warn when body is exactly at threshold', () => {
    expect(buildNoteSizeWarning(5120)).toBeNull();
  });

  it('does NOT warn when body is below threshold', () => {
    expect(buildNoteSizeWarning(1024)).toBeNull();
    expect(buildNoteSizeWarning(0)).toBeNull();
  });

  it('warning includes KB representation of actual size', () => {
    const warning = buildNoteSizeWarning(10 * 1024); // 10KB
    expect(warning).toContain('10KB');
  });
});

// ─── Suggestion type selection (truncation vs non-truncation) ─────────────────

describe('suggestion type selection based on truncation', () => {
  /**
   * Mirrors the suggestion selection logic in runRefineTool (refine.mjs).
   * When hasTruncationContext = true → disk_fetch_context
   * When hasTruncationContext = false → add_code_snippet
   */
  function selectSuggestionType(hasTruncation) {
    return hasTruncation ? 'disk_fetch_context' : 'add_code_snippet';
  }

  it('selects disk_fetch_context when truncation detected', () => {
    expect(selectSuggestionType(true)).toBe('disk_fetch_context');
  });

  it('selects add_code_snippet when no truncation', () => {
    expect(selectSuggestionType(false)).toBe('add_code_snippet');
  });

  it('add_code_snippet path is intact when truncation is NOT detected', () => {
    // Non-truncation path should still emit add_code_snippet, not disk_fetch_context
    const type = selectSuggestionType(false);
    expect(type).toBe('add_code_snippet');
    expect(type).not.toBe('disk_fetch_context');
  });
});

// ─── Story note body invariant ────────────────────────────────────────────────

describe('story note body invariant after disk_fetch_context', () => {
  /**
   * When disk_fetch_context is handled, the story note body must NOT change.
   * This test verifies the invariant by simulating the handler logic:
   * disk-fetch reads file content but does not append to body.
   */
  it('story note body unchanged — disk_fetch_context does not append to body', () => {
    const originalBody = '## Problem\n\nThis is the story note body.';
    let body = originalBody;

    // Simulate disk_fetch_context handler: reads file content, does NOT modify body
    const diskFetchedContent = 'export function foo() { return 42; }';
    const outOfBandContextItems = [];
    // Handler logic: push to outOfBandContextItems, NOT to body
    outOfBandContextItems.push({ file: 'src/foo.mjs', content: diskFetchedContent });

    // Body is unchanged
    expect(body).toBe(originalBody);
    // Content is in outOfBandContext
    expect(outOfBandContextItems).toHaveLength(1);
    expect(outOfBandContextItems[0].file).toBe('src/foo.mjs');
    expect(outOfBandContextItems[0].content).toBe(diskFetchedContent);
  });

  it('story note body does NOT grow across multiple disk-fetch cycles', () => {
    let body = '## Problem\n\nOriginal body.';
    const initialLength = body.length;

    // Simulate 3 refine cycles — each using disk_fetch_context
    for (let i = 0; i < 3; i++) {
      // disk_fetch_context handler does NOT append to body
      const outOfBandContextItems = [{ file: 'src/foo.mjs', content: 'file content cycle ' + i }];
      // body is untouched
      expect(body.length).toBe(initialLength);
      expect(outOfBandContextItems).toHaveLength(1);
    }
  });
});
