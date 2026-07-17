import { describe, it, expect } from 'vitest';
import { getSliceWithContext } from '../../packages/mcp-rks/src/llm/slices.mjs';

// Note: findFunctionSlice returns null for ambiguous matches (e.g. "export async function foo"
// matches multiple patterns at different indices). Tests use unambiguous declarations.
const SOURCE = `import fs from 'fs';

function helperFn() {
  return 42;
}

function runMainTool(projectRoot) {
  const result = helperFn();
  return { ok: true, result };
}

function anotherFn() {
  if (true) {
    return "nested";
  }
}
`;

describe('getSliceWithContext', () => {
  it('returns padded text with surrounding context lines', () => {
    const result = getSliceWithContext(SOURCE, 'runMainTool', 2);
    expect(result).not.toBeNull();
    // Should include lines around the function
    expect(result.text).toContain('function runMainTool(projectRoot)');
    expect(result.text).toContain('return { ok: true, result }');
  });

  it('returns correct line-range metadata', () => {
    const result = getSliceWithContext(SOURCE, 'helperFn', 0);
    expect(result).not.toBeNull();
    expect(typeof result.startLine).toBe('number');
    expect(typeof result.endLine).toBe('number');
    expect(result.startLine).toBeGreaterThan(0);
    expect(result.endLine).toBeGreaterThanOrEqual(result.startLine);
    expect(result.totalLines).toBeGreaterThan(0);
  });

  it('returns totalLines equal to total lines in source', () => {
    const result = getSliceWithContext(SOURCE, 'helperFn', 0);
    expect(result.totalLines).toBe(SOURCE.split('\n').length);
  });

  it('returns functionName in result', () => {
    const result = getSliceWithContext(SOURCE, 'runMainTool', 3);
    expect(result.functionName).toBe('runMainTool');
  });

  it('pads context lines before and after the function', () => {
    // helperFn is near the top — context padding before should reach line 1
    const result = getSliceWithContext(SOURCE, 'helperFn', 10);
    expect(result.startLine).toBe(1); // clamped to start of file
    expect(result.endLine).toBeGreaterThan(5);
  });

  it('returns null when findFunctionSlice returns null (function not found)', () => {
    const result = getSliceWithContext(SOURCE, 'nonExistentFn', 5);
    expect(result).toBeNull();
  });

  it('returns null when functionName is empty or null', () => {
    expect(getSliceWithContext(SOURCE, '', 5)).toBeNull();
    expect(getSliceWithContext(SOURCE, null, 5)).toBeNull();
  });

  it('returns null when source text is empty', () => {
    expect(getSliceWithContext('', 'helperFn', 5)).toBeNull();
  });
});
