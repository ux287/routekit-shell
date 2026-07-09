import fs from 'fs';
import path from 'path';

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

    // Pattern: Empty test bodies
    const emptyTestPattern = /(?:it|test)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
    const emptyMatches = content.match(emptyTestPattern) || [];
    for (const match of emptyMatches) {
      issues.push({
        file: testFile,
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
          file: testFile,
          type: 'no_assertions',
          severity: 'critical',
          message: `Test "${testName}" has no assertions`,
          testName,
        });
      }

      // Warning: Single assertion
      const assertionCount = (testBody.match(/expect\s*\(/g) || []).length +
                            (testBody.match(/assert[\.(]/g) || []).length;
      if (assertionCount === 1) {
        warnings.push({
          file: testFile,
          type: 'single_assertion',
          severity: 'warning',
          message: `Test "${testName}" has only 1 assertion`,
          testName,
        });
      }
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
          file: testFile,
          type: 'unverified_mocks',
          severity: 'warning',
          message: 'Tests use mocks but may not verify behavior',
        });
      }
    }
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
