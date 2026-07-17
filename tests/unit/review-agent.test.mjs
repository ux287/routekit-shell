/**
 * Tests for the agent-based code review module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadReviewPolicy, runPatternChecks, buildReviewPrompt } from '../../packages/mcp-rks/src/server/review.mjs';
import path from 'path';
import fs from 'fs';
import os from 'os';

describe('loadReviewPolicy', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return defaults when no policy file exists', () => {
    const policy = loadReviewPolicy(tempDir);
    expect(policy.enabled).toBe(true);
    expect(policy.verdictMode).toBe('warn');
    expect(policy.blockCategories).toContain('enforcement_modification');
    expect(policy.blockCategories).toContain('security_issue');
  });

  it('should load custom policy from file', () => {
    const rksDir = path.join(tempDir, '.rks');
    fs.mkdirSync(rksDir, { recursive: true });
    fs.writeFileSync(path.join(rksDir, 'review-policy.yaml'), `
enabled: false
verdictMode: block
model: claude-opus-4-20250514
`);

    const policy = loadReviewPolicy(tempDir);
    expect(policy.enabled).toBe(false);
    expect(policy.verdictMode).toBe('block');
    expect(policy.model).toBe('claude-opus-4-20250514');
  });
});

describe('runPatternChecks', () => {
  const defaultPolicy = {
    enforcementPaths: ['.routekit/hooks/', '.rks/protected-files.yml'],
    securityPatterns: ['eval\\(', 'password.*=.*[\'"]'],
    antiPatterns: ['console\\.log\\(', '// TODO'],
    blockCategories: ['enforcement_modification', 'security_issue'],
    warnCategories: ['anti_patterns', 'test_coverage'],
  };

  it('should detect enforcement file modifications', () => {
    const changedFiles = ['.routekit/hooks/my-hook.mjs', 'src/app.js'];
    const findings = runPatternChecks('', changedFiles, defaultPolicy);

    const enforcementFinding = findings.find(f => f.category === 'enforcement_modification');
    expect(enforcementFinding).toBeDefined();
    expect(enforcementFinding.severity).toBe('block');
    expect(enforcementFinding.file).toBe('.routekit/hooks/my-hook.mjs');
  });

  it('should detect security issues in added lines', () => {
    const diff = `
+++ b/src/app.js
+const secret = eval(userInput);
+const password = "hunter2";
`;
    const findings = runPatternChecks(diff, ['src/app.js'], defaultPolicy);

    const evalFinding = findings.find(f => f.message?.includes('eval'));
    expect(evalFinding).toBeDefined();
    expect(evalFinding.severity).toBe('block');

    const passwordFinding = findings.find(f => f.message?.includes('password'));
    expect(passwordFinding).toBeDefined();
    expect(passwordFinding.severity).toBe('block');
  });

  it('should detect anti-patterns in added lines', () => {
    const diff = `
+++ b/src/debug.js
+console.log("debug info");
+// TODO: fix this later
`;
    const findings = runPatternChecks(diff, ['src/debug.js'], defaultPolicy);

    const consoleFinding = findings.find(f => f.message?.includes('console'));
    expect(consoleFinding).toBeDefined();
    expect(consoleFinding.severity).toBe('warn');

    const todoFinding = findings.find(f => f.message?.includes('TODO'));
    expect(todoFinding).toBeDefined();
    expect(todoFinding.severity).toBe('warn');
  });

  it('should warn about missing test coverage', () => {
    const changedFiles = ['src/feature.mjs', 'src/utils.mjs'];
    const findings = runPatternChecks('', changedFiles, defaultPolicy);

    const testFinding = findings.find(f => f.category === 'test_coverage');
    expect(testFinding).toBeDefined();
    expect(testFinding.severity).toBe('warn');
    expect(testFinding.message).toContain('2 code file(s) modified without test changes');
  });

  it('should not warn about test coverage when tests are included', () => {
    const changedFiles = ['src/feature.mjs', 'tests/feature.test.mjs'];
    const findings = runPatternChecks('', changedFiles, defaultPolicy);

    const testFinding = findings.find(f => f.category === 'test_coverage');
    expect(testFinding).toBeUndefined();
  });

  it('should pass clean code with no findings', () => {
    const diff = `
+++ b/src/clean.js
+function clean() {
+  return true;
+}
`;
    const changedFiles = ['src/clean.js', 'tests/clean.test.js'];
    const findings = runPatternChecks(diff, changedFiles, defaultPolicy);

    expect(findings).toHaveLength(0);
  });
});

describe('buildReviewPrompt', () => {
  it('should include diff in prompt', () => {
    const prompt = buildReviewPrompt({
      diff: '+function hello() {}',
      story: null,
      ragContext: [],
      changedFiles: ['src/hello.js'],
    });

    expect(prompt).toContain('+function hello() {}');
    expect(prompt).toContain('src/hello.js');
  });

  it('should include story details when provided', () => {
    const prompt = buildReviewPrompt({
      diff: '+code',
      story: {
        title: 'Add feature X',
        desc: 'This adds feature X',
        content: '## Acceptance Criteria\n- [ ] Feature X works\n## Testing Requirements\n- [ ] Test X',
      },
      ragContext: [],
      changedFiles: ['src/x.js'],
    });

    expect(prompt).toContain('Add feature X');
    expect(prompt).toContain('Feature X works');
  });

  it('should include RAG context when provided', () => {
    const prompt = buildReviewPrompt({
      diff: '+code',
      story: null,
      ragContext: [
        { path: 'docs/patterns.md', text: 'Always use error handling' },
      ],
      changedFiles: ['src/x.js'],
    });

    expect(prompt).toContain('docs/patterns.md');
    expect(prompt).toContain('Always use error handling');
  });

  it('should request JSON response format', () => {
    const prompt = buildReviewPrompt({
      diff: '+code',
      story: null,
      ragContext: [],
      changedFiles: ['src/x.js'],
    });

    expect(prompt).toContain('Respond with JSON only');
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"findings"');
  });
});
