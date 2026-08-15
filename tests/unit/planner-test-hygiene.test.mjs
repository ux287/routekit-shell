import { describe, it, expect } from 'vitest';
import {
  buildTestGenerationPrompt,
  TEST_GEN_SYSTEM_PROMPT,
  selfCheckGeneratedTest,
} from '../../packages/mcp-rks/src/llm/planner.mjs';

// backlog.fix.planner-test-generation-assertion-hygiene
// The planner generated tests its OWN test_quality gate rejects: a loop-body test with no
// executing assertion (recurred even after QA rewrote the requirement) and expect(x).toBe(10.2)
// on a computed 10.22. The prompt now carries explicit hygiene guidance, and the planner runs a
// pre-emit self-check so it never emits a test its own gate would reject.

describe('planner test-generation prompt hygiene guidance', () => {
  const prompt = buildTestGenerationPrompt({
    testPath: 'src/palette.test.tsx',
    testExemplar: "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });",
    requirements: 'Verify palette contrast for every swatch.',
    sourceChanges: '',
    existingContent: '',
  });

  it('instructs collect-then-assert-once for loops (assert outside the loop)', () => {
    expect(prompt).toMatch(/outside the loop/i);
    expect(prompt).toMatch(/failures/i);
  });

  it('instructs toBeCloseTo for computed floating-point comparisons', () => {
    expect(prompt).toContain('toBeCloseTo');
  });

  it('the system prompt also carries the loop + float hygiene guidance', () => {
    expect(TEST_GEN_SYSTEM_PROMPT).toMatch(/outside the loop/i);
    expect(TEST_GEN_SYSTEM_PROMPT).toContain('toBeCloseTo');
  });
});

describe('planner pre-emit self-check (never emits a test its own gate rejects)', () => {
  it('rejects an assertion-free loop-body test (loop_only_assertion)', () => {
    const generated = `
import { it, expect } from 'vitest';
it('palette contrast', () => {
  getPalette().forEach((c) => {
    expect(contrast(c)).toBeGreaterThan(4.5);
  });
});
`;
    const verdict = selfCheckGeneratedTest(generated, 'src/palette.test.tsx');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.type === 'loop_only_assertion')).toBe(true);
  });

  it('rejects an exact-float toBe test (float_exact_equality)', () => {
    const generated = `
import { it, expect } from 'vitest';
it('ratio', () => {
  expect(computeRatio()).toBe(10.22);
  expect(computeRatio()).toBeGreaterThan(0);
});
`;
    const verdict = selfCheckGeneratedTest(generated, 'src/ratio.test.tsx');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.type === 'float_exact_equality')).toBe(true);
  });

  it('accepts a clean collect-then-assert-once + toBeCloseTo test', () => {
    const generated = `
import { it, expect } from 'vitest';
it('palette contrast', () => {
  const failures = [];
  getPalette().forEach((c) => { if (contrast(c) < 4.5) failures.push(c); });
  expect(failures).toEqual([]);
  expect(computeRatio()).toBeCloseTo(10.22, 2);
});
`;
    const verdict = selfCheckGeneratedTest(generated, 'src/palette.test.tsx');
    expect(verdict.ok).toBe(true);
  });
});
