import fs from 'fs';
import path from 'path';

/**
 * Find the brace-delimited body ranges of iteration constructs (for/while/forEach) in a test body.
 * Returns an array of [start, end) index pairs. Braceless single-statement loops produce no range
 * (an assertion inside one is rare in generated tests and not worth the false-positive risk).
 */
export function findLoopBodyRanges(body) {
  const ranges = [];
  const loopRe = /\b(?:for|while)\s*\(|\.\s*forEach\s*\(/g;
  let m;
  while ((m = loopRe.exec(body)) !== null) {
    // Scan forward to the loop/callback body opener '{'. Stop at ';' (braceless statement).
    let i = m.index + m[0].length;
    while (i < body.length && body[i] !== '{' && body[i] !== ';') i++;
    if (i >= body.length || body[i] !== '{') continue;
    // Brace-match from the opener to find the body end.
    let depth = 0;
    let j = i;
    for (; j < body.length; j++) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    ranges.push([i, j]);
  }
  return ranges;
}

/**
 * True when a test body has at least one assertion and EVERY assertion sits inside a loop body
 * (no assertion executes outside the loop). A loop-internal expect() passes the string-based
 * no_assertions check yet may never run — the collect-then-assert-once pattern (push failures in
 * the loop, expect(failures).toEqual([]) after it) is the correct shape and is NOT flagged.
 */
export function hasLoopOnlyAssertion(testBody) {
  const ranges = findLoopBodyRanges(testBody);
  if (ranges.length === 0) return false;
  const assertRe = /\bexpect\s*\(|\bassert[.(]/g;
  const positions = [];
  let a;
  while ((a = assertRe.exec(testBody)) !== null) positions.push(a.index);
  if (positions.length === 0) return false;
  const insideAnyLoop = (idx) => ranges.some(([s, e]) => idx >= s && idx < e);
  return positions.every(insideAnyLoop);
}

/**
 * Analyze test files for quality issues using static analysis.
 * This is a last-defense layer - catches escapes from earlier quality gates.
 */
export function analyzeTestQuality(projectRoot, testFiles) {
  const issues = [];
  const warnings = [];

  for (const testFile of testFiles) {
    const fullPath = path.join(projectRoot, testFile);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    const perFile = analyzeTestContent(content, testFile);
    issues.push(...perFile.issues);
    warnings.push(...perFile.warnings);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    summary: {
      filesAnalyzed: testFiles.length,
      criticalIssues: issues.length,
      warnings: warnings.length,
    },
  };
}

/**
 * Run the test-quality checks over an in-memory test file string. This is the shared surface
 * the planner's pre-emit self-check reuses so it returns the same verdict analyzeTestQuality
 * would — the planner never emits a test its own gate would reject. `fileLabel` is used only for
 * the `file` field on findings.
 */
export function analyzeTestContent(content, fileLabel = '<generated>') {
  const issues = [];
  const warnings = [];
  if (!content || typeof content !== 'string') {
    return { ok: true, issues, warnings };
  }

  // Pattern: Empty test bodies
  const emptyTestPattern = /(?:it|test)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
  const emptyMatches = content.match(emptyTestPattern) || [];
  for (const match of emptyMatches) {
    issues.push({
      file: fileLabel,
      type: 'empty_test',
      severity: 'critical',
      message: 'Empty test body - test does nothing',
      snippet: match.slice(0, 80),
    });
  }

  // Pattern: No assertions
  // Find test blocks using brace-depth counting to handle nested structures
  const testHeaderPattern = /(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  let headerMatch;
  while ((headerMatch = testHeaderPattern.exec(content)) !== null) {
    const testName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    // Extract full test body by counting brace depth
    let depth = 1;
    let pos = bodyStart;
    while (pos < content.length && depth > 0) {
      if (content[pos] === '{') depth++;
      else if (content[pos] === '}') depth--;
      pos++;
    }
    const testBody = content.slice(bodyStart, pos - 1);

    // Check for assertions
    const hasExpect = /expect\s*\(/.test(testBody);
    const hasAssert = /assert[\.(]/.test(testBody);
    const hasThrow = /toThrow|rejects/.test(testBody);

    if (!hasExpect && !hasAssert && !hasThrow) {
      issues.push({
        file: fileLabel,
        type: 'no_assertions',
        severity: 'critical',
        message: `Test "${testName}" has no assertions`,
        testName,
      });
    } else if (hasLoopOnlyAssertion(testBody)) {
      // Assertion(s) exist but ALL sit inside a loop body — may never execute on an empty
      // collection (the observed bug: a loop-body test with no executing assertion). Collect
      // failures in the loop and assert once outside it (expect(failures).toEqual([])).
      issues.push({
        file: fileLabel,
        type: 'loop_only_assertion',
        severity: 'critical',
        message: `Test "${testName}" only asserts inside a loop body — it may never execute on an empty collection. Collect failures in the loop and assert once outside it (e.g. expect(failures).toEqual([])).`,
        testName,
      });
    }

    // Warning: Single assertion
    const assertionCount = (testBody.match(/expect\s*\(/g) || []).length +
                          (testBody.match(/assert[\.(]/g) || []).length;
    if (assertionCount === 1) {
      warnings.push({
        file: fileLabel,
        type: 'single_assertion',
        severity: 'warning',
        message: `Test "${testName}" has only 1 assertion`,
        testName,
      });
    }
  }

  // Pattern: Exact-float equality — expect(x).toBe(10.22) on a computed value is fragile
  // (floating-point equality). Only non-integer decimal literals trigger; integer .toBe(3) is
  // exempt. Recommend toBeCloseTo (or toEqual with tolerance).
  const floatEqPattern = /\.toBe\(\s*(-?(?:\d+\.\d+|\.\d+))\s*\)/g;
  let floatMatch;
  while ((floatMatch = floatEqPattern.exec(content)) !== null) {
    issues.push({
      file: fileLabel,
      type: 'float_exact_equality',
      severity: 'critical',
      message: `Exact-float equality expect(...).toBe(${floatMatch[1]}) is fragile for computed values — use toBeCloseTo(${floatMatch[1]}, <digits>) instead.`,
      snippet: floatMatch[0],
    });
  }

  // Pattern: Mock-only tests (calls mock but never asserts result)
  const mockPattern = /vi\.fn\(\)|jest\.fn\(\)|sinon\.stub\(\)/g;
  const hasMocks = mockPattern.test(content);
  if (hasMocks) {
    // Check if mocks are verified
    const hasVerification = /toHaveBeenCalled|calledWith|toHaveBeenCalledWith|called\b/.test(content);
    const hasResultAssertion = /expect\([^)]*\)\.(?:toBe|toEqual|toMatch|toContain|toBeDefined)/.test(content);

    if (!hasVerification && !hasResultAssertion) {
      warnings.push({
        file: fileLabel,
        type: 'unverified_mocks',
        severity: 'warning',
        message: 'Tests use mocks but may not verify behavior',
      });
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}
