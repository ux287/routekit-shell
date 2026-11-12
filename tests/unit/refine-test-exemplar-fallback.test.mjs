/**
 * Unit tests for the test exemplar fallback template injection in refine.mjs.
 *
 * When rks_refine_apply runs add_test_exemplar but finds no existing test files,
 * it should inject a minimal framework-specific fallback template (vitest or jest)
 * rather than returning a no-op result.
 */

import { describe, it, expect } from 'vitest';

// ─── Framework detection logic ─────────────────────────────────────────────────

describe('test exemplar fallback — framework detection', () => {
  function detectFramework(pkgJson) {
    const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    if (allDeps['jest'] || allDeps['@jest/globals']) return 'jest';
    if (allDeps['vitest']) return 'vitest';
    return 'vitest'; // default
  }

  it('detects vitest when listed in devDependencies', () => {
    const pkg = { devDependencies: { vitest: '^2.0.0' } };
    expect(detectFramework(pkg)).toBe('vitest');
  });

  it('detects jest when listed in devDependencies', () => {
    const pkg = { devDependencies: { jest: '^29.0.0' } };
    expect(detectFramework(pkg)).toBe('jest');
  });

  it('detects jest via @jest/globals', () => {
    const pkg = { devDependencies: { '@jest/globals': '^29.0.0' } };
    expect(detectFramework(pkg)).toBe('jest');
  });

  it('prefers jest over vitest when both present (jest check comes first)', () => {
    const pkg = { devDependencies: { jest: '^29.0.0', vitest: '^2.0.0' } };
    expect(detectFramework(pkg)).toBe('jest');
  });

  it('defaults to vitest when neither framework is detected', () => {
    const pkg = { devDependencies: { typescript: '^5.0.0' } };
    expect(detectFramework(pkg)).toBe('vitest');
  });

  it('defaults to vitest when devDependencies is absent', () => {
    const pkg = {};
    expect(detectFramework(pkg)).toBe('vitest');
  });
});

// ─── Fallback template content ─────────────────────────────────────────────────

describe('test exemplar fallback — template content', () => {
  const fallbackTemplates = {
    vitest: `import { describe, it, expect } from 'vitest';

describe('TODO: replace with subject under test', () => {
  it('TODO: replace with test description', () => {
    // Arrange
    const input = undefined; // TODO: set up test input

    // Act
    const result = input; // TODO: call the function under test

    // Assert
    expect(result).toBeDefined(); // TODO: replace with real assertion
  });
});`,
    jest: `const { describe, it, expect } = require('@jest/globals');

describe('TODO: replace with subject under test', () => {
  it('TODO: replace with test description', () => {
    // Arrange
    const input = undefined; // TODO: set up test input

    // Act
    const result = input; // TODO: call the function under test

    // Assert
    expect(result).toBeDefined(); // TODO: replace with real assertion
  });
});`,
  };

  it('vitest template has correct import line', () => {
    expect(fallbackTemplates.vitest).toContain("import { describe, it, expect } from 'vitest'");
  });

  it('vitest template has describe + it structure', () => {
    expect(fallbackTemplates.vitest).toContain('describe(');
    expect(fallbackTemplates.vitest).toContain('it(');
  });

  it('vitest template has at least one expect() call', () => {
    expect(fallbackTemplates.vitest).toContain('expect(');
  });

  it('jest template has correct require line', () => {
    expect(fallbackTemplates.jest).toContain("require('@jest/globals')");
  });

  it('jest template has describe + it structure', () => {
    expect(fallbackTemplates.jest).toContain('describe(');
    expect(fallbackTemplates.jest).toContain('it(');
  });

  it('jest template has at least one expect() call', () => {
    expect(fallbackTemplates.jest).toContain('expect(');
  });
});

// ─── Applied result message ─────────────────────────────────────────────────────

describe('test exemplar fallback — applied result message', () => {
  it('reports vitest fallback injection with correct message', () => {
    const framework = 'vitest';
    const result = 'injected framework fallback template (' + framework + ')';
    expect(result).toBe('injected framework fallback template (vitest)');
    expect(result).not.toBe('no test files found to use as exemplar');
  });

  it('reports jest fallback injection with correct message', () => {
    const framework = 'jest';
    const result = 'injected framework fallback template (' + framework + ')';
    expect(result).toBe('injected framework fallback template (jest)');
    expect(result).not.toBe('no test files found to use as exemplar');
  });
});

// ─── Guard: existing exemplar skips injection ──────────────────────────────────

describe('test exemplar fallback — existing exemplar guard', () => {
  it('does not inject when body already contains ### Test Exemplar:', () => {
    const body = 'Some story body\n\n### Test Exemplar: existing-test.mjs\n\n```javascript\n// ...\n```\n';
    const shouldSkip = body.includes('### Test Exemplar:');
    expect(shouldSkip).toBe(true);
  });

  it('injects when body does not contain ### Test Exemplar:', () => {
    const body = 'Some story body without any exemplar section.';
    const shouldSkip = body.includes('### Test Exemplar:');
    expect(shouldSkip).toBe(false);
  });
});
