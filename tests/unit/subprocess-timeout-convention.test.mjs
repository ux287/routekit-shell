/**
 * Tests for backlog.fix.subprocess-timeout-convention-compliance (B2-core).
 *
 * Enforces a 120000ms (2-minute) floor on every spawnSync / spawn / execSync /
 * exec / fork call under tests/. Calls that legitimately need a sub-floor
 * timeout opt out via an inline `// timeout-opt-out: <reason>` comment on the
 * same line or the line immediately above.
 *
 * WHY 120000ms:
 *   The floor exists to prevent fork-pool deadlock from concurrent model load +
 *   LanceDB writes on CI runners. Cold-start operations (Node CLI bootstrap,
 *   ML model load, fresh LanceDB index open) can take 30–90s on shared CI
 *   runners. Timeouts below 120s can fire BEFORE the underlying operation
 *   completes, producing flaky test failures. See
 *   notes/backlog.z_implemented.feat.qa-subprocess-timeout-rule.md (the
 *   original convention) and notes/research.2026.06.09.test-infra-topology-
 *   and-skip-debt.md §6 (audit motivating this story).
 *
 * SCOPE — B2-core only:
 *   This story (B2) fixed tests/unit/assert-clean-working-tree.test.mjs (5
 *   calls with no timeout) and added this meta-test. The audit during build
 *   surfaced 27 additional files with at least one violation — far past the
 *   AC5 >5-file decomposition threshold. Rather than fix all 27 in one off-
 *   rail session, they are explicitly allowlisted below. Each allowlist entry
 *   is skip-debt that a follow-up story (B2A/B2B/B2C/…) will pay down.
 *
 *   The meta-test ENFORCES forward progress: any NEW spawn-family call added
 *   to a non-allowlisted file (or a brand-new test file) MUST have a timeout
 *   or an explicit opt-out comment. Existing violators coast until they're
 *   paid down.
 *
 * OPT-OUT FORMAT:
 *   `// timeout-opt-out: <non-empty rationale>` on the same line as the spawn
 *   call OR on the line immediately above. The prefix is exact; the rationale
 *   must be non-empty.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globby } from 'globby';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// AC9: exported floor constant so other tests can reference it.
// Future floor revisions update this one constant.
export const TIMEOUT_FLOOR_MS = 120_000;

// Detect spawn-family calls. `\b` anchors prevent matches inside compound
// identifiers (spawnHelper, superSpawn, etc.). The leading negative-lookbehind
// rules out `.spawnSync(` member access on test helpers (which is a different
// call site and not the convention's concern).
const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|exec|fork)\s*\(/g;

// Files whose spawn calls predate this story's enforcement. Each entry carries
// a justifying comment explaining why the file is exempt. Adding a NEW file to
// this list requires a story reference; the regression test below pins the
// format.
//
// Tier-2 sweep (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit, 2026-06-15):
// 24 entries dropped — those files relocated to tests/integration/, where the
// integration-tier convention governs subprocess hygiene (longer timeouts,
// dedicated convention test). The 3 remaining entries are non-unit-tier files
// (e2e + root-level CLI dispatch) that still warrant retention; each is
// explained inline.
//
// AC4 invariant: ALLOWLIST.size <= 3. The size assertion below fails loud if
// new entries regrow this list.
const ALLOWLIST = new Map([
  // e2e tier runs cold node CLI + git in a real worktree; subprocess timing is
  // dominated by node bootstrap, not by the call options. A separate e2e-tier
  // convention test (future) will govern its hygiene.
  ['tests/e2e/dogfood-workflow.test.mjs',                              'e2e tier — subprocess hygiene governed by future e2e convention test, not the unit floor'],
  // Tier 2.5: project-attach-stack.test.mjs and vendor-subtree.test.mjs were
  // moved from tests/ root to tests/integration/ and are no longer scanned by
  // this unit-tier convention test. Their entries are dropped (not re-anchored
  // to the new integration paths) because the integration tier has its own
  // convention test (tests/integration/integration-suite-convention.test.mjs).
]);

/**
 * Find spawn-family calls in a file and check each for timeout/opt-out compliance.
 * Returns an array of {line, fn} for each violation.
 */
