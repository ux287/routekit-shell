/**
 * Tests for backlog.fix.review-security-gate-discriminating.
 *
 * The ship review's security gate blocked on benign code often enough to stop
 * carrying information. One ship this session drew FOUR blocking findings, all
 * of them `Potential security issue: pattern "process\.env\." found`, against a
 * test-mode guard reading process.env.VITEST. `security_issue` is a hard-block
 * category that verdictMode:'warn' cannot soften, so routine env reads produced
 * blocking verdicts. A gate that blocks on ordinary code stops being believed on
 * the day it is right — that, not the noise itself, is the risk.
 *
 * BOTH DIRECTIONS ARE ASSERTED HERE, deliberately. Proving the noise is gone
 * without proving the gate still fires would leave a gate that does not work.
 *
 * NOTE ON FIXTURES: the credential-shaped literals below are obviously synthetic
 * and are NOT obfuscated by concatenation — obfuscating them would defeat the
 * very match these tests exist to prove. They live in a test file, which the
 * file-attribution downgrade covers; without that downgrade this file would
 * hard-block its own ship.
 *
 * TIERING: pure functions only. No spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect } from 'vitest';
import {
  runPatternChecks,
  computeFinalVerdict,
} from '../../packages/mcp-rks/src/server/review.mjs';

const POLICY = {
  blockCategories: ['enforcement_modification', 'security_issue'],
  enforcementPaths: ['.routekit/hooks/'],
  securityPatterns: [
    'eval\\(',
    'new Function\\(',
    "password\\s*[:=]\\s*['\"][^'\"]+['\"]",
    "api[_-]?key\\s*[:=]\\s*['\"][^'\"]+['\"]",
    "secret\\s*[:=]\\s*['\"][^'\"]+['\"]",
  ],
  securityHeuristics: ['process\\.env\\.'],
  antiPatterns: [],
};

/** Build a unified-diff fragment attributing added lines to one file. */
function diffFor(file, ...addedLines) {
  return [`--- a/${file}`, `+++ b/${file}`, ...addedLines.map((l) => `+${l}`)].join('\n');
}

const securityFindings = (findings) => findings.filter((f) => f.category === 'security_issue');

describe('security gate — direction 1: benign code must not block', () => {
  it('an env-var READ produces no blocking finding (the ea8eea68 case)', () => {
    const diff = diffFor('src/thing.mjs', 'const skip = Boolean(process.env.VITEST);');
    const found = securityFindings(runPatternChecks(diff, ['src/thing.mjs'], POLICY));

    // It is still REPORTED — the category is preserved so telemetry sees it —
    // but at warn severity, so it cannot hard-block.
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.severity === 'warn')).toBe(true);
    expect(found.every((f) => f.category === 'security_issue')).toBe(true);
  });

  it('an empty credential assignment does not match at all', () => {
    const diff = diffFor('src/thing.mjs', 'let password = "";', 'const secret = \'\';');
    expect(securityFindings(runPatternChecks(diff, ['src/thing.mjs'], POLICY))).toEqual([]);
  });

  it('an ordinary parameter default does not match', () => {
    const diff = diffFor('src/thing.mjs', 'function connect(host, password) {');
    expect(securityFindings(runPatternChecks(diff, ['src/thing.mjs'], POLICY))).toEqual([]);
  });

  it('a credential read from the environment does not match', () => {
    // No quoted literal on the right-hand side, so the hard-block patterns miss.
    const diff = diffFor('src/thing.mjs', 'const apiKey = process.env.API_KEY;');
    const found = securityFindings(runPatternChecks(diff, ['src/thing.mjs'], POLICY));
    expect(found.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('an env read does not produce a blocking VERDICT end to end', () => {
    const diff = diffFor('src/thing.mjs', 'const skip = Boolean(process.env.VITEST);');
    const findings = runPatternChecks(diff, ['src/thing.mjs'], POLICY);
    const verdict = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'pass',
      policy: POLICY,
    });
    expect(verdict).not.toBe('block');
  });
});

describe('security gate — direction 2: the gate must still fire', () => {
  it('a hardcoded credential literal in a SOURCE file blocks', () => {
    const diff = diffFor('src/config.mjs', 'const apiKey = "EXAMPLE-NOT-A-REAL-KEY";');
    const found = securityFindings(runPatternChecks(diff, ['src/config.mjs'], POLICY));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.severity === 'block')).toBe(true);
  });

  it('that credential produces a blocking VERDICT even under verdictMode warn', () => {
    const diff = diffFor('src/config.mjs', 'const password = "EXAMPLE-NOT-A-REAL-PASSWORD";');
    const findings = runPatternChecks(diff, ['src/config.mjs'], POLICY);
    const verdict = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'pass',
      policy: { ...POLICY, verdictMode: 'warn' },
    });
    expect(verdict).toBe('block');
  });

  it('eval and new Function still block', () => {
    for (const line of ['const r = eval(userInput);', 'const f = new Function("a", "return a");']) {
      const diff = diffFor('src/danger.mjs', line);
      const found = securityFindings(runPatternChecks(diff, ['src/danger.mjs'], POLICY));
      expect(found.some((f) => f.severity === 'block'), `expected block for: ${line}`).toBe(true);
    }
  });
});

