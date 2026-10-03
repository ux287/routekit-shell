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
import { vi } from 'vitest';
import { analyzeTestQuality, analyzeTestContent } from '../../packages/mcp-rks/src/server/test-static-analysis.mjs';
// Namespace import for the helpers added by backlog.fix.test-static-analysis-false-blocks, so a
// missing export fails the individual tests that use it rather than the whole module load.
import * as SA from '../../packages/mcp-rks/src/server/test-static-analysis.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

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
  it('flags a test whose sole assertion is inside a loop body (iteration_only_assertion)', () => {
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
    const issue = result.issues.find((i) => i.type === 'iteration_only_assertion');
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
    expect(result.issues.find((i) => i.type === 'iteration_only_assertion')).toBeUndefined();
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
    // Pinned form (backlog.fix.test-static-analysis-false-blocks): toBeCloseTo with a concrete
    // integer precision — the literal's decimal places — never a <digits> placeholder.
    expect(issue.message).toMatch(/toBeCloseTo\(10\.22, 2\)/);
    expect(issue.message).not.toContain('<digits>');
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
    expect(analyzeTestContent(loopOnly, 'gen.test.mjs').issues.some((i) => i.type === 'iteration_only_assertion')).toBe(true);
    expect(analyzeTestContent(clean, 'gen.test.mjs').ok).toBe(true);
  });
});

