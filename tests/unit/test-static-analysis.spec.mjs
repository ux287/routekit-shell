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
import { analyzeTestQuality, analyzeTestContent } from '../../packages/mcp-rks/src/server/test-static-analysis.mjs';

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

  // ── backlog.fix.planner-test-generation-assertion-hygiene ────────────────────────
  it('flags a test whose sole assertion is inside a loop body (loop_only_assertion)', () => {
    const testContent = `
import { it, expect } from 'vitest';
it('checks palette contrast', () => {
  const palette = getPalette();
  palette.forEach((color) => {
    expect(contrast(color)).toBeGreaterThan(4.5);
  });
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'loop.test.mjs'), testContent);
    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['loop.test.mjs']);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.type === 'loop_only_assertion');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('critical');
  });

  it('passes a collect-then-assert-once test (assertion outside the loop)', () => {
    const testContent = `
import { it, expect } from 'vitest';
it('checks palette contrast', () => {
  const palette = getPalette();
  const failures = [];
  palette.forEach((color) => {
    if (contrast(color) < 4.5) failures.push(color);
  });
  expect(failures).toEqual([]);
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'collect.test.mjs'), testContent);
    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['collect.test.mjs']);
    expect(result.issues.find((i) => i.type === 'loop_only_assertion')).toBeUndefined();
  });

  it('flags exact-float equality expect(x).toBe(10.22) (float_exact_equality)', () => {
    const testContent = `
import { it, expect } from 'vitest';
it('computes ratio', () => {
  const ratio = computeRatio();
  expect(ratio).toBe(10.22);
  expect(ratio).toBeGreaterThan(0);
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'float.test.mjs'), testContent);
    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['float.test.mjs']);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.type === 'float_exact_equality');
    expect(issue).toBeDefined();
    expect(issue.message).toMatch(/toBeCloseTo/);
  });

  it('passes toBeCloseTo for floats and integer toBe (integer carve-out)', () => {
    const testContent = `
import { it, expect } from 'vitest';
it('computes ratio and count', () => {
  const ratio = computeRatio();
  const count = computeCount();
  expect(ratio).toBeCloseTo(10.22, 2);
  expect(count).toBe(3);
});
`;
    fs.writeFileSync(path.join(TEST_PROJECT_DIR, 'close.test.mjs'), testContent);
    const result = analyzeTestQuality(TEST_PROJECT_DIR, ['close.test.mjs']);
    expect(result.issues.find((i) => i.type === 'float_exact_equality')).toBeUndefined();
  });

  it('analyzeTestContent returns the same verdict over an in-memory string (shared self-check surface)', () => {
    const loopOnly = `
it('loops', () => { for (const x of items) { expect(x).toBeTruthy(); } });
`;
    const clean = `
it('adds', () => { expect(1 + 1).toBe(2); expect(2 + 2).toBe(4); });
`;
    expect(analyzeTestContent(loopOnly, 'gen.test.mjs').ok).toBe(false);
    expect(analyzeTestContent(loopOnly, 'gen.test.mjs').issues.some((i) => i.type === 'loop_only_assertion')).toBe(true);
    expect(analyzeTestContent(clean, 'gen.test.mjs').ok).toBe(true);
  });
});

describe('every finding carries a LOCATION — backlog.feat.intervention-receipts-at-forced-exit-paths', () => {
  // THE DEFECT. Every issue named a file and nothing else. `no_assertions` and
  // `loop_only_assertion` carried no snippet either. The gate told the operator a
  // rule had fired somewhere in a file, and the operator grepped — on every
  // failure. That grep is one of the three intervention classes the UAT exists
  // to attribute.

  const FIXTURES = {
    empty_test: 'it("does nothing", () => {})\n',
    no_assertions: 'it("asserts nothing", () => {\n  const x = 1;\n});\n',
    loop_only_assertion: 'it("loops", () => {\n  for (const a of xs) {\n    expect(a).toBe(1);\n  }\n});\n',
    single_assertion: 'it("one", () => {\n  expect(1).toBe(1);\n});\n',
    float_exact_equality: 'it("float", () => {\n  expect(x).toBe(10.22);\n  expect(y).toBe(2);\n});\n',
    unverified_mocks: 'const f = vi.fn();\nit("mocks", () => {\n  f();\n});\n',
  };

  const findingsFor = (content) => {
    const res = analyzeTestContent(content, 'fixture.test.mjs');
    return [...res.issues, ...res.warnings];
  };

  it('ALL SIX types carry a 1-based integer line and a non-empty snippet', () => {
    const seen = new Set();
    for (const [type, content] of Object.entries(FIXTURES)) {
      const finding = findingsFor(content).find((f) => f.type === type);
      expect(finding, `fixture did not produce a ${type} finding`).toBeTruthy();
      seen.add(type);
      expect(Number.isInteger(finding.line), `${type} line is not an integer`).toBe(true);
      expect(finding.line, `${type} line is below 1`).toBeGreaterThanOrEqual(1);
      expect(typeof finding.snippet, `${type} snippet is not a string`).toBe('string');
      expect(finding.snippet.length, `${type} snippet is empty`).toBeGreaterThan(0);
    }
    // ANTI-VACUITY: the loop really covered six distinct types, not one repeated.
    expect(seen.size).toBe(6);
  });

  it('the line is COMPUTED from position, not a constant', () => {
    // Same fixture shifted down by k blank lines must report N + k. A hardcoded
    // 1, or a line taken from the first match in the file, fails this.
    for (const [type, content] of Object.entries(FIXTURES)) {
      const base = findingsFor(content).find((f) => f.type === type);
      const shifted = findingsFor('\n\n\n' + content).find((f) => f.type === type);
      expect(shifted.line, `${type} did not shift`).toBe(base.line + 3);
    }
  });

  it('changedByThisRun is NULL, never false, when the changed-line set is absent', () => {
    // Reporting `false` without the set asserts "this code is pre-existing"
    // without observing it — the intent-sourced-status defect.
    for (const [type, content] of Object.entries(FIXTURES)) {
      const finding = findingsFor(content).find((f) => f.type === type);
      expect(finding.changedByThisRun, `${type}`).toBeNull();
    }
  });

  it('changedByThisRun is true on a changed line and false outside it', () => {
    const content = FIXTURES.float_exact_equality;
    const finding = analyzeTestContent(content, 'f.test.mjs', {
      changedLines: new Set([2]),
    }).issues.find((f) => f.type === 'float_exact_equality');
    expect(finding.line).toBe(2);
    expect(finding.changedByThisRun).toBe(true);

    const other = analyzeTestContent(content, 'f.test.mjs', {
      changedLines: new Set([99]),
    }).issues.find((f) => f.type === 'float_exact_equality');
    expect(other.changedByThisRun).toBe(false);
  });

  it('the two-argument call form still works', () => {
    // Requirement 9: the third parameter is optional and additive.
    //
    // NOT Function.length — that counts parameters up to the first DEFAULTED
    // one, so it reports 2 here whether or not the two-argument form works, and
    // the assertion would pass vacuously. Behaviour is the only real check.
    const res = analyzeTestContent(FIXTURES.empty_test, 'f.test.mjs');
    expect(res.ok).toBe(false);
    expect(res.issues[0].type).toBe('empty_test');
    expect(res.issues[0].line).toBe(1);
    expect(res.issues[0].snippet.length).toBeGreaterThan(0);
    // The distinguishing half: with no changed-line set the flag is null.
    expect(res.issues[0].changedByThisRun).toBeNull();
  });
});
