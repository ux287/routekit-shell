/**
 * Tests for the story-authorized rewrite escape on the destructive-edit gate
 * (backlog.fix.plan-quality.rewrite-escape).
 *
 * checkDestructiveEdit hard-blocks an edit_file replacing a >100-line file. This fix adds a
 * PER-TARGET authorization: a target listed in storyMeta.destructiveRewriteFiles (set by the
 * acknowledge_destructive_rewrite refinement) or flagged rewrite:true on a targetFile may be
 * rewritten. The load-bearing SAFETY PIN: an UNAUTHORIZED >100-line edit_file still ERRORs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkDestructiveEdit,
  computeAuthorizedRewriteFiles,
  reviewPlan,
} from '../../packages/mcp-rks/src/server/plan-quality.mjs';

function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `const line_${i} = ${i};`).join('\n');
}
const editStep = (p) => ({ action: 'edit_file', path: p, title: `edit ${p}` });

describe('plan-quality — destructive-rewrite escape (backlog.fix.plan-quality.rewrite-escape)', () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewrite-escape-'));
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src/big.mjs'), makeLines(172));  // >100 lines
    fs.writeFileSync(path.join(projectRoot, 'src/big2.mjs'), makeLines(150)); // >100 lines
    fs.writeFileSync(path.join(projectRoot, 'src/small.mjs'), makeLines(40)); // <=100 lines
  });
  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('checkDestructiveEdit', () => {
    it('SAFETY PIN: an unauthorized >100-line edit_file still ERRORs', () => {
      const issues = checkDestructiveEdit(projectRoot, editStep('src/big.mjs'));
      expect(issues).toHaveLength(1);
      expect(issues[0].check).toBe('destructive_edit');
      expect(issues[0].severity).toBe('error');
    });

    it('an AUTHORIZED >100-line edit_file passes (no destructive_edit error)', () => {
      const issues = checkDestructiveEdit(projectRoot, editStep('src/big.mjs'), new Set(['src/big.mjs']));
      expect(issues).toHaveLength(0);
    });

    it('authorization is PER-TARGET: authorizing one file does not authorize another >100-line edit', () => {
      const authorized = new Set(['src/big.mjs']);
      expect(checkDestructiveEdit(projectRoot, editStep('src/big.mjs'), authorized)).toHaveLength(0);
      const other = checkDestructiveEdit(projectRoot, editStep('src/big2.mjs'), authorized);
      expect(other).toHaveLength(1);
      expect(other[0].check).toBe('destructive_edit');
    });

    it('small (<=100-line) edits are unaffected by the flag', () => {
      expect(checkDestructiveEdit(projectRoot, editStep('src/small.mjs'))).toHaveLength(0);
      expect(checkDestructiveEdit(projectRoot, editStep('src/small.mjs'), new Set(['src/small.mjs']))).toHaveLength(0);
    });

    it('the unauthorized error suggestion names the acknowledge_destructive_rewrite escape', () => {
      const issues = checkDestructiveEdit(projectRoot, editStep('src/big.mjs'));
      expect(issues[0].suggestion).toContain('acknowledge_destructive_rewrite');
    });

    it('accepts a plain array (not just a Set) as the authorized list', () => {
      expect(checkDestructiveEdit(projectRoot, editStep('src/big.mjs'), ['src/big.mjs'])).toHaveLength(0);
    });
  });

  describe('computeAuthorizedRewriteFiles', () => {
    it('derives authorized paths from storyMeta.destructiveRewriteFiles', () => {
      const s = computeAuthorizedRewriteFiles({ destructiveRewriteFiles: ['a.mjs', 'b.mjs'] }, []);
      expect(s.has('a.mjs')).toBe(true);
      expect(s.has('b.mjs')).toBe(true);
    });
    it('derives authorized paths from a targetFile flagged rewrite:true (only that file)', () => {
      const s = computeAuthorizedRewriteFiles({}, [
        { path: 'c.mjs', op: 'edit', rewrite: true },
        { path: 'd.mjs', op: 'edit' },
      ]);
      expect(s.has('c.mjs')).toBe(true);
      expect(s.has('d.mjs')).toBe(false);
    });
    it('is empty when neither source authorizes (gate behaves exactly as before)', () => {
      expect(computeAuthorizedRewriteFiles({}, [{ path: 'x.mjs', op: 'edit' }]).size).toBe(0);
      expect(computeAuthorizedRewriteFiles(undefined, undefined).size).toBe(0);
    });
  });

  describe('reviewPlan integration', () => {
    const planFor = (p) => ({ steps: [editStep(p)] });
    const deErrors = (res) => res.errors.filter((e) => e.check === 'destructive_edit');

    it('unauthorized story: reviewPlan surfaces the destructive_edit error', async () => {
      const res = await reviewPlan({
        projectRoot, plan: planFor('src/big.mjs'), problemContent: null,
        storyMeta: {}, targetFiles: [{ path: 'src/big.mjs', op: 'edit' }],
      });
      expect(deErrors(res)).toHaveLength(1);
    });

    it('authorized via storyMeta.destructiveRewriteFiles: no destructive_edit error', async () => {
      const res = await reviewPlan({
        projectRoot, plan: planFor('src/big.mjs'), problemContent: null,
        storyMeta: { destructiveRewriteFiles: ['src/big.mjs'] },
        targetFiles: [{ path: 'src/big.mjs', op: 'edit' }],
      });
      expect(deErrors(res)).toHaveLength(0);
    });

    it('authorized via targetFile rewrite:true: no destructive_edit error', async () => {
      const res = await reviewPlan({
        projectRoot, plan: planFor('src/big.mjs'), problemContent: null,
        storyMeta: {}, targetFiles: [{ path: 'src/big.mjs', op: 'edit', rewrite: true }],
      });
      expect(deErrors(res)).toHaveLength(0);
    });
  });
});