describe('file attribution', () => {
  const CREDENTIAL = 'const apiKey = "EXAMPLE-NOT-A-REAL-KEY";';

  it('downgrades — but does NOT drop — the same literal in a test file', () => {
    for (const file of [
      'tests/unit/x.test.mjs',
      'tests/unit/x.spec.mjs',
      'packages/p/__tests__/x.mjs',
      'tests/integration/x.mjs',
    ]) {
      const found = securityFindings(runPatternChecks(diffFor(file, CREDENTIAL), [file], POLICY));
      expect(found.length, `expected a retained finding for ${file}`).toBeGreaterThan(0);
      expect(found.every((f) => f.severity === 'warn'), `expected warn for ${file}`).toBe(true);
      // Category preserved so telemetry still sees it.
      expect(found.every((f) => f.category === 'security_issue')).toBe(true);
    }
  });

  it('FAILS SAFE: an added line with no +++ header keeps full severity', () => {
    // Live case, not hypothetical — callers pass a bare diff with no headers.
    const found = securityFindings(runPatternChecks(`+${CREDENTIAL}`, [], POLICY));
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((f) => f.severity === 'block')).toBe(true);
  });

  it('stamps the originating file onto attributed findings', () => {
    const found = securityFindings(runPatternChecks(diffFor('src/a.mjs', CREDENTIAL), ['src/a.mjs'], POLICY));
    expect(found[0].file).toBe('src/a.mjs');
  });
});

describe('computeFinalVerdict — the two verdict-path defects', () => {
  it('FIX (a): a warn-severity security_issue does not force a block', () => {
    // verdictMode is deliberately NOT 'warn', so passing cannot be a softening
    // artifact — it must be the severity check itself doing the work.
    const verdict = computeFinalVerdict({
      patternFindings: [{ severity: 'warn', category: 'security_issue' }],
      allFindings: [{ severity: 'warn', category: 'security_issue' }],
      llmVerdict: 'pass',
      policy: { verdictMode: 'block', blockCategories: ['security_issue'] },
    });
    expect(verdict).toBe('pass');
  });

  it('FIX (a): a block-severity security_issue still forces a block', () => {
    const verdict = computeFinalVerdict({
      patternFindings: [{ severity: 'block', category: 'security_issue' }],
      allFindings: [{ severity: 'block', category: 'security_issue' }],
      llmVerdict: 'pass',
      policy: { verdictMode: 'block', blockCategories: ['security_issue'] },
    });
    expect(verdict).toBe('block');
  });

  it('FIX (b): the hard-block set is read from policy, differentially', () => {
    const findings = [{ severity: 'block', category: 'security_issue' }];
    // llmVerdict 'block' reaches the softening branch independently of
    // hasPatternBlockers — otherwise removing the category would short-circuit
    // before the branch under test and pass for the wrong reason.
    const withCategory = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: { verdictMode: 'warn', blockCategories: ['security_issue'] },
    });
    const withoutCategory = computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: { verdictMode: 'warn', blockCategories: [] },
    });
    expect(withCategory).toBe('block');
    // Changing policy CHANGES the outcome. If these were equal, the category
    // literals would still be hardcoded and blockCategories decorative.
    expect(withoutCategory).toBe('warn');
    expect(withoutCategory).not.toBe(withCategory);
  });

  it('enforcement_modification remains a hard block', () => {
    const findings = [{ severity: 'block', category: 'enforcement_modification' }];
    expect(computeFinalVerdict({
      patternFindings: findings,
      allFindings: findings,
      llmVerdict: 'block',
      policy: { verdictMode: 'warn', blockCategories: ['enforcement_modification', 'security_issue'] },
    })).toBe('block');
  });

  it("verdictMode 'skip' still forces a pass", () => {
    expect(computeFinalVerdict({
      patternFindings: [{ severity: 'block', category: 'security_issue' }],
      allFindings: [{ severity: 'block', category: 'security_issue' }],
      llmVerdict: 'block',
      policy: { verdictMode: 'skip', blockCategories: ['security_issue'] },
    })).toBe('pass');
  });
});