describe('every finding carries a LOCATION — backlog.feat.intervention-receipts-at-forced-exit-paths', () => {
  // THE DEFECT. Every issue named a file and nothing else. `no_assertions` and
  // `iteration_only_assertion` carried no snippet either. The gate told the operator a
  // rule had fired somewhere in a file, and the operator grepped — on every
  // failure. That grep is one of the three intervention classes the UAT exists
  // to attribute.

  const FIXTURES = {
    empty_test: 'it("does nothing", () => {})\n',
    no_assertions: 'it("asserts nothing", () => {\n  const x = 1;\n});\n',
    iteration_only_assertion: 'it("loops", () => {\n  for (const a of xs) {\n    expect(a).toBe(1);\n  }\n});\n',
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

  it('no FIXTURES entry emits the retired loop-check type; the loop fixture emits iteration_only_assertion', () => {
    const OLD_TYPE = 'loop' + '_only_assertion';
    const emittedTypes = [];
    for (const content of Object.values(FIXTURES)) {
      for (const f of findingsFor(content)) emittedTypes.push(f.type);
    }
    // ANTI-VACUITY: findings were actually produced and the new type is among them.
    expect(emittedTypes.length).toBeGreaterThanOrEqual(6);
    expect(emittedTypes).toContain('iteration_only_assertion');
    expect(emittedTypes).not.toContain(OLD_TYPE);
  });
});

// ── backlog.fix.test-static-analysis-false-blocks ──────────────────────────────────────────────

const issuesOfType = (res, type) => res.issues.filter((i) => i.type === type);

describe('A3 — float_exact_equality exempts numeric-literal left-hand sides only', () => {
  it('a numeric literal on the left produces no float_exact_equality issue and ok true', () => {
    const content = "it('literals', () => {\n  expect(1.5).toBe(1.5);\n  expect(2).toBe(2);\n});\n";
    const res = analyzeTestContent(content, 'lit.test.mjs');
    expect(issuesOfType(res, 'float_exact_equality')).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('identifier, call and named-constant left-hand sides EACH produce exactly one critical finding', () => {
    const cases = {
      identifier: 'expect(ratio).toBe(10.22);',
      call: 'expect(computeRatio()).toBe(10.22);',
      namedConstant: 'expect(VERSION).toBe(1.5);',
    };
    for (const [name, stmt] of Object.entries(cases)) {
      const content = `it('${name}', () => {\n  ${stmt}\n  expect(other).toBeTruthy();\n});\n`;
      const res = analyzeTestContent(content, `${name}.test.mjs`);
      const found = issuesOfType(res, 'float_exact_equality');
      expect(found, name).toHaveLength(1);
      expect(found[0].severity, name).toBe('critical');
      expect(res.ok, name).toBe(false);
    }
  });

  it('.toBe(10.22) in comments and strings is ignored; exactly the one real statement is flagged, on its line', () => {
    const content = [
      "it('mixed', () => {",                       // 1
      '  // expect(a).toBe(10.22) in a line comment', // 2
      '  /* expect(b).toBe(10.22) in a block */',     // 3
      "  const s1 = 'x.toBe(10.22)';",              // 4
      '  const s2 = "x.toBe(10.22)";',              // 5
      '  const s3 = `x.toBe(10.22)`;',              // 6
      '  expect(ratio).toBe(10.22);',               // 7  <- the real one
      '  expect(s1 + s2 + s3).toBeTruthy();',       // 8
      '});',
      '',
    ].join('\n');
    const found = issuesOfType(analyzeTestContent(content, 'cs.test.mjs'), 'float_exact_equality');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(7);
  });

  it('the message names toBeCloseTo with a concrete integer precision and never the <digits> placeholder', () => {
    for (const [literal, digits] of [['10.22', 2], ['1.5', 1], ['0.125', 3]]) {
      const content = `it('m', () => {\n  expect(x).toBe(${literal});\n  expect(y).toBeTruthy();\n});\n`;
      const [issue] = issuesOfType(analyzeTestContent(content, 'm.test.mjs'), 'float_exact_equality');
      expect(issue.message).not.toContain('<digits>');
      const m = issue.message.match(/toBeCloseTo\(([-\d.]+), (\d+)\)/);
      expect(m, issue.message).not.toBeNull();
      expect(m[1]).toBe(literal);
      expect(Number(m[2])).toBe(digits);
    }
  });
});

describe('B4 — the iteration check is renamed, not narrowed', () => {
  const forOf = "it('for-of', () => {\n  for (const a of xs) {\n    expect(a).toBeTruthy();\n  }\n});\n";
  const forEach = "it('forEach', () => {\n  xs.forEach((a) => {\n    expect(a).toBeTruthy();\n  });\n});\n";

  it('a braced for-of body and a braced .forEach callback EACH produce a critical iteration_only_assertion', () => {
    for (const content of [forOf, forEach]) {
      const res = analyzeTestContent(content, 'it.test.mjs');
      const [issue] = issuesOfType(res, 'iteration_only_assertion');
      expect(issue, content).toBeDefined();
      expect(issue.severity).toBe('critical');
      expect(res.ok).toBe(false);
    }
  });

  it('the message names forEach and states that a body without braces is exempt', () => {
    const [issue] = issuesOfType(analyzeTestContent(forEach, 'it.test.mjs'), 'iteration_only_assertion');
    expect(issue.message).toMatch(/forEach/);
    expect(issue.message).toMatch(/brace/i);
    expect(issue.message).toMatch(/exempt/i);
  });

  it('a braceless single-statement loop is exempt (the documented exemption is a contract)', () => {
    const content = "it('braceless', () => {\n  for (const a of xs) expect(a).toBe(1);\n});\n";
    const res = analyzeTestContent(content, 'bl.test.mjs');
    expect(issuesOfType(res, 'iteration_only_assertion')).toEqual([]);
    // Positive control: the same assertion inside braces IS flagged.
    const braced = analyzeTestContent(content.replace('expect(a).toBe(1);', '{ expect(a).toBe(1); }'), 'bl.test.mjs');
    expect(issuesOfType(braced, 'iteration_only_assertion')).toHaveLength(1);
  });

  it('rename blast radius: no source names the retired type; the witnesses assert the new one', () => {
    const OLD_TYPE = 'loop' + '_only_assertion';
    const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const rel of [
      'packages/mcp-rks/src/server/test-static-analysis.mjs',
      'packages/mcp-rks/src/llm/planner.mjs',
      'tests/unit/planner-test-hygiene.test.mjs',
      'tests/unit/test-static-analysis.spec.mjs',
    ]) {
      const src = read(rel);
      expect(src.length, rel).toBeGreaterThan(1000); // whole file, not an empty read
      expect(src.includes(OLD_TYPE), rel).toBe(false);
    }
    expect(read('packages/mcp-rks/src/server/test-static-analysis.mjs')).toContain("type: 'iteration_only_assertion'");
    expect(read('tests/unit/planner-test-hygiene.test.mjs')).toContain("i.type === 'iteration_only_assertion'");
    const spec = read('tests/unit/test-static-analysis.spec.mjs');
    expect(spec).toContain("i.type === 'iteration_only_assertion'");
    expect(spec).toMatch(/^\s+iteration_only_assertion: 'it\("loops"/m); // the FIXTURES key
  });
});

describe('B3 — diff scoping in analyzeTestQuality', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-sa-b3-')); });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  // Line 3 holds a PRE-EXISTING float_exact_equality violation.
  const FILE = 'pre.test.mjs';
  const CONTENT = [
    "import { it, expect } from 'vitest';",       // 1
    "it('old', () => {",                           // 2
    '  expect(ratio).toBe(10.22);',               // 3  <- violation
    '  expect(ratio).toBeGreaterThan(0);',        // 4
    '});',                                         // 5
    "it('new', () => {",                           // 6
    '  expect(add(1, 2)).toBe(3);',               // 7
    '  expect(add(2, 2)).toBe(4);',               // 8
    '});',                                         // 9
    '',
  ].join('\n');

  it('a violation on an untouched line does not block, and is still returned with changedByThisRun false', () => {
    fs.writeFileSync(path.join(dir, FILE), CONTENT);
    const res = analyzeTestQuality(dir, [FILE], new Map([[FILE, new Set([6, 7, 8, 9])]]));
    expect(res.ok).toBe(true);
    const [issue] = issuesOfType(res, 'float_exact_equality');
    expect(issue).toBeDefined();
    expect(issue.line).toBe(3);
    expect(issue.changedByThisRun).toBe(false);
    expect(res.summary.blockingIssues).toBe(0);
  });

  it('negative control: the same violation on a CHANGED line blocks and carries changedByThisRun true', () => {
    fs.writeFileSync(path.join(dir, FILE), CONTENT);
    const res = analyzeTestQuality(dir, [FILE], { [FILE]: [3] });
    expect(res.ok).toBe(false);
    const [issue] = issuesOfType(res, 'float_exact_equality');
    expect(issue.changedByThisRun).toBe(true);
    expect(res.summary.blockingIssues).toBe(1);
  });

  it('fail closed: two-argument call, or a third argument with no entry for the file, blocks as today', () => {
    fs.writeFileSync(path.join(dir, FILE), CONTENT);
    const twoArg = analyzeTestQuality(dir, [FILE]);
    expect(twoArg.ok).toBe(false);
    expect(issuesOfType(twoArg, 'float_exact_equality')[0].changedByThisRun).toBeNull();
    const noEntry = analyzeTestQuality(dir, [FILE], new Map([['some/other.test.mjs', new Set([1])]]));
    expect(noEntry.ok).toBe(false);
    expect(issuesOfType(noEntry, 'float_exact_equality')[0].changedByThisRun).toBeNull();
  });

  it('fail closed: the planner pre-emit self-check (two-argument form) keeps blocking', async () => {
    const { selfCheckGeneratedTest } = await import('../../packages/mcp-rks/src/llm/planner.mjs');
    const verdict = selfCheckGeneratedTest(CONTENT, 'src/pre.test.mjs');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.type === 'float_exact_equality')).toBe(true);
  });

  it('a test-level finding counts as changed when any line of that test changed', () => {
    const content = "it('t', () => {\n  const x = 1;\n  const y = 2;\n});\n";
    fs.writeFileSync(path.join(dir, 'na.test.mjs'), content);
    const touched = analyzeTestQuality(dir, ['na.test.mjs'], { 'na.test.mjs': [3] });
    expect(touched.ok).toBe(false);
    expect(issuesOfType(touched, 'no_assertions')[0].changedByThisRun).toBe(true);
    const untouched = analyzeTestQuality(dir, ['na.test.mjs'], { 'na.test.mjs': [99] });
    expect(untouched.ok).toBe(true);
    expect(issuesOfType(untouched, 'no_assertions')[0].changedByThisRun).toBe(false);
  });
});

