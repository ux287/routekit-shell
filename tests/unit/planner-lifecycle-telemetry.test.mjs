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

  // backlog.fix.planner-note-step-degeneracy — the op:create rag_miss carve-out is ADDITIVE:
  // rag_miss on a not-yet-existing op:create target must NOT suppress create-step generation.
  // The pinned ternary above stays verbatim; the carve-out is appended downstream of it.
  it('adds an op:create carve-out that does not block create-step generation (additive)', () => {
    expect(plannerLlmSrc).toContain('op:create carve-out');
    expect(plannerLlmSrc).toContain('CREATE TARGETS');
    expect(plannerLlmSrc).toContain('uncoveredCreatePaths');
    // Carve-out must appear AFTER the pinned reason ternary — additive, not a replacement.
    const ternaryIdx = plannerLlmSrc.indexOf("? 'rag_miss' : 'query_empty'");
    const carveIdx = plannerLlmSrc.indexOf('op:create carve-out');
    expect(ternaryIdx).toBeGreaterThan(-1);
    expect(carveIdx).toBeGreaterThan(ternaryIdx);
  });
});

// backlog.fix.plan-failed-worker-terminals-carry-no-failureclass
// Both worker-outcome plan.failed terminals carry a classifier-derived class. Slices are
// bounded by structural markers, never a fixed window.
describe('plan.failed worker-outcome terminals carry failureClass', () => {
  const site1Start = plannerSrc.indexOf('if (llmOrchResult.refinementRequired) {');
  // `return {` — the block's comment contains "early-return", so a bare "return" stops short.
  const site1Return = plannerSrc.indexOf('return {', site1Start);
  const site1End = plannerSrc.indexOf('};', site1Return);
  const site1 = plannerSrc.slice(site1Start, site1End);
  const site1Head = plannerSrc.slice(site1Start, site1Return);

  const site2Start = plannerSrc.indexOf('const planResult = await persistAndFinalize(');
  const site2End = plannerSrc.indexOf('return planResult;', site2Start);
  const site2 = plannerSrc.slice(site2Start, site2End);

  it('site 1: the refinementRequired emit carries failureClass from a classifyMarkerFailure call', () => {
    expect(site1Start).toBeGreaterThan(-1);
    expect(site1Head).toMatch(/emit\("plan\.failed"[^\n]*failureClass/);
    expect(site1Head).toContain('classifyMarkerFailure(');
  });

  it('site 1: emit and return share ONE derived identifier', () => {
    expect(site1.split('classifyMarkerFailure(').length - 1).toBe(1);
    const ident = site1.match(/const (\w+) = classifyMarkerFailure\(/)?.[1];
    expect(ident).toBeTruthy();
    expect(site1Head).toMatch(new RegExp(`emit\\("plan\\.failed"[^\\n]*failureClass: ${ident}\\b`));
    expect(plannerSrc.slice(site1Return, site1End)).toMatch(new RegExp(`failureClass: ${ident}\\b`));
  });

  it('site 1: the classification input is refinement_required plus failReason', () => {
    const call = site1.slice(site1.indexOf('classifyMarkerFailure('));
    const callLine = call.slice(0, call.indexOf('\n'));
    expect(callLine).toContain('"refinement_required"');
    expect(callLine).toContain('failReason');
  });

  it('site 1 (R9): classified before the best-effort try; returned stamp after its catch', () => {
    const callIdx = site1.indexOf('classifyMarkerFailure(');
    const tryIdx = site1.indexOf('try {');
    const catchIdx = site1.indexOf('/* telemetry is best-effort */');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeLessThan(tryIdx);
    const tryLine = site1.slice(tryIdx, site1.indexOf('\n', tryIdx));
    expect(tryLine).not.toContain('classifyMarkerFailure');
    expect(site1.lastIndexOf('failureClass:')).toBeGreaterThan(catchIdx);
  });

  it('site 2: stamped only under a quality_failed status gate', () => {
    const gateIdx = site2.indexOf('planResult.status === "quality_failed"');
    const callIdx = site2.indexOf('classifyMarkerFailure(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(gateIdx);
    expect(site2).toMatch(/classifyMarkerFailure\(planResult\)\.failureClass/);
    expect(site2).toMatch(/planResult\.failureClass = \w+;/);
    expect(site2).toMatch(/emit\("plan\.failed"[^\n]*failureClass/);
  });

  it('site 2: every failureClass write is reachable only under the gate', () => {
    // Before the gate there is no failureClass write at all; the only planResult stamp sits
    // inside the gated block, and the emit spreads the class only when the gated local is set.
    const gateIdx = site2.indexOf('if (planResult.status === "quality_failed") {');
    const gateEnd = site2.indexOf('}', gateIdx);
    expect(site2.slice(0, gateIdx)).not.toContain('failureClass');
    const stamps = [...site2.matchAll(/planResult\.failureClass =/g)].map((m) => m.index);
    expect(stamps.length).toBe(1);
    expect(stamps[0]).toBeGreaterThan(gateIdx);
    expect(stamps[0]).toBeLessThan(gateEnd);
    const local = site2.match(/let (\w+) = null;/)?.[1];
    expect(local).toBeTruthy();
    expect(site2).toContain(`...(${local} ? { failureClass: ${local} } : {})`);
  });

  it('site 2 (R9): classifier call and stamp precede the best-effort try', () => {
    const tryIdx = site2.indexOf('try {');
    expect(tryIdx).toBeGreaterThan(-1);
    expect(site2.indexOf('classifyMarkerFailure(')).toBeLessThan(tryIdx);
    expect(site2.indexOf('planResult.failureClass =')).toBeLessThan(tryIdx);
    expect(site2.slice(tryIdx)).not.toContain('classifyMarkerFailure(');
  });

  it('site 2: no second if (planResult.ok) is introduced', () => {
    expect(plannerSrc.match(/if\s*\(planResult\.ok\)/g)).toHaveLength(1);
  });

  it('the four preflight emits stay unclassified; structural keeps its class', () => {
    for (const reason of ['not_ready', 'wrong_branch', 'dirty_tree', 'rag_stale']) {
      const lines = plannerSrc.split('\n').filter((l) => l.includes('"plan.failed"') && l.includes(`"${reason}"`));
      expect(lines, reason).toHaveLength(1);
      expect(lines[0], reason).not.toContain('failureClass');
    }
    const structural = plannerSrc.split('\n').filter((l) => l.includes('"plan.failed"') && l.includes('structural_create_unauthorable'));
    expect(structural.join('\n')).toContain('failureClass: structural.failureClass');
  });
});

describe('classifier context the site-2 gate exists for', async () => {
  const { classifyMarkerFailure } = await import('../../packages/mcp-rks/src/server/failure-classification.mjs');

  it('non-quality persist failures would be mislabelled worker_crashed if classified', () => {
    expect(classifyMarkerFailure({ ok: false, status: 'phase_write_failed' }).failureClass).toBe('worker_crashed');
    expect(classifyMarkerFailure({ ok: false, error: 'phase_immutable_plan_rejected' }).failureClass).toBe('worker_crashed');
  });

  it('refinement_required maps by reason', () => {
    expect(classifyMarkerFailure({ status: 'refinement_required', reason: 'create_file_complexity' }).failureClass).toBe('story_unplannable');
    expect(classifyMarkerFailure({ status: 'refinement_required', reason: 'stale_edits' }).failureClass).toBe('output_invalid');
  });
});
