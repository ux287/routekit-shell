/**
 * Tests for Test Static Analysis
 *
 * Tests the static analysis layer that catches test quality issues:
 * - Empty test bodies
 * - Missing assertions
 * - Single assertion warnings
 * - Unverified mock usage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { analyzeTestQuality } from '../../packages/mcp-rks/src/server/test-static-analysis.mjs';

let TEST_PROJECT_DIR;

describe('Test Static Analysis', () => {
  beforeEach(() => {
    TEST_PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-static-analysis-'));
  });

  afterEach(() => {
    if (TEST_PROJECT_DIR) {
      fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('detects empty test bodies', () => {
    const testContent = `
import { it, expect } from 'vitest';

it('should work', () => {});
it('another empty', async () => {});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'empty.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['empty.test.mjs']);

    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.issues[0].type).toBe('empty_test');
    expect(result.issues[0].severity).toBe('critical');
  });

  it('detects tests without assertions', () => {
    const testContent = `
import { it } from 'vitest';

it('does something', () => {
  const x = 1 + 1;
  console.log(x);
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'no-assert.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['no-assert.test.mjs']);

    expect(result.ok).toBe(false);
    const noAssertIssue = result.issues.find(i => i.type === 'no_assertions');
    expect(noAssertIssue).toBeDefined();
    expect(noAssertIssue.severity).toBe('critical');
  });

  it('passes valid tests with assertions', () => {
    const testContent = `
import { it, expect } from 'vitest';

it('adds numbers', () => {
  expect(1 + 1).toBe(2);
  expect(2 + 2).toBe(4);
});

it('handles errors', () => {
  expect(() => { throw new Error(); }).toThrow();
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'valid.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['valid.test.mjs']);

    expect(result.ok).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  it('warns about single assertion tests', () => {
    const testContent = `
import { it, expect } from 'vitest';

it('one assertion', () => {
  expect(true).toBe(true);
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'single.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['single.test.mjs']);

    expect(result.ok).toBe(true); // Warnings don't fail
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0].type).toBe('single_assertion');
  });

  it('warns about unverified mocks', () => {
    const testContent = `
import { it, vi } from 'vitest';

it('uses mocks', () => {
  const mock = vi.fn();
  const result = doSomething(mock);
  // No verification of mock calls
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'mock.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['mock.test.mjs']);

    const mockWarning = result.warnings.find(w => w.type === 'unverified_mocks');
    expect(mockWarning).toBeDefined();
  });

  it('accepts properly verified mocks', () => {
    const testContent = `
import { it, expect, vi } from 'vitest';

it('verifies mock calls', () => {
  const mock = vi.fn();
  callWithMock(mock);
  expect(mock).toHaveBeenCalled();
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'verified-mock.test.mjs'), testContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['verified-mock.test.mjs']);

    const mockWarning = result.warnings.find(w => w.type === 'unverified_mocks');
    expect(mockWarning).toBeUndefined();
  });

  it('handles missing files gracefully', () => {
    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['nonexistent.test.mjs']);

    expect(result.ok).toBe(true);
    expect(result.issues.length).toBe(0);
    expect(result.summary.filesAnalyzed).toBe(1);
  });

  it('returns correct summary', () => {
    const validContent = `
import { it, expect } from 'vitest';
it('valid', () => { expect(1).toBe(1); expect(2).toBe(2); });
`;
    const emptyContent = `
import { it } from 'vitest';
it('empty', () => {});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'valid.test.mjs'), validContent);
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'empty.test.mjs'), emptyContent);

    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['valid.test.mjs', 'empty.test.mjs']);

    expect(result.summary.filesAnalyzed).toBe(2);
    expect(result.summary.criticalIssues).toBeGreaterThanOrEqual(1);
  });
});
