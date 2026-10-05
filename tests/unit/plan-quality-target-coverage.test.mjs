import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';
import {
  buildPlanReviewArgs,
  formatPlanReviewBlockLog,
  describePlanContents,
} from '../../packages/mcp-rks/src/server/plan-quality.mjs';

// backlog.fix.plan-review-validates-target-coverage
// reviewPlan green-lit a plan covering 1 of 4 declared targets because it only inspected steps
// that were PRESENT. The op-aware coverage layer blocks any plan missing a covering step for a
// declared targetFile (op:create especially) — converting a silent incomplete-ship into a loud
// re-plan trigger. No-op when no targetFiles are declared (existing callers unaffected).

// Empty temp projectRoot so the create_file/destructive sub-checks see non-existent files and
// don't add unrelated errors; we assert specifically on the coverage issue.
let root;
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-planq-')); });
afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

const findCoverage = (r) => (r.errors || []).find((e) => e.check === 'incomplete_target_coverage');

describe('reviewPlan — declared-target coverage guard', () => {
  it('REJECTS a plan that dropped op:create targets (only the edit covered)', async () => {
    const plan = { steps: [{ action: 'search_replace', path: 'package.json', edits: [{ search: 'a', replace: 'b' }] }] };
    const targetFiles = [
      { path: 'package.json', op: 'edit' },
      { path: 'vitest.config.ts', op: 'create' },
      { path: 'src/test/setup.ts', op: 'create' },
    ];
    const r = await reviewPlan({ projectRoot: root, plan, targetFiles });
    expect(r.ok).toBe(false);
    const cov = findCoverage(r);
    expect(cov, 'expected an incomplete_target_coverage error').toBeTruthy();
    expect(cov.uncovered.map((u) => u.path)).toEqual(
      expect.arrayContaining(['vitest.config.ts', 'src/test/setup.ts'])
    );
  });

  it('ACCEPTS a plan that covers every declared target (op-aware)', async () => {
    const plan = { steps: [
      { action: 'search_replace', path: 'package.json', edits: [{ search: 'a', replace: 'b' }] },
      { action: 'create_file', path: 'vitest.config.ts', content: 'x' },
      { action: 'create_file', path: 'src/test/setup.ts', content: 'y' },
    ] };
    const targetFiles = [
      { path: 'package.json', op: 'edit' },
      { path: 'vitest.config.ts', op: 'create' },
      { path: 'src/test/setup.ts', op: 'create' },
    ];
    const r = await reviewPlan({ projectRoot: root, plan, targetFiles });
    expect(findCoverage(r), 'a complete plan must not raise a coverage error').toBeFalsy();
  });

  it('op-aware: an op:create target covered only by a search_replace step is still flagged', async () => {
    const plan = { steps: [{ action: 'search_replace', path: 'new.ts', edits: [{ search: 'a', replace: 'b' }] }] };
    const r = await reviewPlan({ projectRoot: root, plan, targetFiles: [{ path: 'new.ts', op: 'create' }] });
    expect(findCoverage(r)).toBeTruthy();
  });

  it('recognizes the raw frontmatter create shapes (action:CREATE / create:true)', async () => {
    const plan = { steps: [{ action: 'search_replace', path: 'x.ts', edits: [{ search: 'a', replace: 'b' }] }] };
    const r1 = await reviewPlan({ projectRoot: root, plan, targetFiles: [{ path: 'a.ts', action: 'CREATE' }] });
    expect(findCoverage(r1)).toBeTruthy();
    const r2 = await reviewPlan({ projectRoot: root, plan, targetFiles: [{ path: 'b.ts', create: true }] });
    expect(findCoverage(r2)).toBeTruthy();
  });

  it('is a NO-OP when no targetFiles are declared (existing callers unaffected)', async () => {
    const plan = { steps: [{ action: 'create_file', path: 'a.ts', content: 'x' }] };
    const r = await reviewPlan({ projectRoot: root, plan });
    expect(findCoverage(r)).toBeFalsy();
  });
});

