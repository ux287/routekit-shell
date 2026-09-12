/**
 * Tests for checkOverlappingEditRegions in plan-quality.mjs
 *
 * Covers:
 * 1. checkOverlappingEditRegions is exported from plan-quality.mjs
 * 2. Dependent-output overlap: REPLACE(A) contains 30+ char substring from SEARCH(B) → error
 * 3. Adjacent line ranges (gap ≤ 3): two edits on same file within 3 lines → error
 * 4. Overlapping line ranges: two edits whose SEARCH regions overlap → error
 * 5. Different files: two steps on different files → no error
 * 6. Single step on a file: no pair → no error
 * 7. Same step, multiple edits: edits in same step → no error (atomic)
 * 8. reviewPlan() propagates overlapping_edit_regions errors to ok: false
 * 9. planner.mjs DEPENDENT CHAINS bullet contains structural-transformation example
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDir, writeFile, ensureDir } from '../helpers/tmp.mjs';
import { checkOverlappingEditRegions, reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeStep(order, title, filePath, edits) {
  return {
    order,
    title,
    action: 'search_replace',
    path: filePath,
    edits,
  };
}

function makePlan(steps) {
  return { steps };
}

// ─── export check ────────────────────────────────────────────────────────────

describe('checkOverlappingEditRegions — export', () => {
  it('is exported from plan-quality.mjs', () => {
    expect(typeof checkOverlappingEditRegions).toBe('function');
  });
});

// ─── dependent-output overlap (check a) ─────────────────────────────────────

describe('checkOverlappingEditRegions — dependent-output overlap', () => {
  it('returns error when REPLACE(A) contains 30+ char substring from SEARCH(B) on same file', () => {
    const plan = makePlan([
      makeStep(1, 'Rename function', 'src/foo.mjs', [{
        search: 'function oldName() {',
        replace: 'function newName() {\n  const processHelper = () => { return transformData(input); };',
      }]),
      makeStep(2, 'Add call', 'src/foo.mjs', [{
        search: 'const processHelper = () => { return transformData(input); };',
        replace: 'const processHelper = () => { return transformData(input); };\n  processHelper();',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('overlapping_edit_regions');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].file).toBe('src/foo.mjs');
  });

  it('error message names both step titles and the file', () => {
    const plan = makePlan([
      makeStep(1, 'Step Alpha', 'src/bar.mjs', [{
        search: 'const OLD = "value";',
        replace: 'const NEW = "value";\nconst helperFn = () => processAndTransformTheValue(NEW);',
      }]),
      makeStep(2, 'Step Beta', 'src/bar.mjs', [{
        search: 'const helperFn = () => processAndTransformTheValue(NEW);',
        replace: 'const helperFn = () => processAndTransformTheValue(NEW);\nhelperFn();',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    const issue = issues[0];
    expect(issue.message).toMatch(/Step Alpha/);
    expect(issue.message).toMatch(/Step Beta/);
    expect(issue.message).toMatch(/src\/bar\.mjs/);
    expect(issue.suggestion).toMatch(/[Mm]erge/);
  });

  it('does NOT flag dependent-output when SEARCH(B) already exists in the file (independent sections with shared patterns)', async () => {
    // Simulates adjacent form sections: REPLACE(A) generates Tailwind patterns
    // that also appear in SEARCH(B) — but SEARCH(B) content already exists on disk.
    const projectRoot2 = makeTempDir('dep_output_file_guard');
    ensureDir(path.join(projectRoot2, 'src'));
    // The file has section-a and section-b as distinct adjacent blocks
    const content = [
      '<div class="section-a">',
      '  <label>Field A</label>',
      '  <input type="text" />',
      '</div>',
      '<div class="section-b">',
      '  <label>Field B</label>',
      '  <input type="text" />',
      '</div>',
    ].join('\n');
    writeFile(path.join(projectRoot2, 'src/form.tsx'), content);

    const plan = makePlan([
      makeStep(1, 'Rewrite section A', 'src/form.tsx', [{
        search: '<div class="section-a">\n  <label>Field A</label>\n  <input type="text" />\n</div>',
        // REPLACE contains a 30+ char pattern that also appears in section-b SEARCH
        replace: '<div className="flex flex-col gap-1">\n  <label>Field A</label>\n  <input type="text" />\n</div>',
      }]),
      makeStep(2, 'Rewrite section B', 'src/form.tsx', [{
        // SEARCH exists in the current file — B is independent of A
        search: '<div class="section-b">\n  <label>Field B</label>\n  <input type="text" />\n</div>',
        replace: '<div className="flex flex-col gap-1">\n  <label>Field B</label>\n  <input type="text" />\n</div>',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, projectRoot2);
    try { fs.rmSync(projectRoot2, { recursive: true, force: true }); } catch { /* ignore */ }
    // SEARCH(B) exists on disk → no dependent-output error even if REPLACE(A) shares patterns
    expect(issues).toHaveLength(0);
  });

  it('does not error when overlap substring is shorter than 30 chars', () => {
    // Short common patterns should not trigger false positives
    const plan = makePlan([
      makeStep(1, 'Edit header', 'src/baz.mjs', [{
        search: 'const x = 1;',
        replace: 'const x = 2;\n</div>',
      }]),
      makeStep(2, 'Edit footer', 'src/baz.mjs', [{
        search: '</div>',
        replace: '</section>',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    // </div> is only 6 chars — should not trigger dependent-output check
    expect(issues).toHaveLength(0);
  });
});

// ─── line range checks (check b) ─────────────────────────────────────────────

describe('checkOverlappingEditRegions — adjacent/overlapping line ranges', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('overlap_line_test');
    ensureDir(path.join(projectRoot, 'src'));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns error when two edits on same file have overlapping SEARCH regions', () => {
    // Write a file where two SEARCH patterns overlap in line range
    const content = [
      'function foo() {',   // line 0
      '  const a = 1;',     // line 1
      '  const b = 2;',     // line 2
      '  const c = 3;',     // line 3
      '  return a + b + c;', // line 4
      '}',                   // line 5
    ].join('\n');
    writeFile(path.join(projectRoot, 'src/example.mjs'), content);

    // Step 1 SEARCH covers lines 1-3 (overlaps with step 2)
    // Step 2 SEARCH covers lines 2-4 (overlaps with step 1)
    const plan = makePlan([
      makeStep(1, 'Edit middle', 'src/example.mjs', [{
        search: '  const a = 1;\n  const b = 2;\n  const c = 3;',
        replace: '  const a = 10;\n  const b = 20;\n  const c = 30;',
      }]),
      makeStep(2, 'Edit tail', 'src/example.mjs', [{
        search: '  const b = 2;\n  const c = 3;\n  return a + b + c;',
        replace: '  const b = 20;\n  const c = 30;\n  return a + b + c;',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, projectRoot);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('overlapping_edit_regions');
    expect(issues[0].severity).toBe('error');
    expect(issues[0].file).toBe('src/example.mjs');
  });

  it('does NOT return error for adjacent SEARCH regions (gap = 1) — adjacent sections are independent', () => {
    const content = [
      'const alpha = "a";',  // line 0
      'const beta = "b";',   // line 1
      'const gamma = "c";',  // line 2
      'const delta = "d";',  // line 3
      'const epsilon = "e";',// line 4
    ].join('\n');
    writeFile(path.join(projectRoot, 'src/adjacent.mjs'), content);

    // Step 1 SEARCH covers lines 0-1 (ends at line 1)
    // Step 2 SEARCH covers line 3 (starts at line 3 = gap of 1 line)
    const plan = makePlan([
      makeStep(1, 'Edit top', 'src/adjacent.mjs', [{
        search: 'const alpha = "a";\nconst beta = "b";',
        replace: 'const alpha = "A";\nconst beta = "B";',
      }]),
      makeStep(2, 'Edit near', 'src/adjacent.mjs', [{
        search: 'const delta = "d";',
        replace: 'const delta = "D";',
      }]),
    ]);
    // gap = 1 line — adjacent but independent, should NOT trigger
    const issues = checkOverlappingEditRegions(plan, projectRoot);
    expect(issues).toHaveLength(0);
  });

  it('does not return error when two edits on same file have gap > 3 lines', () => {
    const content = [
      'const line0 = 0;',
      'const line1 = 1;',
      'const line2 = 2;',
      'const line3 = 3;',
      'const line4 = 4;',
      'const line5 = 5;',
      'const line6 = 6;',
      'const line7 = 7;',
      'const line8 = 8;',
    ].join('\n');
    writeFile(path.join(projectRoot, 'src/spaced.mjs'), content);

    // Step 1 SEARCH: line 0 (1 line)
    // Step 2 SEARCH: line 5 (gap = 4 lines > 3 → no error)
    const plan = makePlan([
      makeStep(1, 'Edit top', 'src/spaced.mjs', [{
        search: 'const line0 = 0;',
        replace: 'const line0 = 99;',
      }]),
      makeStep(2, 'Edit bottom', 'src/spaced.mjs', [{
        search: 'const line5 = 5;',
        replace: 'const line5 = 99;',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, projectRoot);
    expect(issues).toHaveLength(0);
  });
});

// ─── no false positives ───────────────────────────────────────────────────────

describe('checkOverlappingEditRegions — no false positives', () => {
  it('returns no error for two steps on different files', () => {
    const plan = makePlan([
      makeStep(1, 'Edit file A', 'src/a.mjs', [{
        search: 'const x = processAndTransformTheValue(input);',
        replace: 'const x = processAndTransformTheValue(output);',
      }]),
      makeStep(2, 'Edit file B', 'src/b.mjs', [{
        search: 'const x = processAndTransformTheValue(input);',
        replace: 'const x = processAndTransformTheValue(output);',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    expect(issues).toHaveLength(0);
  });

  it('returns no error for a single search_replace step on a file', () => {
    const plan = makePlan([
      makeStep(1, 'Only step', 'src/solo.mjs', [{
        search: 'const y = processAndTransformTheValue(input);',
        replace: 'const y = processAndTransformTheValue(output);',
      }]),
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    expect(issues).toHaveLength(0);
  });

  it('returns no error for multiple edits within the same step (same-step edits are atomic)', () => {
    const plan = makePlan([
      {
        order: 1,
        title: 'Multi-edit step',
        action: 'search_replace',
        path: 'src/multi.mjs',
        edits: [
          {
            search: 'const processAndTransformInputValue = () => processData(input);',
            replace: 'const processAndTransformInputValue = () => processData(output);',
          },
          {
            search: 'const processAndTransformOutputValue = () => processData(output);',
            replace: 'const processAndTransformOutputValue = () => processData(final);',
          },
        ],
      },
    ]);
    const issues = checkOverlappingEditRegions(plan, null);
    expect(issues).toHaveLength(0);
  });
});

// ─── reviewPlan integration ──────────────────────────────────────────────────

describe('reviewPlan — overlapping_edit_regions propagation', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('review_plan_overlap');
    ensureDir(path.join(projectRoot, 'src'));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns ok: false when plan has overlapping edit regions', async () => {
    const content = [
      'function wrapper() {',
      '  const processAndTransformTheInputValue = () => transformData(raw);',
      '  const processAndTransformTheOutputValue = () => formatData(raw);',
      '  return processAndTransformTheInputValue();',
      '}',
    ].join('\n');
    writeFile(path.join(projectRoot, 'src/wrap.mjs'), content);

    // Step 1 REPLACE contains 30+ char text that step 2 SEARCH looks for
    const plan = makePlan([
      makeStep(1, 'Refactor helper', 'src/wrap.mjs', [{
        search: 'function wrapper() {',
        replace: 'function wrapper() {\n  const processAndTransformTheInputValue = () => transformData(final);',
      }]),
      makeStep(2, 'Wire helper', 'src/wrap.mjs', [{
        search: 'const processAndTransformTheInputValue = () => transformData(final);',
        replace: 'const processAndTransformTheInputValue = () => transformData(final);\n  // done',
      }]),
    ]);

    const result = await reviewPlan({ projectRoot, plan, problemContent: null });
    expect(result.ok).toBe(false);
    const overlapErrors = result.errors.filter(e => e.check === 'overlapping_edit_regions');
    expect(overlapErrors.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── planner.mjs guidance check ──────────────────────────────────────────────

describe('planner.mjs DEPENDENT CHAINS rule', () => {
  it('contains structural-transformation example mentioning closing region', () => {
    const plannerPath = path.resolve(
      new URL('../../packages/mcp-rks/src/llm/planner.mjs', import.meta.url).pathname
    );
    expect(fs.existsSync(plannerPath)).toBe(true);
    const content = fs.readFileSync(plannerPath, 'utf8');
    expect(content).toMatch(/DEPENDENT CHAINS NOT ALLOWED/);
    expect(content).toMatch(/closing region/i);
    expect(content).toMatch(/Fragment/i);
  });
});