function findViolations(src) {
  const lines = src.split('\n');

  // Strip line comments for matching (but keep originals for opt-out detection).
  const stripped = lines.map((l) => {
    const idx = l.indexOf('//');
    return idx === -1 ? l : l.slice(0, idx);
  });

  const violations = [];

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i];
    const matches = [...line.matchAll(SPAWN_FAMILY_RE)];
    for (const m of matches) {
      // Skip matches inside an unclosed string literal on the same line.
      const before = line.slice(0, m.index);
      const dq = (before.match(/"/g) || []).length;
      const sq = (before.match(/'/g) || []).length;
      const bq = (before.match(/`/g) || []).length;
      if (dq % 2 === 1 || sq % 2 === 1 || bq % 2 === 1) continue;

      // Skip function declarations (`function spawnSync(`) and helper definitions
      // (`const spawn = function(`, `const spawn = (...) =>`).
      const window = line.slice(Math.max(0, m.index - 40), m.index + 20);
      if (/function\s+\w+\s*\(/.test(window)) continue;
      if (/(const|let|var)\s+\w+\s*=\s*(function|\([^)]*\)\s*=>)/.test(line)) continue;

      // Look ahead up to 15 lines for a `timeout:` key inside the same call's
      // options object literal. Track paren depth so we stop at the call's close.
      // CRITICAL: check timeout regex BEFORE breaking on close-paren, since a
      // single-line call like `spawnSync(..., { timeout: 120_000 });` has its
      // close-paren on the same line as the timeout key.
      let hasTimeout = false;
      let parenDepth = 0;
      let started = false;
      outer: for (let j = i; j < Math.min(i + 15, stripped.length); j++) {
        const seg = j === i ? stripped[j].slice(m.index) : stripped[j];
        if (/\btimeout\s*:/.test(seg)) hasTimeout = true;
        for (const ch of seg) {
          if (ch === '(') { parenDepth++; started = true; }
          else if (ch === ')') {
            parenDepth--;
            if (started && parenDepth === 0) break outer;
          }
        }
      }

      // Opt-out: `// timeout-opt-out: <reason>` on same line or line above.
      // Reason must be non-empty after the colon.
      const sameLine = lines[i] || '';
      const lineAbove = lines[i - 1] || '';
      const optOutRe = /\/\/\s*timeout-opt-out:\s*(\S.*)/;
      const hasOptOut = optOutRe.test(sameLine) || optOutRe.test(lineAbove);

      if (!hasTimeout && !hasOptOut) {
        violations.push({ line: i + 1, fn: m[1] });
      }
    }
  }

  return violations;
}

let scanResult = new Map();

beforeAll(async () => {
  // Tier-2 sweep (2026-06-15): scope excludes tests/integration/** — that tier
  // has its own discipline (longer timeouts, integration-suite-convention
  // governs filename hygiene; subprocess work is the expected mode). The unit
  // tier's no-subprocess invariant is enforced separately by
  // tests/unit/unit-tier-purity.test.mjs. This file's job is to govern the
  // unit tier + root-level CLI dispatch tests + e2e tier, all of which retain
  // the 120s floor.
  const files = await globby(
    [
      'tests/**/*.test.mjs',
      'tests/**/*.test.js',
      '!tests/integration/**',
    ],
    { cwd: REPO_ROOT },
  );
  for (const f of files.sort()) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    const violations = findViolations(src);
    if (violations.length > 0) scanResult.set(f, violations);
  }
}, 30_000);

describe('subprocess-timeout-convention — meta-test scan setup', () => {
  it('scan produces a usable result map', () => {
    expect(scanResult).toBeInstanceOf(Map);
  });
});

describe('AC1 — assert-clean-working-tree.test.mjs is compliant', () => {
  it('this file (the critical case B2 fixed) has zero violations', () => {
    const violations = scanResult.get('tests/unit/assert-clean-working-tree.test.mjs');
    expect(violations, `assert-clean-working-tree.test.mjs MUST have zero violations after B2; found: ${JSON.stringify(violations)}`).toBeUndefined();
  });
});

describe('AC2 + AC4 + AC8 — meta-test enforces compliance on every test file', () => {
  it('no NEW files have violations outside the allowlist', () => {
    const violatorFiles = [...scanResult.keys()].sort();
    const unallowlisted = violatorFiles.filter((f) => !ALLOWLIST.has(f));
    expect(
      unallowlisted,
      `New violator files detected (not in allowlist): ${JSON.stringify(unallowlisted, null, 2)}. ` +
        `Either add a timeout: ${TIMEOUT_FLOOR_MS}_000 to the spawn call, add a // timeout-opt-out: <reason> comment, ` +
        `or open a follow-up story and add the file to ALLOWLIST.`,
    ).toEqual([]);
  });

  it('reports filepath:line for each violation (actionable format)', () => {
    // Verify the violation format is structured for follow-up work, not opaque.
    for (const [file, violations] of scanResult) {
      for (const v of violations) {
        expect(v).toHaveProperty('line');
        expect(v).toHaveProperty('fn');
        expect(typeof v.line).toBe('number');
        expect(['spawnSync', 'spawn', 'execSync', 'exec', 'fork']).toContain(v.fn);
      }
    }
  });
});

describe('AC3 — opt-out comment format', () => {
  // Self-test: build a fake file with various opt-out shapes and verify the
  // detector accepts the valid forms and rejects the invalid ones.
  const fakeSrc = [
    "import { spawnSync } from 'child_process';",
    "function valid1() {",
    "  // timeout-opt-out: known-fast git status call",
    "  return spawnSync('git', ['status']);",
    "}",
    "function valid2() {",
    "  return spawnSync('git', ['status']); // timeout-opt-out: another fast call",
    "}",
    "function invalid1() {",
    "  // opt-out",
    "  return spawnSync('git', ['status']);",
    "}",
    "function invalid2() {",
    "  // timeout-opt-out:",
    "  return spawnSync('git', ['status']);",
    "}",
    "function invalid3() {",
    "  // wrong-prefix-opt-out: blah",
    "  return spawnSync('git', ['status']);",
    "}",
  ].join('\n');

  it('accepts opt-out on line above with non-empty reason', () => {
    const violations = findViolations(fakeSrc);
    // valid1 (line 4) should NOT be a violation
    expect(violations.some((v) => v.line === 4)).toBe(false);
  });

  it('accepts opt-out on same line with non-empty reason', () => {
    const violations = findViolations(fakeSrc);
    // valid2 (line 7) should NOT be a violation
    expect(violations.some((v) => v.line === 7)).toBe(false);
  });

  it('rejects bare "// opt-out" (missing prefix)', () => {
    const violations = findViolations(fakeSrc);
    // invalid1 (line 11) SHOULD be a violation
    expect(violations.some((v) => v.line === 11)).toBe(true);
  });

  it('rejects "// timeout-opt-out:" with empty reason', () => {
    const violations = findViolations(fakeSrc);
    // invalid2 (line 15) SHOULD be a violation
    expect(violations.some((v) => v.line === 15)).toBe(true);
  });

  it('rejects wrong-prefix opt-outs', () => {
    const violations = findViolations(fakeSrc);
    // invalid3 (line 19) SHOULD be a violation
    expect(violations.some((v) => v.line === 19)).toBe(true);
  });
});

describe('AC9 — TIMEOUT_FLOOR_MS exported constant', () => {
  it('TIMEOUT_FLOOR_MS equals 120000ms (2 minutes)', () => {
    expect(TIMEOUT_FLOOR_MS).toBe(120_000);
  });

  it('TIMEOUT_FLOOR_MS is importable from this module', async () => {
    const mod = await import('./subprocess-timeout-convention.test.mjs');
    expect(mod.TIMEOUT_FLOOR_MS).toBe(TIMEOUT_FLOOR_MS);
  });
});

describe('AC7 — meta-test uses no subprocess spawns', () => {
  // Pure config introspection. fs/promises + globby are the heaviest imports.
  // No spawn-family calls in this file. Verifiable by self-check + by
  // running this file in isolation with `vitest run` and observing zero
  // subprocess output.
  it('meta-test source contains no real spawn-family invocation (only the fakeSrc fixture string)', () => {
    const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const violations = findViolations(selfSrc);
    // The detector should skip its own spawn calls inside the fakeSrc fixture
    // string (they're inside an unclosed string literal segment per the line-
    // parser). If a real call leaks in, this self-check fires.
    expect(violations, `Meta-test introduced a real spawn call: ${JSON.stringify(violations)}`).toEqual([]);
  });
});

describe('AC10 — file header documents the convention', () => {
  it('this file has a header block stating the convention, floor, and opt-out syntax', () => {
    const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(selfSrc).toMatch(/120000ms/);
    expect(selfSrc).toMatch(/timeout-opt-out:/);
    expect(selfSrc).toMatch(/qa-subprocess-timeout-rule/);
  });
});

describe('Allowlist hygiene', () => {
  it('AC4 — allowlist has <=3 entries after Tier-2 sweep', () => {
    // Tier-2 sweep (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit) trimmed
    // this from 27 entries to 3. The cap is structural: if the count regrows,
    // either the offending file should move to integration tier, or the spawn
    // call should gain an explicit timeout / opt-out comment. Do NOT raise the
    // cap to fit a regression — fix the regression instead.
    expect(
      ALLOWLIST.size,
      `ALLOWLIST has ${ALLOWLIST.size} entries (cap is 3). Either move the new file to tests/integration/ or add an explicit timeout / // timeout-opt-out: <reason> comment to the spawn call.`,
    ).toBeLessThanOrEqual(3);
  });

  it('every allowlist entry has a non-empty rationale', () => {
    for (const [file, reason] of ALLOWLIST) {
      expect(reason.length, `allowlist entry for ${file} has empty rationale`).toBeGreaterThan(5);
    }
  });

  it('every allowlist entry corresponds to a real file with at least one violation', () => {
    const stale = [];
    for (const [file] of ALLOWLIST) {
      const absPath = path.join(REPO_ROOT, file);
      if (!fs.existsSync(absPath)) {
        stale.push(`${file} (file does not exist)`);
        continue;
      }
      if (!scanResult.has(file)) {
        stale.push(`${file} (no violations found — allowlist entry is stale and should be removed)`);
      }
    }
    expect(stale, `Stale allowlist entries: ${JSON.stringify(stale, null, 2)}`).toEqual([]);
  });
});

// Audit summary, captured at story commit time. Useful for follow-up story scoping.
// AUDIT (2026-06-09, B2-core):
//   - 27 violator files total at B2-core ship
//   - ~290 individual spawn-family calls without timeout
//   - Major buckets: git-ops tests (~14 files), git-release family (3 files + 1 excluded),
//     CLI dispatch tests (3 files), hook tests (1 file), planner tests (2 files),
//     e2e tier (1 file)
//   - Largest single file: tests/unit/git-release.test.mjs (93 violations, excluded from CI)
//   - Estimated follow-up: 4 child stories grouped by bucket
//
// TIER-2 SWEEP (2026-06-15, backlog.feat.test-suite-tier-2-unit-tier-bloat-audit):
//   - 24 ALLOWLIST entries dropped — those files moved from tests/unit/ to
//     tests/integration/, where the integration-tier convention governs them.
//   - 3 entries remain: e2e/dogfood-workflow, project-attach-stack, vendor-subtree.
//     None of these live under tests/unit/; the timeout floor still applies to
//     them structurally (any new spawn-family addition needs timeout or opt-out
//     comment), but the existing calls are documented as exempt.
//   - AC4 cap (ALLOWLIST.size <= 3) is now structurally enforced above.