// backlog.fix.plan-review-per-file-block-count-shortfall
// rks_plan_review compared nothing between the story's per-file @@SEARCH blocks and the plan's
// edits, so a plan that dropped a block for a file that still had other steps passed ok:true.
// These tests drive reviewPlan's authoredStoryBody check and the two exported handler helpers
// (buildPlanReviewArgs, formatPlanReviewBlockLog) behaviourally — no server.mjs source text.
describe('reviewPlan — authored-block shortfall check (authoredStoryBody)', () => {
  // Real files so every OTHER check (search_pattern_not_found, target_file_not_found, ...) passes
  // and `ok` reflects the authored-block check alone.
  const S1 = 'const s1 = 1;';
  const S2 = 'const s2 = 2;';
  const S = 'const shared = 3;';
  const T = 'const other = 4;';
  const U = 'const unrelated = 5;';
  const FILE_BODY = [S1, S2, S, T, U, ''].join('\n');
  let broot;
  beforeAll(() => {
    broot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-planq-blocks-'));
    for (const rel of ['a.mjs', 'b.mjs', 'packages/x/a.mjs', 'src/a.mjs']) {
      fs.mkdirSync(path.dirname(path.join(broot, rel)), { recursive: true });
      fs.writeFileSync(path.join(broot, rel), FILE_BODY);
    }
  });
  afterAll(() => {
    if (broot) fs.rmSync(broot, { recursive: true, force: true });
  });

  const block = (label, search, replace = `${search} // edited`) =>
    `${label === null ? '' : `${label}\n`}@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END\n`;
  const step = (file, ...searches) => ({
    action: 'search_replace', path: file,
    edits: searches.map((s) => ({ search: s, replace: `${s} // edited` })),
  });
  const TF_A = [{ path: 'a.mjs', op: 'edit' }];
  const TF_AB = [{ path: 'a.mjs', op: 'edit' }, { path: 'b.mjs', op: 'edit' }];
  const shortfalls = (r) => (r.errors || []).filter((e) => e.check === 'authored_block_shortfall');
  const unattributed = (r) => (r.warnings || []).filter((w) => w.check === 'unattributed_authored_block');
  const review = (authoredStoryBody, steps, targetFiles = TF_A, extra = {}) =>
    reviewPlan({ projectRoot: broot, plan: { steps }, targetFiles, checkExecutableSteps: true, authoredStoryBody, ...extra });

  // Shapes the counted-category fixtures share.
  const fencedPairBody = (heading) =>
    `${heading}\n\nSEARCH:\n\`\`\`js\n${S1}\n\`\`\`\nREPLACE:\n\`\`\`js\n${S1} // edited\n\`\`\`\n`;
  const headingPairBody =
    `### EDIT: a.mjs\n\n#### SEARCH\n\`\`\`js\n${S2}\n\`\`\`\n\n#### REPLACE\n\`\`\`js\n${S2} // edited\n\`\`\`\n`;
  const addBody = (verb) => `Add ${verb} \`${T}\`:\n\`\`\`js\nconst added = 6;\n\`\`\`\n`;
  const conflictBody =
    `### a.mjs\n<<<<<<< SEARCH\n${S1}\n=======\n${S1} // edited\n>>>>>>> REPLACE\n`;

  // R1, R2, R3
  it('R1-R3: a dropped block for a file that still has another step is ONE blocking shortfall error', async () => {
    // Each block directly under a ### a.mjs heading line.
    const body = block('### a.mjs', S1) + '\n' + block('### a.mjs', S2);
    const r = await review(body, [step('a.mjs', S1)]);
    expect(r.ok).toBe(false);
    const sf = shortfalls(r);
    expect(sf).toHaveLength(1);
    expect(sf[0].file).toBe('a.mjs');
    expect(sf[0].authored).toBe(2);
    expect(sf[0].matched).toBe(1);
    const preview = sf[0].missingPreviews.join('\n');
    expect(preview).toContain(S2);
    expect(preview).not.toContain(S1);
    expect(r.unplannedBlocks).toBe(1);
    // R2: own check id, distinct from incomplete_target_coverage, selectable like findCoverage.
    expect(sf[0].check).not.toBe('incomplete_target_coverage');
    expect(findCoverage(r)).toBeFalsy();
    // R3: blocking (in errors, not warnings) and the ONLY error, so ok is false solely by it.
    expect(r.errors).toHaveLength(1);
    expect((r.warnings || []).some((w) => w.check === 'authored_block_shortfall')).toBe(false);
  });

  it('R1 (single-heading form): two blocks under ONE ### a.mjs heading', async () => {
    // The second block's nearest non-blank line above is the first block's @@END, so it
    // continues the run under the same heading and binds to a.mjs too.
    const body = `### a.mjs\n\n${block(null, S1)}\n${block(null, S2)}`;
    const r = await review(body, [step('a.mjs', S1)]);
    expect(r.ok).toBe(false);
    const sf = shortfalls(r);
    expect(sf).toHaveLength(1);
    expect(sf[0].file).toBe('a.mjs');
    expect(sf[0].authored).toBe(2);
    expect(sf[0].matched).toBe(1);
    expect(sf[0].missingPreviews.join('\n')).toContain(S2);
    expect(sf[0].missingPreviews.join('\n')).not.toContain(S1);
    expect(r.unplannedBlocks).toBe(1);
    expect(r.unattributedBlocks).toBe(0);
  });

  it('prose between two blocks breaks the run: the second block is unattributed, not a shortfall', async () => {
    const body = `### a.mjs\n${block(null, S1)}\nThen also change this:\n${block(null, S2)}`;
    const r = await review(body, [step('a.mjs', S1)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBe(1);
    expect(unattributed(r)[0].reason).toBe('no_label');
  });

  // R4
  it('R4: per (file, SEARCH), never per step - one step with both edits, or two steps, both cover', async () => {
    const body = block('### a.mjs', S1) + '\n' + block('### a.mjs', S2);
    const one = await review(body, [step('a.mjs', S1, S2)]);
    expect(shortfalls(one)).toHaveLength(0);
    expect(one.unplannedBlocks).toBe(0);
    const two = await review(body, [step('a.mjs', S1), step('a.mjs', S2)]);
    expect(shortfalls(two)).toHaveLength(0);
    expect(two.unplannedBlocks).toBe(0);
  });

  // R5
  it('R5: the single-edit step shape (step.search, no edits[]) covers its block', async () => {
    const body = block('### a.mjs', S1) + '\n' + block('### a.mjs', S2);
    const r = await review(body, [
      step('a.mjs', S1),
      { action: 'search_replace', path: 'a.mjs', search: S2, replace: `${S2} // edited` },
    ]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
  });

  // R6
  it('R6: a whitespace-only difference (indentation, inner spaces, trailing spaces) still covers', async () => {
    const body = block('### a.mjs', S1) + '\n' + block('### a.mjs', `${S2}   `);
    const r = await review(body, [step('a.mjs', S1, '    const   s2  =  2;   ')]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
  });

  // R7
  it('R7: a byte-identical pair under one heading counts once', async () => {
    const body = `### a.mjs\n${block(null, S)}\n${block(null, S)}\n${block(null, T)}`;
    const both = await review(body, [step('a.mjs', S, T)]);
    expect(shortfalls(both)).toHaveLength(0);
    expect(both.unplannedBlocks).toBe(0);
    const onlyT = await review(body, [step('a.mjs', T)]);
    const sf = shortfalls(onlyT);
    expect(sf).toHaveLength(1);
    expect(sf[0].file).toBe('a.mjs');
    expect(sf[0].authored).toBe(2);
    expect(sf[0].matched).toBe(1);
    expect(onlyT.unplannedBlocks).toBe(1);
  });

  // R8
  it('R8: identity blocks never count - not in the authored count, not unattributed', async () => {
    const body = block('### a.mjs', S1) + '\n' + block('### a.mjs', S2, S2);
    const r = await review(body, [step('a.mjs', S1)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    const r2 = await review(block('### a.mjs', S1) + '\n' + block('### a.mjs', T), [step('a.mjs', S1)]);
    expect(shortfalls(r2)[0].authored).toBe(2); // control: a non-identity T does raise the count
    const headless = await review(block(null, S2, S2), [step('a.mjs', S1)]);
    expect(headless.unattributedBlocks).toBe(0);
    expect(unattributed(headless)).toHaveLength(0);
  });

  // R9
  it('R9: an identical block under two headings counts once PER FILE', async () => {
    const body = block('### a.mjs', S) + '\n' + block('### b.mjs', S);
    const r = await review(body, [step('a.mjs', S), step('b.mjs', T)], TF_AB);
    const sf = shortfalls(r);
    expect(sf.map((e) => e.file)).toEqual(['b.mjs']);
    expect(r.unplannedBlocks).toBe(1);
    const both = await review(body, [step('a.mjs', S), step('b.mjs', S)], TF_AB);
    expect(shortfalls(both)).toHaveLength(0);
    expect(both.unplannedBlocks).toBe(0);
  });

  // R10
  it('R10: an edit for a.mjs never satisfies a block authored under b.mjs', async () => {
    const body = block('### b.mjs', S1);
    const r = await review(body, [step('a.mjs', S1), step('b.mjs', T)], TF_AB);
    const sf = shortfalls(r);
    expect(sf).toHaveLength(1);
    expect(sf[0].file).toBe('b.mjs');
    // The step's file is read as Layer 0 reads it: s.path || s.target.
    const viaTarget = await review(body, [step('a.mjs', T), { action: 'search_replace', target: 'b.mjs', edits: [{ search: S1, replace: 'x' }] }], TF_AB);
    expect(shortfalls(viaTarget)).toHaveLength(0);
  });

  // R11
  it('R11: repo-relative paths as stories write them', async () => {
    const p = 'packages/x/a.mjs';
    const body = block(`### ${p}`, S1) + '\n' + block(`### ${p}`, S2);
    const r = await review(body, [step(p, S1)], [{ path: p, op: 'edit' }]);
    const sf = shortfalls(r);
    expect(sf).toHaveLength(1);
    expect(sf[0].file).toBe(p);
    expect(r.unplannedBlocks).toBe(1);
  });

  // R12
  it('R12: only op:edit targets are checked; op:create excluded everywhere; non-target heading is unattributed', async () => {
    const tf = [{ path: 'a.mjs', op: 'edit' }, { path: 'new.mjs', op: 'create' }];
    const createOnly = await review(block('### new.mjs', S1), [step('a.mjs', T)], tf);
    expect(shortfalls(createOnly)).toHaveLength(0);
    expect(createOnly.unplannedBlocks).toBe(0);
    expect(createOnly.unattributedBlocks).toBe(0);
    expect(unattributed(createOnly)).toHaveLength(0);
    const nonTarget = await review(block('### other.mjs', S1), [step('a.mjs', T)], tf);
    expect(shortfalls(nonTarget)).toHaveLength(0);
    expect(nonTarget.unplannedBlocks).toBe(0);
    expect(nonTarget.unattributedBlocks).toBe(1);
    expect(unattributed(nonTarget)).toHaveLength(1);
  });

  // R13, R14, R15, R16
  for (const [name, label] of [
    ['R13: level-2 heading', '## a.mjs'],
    ['R14: level-4 heading', '#### a.mjs'],
    ['R15: ### Target: label is stripped', '### Target: a.mjs'],
    ['R16: a File: line directly above the marker', 'File: a.mjs'],
  ]) {
    it(`${name} binds the block`, async () => {
      const body = `Some prose.\n\n${block(label, S)}`;
      const miss = await review(body, [step('a.mjs', U)]);
      const sf = shortfalls(miss);
      expect(sf).toHaveLength(1);
      expect(sf[0].file).toBe('a.mjs');
      expect(miss.unplannedBlocks).toBe(1);
      expect(miss.unattributedBlocks).toBe(0);
      const hit = await review(body, [step('a.mjs', S)]);
      expect(shortfalls(hit)).toHaveLength(0);
      expect(hit.unplannedBlocks).toBe(0);
    });
  }

  // R17
  it('R17: CRLF line endings and trailing spaces after every marker are tolerated', async () => {
    const body = `### a.mjs\r\n@@SEARCH  \r\n${S}\r\n@@REPLACE \r\n${S} // edited\r\n@@END   \r\n`;
    const miss = await review(body, [step('a.mjs', U)]);
    expect(shortfalls(miss)).toHaveLength(1);
    expect(shortfalls(miss)[0].file).toBe('a.mjs');
    expect(miss.unplannedBlocks).toBe(1);
    expect(miss.unattributedBlocks).toBe(0);
    const hit = await review(body, [step('a.mjs', S)]);
    expect(shortfalls(hit)).toHaveLength(0);
    expect(hit.unplannedBlocks).toBe(0);
  });

  it('fence lines are read as blank, so a fenced @@SEARCH block still binds to its heading', async () => {
    const body = `### a.mjs\n\`\`\`\n@@SEARCH\n${S}\n@@REPLACE\n${S} // edited\n@@END\n\`\`\`\n`;
    const miss = await review(body, [step('a.mjs', U)]);
    expect(shortfalls(miss)).toHaveLength(1);
    expect(miss.unattributedBlocks).toBe(0);
  });

  // R18
  it('R18: exact binding only - ### a.mjs never binds to declared src/a.mjs', async () => {
    const r = await review(block('### a.mjs', S), [step('src/a.mjs', U)], [{ path: 'src/a.mjs', op: 'edit' }]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBeGreaterThanOrEqual(1);
    const w = unattributed(r);
    expect(w).toHaveLength(1);
    expect((r.errors || []).some((e) => e.check === 'unattributed_authored_block')).toBe(false);
    expect(w[0].preview).toContain(S);
    expect(w[0].reason).toBe('label_not_declared_target');
    expect(w[0].label).toBe('a.mjs');
    expect(w[0].message).toContain('a.mjs');
  });

  // R19
  it('R19: headingless blocks (start of body, or prose directly above) are unattributed, never a shortfall', async () => {
    for (const body of [block(null, S), `This sentence explains the change.\n${block(null, S)}`]) {
      const r = await review(body, [step('a.mjs', U)]);
      expect(shortfalls(r)).toHaveLength(0);
      expect(r.unattributedBlocks).toBeGreaterThanOrEqual(1);
      const w = unattributed(r);
      expect(w).toHaveLength(1);
      expect(w[0].preview).toContain(S);
      expect(typeof w[0].reason).toBe('string');
      expect(w[0].reason.length).toBeGreaterThan(0);
    }
  });

  // R20
  it('R20: a fenced SEARCH:/REPLACE: pair under a declared op:edit heading is unattributed', async () => {
    const r = await review(fencedPairBody('### a.mjs'), [step('a.mjs', U)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unattributedBlocks).toBeGreaterThanOrEqual(1);
    const w = unattributed(r);
    expect(w).toHaveLength(1);
    expect(w[0].preview).toContain(S1);
    expect(w[0].reason).toBe('fenced_search_replace_pair');
  });

  // R21
  it('R21: a #### SEARCH / #### REPLACE heading-format pair counts exactly once', async () => {
    const r = await review(headingPairBody, [step('a.mjs', U)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBe(1);
    const w = unattributed(r);
    expect(w).toHaveLength(1);
    expect(w[0].preview).toContain(S2);
    expect(w[0].reason).toBe('heading_format_pair');
  });

  // R22, R23
  for (const verb of ['after', 'before']) {
    it(`R22/R23: an Add ${verb} anchor block counts exactly once and does not change ok`, async () => {
      const r = await review(addBody(verb), [step('a.mjs', U)]);
      expect(shortfalls(r)).toHaveLength(0);
      expect(r.unplannedBlocks).toBe(0);
      expect(r.unattributedBlocks).toBe(1);
      const w = unattributed(r);
      expect(w).toHaveLength(1);
      expect(w[0].preview).toContain(T);
      expect(w[0].reason).toBe('add_after_before_block');
      expect(r.ok).toBe(true);
    });
  }

  // R24
  it('R24: a <<<<<<< SEARCH conflict-marker block counts exactly once', async () => {
    const r = await review(conflictBody, [step('a.mjs', U)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBe(1);
    const w = unattributed(r);
    expect(w).toHaveLength(1);
    expect(w[0].preview).toContain(S1);
    expect(w[0].reason).toBe('conflict_marker_block');
  });

  // R25
  it('R25: a fenced pair under ### Edit: a.mjs (fits two grammars) is counted once', async () => {
    const r = await review(fencedPairBody('### Edit: a.mjs'), [step('a.mjs', U)]);
    expect(r.unattributedBlocks).toBe(1);
    expect(unattributed(r)).toHaveLength(1);
  });

  // R26
  it('R26: reason strings are pairwise distinct across the six categories', async () => {
    const fixtures = [
      [block(null, S), TF_A],
      [block('### a.mjs', S), [{ path: 'src/a.mjs', op: 'edit' }]],
      [fencedPairBody('### a.mjs'), TF_A],
      [headingPairBody, TF_A],
      [addBody('after'), TF_A],
      [conflictBody, TF_A],
    ];
    const reasons = [];
    for (const [body, tf] of fixtures) {
      const w = unattributed(await review(body, [step('a.mjs', U)], tf));
      expect(w).toHaveLength(1);
      reasons.push(w[0].reason);
    }
    expect(new Set(reasons).size).toBe(6);
  });

  // R27
  it('R27: mixed body - one shortfall error plus one unattributed warning', async () => {
    const body = block('### a.mjs', S) + '\n' + headingPairBody;
    const r = await review(body, [step('a.mjs', U)]);
    expect(r.ok).toBe(false);
    expect(r.unplannedBlocks).toBe(1);
    expect(r.unattributedBlocks).toBe(1);
    expect(shortfalls(r)).toHaveLength(1);
    expect(unattributed(r)).toHaveLength(1);
  });

  // R28
  it('R28: the unattributed warning has its own id, is never an error and never changes ok', async () => {
    const r = await review(block(null, S), [step('a.mjs', U)]);
    const w = unattributed(r);
    expect(w).toHaveLength(1);
    expect(w[0].check).not.toBe('authored_block_shortfall');
    expect(w[0].check).not.toBe('incomplete_target_coverage');
    expect(w[0].severity).toBe('warning');
    expect((r.errors || []).some((e) => e.check === w[0].check)).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  // R29
  it('R29: a fully attributed body yields unattributedBlocks 0 and no warning', async () => {
    const body = `## Target Files\n\n${block('### a.mjs', S1)}\n${block('### b.mjs', S2)}\n${block('### a.mjs', T, T)}`;
    const r = await review(body, [step('a.mjs', S1), step('b.mjs', S2)], TF_AB);
    expect(r.unattributedBlocks).toBe(0);
    expect(unattributed(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.ok).toBe(true);
  });

  // R30
  it('R30: no authoredStoryBody (undefined or null, and the exec.mjs recheck shape) runs no check', async () => {
    const plan = { steps: [step('a.mjs', S1)] };
    const execShape = await reviewPlan({ projectRoot: broot, plan });
    const viaNull = await reviewPlan({ projectRoot: broot, plan, problemContent: null, targetFiles: TF_A, authoredStoryBody: null });
    const viaUndef = await reviewPlan({ projectRoot: broot, plan, problemContent: null, targetFiles: TF_A, authoredStoryBody: undefined });
    const legacy = await reviewPlan({ projectRoot: broot, plan, problemContent: null, targetFiles: TF_A });
    for (const r of [execShape, viaNull, viaUndef, legacy]) {
      expect(r.unplannedBlocks).toBeNull();
      expect(r.unattributedBlocks).toBeNull();
      expect(r.authoredBlockCheckSkipped).toBeNull();
      expect(unattributed(r)).toHaveLength(0);
      expect(shortfalls(r)).toHaveLength(0);
    }
    expect(viaNull.errors).toEqual(legacy.errors);
    expect(viaNull.ok).toBe(legacy.ok);
    expect(viaUndef.errors).toEqual(legacy.errors);
    expect(viaUndef.ok).toBe(legacy.ok);
  });

  // R31
  it('R31: problemContent alone (persistAndFinalize shape) runs no check', async () => {
    const problemContent = block('### a.mjs', S);
    const r = await reviewPlan({ projectRoot: broot, plan: { steps: [step('a.mjs', U)] }, problemContent, storyMeta: {}, targetFiles: TF_A });
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBeNull();
    expect(r.unattributedBlocks).toBeNull();
  });

  // R32
  it('R32: a body with no @@SEARCH blocks runs the check and reports zeros', async () => {
    const r = await review('## Problem\n\nNo blocks here.\n', [step('a.mjs', U)]);
    expect(shortfalls(r)).toHaveLength(0);
    expect(r.unplannedBlocks).toBe(0);
    expect(r.unattributedBlocks).toBe(0);
  });
});

describe('buildPlanReviewArgs / formatPlanReviewBlockLog — rks_plan_review handler wiring', () => {
  const S1 = 'const s1 = 1;';
  const S2 = 'const s2 = 2;';
  const P = 'backlog.fix.some-story';
  let hroot;
  beforeAll(() => {
    hroot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-planq-handler-'));
    fs.writeFileSync(path.join(hroot, 'a.mjs'), `${S1}\n${S2}\n`);
  });
  afterAll(() => {
    if (hroot) fs.rmSync(hroot, { recursive: true, force: true });
  });
  const blk = (s) => `### a.mjs\n@@SEARCH\n${s}\n@@REPLACE\n${s} // edited\n@@END\n`;
  const storyBody = `${blk(S1)}\n${blk(S2)}`;
  const targetFiles = [{ path: 'a.mjs', op: 'edit' }];
  const plan = (...ss) => ({ steps: [{ action: 'search_replace', path: 'a.mjs', edits: ss.map((s) => ({ search: s, replace: `${s} // edited` })) }] });
  const note = { targetFiles, content: storyBody };

  // R33
  it('R33: passes note.content as authoredStoryBody, checkExecutableSteps true, no problemContent', async () => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: plan(S1), note, targetFiles });
    expect(args.authoredStoryBody).toBe(note.content);
    expect(args.checkExecutableSteps).toBe(true);
    expect('problemContent' in args).toBe(false);
    const r = await reviewPlan(args);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.check === 'authored_block_shortfall')).toBe(true);
  });

  // R34
  it('R34: no problemId and note null - label-only path stays null throughout', async () => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: plan(S1), note: null, targetFiles: undefined });
    expect(args.authoredStoryBody).toBeNull();
    expect(args.authoredBlockCheckSkipped).toBeNull();
    const r = await reviewPlan(args);
    expect(r.errors.some((e) => e.check === 'authored_block_shortfall')).toBe(false);
    expect(r.unplannedBlocks).toBeNull();
    expect(r.unattributedBlocks).toBeNull();
    expect(r.authoredBlockCheckSkipped).toBeNull();
    expect(formatPlanReviewBlockLog({
      unplannedBlocks: r.unplannedBlocks, unattributedBlocks: r.unattributedBlocks,
      authoredBlockCheckSkipped: r.authoredBlockCheckSkipped,
    })).toBeNull();
  });

  // R35
  it('R35: problemId with an unreadable note records note_unreadable and changes nothing else', async () => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: plan(S1), note: null, targetFiles: undefined, problemId: P, noteReadError: new Error('ENOENT') });
    expect(args.authoredStoryBody).toBeNull();
    expect(args.authoredBlockCheckSkipped).toEqual({ problemId: P, reason: 'note_unreadable' });
    const r = await reviewPlan(args);
    expect(r.authoredBlockCheckSkipped).toEqual({ problemId: P, reason: 'note_unreadable' });
    expect(r.unplannedBlocks).toBeNull();
    expect(r.unattributedBlocks).toBeNull();
    expect(r.errors.some((e) => e.check === 'authored_block_shortfall')).toBe(false);
    expect(r.warnings.some((w) => w.check === 'unattributed_authored_block')).toBe(false);
    const { authoredBlockCheckSkipped: _skip, ...withoutSkip } = args;
    const baseline = await reviewPlan(withoutSkip);
    expect(r.ok).toBe(baseline.ok);
    expect(r.errors).toEqual(baseline.errors);
  });

  // R36
  it('R36: problemId with a note whose content is not a string records note_content_not_string', async () => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: plan(S1), note: { targetFiles, content: undefined }, targetFiles, problemId: P });
    expect(args.authoredStoryBody).toBeNull();
    expect(args.authoredBlockCheckSkipped).toEqual({ problemId: P, reason: 'note_content_not_string' });
    const r = await reviewPlan(args);
    expect(r.authoredBlockCheckSkipped).toEqual(args.authoredBlockCheckSkipped);
    expect('note_content_not_string').not.toBe('note_unreadable');
  });

  // R37
  it('R37: problemId with a string-content note records no skip', async () => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: plan(S1, S2), note, targetFiles, problemId: P });
    expect(args.authoredBlockCheckSkipped).toBeNull();
    const r = await reviewPlan(args);
    expect(r.authoredBlockCheckSkipped).toBeNull();
  });

  // R38
  it('R38: the formatter returns null with no skip and no count above 0', () => {
    for (const [u, a] of [[null, null], [0, 0], [null, 0], [0, null]]) {
      expect(formatPlanReviewBlockLog({ problemId: P, unplannedBlocks: u, unattributedBlocks: a })).toBeNull();
      expect(formatPlanReviewBlockLog({ problemId: P, unplannedBlocks: u, unattributedBlocks: a, authoredBlockCheckSkipped: null })).toBeNull();
    }
  });

  // R39
  it('R39: the formatter returns one [rks.plan_review] line with the problemId and both counts', () => {
    for (const [u, a] of [[1, 0], [0, 2], [3, 4]]) {
      const line = formatPlanReviewBlockLog({ problemId: P, unplannedBlocks: u, unattributedBlocks: a });
      expect(line).not.toBeNull();
      expect(line.startsWith('[rks.plan_review]')).toBe(true);
      expect(line).not.toMatch(/\n/);
      expect(line).toContain(P);
      expect(line).toContain(`unplannedBlocks=${u}`);
      expect(line).toContain(`unattributedBlocks=${a}`);
    }
  });

  // R40
  it('R40: the skip line names the problemId and the reason', () => {
    for (const reason of ['note_unreadable', 'note_content_not_string']) {
      const line = formatPlanReviewBlockLog({ problemId: P, unplannedBlocks: null, unattributedBlocks: null, authoredBlockCheckSkipped: { problemId: P, reason } });
      expect(line.startsWith('[rks.plan_review]')).toBe(true);
      expect(line).not.toMatch(/\n/);
      expect(line).toContain(P);
      expect(line).toContain(reason);
    }
  });

  const chain = async ({ problemId, note: n, noteReadError, planObj }) => {
    const args = buildPlanReviewArgs({ projectRoot: hroot, plan: planObj, note: n, targetFiles: n?.targetFiles, problemId, noteReadError });
    const r = await reviewPlan(args);
    return formatPlanReviewBlockLog({
      problemId, unplannedBlocks: r.unplannedBlocks, unattributedBlocks: r.unattributedBlocks,
      authoredBlockCheckSkipped: r.authoredBlockCheckSkipped,
    });
  };

  // R41
  it('R41: composition - helper -> reviewPlan -> formatter', async () => {
    const line = await chain({ problemId: P, note, planObj: plan(S1) });
    expect(line).not.toBeNull();
    expect(line).toContain(P);
    expect(await chain({ problemId: P, note, planObj: plan(S1, S2) })).toBeNull();
  });

  // R42
  it('R42: skip composition - unreadable note with a problemId logs; without one, null', async () => {
    const line = await chain({ problemId: P, note: null, noteReadError: new Error('ENOENT'), planObj: plan(S1) });
    expect(line).not.toBeNull();
    expect(line.startsWith('[rks.plan_review]')).toBe(true);
    expect(line).toContain(P);
    expect(line).toContain('note_unreadable');
    expect(await chain({ problemId: null, note: null, planObj: plan(S1) })).toBeNull();
  });

  // R43
  it('R43: the helper, reviewPlan and the formatter write nothing to the console', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const mixed = { targetFiles, content: `${blk(S1)}\nSEARCH:\n\`\`\`\n${S2}\n\`\`\`\nREPLACE:\n\`\`\`\nx\n\`\`\`\n` };
      const line1 = await chain({ problemId: P, note: mixed, planObj: plan(S2) });
      expect(line1).toContain('unplannedBlocks=1');
      expect(line1).toContain('unattributedBlocks=1');
      const line2 = await chain({ problemId: P, note: null, noteReadError: new Error('x'), planObj: plan(S1) });
      expect(line2).toContain('note_unreadable');
      expect(err).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  // R44
  it('R44: option (b) - omittedSteps is still display truncation (all.length - shown.length)', () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({ action: 'note', path: `f${i}` }));
    expect(describePlanContents({ steps }, { maxSteps: 2 }).omittedSteps).toBe(3);
    expect(describePlanContents({ steps }).omittedSteps).toBe(0);
  });
});
