/**
 * Witness: the planner's LOUD structural signal FIRES on note-only LLM output for a
 * from-scratch op:create target — the airvoyant v0.21.1 "structural never fired" claim,
 * verified against the REAL routing and proven NOT to reproduce on current staging.
 *
 * GROUNDING — real off-rail harness (2026-07-09, story
 * backlog.test.planner-structural-degeneracy-real-verification):
 *   The REAL gatherTargetContext() (planner-context.mjs) was run against a REAL op:create
 *   story (frontmatter targetFiles: [{ path: "public/decks/repro-deck.html", op: "create" }],
 *   NO "CREATE FILE:" body directive, NO in-repo anchor, zero RAG snippets). It returned:
 *       frontmatterCreateFiles = ["public/decks/repro-deck.html"]   (size 1)
 *       automatedSteps        = []
 *   Therefore, at planner.mjs (runPlanTool, the immediate-structural block), for a note-only
 *   LLM result (no create_file action with content → llmCreatePaths empty):
 *       uncoveredCreatesAfterLlm = frontmatterCreateFiles − automatedStepPaths − llmCreatePaths
 *                                = ["public/decks/repro-deck.html"]  (length > 0)
 *   → buildStructuralFailure fires DETERMINISTICALLY and the call returns
 *     { failureClass:"structural", uncoveredCreateTargets:[...], refinable:false, message:… }
 *     BEFORE reaching the generic has_note_steps retry.
 *
 *   This is the "forced-empty LLM, everything-else-real" reproduction. It does NOT bypass the
 *   real frontmatterCreateFiles derivation (that derivation is separately guarded by
 *   tests/unit/planner-context.frontmatter-create-fold-op-edit.test.mjs and the live-read
 *   planner-context tests). The refine-layer "createFiles: {} / no CREATE FILE directive"
 *   heuristic is a DIFFERENT set and does NOT gate this structural check.
 *
 * This witness pins the two pieces the grounding depends on:
 *   1. the REAL buildStructuralFailure contract (behavioral), and
 *   2. the wiring in planner.mjs that routes a non-empty uncovered op:create set to it and
 *      returns the structural discriminator BEFORE the has_note_steps retry (regression guard).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildStructuralFailure } from '../../packages/mcp-rks/src/server/planner.mjs';
import { isSynthesizedBody } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

describe('buildStructuralFailure — loud, non-refinable structural contract', () => {
  it('names the uncovered create target(s), is non-refinable, and carries failureClass:structural', () => {
    const s = buildStructuralFailure(['public/decks/repro-deck.html']);
    expect(s.failureClass).toBe('structural');
    expect(s.uncoveredCreateTargets).toEqual(['public/decks/repro-deck.html']);
    expect(s.refinable).toBe(false);
    expect(typeof s.message).toBe('string');
    expect(s.message).toContain('public/decks/repro-deck.html');
  });

  it('filters falsy targets but still returns a structural object', () => {
    const s = buildStructuralFailure([null, 'public/decks/a.html', undefined, '']);
    expect(s.failureClass).toBe('structural');
    expect(s.uncoveredCreateTargets).toEqual(['public/decks/a.html']);
    expect(s.refinable).toBe(false);
  });

  it('handles a non-array input without throwing (defensive)', () => {
    const s = buildStructuralFailure(undefined);
    expect(s.failureClass).toBe('structural');
    expect(Array.isArray(s.uncoveredCreateTargets)).toBe(true);
    expect(s.uncoveredCreateTargets).toEqual([]);
  });
});

describe('planner.mjs — note-only op:create routes to structural BEFORE the has_note_steps retry', () => {
  const src = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server/planner.mjs'),
    'utf8'
  );

  it('uncoveredCreatesAfterLlm = frontmatterCreateFiles − automatedStepPaths − llmCreatePaths', () => {
    expect(src).toContain('const uncoveredCreatesAfterLlm = Array.from(frontmatterCreateFiles || [])');
    expect(src).toMatch(/!automatedStepPaths\.has\(p\)\s*&&\s*!llmCreatePaths\.has\(p\)/);
  });

  it('llmCreatePaths counts only create_file actions whose content is a REAL BODY (shared predicate)', () => {
    // backlog.fix.planner-greenfield-body-synthesis: was a source-grep pin on the old
    // `a?.content && String(a.content).trim()` rule — which counted PROSE NARRATION as content
    // and is what stranded greenfield plans. The gate now delegates to isSynthesizedBody; assert
    // the delegation, and assert the predicate's behavior directly (below) rather than grepping
    // the implementation for a copy of its own source text.
    expect(src).toMatch(/create_file"\s*&&\s*isSynthesizedBody\(/);
  });

  it('the shared predicate rejects narration/placeholders and accepts real bodies', () => {
    const p = 'src/components/Calculator.tsx';
    expect(isSynthesizedBody('', p)).toBe(false);
    expect(isSynthesizedBody('// TODO: implement', p)).toBe(false);
    expect(isSynthesizedBody('Create a Calculator component that handles the four operations.', p)).toBe(false);
    expect(isSynthesizedBody('export const Calculator = () => <div>0</div>;', p)).toBe(true);
    // A real body containing an incidental TODO is still a real body — must not over-reject.
    expect(isSynthesizedBody('export const C = () => {\n  // TODO: edge case\n  return null;\n};', p)).toBe(true);
    // Prose-shaped content in a PROSE file type is legitimate content.
    expect(isSynthesizedBody('Create a deck about governed AI.', 'notes/deck.md')).toBe(true);
  });

  it('a non-empty uncovered create set returns the structural discriminator immediately', () => {
    const idx = src.indexOf('if (uncoveredCreatesAfterLlm.length > 0) {');
    expect(idx).toBeGreaterThan(-1);
    // Slice to the END of the block (next top-level `const ` at the same indent), not a fixed
    // char count: a 2200-char window silently empties the moment the block above it grows, and
    // then every assertion below vacuously "passes" against an empty string.
    const rest = src.slice(idx);
    const endIdx = rest.indexOf('\n  const hasNoteSteps');
    const block = endIdx > -1 ? rest.slice(0, endIdx) : rest;
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain('buildStructuralFailure(uncoveredCreatesAfterLlm)');
    expect(block).toContain('failureClass: structural.failureClass');
    expect(block).toContain('uncoveredCreateTargets: structural.uncoveredCreateTargets');
    expect(block).toContain('refinable: structural.refinable');
  });

  it('the immediate structural return precedes the generic has_note_steps retry block', () => {
    const structIdx = src.indexOf('if (uncoveredCreatesAfterLlm.length > 0) {');
    const retryIdx = src.indexOf('const hasNoteSteps = combinedSteps.some(s => s?.action === "note")');
    expect(structIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(structIdx);
  });
});