describe('B3 — changed-line derivation (the function exec Layer D uses)', () => {
  it('a newly created file: every line 1..N is changed', () => {
    const set = SA.deriveChangedLines(null, 'a\nb\nc\n', { newFile: true });
    expect([...set].sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('a line inserted at position K is in the set; the unchanged lines around it are not', () => {
    const set = SA.deriveChangedLines('a\nb\nc\nd\n', 'a\nb\nNEW\nc\nd\n');
    expect(set.has(3)).toBe(true);
    for (const unchanged of [1, 2, 4, 5]) expect(set.has(unchanged), `line ${unchanged}`).toBe(false);
    expect(set.size).toBe(1);
  });

  it('a modified line is included', () => {
    const set = SA.deriveChangedLines('a\nb\nc\n', 'a\nB2\nc\n');
    expect([...set]).toEqual([2]);
  });

  it('a pure deletion marks the line that now follows it', () => {
    const set = SA.deriveChangedLines('a\nb\nc\n', 'a\nc\n');
    expect([...set]).toEqual([2]);
  });

  it('no obtainable pre-apply or post-apply content yields no set (fail closed downstream)', () => {
    expect(SA.deriveChangedLines(null, 'a\n')).toBeNull();
    expect(SA.deriveChangedLines(undefined, 'a\n')).toBeNull();
    expect(SA.deriveChangedLines('a\n', null)).toBeNull();
  });
});

describe('B3 — exec Layer D wiring and reporting (ARCH R9, decision 2026-10-03)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-sa-layer-d-')); });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const PRE = "it('old', () => {\n  expect(ratio).toBe(10.22);\n  expect(ratio).toBeTruthy();\n});\n";
  const POST = PRE + "it('new', () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(4);\n});\n";

  it('derivation end-to-end: snapshot, apply, derive, analyze — pre-existing finding passes and is reported', () => {
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), PRE);
    const snapshot = SA.capturePreApplyTestSnapshot(dir, ['a.test.mjs', 'b.test.mjs']);
    fs.writeFileSync(path.join(dir, 'a.test.mjs'), POST); // the "apply"
    fs.writeFileSync(path.join(dir, 'b.test.mjs'), "it('b', () => {\n  expect(f()).toBe(1);\n  expect(g()).toBe(2);\n});\n"); // created
    const { changedLinesByFile, wholeFileFallbackFiles } = SA.deriveChangedLinesForFiles(dir, ['a.test.mjs', 'b.test.mjs'], snapshot);
    expect(wholeFileFallbackFiles).toEqual([]);
    expect([...changedLinesByFile.get('a.test.mjs')]).toEqual([5, 6, 7, 8]);
    expect([...changedLinesByFile.get('b.test.mjs')]).toEqual([1, 2, 3, 4]);

    const staticResult = analyzeTestQuality(dir, ['a.test.mjs', 'b.test.mjs'], changedLinesByFile);
    expect(staticResult.ok).toBe(true);
    const warn = vi.fn();
    const report = SA.buildStaticAnalysisReport(staticResult, wholeFileFallbackFiles, { warn });
    expect(report.nonBlockingIssues).toHaveLength(1);
    expect(report.nonBlockingIssues[0]).toMatchObject({ file: 'a.test.mjs', line: 2, type: 'float_exact_equality', changedByThisRun: false });
    expect(report.wholeFileFallbackFiles).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('a.test.mjs');
    expect(msg).toContain(':2');
    expect(msg).toContain('float_exact_equality');
  });

  it('negative control: no issues means nonBlockingIssues is present and empty, and nothing is warned', () => {
    const warn = vi.fn();
    const report = SA.buildStaticAnalysisReport({ ok: true, issues: [], warnings: [] }, [], { warn });
    expect(report).toEqual({ nonBlockingIssues: [], wholeFileFallbackFiles: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('whole-file fallback: a file with no derivable set is warned and listed; a derived file is not', () => {
    fs.writeFileSync(path.join(dir, 'ok.test.mjs'), PRE);
    fs.writeFileSync(path.join(dir, 'lost.test.mjs'), PRE);
    // ok.test.mjs was snapshotted; lost.test.mjs has no pre-apply snapshot entry.
    const snapshot = SA.capturePreApplyTestSnapshot(dir, ['ok.test.mjs']);
    const { changedLinesByFile, wholeFileFallbackFiles } = SA.deriveChangedLinesForFiles(dir, ['ok.test.mjs', 'lost.test.mjs'], snapshot);
    expect(wholeFileFallbackFiles).toEqual(['lost.test.mjs']);
    expect(changedLinesByFile.has('ok.test.mjs')).toBe(true);
    expect(changedLinesByFile.has('lost.test.mjs')).toBe(false);

    const staticResult = analyzeTestQuality(dir, ['ok.test.mjs', 'lost.test.mjs'], changedLinesByFile);
    // The fallback file is analysed whole-file: its float finding blocks (fail closed).
    expect(staticResult.ok).toBe(false);
    const warn = vi.fn();
    const report = SA.buildStaticAnalysisReport(staticResult, wholeFileFallbackFiles, { warn });
    expect(report.wholeFileFallbackFiles).toEqual(['lost.test.mjs']);
    const messages = warn.mock.calls.map((c) => c[0]);
    const fallbackWarns = messages.filter((m) => /whole-file/.test(m));
    expect(fallbackWarns).toHaveLength(1);
    expect(fallbackWarns[0]).toContain('lost.test.mjs');
    expect(messages.some((m) => /whole-file/.test(m) && m.includes('ok.test.mjs'))).toBe(false);
  });

  it('exec.mjs (full source): Layer D derives changed lines, passes them as the third argument, and reports on both result sites', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/exec.mjs'), 'utf8');
    expect(src.length).toBeGreaterThan(50000); // the whole file
    expect(src).toMatch(/capturePreApplyTestSnapshot\(\s*projectRoot,/);
    expect(src).toMatch(/deriveChangedLinesForFiles\(\s*projectRoot, testFilesApplied, preApplyTestSnapshot\s*\)/);
    expect(src).toContain('analyzeTestQuality(projectRoot, testFilesApplied, changedLinesByFile)');
    expect(src).not.toContain('analyzeTestQuality(projectRoot, testFilesApplied);');
    // console.warn of non-blocking issues and fallbacks happens in buildStaticAnalysisReport (default warn).
    expect(src).toContain('staticAnalysis = buildStaticAnalysisReport(staticResult, wholeFileFallbackFiles);');
    expect(src).toContain("let staticAnalysis = { nonBlockingIssues: [], wholeFileFallbackFiles: [] };");

    // static_analysis_failed payload carries staticAnalysis.
    const idxFailed = src.indexOf("status: 'static_analysis_failed'");
    const failedObj = src.slice(src.lastIndexOf('return {', idxFailed), src.indexOf('};', idxFailed));
    expect(failedObj).toMatch(/\n\s+staticAnalysis,\n/);

    // pending_ship success result carries staticAnalysis.
    const idxShip = src.indexOf("status: 'pending_ship'");
    const shipObj = src.slice(src.lastIndexOf('return {', idxShip), src.indexOf('};', idxShip));
    expect(shipObj).toMatch(/\n\s+staticAnalysis,\n/);
    expect(shipObj).toContain('baselineRed:');
  });

  it('buildStaticAnalysisReport defaults to console.warn', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      SA.buildStaticAnalysisReport({ ok: true, issues: [{ file: 'f.test.mjs', line: 4, type: 'float_exact_equality', changedByThisRun: false }] }, ['g.test.mjs']);
      const messages = spy.mock.calls.map((c) => c[0]);
      expect(messages.some((m) => m.includes('f.test.mjs:4') && m.includes('float_exact_equality'))).toBe(true);
      expect(messages.some((m) => m.includes('g.test.mjs') && /whole-file/.test(m))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the server planner keeps its two-argument (fail-closed) call', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/planner.mjs'), 'utf8');
    expect(src).toContain('analyzeTestQuality(projectRoot, testFiles);');
  });
});

