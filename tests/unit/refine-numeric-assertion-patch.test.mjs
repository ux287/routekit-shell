/**
 * Unit tests for numeric assertion mismatch detection in refine.mjs.
 *
 * Tests detectNumericAssertionMismatch in isolation, then verifies the
 * integration: runRefineTool returns fix_numeric_assertion suggestion when
 * trigger=test_failed, testOutput contains the pattern, and the test file
 * is in the story's targetFiles.
 */
import { describe, it, expect } from 'vitest';
import { detectNumericAssertionMismatch, extractTestStackFrame } from '../../packages/mcp-rks/src/server/refine.mjs';

// ─── detectNumericAssertionMismatch unit tests ────────────────────────────────

describe('detectNumericAssertionMismatch — pure detection', () => {
  it('detects Expected N / Received M pattern with delta in [1,5]', () => {
    const output = `
  AssertionError:
  Expected: 6
  Received: 8
    at Object.<anonymous>
`;
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.expected).toBe(6);
    expect(result.received).toBe(8);
    expect(result.delta).toBe(2);
  });

  it('detects delta of 1 (lower bound)', () => {
    const output = 'Expected: 5\nReceived: 6';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.delta).toBe(1);
  });

  it('detects delta of 5 (upper bound)', () => {
    const output = 'Expected: 10\nReceived: 15';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.delta).toBe(5);
  });

  it('fires for delta of 8 (previously blocked at 5, now within [1, 20])', () => {
    const output = 'Expected: 10\nReceived: 18';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.delta).toBe(8);
  });

  it('fires for delta of 20 (upper bound inclusive)', () => {
    const output = 'Expected: 5\nReceived: 25';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.delta).toBe(20);
  });

  it('does NOT fire when delta exceeds 20 (cap)', () => {
    const output = 'Expected: 2\nReceived: 25';
    expect(detectNumericAssertionMismatch(output)).toBeNull();
  });

  it('does NOT fire on negative delta (received < expected)', () => {
    const output = 'Expected: 8\nReceived: 6';
    expect(detectNumericAssertionMismatch(output)).toBeNull();
  });

  it('does NOT fire on zero delta', () => {
    const output = 'Expected: 6\nReceived: 6';
    expect(detectNumericAssertionMismatch(output)).toBeNull();
  });

  it('does NOT fire on non-numeric assertion failures (string mismatch)', () => {
    const output = `
  AssertionError:
  Expected: "foo"
  Received: "bar"
`;
    expect(detectNumericAssertionMismatch(output)).toBeNull();
  });

  it('does NOT fire on type errors', () => {
    const output = `TypeError: Cannot read property 'length' of undefined`;
    expect(detectNumericAssertionMismatch(output)).toBeNull();
  });

  it('returns null for empty or null input', () => {
    expect(detectNumericAssertionMismatch('')).toBeNull();
    expect(detectNumericAssertionMismatch(null)).toBeNull();
    expect(detectNumericAssertionMismatch(undefined)).toBeNull();
  });

  it('returns first matching mismatch when multiple patterns appear', () => {
    const output = 'Expected: 6\nReceived: 8\n\nExpected: 3\nReceived: 4';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.expected).toBe(6);
    expect(result.received).toBe(8);
  });

  it('handles "Expected value:" / "Received value:" variant', () => {
    const output = 'Expected value: 4\nReceived value: 6';
    const result = detectNumericAssertionMismatch(output);
    expect(result).not.toBeNull();
    expect(result.expected).toBe(4);
    expect(result.received).toBe(6);
    expect(result.delta).toBe(2);
  });
});

// ─── extractTestStackFrame unit tests ────────────────────────────────────────

describe('extractTestStackFrame', () => {
  it('extracts file and line from parenthesized stack frame', () => {
    const output = `AssertionError\n  at Object.<anonymous> (src/components/Modal.test.tsx:42:5)`;
    const result = extractTestStackFrame(output);
    expect(result).not.toBeNull();
    expect(result.file).toBe('src/components/Modal.test.tsx');
    expect(result.line).toBe(42);
  });

  it('extracts file and line from bare at-frame (no parens)', () => {
    const output = `at src/components/Modal.test.ts:17:3`;
    const result = extractTestStackFrame(output);
    expect(result).not.toBeNull();
    expect(result.file).toContain('Modal.test.ts');
    expect(result.line).toBe(17);
  });

  it('matches .test.tsx, .test.ts, .spec.js, .spec.jsx', () => {
    expect(extractTestStackFrame('at foo.test.tsx:1:1')).not.toBeNull();
    expect(extractTestStackFrame('at foo.test.ts:1:1')).not.toBeNull();
    expect(extractTestStackFrame('at foo.spec.js:1:1')).not.toBeNull();
    expect(extractTestStackFrame('at foo.spec.jsx:1:1')).not.toBeNull();
  });

  it('does NOT match non-test files in stack frames', () => {
    const output = 'at src/components/Modal.tsx:42:5';
    expect(extractTestStackFrame(output)).toBeNull();
  });

  it('returns null for empty/null input', () => {
    expect(extractTestStackFrame('')).toBeNull();
    expect(extractTestStackFrame(null)).toBeNull();
    expect(extractTestStackFrame(undefined)).toBeNull();
  });
});
