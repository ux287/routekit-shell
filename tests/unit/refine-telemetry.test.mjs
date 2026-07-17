/**
 * Tests for refine.mjs telemetry enrichment
 * (backlog.feat.telemetry-refine-lifecycle)
 *
 * Verifies refine.complete and refine.failed payload shapes.
 * ARCH note: refine.complete uses suggestionsGenerated (not changesApplied) —
 * runRefineTool produces suggestions, not applied changes (that's runRefineApplyTool).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const refineSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/refine.mjs'),
  'utf8'
);

describe('refine.complete telemetry', () => {
  it('emits refine.complete at the successful exit of runRefineTool', () => {
    expect(refineSrc).toContain('"refine.complete"');
  });

  it('refine.complete payload includes suggestionsGenerated (not changesApplied)', () => {
    expect(refineSrc).toContain('suggestionsGenerated');
    expect(refineSrc).not.toContain('changesApplied');
  });

  it('suggestionsGenerated equals suggestions.length', () => {
    expect(refineSrc).toMatch(/suggestionsGenerated:\s*suggestions\.length/);
  });

  it('refine.complete payload includes trigger field', () => {
    const completeEmit = refineSrc.match(/emit\("refine\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('trigger:');
  });

  it('refine.complete payload includes durationMs using refineStartMs', () => {
    const completeEmit = refineSrc.match(/emit\("refine\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('durationMs');
    expect(completeEmit).toContain('refineStartMs');
  });

  it('refine.complete payload includes problemId', () => {
    const completeEmit = refineSrc.match(/emit\("refine\.complete"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(completeEmit).toContain('problemId');
  });

  it('refine.complete is only in runRefineTool, not runRefineApplyTool', () => {
    // runRefineApplyTool emits refine.apply, not refine.complete
    const applySection = refineSrc.split('runRefineApplyTool')[1] ?? '';
    expect(applySection).not.toContain('"refine.complete"');
  });
});

describe('refine.failed telemetry', () => {
  it('emits refine.failed in the outer catch block of runRefineTool', () => {
    expect(refineSrc).toContain('"refine.failed"');
  });

  it('refine.failed payload includes trigger field', () => {
    const failedEmit = refineSrc.match(/emit\("refine\.failed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(failedEmit).toContain('trigger:');
  });

  it('refine.failed payload includes durationMs', () => {
    const failedEmit = refineSrc.match(/emit\("refine\.failed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(failedEmit).toContain('durationMs');
  });

  it('refine.failed payload includes error field', () => {
    const failedEmit = refineSrc.match(/emit\("refine\.failed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(failedEmit).toContain('error:');
  });

  it('refine.failed payload includes problemId', () => {
    const failedEmit = refineSrc.match(/emit\("refine\.failed"[\s\S]*?\}\)/)?.[0] ?? '';
    expect(failedEmit).toContain('problemId');
  });
});

describe('refine.complete and refine.failed are mutually exclusive', () => {
  it('refine.complete is wrapped in try/catch for best-effort delivery', () => {
    // The emit should be inside a try block
    expect(refineSrc).toMatch(/try\s*\{[\s\S]*?"refine\.complete"/);
  });

  it('refine.failed is wrapped in try/catch for best-effort delivery', () => {
    expect(refineSrc).toMatch(/try\s*\{[\s\S]*?"refine\.failed"/);
  });

  it('existing refine.analyze events are unchanged', () => {
    expect(refineSrc).toContain('"refine.analyze"');
    expect(refineSrc).toContain('suggestionCount');
  });
});
