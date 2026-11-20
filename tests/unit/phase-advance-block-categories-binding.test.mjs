// Option C binding: rule 1 of the advisory phase-advance gate honours only block
// findings whose category is in policy.blockCategories; the explicit block-posture
// halt keeps reading per-finding severity. Behavioural assertions only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  resolvePhaseAdvanceSuppression,
  resolveOffRailHalt,
} from '../../packages/mcp-rks/src/server/guardrails-audit.mjs';
import { loadReviewPolicy } from '../../packages/mcp-rks/src/server/review.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SRC = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/mcp-rks/src/server/guardrails-audit.mjs'),
  'utf8',
);
const DEFAULT_BLOCK = ['enforcement_modification', 'security_issue'];
const COVERED = { assessed: true, covered: ['AC1'], notCovered: [], uncertain: [] };
const passingScope = { step: 'scope_reconcile', ok: true, inScopeCount: 1, violations: [] };
const DOWNGRADE =
  "verdictMode 'warn' downgraded block to warn: block-severity finding categories [ac_coverage, test_coverage] are not listed in policy blockCategories [enforcement_modification, security_issue]";

const step = (findings, extra = {}) => ({
  step: 'review',
  verdict: 'warn',
  findings,
  acCoverage: COVERED,
  ...extra,
});
const f = (category, severity = 'block') => ({ category, severity, message: `${category} finding` });

describe('rule 1 honours only policy.blockCategories', () => {
  for (const cat of ['missing_error_handling', 'ac_coverage', 'test_coverage']) {
    it(`a block finding in warn category ${cat} does not suppress with block_severity_finding`, () => {
      const out = resolvePhaseAdvanceSuppression(step([f(cat)]), { blockCategories: DEFAULT_BLOCK });
      expect(out === null || out.suppress === false).toBe(true);
    });
  }

  it('the observed 0fe530f9 shape (inherited downgradeReason, ac_coverage + test_coverage) no longer suppresses', () => {
    const s = step([f('ac_coverage'), f('test_coverage')], { downgradedFrom: 'block', downgradeReason: DOWNGRADE });
    const out = resolvePhaseAdvanceSuppression(s, { blockCategories: DEFAULT_BLOCK });
    expect(out === null || out.suppress === false).toBe(true);
  });

  it('a block finding in a listed category still suppresses under rule 1', () => {
    const out = resolvePhaseAdvanceSuppression(step([f('security_issue')]), { blockCategories: DEFAULT_BLOCK });
    expect(out).not.toBeNull();
    expect(out.suppress).not.toBe(false);
    expect(out.reason).toMatch(/block_severity_finding|security_issue/);
    expect(out.categories).toEqual(['security_issue']);
  });

  it('mixed findings: only the honoured category is reported by rule 1', () => {
    const out = resolvePhaseAdvanceSuppression(step([f('ac_coverage'), f('security_issue')]), { blockCategories: DEFAULT_BLOCK });
    expect(out.categories).toEqual(['security_issue']);
    expect(out.findingCount).toBe(1);
  });

  it('a category added to blockCategories by project policy gets rule-1 suppression', () => {
    const out = resolvePhaseAdvanceSuppression(step([f('ac_coverage')]), {
      blockCategories: [...DEFAULT_BLOCK, 'ac_coverage'],
    });
    expect(out).not.toBeNull();
    expect(out.suppress).not.toBe(false);
    expect(out.categories).toEqual(['ac_coverage']);
  });

  it('a non-honoured block finding is visible with a reason naming blockCategories', () => {
    const out = resolvePhaseAdvanceSuppression(step([f('ac_coverage')]), { blockCategories: DEFAULT_BLOCK });
    expect(out).not.toBeNull();
    expect(out.suppress).toBe(false);
    expect(out.reason).toContain('blockCategories');
    expect(out.reason).toContain('ac_coverage');
  });

  it('the non-honoured notice also replaces the advanceOnUnassessedAC null exit', () => {
    const s = step([f('ac_coverage')], { acCoverage: undefined });
    const out = resolvePhaseAdvanceSuppression(s, { blockCategories: DEFAULT_BLOCK, advanceOnUnassessedAC: true });
    expect(out).not.toBeNull();
    expect(out.suppress).toBe(false);
    expect(out.reason).toContain('blockCategories');
    expect(out.reason).toContain('ac_coverage');
  });

  it('does not mutate finding severity', () => {
    const finding = f('ac_coverage');
    resolvePhaseAdvanceSuppression(step([finding]), { blockCategories: DEFAULT_BLOCK });
    expect(finding.severity).toBe('block');
  });
});

describe('fail closed when blockCategories is absent or malformed', () => {
  for (const opts of [undefined, {}, { blockCategories: null }, { blockCategories: 'security_issue' }]) {
    it(`honours every block finding for options ${JSON.stringify(opts)}`, () => {
      const out = resolvePhaseAdvanceSuppression(step([f('ac_coverage')]), opts);
      expect(out).not.toBeNull();
      expect(out.suppress).not.toBe(false);
      expect(out.reason).toBe('block_severity_finding (ac_coverage)');
    });
  }

  it('inherited downgradeReason is still reused verbatim on the fail-closed path', () => {
    const s = step([f('ac_coverage')], { downgradedFrom: 'block', downgradeReason: DOWNGRADE });
    expect(resolvePhaseAdvanceSuppression(s).reason).toBe(DOWNGRADE);
  });
});

describe('non-honoured block findings fall through to the AC-evidence rules', () => {
  it('notCovered non-empty still suppresses with ac_not_covered', () => {
    const s = step([f('ac_coverage')], { acCoverage: { assessed: true, covered: [], notCovered: ['AC1'], uncertain: [] } });
    const out = resolvePhaseAdvanceSuppression(s, { blockCategories: DEFAULT_BLOCK });
    expect(out).not.toBeNull();
    expect(out.suppress).not.toBe(false);
    expect(out.reason).toMatch(/ac_not_covered/);
  });

  it('uncertain non-empty still suppresses with ac_coverage_uncertain', () => {
    const s = step([f('test_coverage')], { acCoverage: { assessed: true, covered: [], notCovered: [], uncertain: ['AC1'] } });
    const out = resolvePhaseAdvanceSuppression(s, { blockCategories: DEFAULT_BLOCK });
    expect(out).not.toBeNull();
    expect(out.reason).toMatch(/ac_coverage_uncertain/);
  });
});

describe('resolveOffRailHalt review_block_finding is kept under posture block', () => {
  it('a warn-category block finding with verdict warn still halts as review_block_finding', () => {
    expect(
      resolveOffRailHalt({ posture: 'block', reviewStep: step([f('ac_coverage')]), scopeStep: passingScope, overrideApplied: false }),
    ).toBe('review_block_finding');
  });
});

describe('call site and policy wiring', () => {
  it('default policy blockCategories are the values the gate is passed', () => {
    expect(loadReviewPolicy('/nonexistent-root-so-defaults-apply').blockCategories).toEqual(DEFAULT_BLOCK);
  });

  it('the single call site passes policy blockCategories beside advanceOnUnassessedAC', () => {
    expect(AUDIT_SRC).toMatch(/blockCategories:\s*policy\?\.blockCategories/);
    expect((AUDIT_SRC.match(/resolvePhaseAdvanceSuppression\(/g) || []).length).toBe(2);
  });
});
