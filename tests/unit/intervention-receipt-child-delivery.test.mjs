/**
 * Receipts must not dirty a child's working tree.
 * backlog.feat.intervention-receipts-at-forced-exit-paths, requirement 21.
 *
 * THE HAZARD THIS PINS. Instrumentation that leaves untracked files behind would
 * MANUFACTURE the interventions it exists to measure: the receipt is written on
 * exactly the forced-exit paths where a clean tree is next asserted. And the
 * shell cannot see the problem from here — the shell's own .gitignore has
 * `.rks/*`, so any receipt path looks ignored locally.
 *
 * `templates/base/.gitignore` enumerates `.rks` paths INDIVIDUALLY with no
 * catch-all. `.rks/state/` is already among them, so the receipt is covered AS
 * DELIVERED with no template edit — which matters because a .gitignore does not
 * reach an already-scaffolded child through a release tag, so an edit here could
 * not have protected the project this instrumentation is for.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECEIPT_RELATIVE_PATH } from '../../packages/mcp-rks/src/shared/intervention-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const rulesOf = (rel) =>
  fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

/** Does any rule cover this repo-relative path? Directory rules match by prefix. */
const covers = (rules, rel) =>
  rules.some((rule) => {
    if (rule.endsWith('/')) return rel.startsWith(rule) || rel.startsWith(rule.replace(/\/$/, '/'));
    if (rule.endsWith('/*')) return rel.startsWith(rule.slice(0, -1));
    return rel === rule;
  });

describe('the receipt path is ignored by the templates AS DELIVERED', () => {
  const posixReceipt = RECEIPT_RELATIVE_PATH.split(path.sep).join('/');

  it('PRECONDITION — the receipt lives under .rks/state/, not the .rks root', () => {
    // This is the assertion that fails if the path is ever moved back. The root
    // is NOT covered by base's gitignore, and a receipt there would leave every
    // forced exit with a dirty tree in a scaffolded child.
    expect(posixReceipt).toBe('.rks/state/interventions.jsonl');
    expect(posixReceipt.startsWith('.rks/state/')).toBe(true);
  });

  it('templates/base/.gitignore covers it with NO edit', () => {
    const rules = rulesOf('templates/base/.gitignore');
    // ANTI-VACuity: base really does enumerate individually and has no catch-all,
    // so `covers` is doing real work rather than matching a blanket rule.
    expect(rules).toContain('.rks/state/');
    expect(rules).not.toContain('.rks/');
    expect(rules).not.toContain('.rks/*');
    expect(covers(rules, posixReceipt)).toBe(true);
  });

  it('THE REGRESSION THIS EXISTS FOR — the .rks ROOT is not covered by base', () => {
    // If someone moves the receipt to `.rks/interventions.jsonl`, base ignores
    // nothing of the sort and every child ship goes dirty. Pinned explicitly so
    // the move is caught here rather than in a UAT run.
    const rules = rulesOf('templates/base/.gitignore');
    expect(covers(rules, '.rks/interventions.jsonl')).toBe(false);
  });

  it('templates/generic/.gitignore covers it wholesale', () => {
    const rules = rulesOf('templates/generic/.gitignore');
    expect(covers(rules, posixReceipt)).toBe(true);
  });
});

describe('the producer message literals are pinned — requirement 26', () => {
  it('all four resolution-failure literals still exist verbatim at their throw sites', () => {
    // The classifier matches these by SUBSTRING. If the producer's wording
    // drifts, every resolution failure silently regresses to an "unauthorized"
    // refusal — the exact defect being retired — with nothing going red. This
    // canary makes that drift a test failure instead.
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/mcp-rks/src/project-context.mjs'),
      'utf8',
    );
    for (const literal of [
      'Project not found:',
      'missing root in registry',
      'Missing .rks/project.json or routekit/project.json',
      'KG file not found for',
    ]) {
      expect(src, `producer literal drifted: ${literal}`).toContain(literal);
    }
  });
});