describe('C1 — braces inside literals do not end a test body', () => {
  const fourExpects = '  expect(call).toBeDefined();\n  expect(call.length).toBeGreaterThan(0);\n  expect(typeof call).toBe("string");\n  expect(call).not.toBeNull();\n';

  it('peer shape: tail.split("})")[0] before four expects yields no no_assertions and ok true', () => {
    const content = `it('every spawn passes an explicit cwd', () => {\n  const call = tail.split("})")[0];\n${fourExpects}});\n`;
    const res = analyzeTestContent(content, 'peer.test.mjs');
    expect(issuesOfType(res, 'no_assertions')).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('single-quoted, template and regex (escaped closing brace) literal variants also pass', () => {
    const variants = [
      "  const call = tail.split('})')[0];",
      '  const call = tail.split(`})`)[0];',
      '  const call = tail.split(/\\}\\)/)[0];',
    ];
    for (const lit of variants) {
      const content = `it('variant', () => {\n${lit}\n${fourExpects}});\n`;
      const res = analyzeTestContent(content, 'v.test.mjs');
      expect(issuesOfType(res, 'no_assertions'), lit).toEqual([]);
      expect(res.ok, lit).toBe(true);
    }
  });

  it('negative control: a brace-bearing literal with genuinely no assertion still yields no_assertions', () => {
    const content = "it('no asserts', () => {\n  const call = tail.split(\"})\")[0];\n  console.log(call);\n});\n";
    const res = analyzeTestContent(content, 'n.test.mjs');
    expect(issuesOfType(res, 'no_assertions')).toHaveLength(1);
    expect(res.ok).toBe(false);
  });

  it('negative control: an unmatched "{" literal does not let the body overrun into the next test', () => {
    const content = [
      "it('first', () => {",
      '  const open = "{";',
      '  console.log(open);',
      '});',
      "it('second', () => {",
      '  expect(a).toBe(1);',
      '  expect(b).toBe(2);',
      '});',
      '',
    ].join('\n');
    const found = issuesOfType(analyzeTestContent(content, 'o.test.mjs'), 'no_assertions');
    expect(found.map((i) => i.testName)).toEqual(['first']);
  });
});

describe('masking — positions, lines and names preserved', () => {
  it('the masked copy has the same length and the same newline offsets', () => {
    const src = "it('x', () => {\n  const t = `a\n}b`; /* c\n} */ const r = /}/; // }\n  expect(t).toBe(1);\n});\n";
    const masked = SA.maskTestSource(src);
    expect(masked.length).toBe(src.length);
    const nl = (s) => [...s].map((ch, i) => (ch === '\n' ? i : -1)).filter((i) => i >= 0);
    expect(nl(masked)).toEqual(nl(src));
    expect(masked).not.toContain('}b');
    expect(masked).toContain('expect(t).toBe(1);');
  });

  it('a multi-line template and block comment before a violation leave its line unchanged', () => {
    const content = [
      "it('t', () => {",          // 1
      '  const tpl = `line one',  // 2
      '  } line two',             // 3
      '  line three`;',           // 4
      '  /* block',               // 5
      '     } comment */',        // 6
      '  expect(ratio).toBe(3.14);', // 7
      '  expect(tpl).toBeTruthy();', // 8
      '});',
      '',
    ].join('\n');
    const [issue] = issuesOfType(analyzeTestContent(content, 'ml.test.mjs'), 'float_exact_equality');
    expect(issue.line).toBe(7);
    expect(issue.snippet).toBe('.toBe(3.14)');
  });

  it('a test name with a closing brace and a // marker is reported verbatim', () => {
    const content = "it('handles }) and // in names', () => {\n  const x = 1;\n});\n";
    const [issue] = issuesOfType(analyzeTestContent(content, 'nm.test.mjs'), 'no_assertions');
    expect(issue).toBeDefined();
    expect(issue.testName).toBe('handles }) and // in names');
    expect(issue.line).toBe(1);
  });

  it('a braced .forEach callback with "}" in a string before its sole assertion still yields iteration_only_assertion', () => {
    const content = "it('fe', () => {\n  xs.forEach((a) => {\n    const s = \"}\";\n    expect(a + s).toBeTruthy();\n  });\n});\n";
    const res = analyzeTestContent(content, 'fe.test.mjs');
    expect(issuesOfType(res, 'iteration_only_assertion')).toHaveLength(1);
    expect(res.ok).toBe(false);
  });
});

// backlog.fix.test-static-analysis-mask-division-as-regex: a `/` after a postfix `++`/`--` or
// after a keyword used as a property name is division. Mis-reading it as a regex start blanks
// real code between two slashes, which could hide a violation (fail open).
describe('masking — division is never read as a regex start', () => {
  const unchanged = (src) => expect(SA.maskTestSource(src)).toBe(src);
  const sameShape = (src) => {
    const masked = SA.maskTestSource(src);
    expect(masked.length).toBe(src.length);
    const nl = (s) => [...s].map((ch, i) => (ch === '\n' ? i : -1)).filter((i) => i >= 0);
    expect(nl(masked)).toEqual(nl(src));
  };

  it('postfix ++ before a division leaves the code unmasked', () => {
    unchanged('n++ / 2 / d');
  });

  it('postfix -- before a division leaves the code unmasked', () => {
    unchanged('n-- / 2 / d');
  });

  it('a keyword used as a property name before a division leaves the code unmasked', () => {
    unchanged('opts.in / 2 / k');
    unchanged('m.delete / x / y');
  });

  it('a keyword reached through optional chaining before a division leaves the code unmasked', () => {
    unchanged('a?.of / 2 / b');
  });

  it('regression guard: a regex after return is still masked', () => {
    const masked = SA.maskTestSource('return /a}b/.test(s)');
    expect(masked).not.toContain('a}b');
    expect(masked).toContain('.test(s)');
  });

  it('regression guard: a regex after a prefix ++ expression and a comma is still masked', () => {
    expect(SA.maskTestSource('x = ++y, /a}b/')).not.toContain('a}b');
  });

  it('regression guard: a regex after a statement with ++ is still masked', () => {
    expect(SA.maskTestSource('if (x) ++y; /a}b/.test(s)')).not.toContain('a}b');
  });

  it('every fixture keeps its length and newline offsets', () => {
    for (const src of [
      'n++ / 2 / d', 'n-- / 2 / d', 'opts.in / 2 / k', 'm.delete / x / y', 'a?.of / 2 / b',
      'return /a}b/.test(s)', 'x = ++y, /a}b/', 'if (x) ++y; /a}b/.test(s)',
      'const r = n++ / 2;\nexpect(r).toBe(0.5);\nconst q = r / 3;\n',
    ]) sameShape(src);
  });

  it('a float violation between two division slashes after postfix ++ is still reported', () => {
    const content = "it('d', () => {\n  const r = n++ / 2; expect(r).toBe(0.5); const q = r / 3;\n  expect(q).toBeTruthy();\n});\n";
    const found = issuesOfType(analyzeTestContent(content, 'div.test.mjs'), 'float_exact_equality');
    expect(found).toHaveLength(1);
    expect(found[0].snippet).toContain('.toBe(0.5)');
  });

  it('a float violation between two division slashes after a property-name keyword is still reported', () => {
    const content = "it('p', () => {\n  const r = opts.in / 2; expect(r).toBe(0.5); const q = r / 3;\n  expect(q).toBeTruthy();\n});\n";
    const found = issuesOfType(analyzeTestContent(content, 'prop.test.mjs'), 'float_exact_equality');
    expect(found).toHaveLength(1);
    expect(found[0].snippet).toContain('.toBe(0.5)');
  });
});
