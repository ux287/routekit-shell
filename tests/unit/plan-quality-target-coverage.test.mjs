import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

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
