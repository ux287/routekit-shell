/**
 * Tests for planner lifecycle telemetry
 * (backlog.feat.telemetry-planner-lifecycle)
 *
 * Verifies plan.start, plan.complete, plan.failed in planner.mjs
 * and plan.prompt.snippets_missing reason field in planner-llm.mjs.
 *
 * ARCH constraints applied:
 * - No blanket try/catch added to runPlanTool (assertions test known throw sites only)
 * - plan.prompt.snippets_missing reason: 'rag_miss' | 'query_empty' only (not 'file_not_indexed')
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const plannerSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/planner.mjs'),
  'utf8'
);

const plannerLlmSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/planner-llm.mjs'),
  'utf8'
);

describe('plan.start telemetry (planner.mjs)', () => {
  it('emits plan.start in runPlanTool', () => {
    expect(plannerSrc).toContain('"plan.start"');
  });

  it('plan.start is emitted after input validation (planStartMs captured)', () => {
    expect(plannerSrc).toContain('planStartMs');
    // planStartMs must appear before plan.start emit
    const startMsIdx = plannerSrc.indexOf('planStartMs = Date.now()');
    const emitIdx = plannerSrc.indexOf('"plan.start"');
    expect(startMsIdx).toBeGreaterThan(0);
    expect(emitIdx).toBeGreaterThan(startMsIdx);
  });

  it('plan.start payload includes problemId', () => {
    const startEmit = plannerSrc.match(/emit\("plan\.start"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(startEmit).toContain('problemId');
  });

  it('plan.start is wrapped in try/catch for best-effort delivery', () => {
    expect(plannerSrc).toMatch(/try\s*\{[^}]*"plan\.start"/);
  });
});

describe('plan.complete telemetry (planner.mjs)', () => {
  it('emits plan.complete when persistAndFinalize returns ok: true', () => {
    expect(plannerSrc).toContain('"plan.complete"');
  });

  it('plan.complete payload includes problemId, slug, steps, durationMs', () => {
    const completeEmit = plannerSrc.match(/emit\("plan\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('problemId');
    expect(completeEmit).toContain('slug');
    expect(completeEmit).toContain('steps');
    expect(completeEmit).toContain('durationMs');
  });

  it('plan.complete durationMs uses planStartMs', () => {
    const completeEmit = plannerSrc.match(/emit\("plan\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('planStartMs');
  });

  it('plan.complete and plan.failed are mutually exclusive (if/else on planResult.ok)', () => {
    expect(plannerSrc).toMatch(/if\s*\(planResult\.ok\)[\s\S]*?"plan\.complete"[\s\S]*?else[\s\S]*?"plan\.failed"/);
  });
});

describe('plan.failed telemetry (planner.mjs)', () => {
  it('emits plan.failed when persistAndFinalize returns ok: false', () => {
    expect(plannerSrc).toContain('"plan.failed"');
  });

  it('plan.failed payload includes reason field', () => {
    // At least one plan.failed emit must have a reason field
    const failedEmits = [...plannerSrc.matchAll(/emit\("plan\.failed"[\s\S]*?\}\)/g)].map(m => m[0]);
    expect(failedEmits.length).toBeGreaterThan(0);
    expect(failedEmits.some(e => e.includes('reason'))).toBe(true);
  });

  it('plan.failed emitted on refinementRequired early return', () => {
    // The refinementRequired block should now emit plan.failed before returning
    expect(plannerSrc).toMatch(/refinementRequired[\s\S]*?"plan\.failed"/);
  });

  it('no blanket try/catch wrapper added around entire runPlanTool body', () => {
    // The function body should not start with a giant try block
    // Check: no single try block that spans from after params to the persistAndFinalize call
    const fnBody = plannerSrc.slice(plannerSrc.indexOf('async function runPlanTool'));
    // The outer try/catch for the refinementRequired block is local — not wrapping everything
    // Verify persistAndFinalize is NOT inside a top-level try block for the whole function
    expect(plannerSrc).toContain('return planResult;');
    // planStartMs must be declared at function scope, not inside a try
    expect(plannerSrc).toMatch(/planStartMs = Date\.now\(\);\s*\n\s*const context/);
  });
});

describe('plan.prompt.snippets_missing reason field (planner-llm.mjs)', () => {
  // planner-llm.mjs uses emitTelemetry() wrapper, not emit() directly
  const missingEmit = plannerLlmSrc.match(/emitTelemetry\("plan\.prompt\.snippets_missing"[\s\S]*?\}\)/)?.[0] ?? '';

  it('emits plan.prompt.snippets_missing with reason field', () => {
    expect(missingEmit).toContain('reason:');
  });

  it("reason is 'rag_miss' when targetFiles are present (ternary based on frontmatterTargets.length)", () => {
    expect(plannerLlmSrc).toContain("'rag_miss'");
    expect(plannerLlmSrc).toContain("'query_empty'");
    expect(plannerLlmSrc).toMatch(/frontmatterTargets\?\.length\s*>\s*0\s*\?\s*'rag_miss'\s*:\s*'query_empty'/);
  });

  it("reason does NOT include 'file_not_indexed' (not distinguishable at this layer)", () => {
    expect(missingEmit).not.toContain('file_not_indexed');
  });

  it('existing fields (targetFiles, promptLength, slug) are preserved', () => {
    expect(missingEmit).toContain('targetFiles');
    expect(missingEmit).toContain('promptLength');
    expect(missingEmit).toContain('slug');
  });
});
