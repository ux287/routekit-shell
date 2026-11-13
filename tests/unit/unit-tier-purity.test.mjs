/**
 * Tests for backlog.feat.test-suite-tier-2-unit-tier-bloat-audit (T2e).
 *
 * Symmetric to tests/unit/integration-suite-convention.test.mjs but for the
 * unit tier. Enforces structural rules that keep tests/unit/ pure:
 *
 *   Rule A — no subprocess spawn-family calls inside tests/unit/ without an
 *            inline `// timeout-opt-out: <reason>` comment. The integration
 *            tier (tests/integration/) is the home for subprocess work; any
 *            new spawnSync / execSync / fork / etc. landing in tests/unit/
 *            is treated as misclassification.
 *
 *   Rule B — no `vi.resetModules()` followed by `await import(...)` of a
 *            module exceeding 1000 source lines inside tests/unit/. Large-
 *            module re-imports are an integration-tier signature (the
 *            audit paper §2 flagged this as the slowest single offender:
 *            server-self-project-id.test.mjs at 107s/CI run via repeated
 *            re-imports of packages/mcp-rks/src/server.mjs).
 *
 * RATIONALE: tests/integration/ already has its own meta-test
 * (integration-suite-convention.test.mjs) enforcing the integration-tier
 * filename-suffix convention. The unit tier had no symmetric enforcer — drive-
 * by integration tests would land in tests/unit/ and accumulate (the Tier 2
 * audit found 27 of them). This file is the structural barrier.
 *
 * The opt-out comment grammar matches the canonical definition in
 * tests/unit/subprocess-timeout-convention.test.mjs:
 *   // timeout-opt-out: <non-empty reason>
 *
 * Audit paper reference:
 *   notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md §5
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globby } from 'globby';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const UNIT_DIR = path.join(REPO_ROOT, 'tests/unit');

// Mirrored from tests/unit/subprocess-timeout-convention.test.mjs so the
// grammar stays in sync. If that constant changes, this one must follow.
// Canonical definition: tests/unit/subprocess-timeout-convention.test.mjs:54.
const SPAWN_FAMILY_RE = /(?<![\w.])(spawnSync|spawn|execSync|exec|fork)\s*\(/g;

// >1000 LOC defines a "large module" for Rule B per the audit paper §2 thesis
// that server.mjs (3,868 LOC) is the canonical offender. The number is a
// heuristic, not a sharp threshold — borderline cases (~900-1100 LOC) should
// either move to integration tier or carry an opt-out comment.
//
// THRESHOLD CROSSING (recorded deliberately WITHOUT a pinned line count — any
// number written here would rot on the next commit):
// packages/mcp-rks/src/server/git/git-release.mjs has grown past this threshold
// and is therefore now IN SCOPE for rule (b). Any tests/unit/ file that pairs a
// vi.resetModules() with a re-import of that module is now a rule-(b) offender,
// including files that were never edited.
//
// Raising LARGE_MODULE_LOC_THRESHOLD is NOT the sanctioned response. It would
// weaken rule (b) for every file in the tier in order to make one module's
// symptom disappear, and the constant is pinned by a self-test below so that
// "fix" reds instead of landing quietly. The sanctioned responses are unchanged:
// move the test to tests/integration/, add the documented opt-out comment, or
// decompose the module.
const LARGE_MODULE_LOC_THRESHOLD = 1000;

// List of EDIT-list entries from the Tier-2 story that were physical moves.
// AC1 — both source-absent AND destination-present must hold for each.
const TIER2_MOVES = [
  'vendor-rks-distribution.test.mjs',
  'route-git-during-off-rail.test.mjs',
  'stale-branch-cleanup.test.mjs',
  'git-preflight.test.mjs',
  'server-self-project-id.test.mjs',
  'auto-phase.test.mjs',
  'commit-and-embed-note.test.mjs',
  'cycle-complete-telemetry.test.mjs',
  'decompose-auto-commit.test.mjs',
  'dendron-write-auto-commit.test.mjs',
  'enforce-targetfile-scope.test.mjs',
  'exec-dirty-note-exclusion.test.mjs',
  'exec-orphaned-branch-cleanup.test.mjs',
  'exec-preflight-exclude-all-notes.test.mjs',
  'exec-rollback.test.mjs',
  'git-agent-read-tools.test.mjs',
  'git-core.tag-guard.test.mjs',
  'git-tools.pr-body.test.mjs',
  'git-workflow-skip-pr.test.mjs',
  'git-workflow.exec-commit-staging.test.mjs',
  'guardrails-auto-cleanup.test.mjs',
  'plan-quality.test.mjs',
  'plan-review-poll-hint.test.mjs',
  'story-ship-preflight.test.mjs',
  'git-release.integration.test.mjs',
  'git-release.staging-merge.test.mjs',
  'git-release.test.mjs',
];

/**
 * Detect spawn-family calls that are NOT documented either by an explicit
 * `timeout: <ms>` option in the call's options literal OR by a
 * `// timeout-opt-out: <reason>` comment on the same line / line above.
 *
 * Mirrors the dual-acceptance logic in
 * tests/unit/subprocess-timeout-convention.test.mjs (canonical definition) so
 * the two meta-tests never disagree on what counts as a violation. The
 * convention test pays down hidden subprocess debt by file; the purity test
 * enforces the same rule structurally at the unit-tier boundary.
 */
function findRawSpawns(src) {
  const lines = src.split('\n');
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

      // Skip function declarations (`function spawnSync(`) and helper
      // definitions (`const spawn = function(`, `const spawn = (...) =>`).
      const window = line.slice(Math.max(0, m.index - 40), m.index + 20);
      if (/function\s+\w+\s*\(/.test(window)) continue;
      if (/(const|let|var)\s+\w+\s*=\s*(function|\([^)]*\)\s*=>)/.test(line)) continue;

      // Look ahead up to 15 lines for a `timeout:` key inside the same call's
      // options object literal — matches the convention test's behavior.
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
      if (hasTimeout) continue;

      const sameLine = lines[i] || '';
      const lineAbove = lines[i - 1] || '';
      const optOutRe = /\/\/\s*timeout-opt-out:\s*(\S.*)/;
      const hasOptOut = optOutRe.test(sameLine) || optOutRe.test(lineAbove);
      if (hasOptOut) continue;

      violations.push({ line: i + 1, fn: m[1] });
    }
  }
  return violations;
}

/**
 * Detect vi.resetModules() followed within `lookahead` lines by an
 * `await import(...)` (or bare `import(...)`) of a path that resolves to a
 * file exceeding LARGE_MODULE_LOC_THRESHOLD. Returns an array of
 * {line, importPath, loc} for each offender.
 */
function findLargeModuleReimports(src, srcFile, lookahead = 60) {
  const lines = src.split('\n');
  // Strip line comments before matching — the same idiom findRawSpawns uses above and
  // skip-debt-audit.test.mjs's findSkips uses for the identical reason. Prose that merely
  // NAMES vi.resetModules() is not a re-import: a comment stating that a file AVOIDS the
  // antipattern was being scored AS the antipattern. NOTE: the opt-out lookup below
  // deliberately keeps reading the RAW `lines`, because the opt-out marker IS a comment —
  // repointing it at `stripped` would erase the rule's own escape hatch.
  const stripped = lines.map((l) => {
    const idx = l.indexOf('//');
    return idx === -1 ? l : l.slice(0, idx);
  });
  const violations = [];
  const resetRe = /\bvi\.resetModules\s*\(\s*\)/;
  const importRe = /\b(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const optOutRe = /\/\/\s*timeout-opt-out:\s*(\S.*)/;

  for (let i = 0; i < lines.length; i++) {
    if (!resetRe.test(stripped[i])) continue;
    // Look ahead for import() calls within `lookahead` lines.
    for (let j = i; j < Math.min(i + lookahead, lines.length); j++) {
      const matches = [...stripped[j].matchAll(importRe)];
      for (const m of matches) {
        const importPath = m[1];
        // Resolve relative to the test file; ignore bare specifiers.
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;
        const resolved = path.resolve(path.dirname(srcFile), importPath);
        if (!fs.existsSync(resolved)) continue;
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) continue;
        const loc = fs.readFileSync(resolved, 'utf8').split('\n').length;
        if (loc <= LARGE_MODULE_LOC_THRESHOLD) continue;

        // Check opt-out on same line or the line above either the reset OR the import.
        const optOutLines = [lines[i], lines[i - 1] || '', lines[j], lines[j - 1] || ''];
        if (optOutLines.some((l) => optOutRe.test(l))) continue;

        violations.push({ line: j + 1, importPath, loc });
      }
    }
  }
  return violations;
}

let unitFiles = [];
let rawSpawnViolations = new Map();
let largeReimportViolations = new Map();

beforeAll(async () => {
  // Tier 2.5: extend glob coverage to root-level tests/*.test.* and tests/*.spec.*
  // patterns. The unit-tier vitest config (vitest.config.unit.mjs) globs both
  // tests/unit/** AND root-level tests/*.test.* + tests/*.spec.* — so future
  // integration-shape tests landing at root (the Tier 2.5 cascade source) get
  // caught by this meta-test before they ship. Note: tests/unit/**/*.spec.*
  // patterns are intentionally NOT added — they carry pre-existing subprocess
  // debt that's out of scope for this story; tracked separately.
  const rel = await globby([
    'tests/unit/**/*.test.mjs',
    'tests/unit/**/*.test.js',
    'tests/*.test.mjs',
    'tests/*.test.js',
    'tests/*.spec.mjs',
    'tests/*.spec.js',
  ], {
    cwd: REPO_ROOT,
  });
  unitFiles = rel.sort();
  for (const f of unitFiles) {
    const abs = path.join(REPO_ROOT, f);
    // Exempt this file itself — the regexes in source would otherwise self-flag.
    if (f === 'tests/unit/unit-tier-purity.test.mjs') continue;
    // Exempt the canonical convention test — it contains test fixtures with
    // spawn calls inside string literals, which the detector already strips,
    // plus its own self-test fakeSrc fixture is intentional.
    if (f === 'tests/unit/subprocess-timeout-convention.test.mjs') continue;

    const src = fs.readFileSync(abs, 'utf8');
    const rs = findRawSpawns(src);
    if (rs.length > 0) rawSpawnViolations.set(f, rs);

    const lr = findLargeModuleReimports(src, abs);
    if (lr.length > 0) largeReimportViolations.set(f, lr);
  }
}, 60_000);

describe('AC5 rule (a) — no raw spawn-family calls in tests/unit/', () => {
  it('every spawn-family call in tests/unit/ carries an opt-out comment', () => {
    const offenders = [...rawSpawnViolations.entries()].map(([file, vs]) => {
      const detail = vs.map((v) => `${v.fn}@${v.line}`).join(', ');
      return `  ${file} — ${detail}`;
    });
    expect(
      offenders,
      `Files in tests/unit/ with raw spawn-family calls (no // timeout-opt-out: comment):\n${offenders.join('\n')}\n\n` +
        `Either: (1) move the file to tests/integration/, or ` +
        `(2) add a // timeout-opt-out: <reason> comment on the same line or line immediately above the spawn call.`,
    ).toEqual([]);
  });
});

describe('AC5 rule (b) — no vi.resetModules + large-module re-import in tests/unit/', () => {
  it('every vi.resetModules + import() of a >1000-LOC module carries an opt-out comment', () => {
    const offenders = [...largeReimportViolations.entries()].flatMap(([file, vs]) =>
      vs.map((v) => `  ${file}:${v.line} — imports ${v.importPath} (${v.loc} LOC)`),
    );
    expect(
      offenders,
      `vi.resetModules() followed by import() of large modules in tests/unit/:\n${offenders.join('\n')}\n\n` +
        `Large-module re-imports cause heavy CI wall-clock (the canonical offender, server.mjs at 3,868 LOC, ` +
        `contributed 107s to the slowest unit shard). Either move the test to tests/integration/ or add a ` +
        `// timeout-opt-out: <reason> comment.`,
    ).toEqual([]);
  });
});

describe('AC1 — Tier-2 move completed (file-system witness)', () => {
  it('every moved file is present at tests/integration/<basename>', () => {
    const missing = TIER2_MOVES.filter((name) => {
      const p = path.join(REPO_ROOT, 'tests/integration', name);
      return !fs.existsSync(p);
    });
    expect(missing, `Missing in tests/integration/: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('every moved file is absent from tests/unit/<basename>', () => {
    const still = TIER2_MOVES.filter((name) => {
      const p = path.join(REPO_ROOT, 'tests/unit', name);
      return fs.existsSync(p);
    });
    expect(still, `Still present in tests/unit/: ${JSON.stringify(still)}`).toEqual([]);
  });
});

describe('AC5 self-test — detector accepts opt-outs and rejects bare spawns', () => {
  const fakeOkComment = [
    "import { spawnSync } from 'child_process';",
    "function good() {",
    "  // timeout-opt-out: known-fast git status",
    "  return spawnSync('git', ['status']);",
    "}",
  ].join('\n');
  const fakeOkTimeout = [
    "import { spawnSync } from 'child_process';",
    "function good() {",
    "  return spawnSync('git', ['status'], { timeout: 30000 });",
    "}",
  ].join('\n');
  const fakeBad = [
    "import { spawnSync } from 'child_process';",
    "function bad() {",
    "  return spawnSync('git', ['status']);",
    "}",
  ].join('\n');

  it('the detector does NOT flag spawn calls preceded by a valid opt-out comment', () => {
    expect(findRawSpawns(fakeOkComment)).toEqual([]);
  });

  it('the detector does NOT flag spawn calls carrying an explicit timeout option', () => {
    expect(findRawSpawns(fakeOkTimeout)).toEqual([]);
  });

  it('the detector DOES flag spawn calls with neither timeout option nor opt-out comment', () => {
    const vs = findRawSpawns(fakeBad);
    expect(vs.length).toBeGreaterThan(0);
    expect(vs[0]).toHaveProperty('fn', 'spawnSync');
  });
});

describe('AC5 rule (b) self-test — comment stripping, opt-out placement, and grammar', () => {
  // The fixture module must be DURABLY large. git-release.mjs sits only a few lines over the
  // 1000-LOC threshold, so a fixture pointing at it would go vacuous on any shrink. server.mjs
  // is several thousand lines over. srcFile is this file itself, so the relative specifier in
  // each fixture resolves from tests/unit/ exactly as it would in a real test file.
  const LARGE_MODULE = '../../packages/mcp-rks/src/server.mjs';
  const SELF_FILE = fileURLToPath(import.meta.url);
  const IMPORT_LINE = `  const mod = await import('${LARGE_MODULE}');`;

  // ANTI-VACUITY. findLargeModuleReimports silently continues on an unresolvable path and on
  // loc <= LARGE_MODULE_LOC_THRESHOLD, so without this every `toEqual([])` case below could
  // pass merely because the fixture module stopped being large (or the srcFile was wrong).
  function assertFixturePrecondition() {
    const resolved = path.resolve(path.dirname(SELF_FILE), LARGE_MODULE);
    expect(fs.existsSync(resolved), `fixture module does not resolve: ${resolved}`).toBe(true);
    const loc = fs.readFileSync(resolved, 'utf8').split('\n').length;
    expect(
      loc,
      `fixture module must exceed LARGE_MODULE_LOC_THRESHOLD (${LARGE_MODULE_LOC_THRESHOLD}); got ${loc}`,
    ).toBeGreaterThan(LARGE_MODULE_LOC_THRESHOLD);
  }

  it('FIXTURE PRECONDITION — the fixture module resolves on disk and is genuinely large', () => {
    assertFixturePrecondition();
  });

  it('THRESHOLD PINNED — LARGE_MODULE_LOC_THRESHOLD is still 1000', () => {
    // Raising the threshold is the forbidden "fix": it widens the exemption for every file
    // in the tier. See the THRESHOLD CROSSING note at the top of this file.
    expect(LARGE_MODULE_LOC_THRESHOLD).toBe(1000);
  });

  it('FALSE POSITIVE CLOSED — prose that merely NAMES the reset call is not a violation', () => {
    assertFixturePrecondition();
    // This is the exact shape found at tests/unit/git-release-ff-fail-rollback.test.mjs: a
    // comment stating the file AVOIDS the antipattern, followed by a top-level import.
    const fixture = [
      '// Single top-level mock — avoids vi.resetModules() per-test which causes LanceDB re-init',
      "import { vi } from 'vitest';",
      IMPORT_LINE,
    ].join('\n');
    expect(findLargeModuleReimports(fixture, SELF_FILE)).toEqual([]);
  });

  it('DETECTOR STILL BITES — a real reset plus a large-module import is still flagged', () => {
    const fixture = [
      "import { vi } from 'vitest';",
      'beforeEach(() => {',
      '  vi.resetModules();',
      '});',
      IMPORT_LINE,
    ].join('\n');
    const violations = findLargeModuleReimports(fixture, SELF_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].importPath).toBe(LARGE_MODULE);
    expect(violations[0].loc).toBeGreaterThan(LARGE_MODULE_LOC_THRESHOLD);
  });

  it('STRIPPING IS NOT A HIDING MECHANISM — trailing comments do not un-flag a real violation', () => {
    // The strip truncates AT the `//` and keeps the code prefix. A strip that discarded whole
    // lines containing `//` would silently un-flag both of these lines.
    const fixture = [
      "import { vi } from 'vitest';",
      '  vi.resetModules(); // fresh module graph for this case',
      `${IMPORT_LINE} // re-import after the reset`,
    ].join('\n');
    const violations = findLargeModuleReimports(fixture, SELF_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].importPath).toBe(LARGE_MODULE);
  });

  it('OPT-OUT HONOURED ON RAW LINES — a marker immediately above the import suppresses', () => {
    assertFixturePrecondition();
    // This is the guard that keeps the comment-stripping fix from erasing its own escape
    // hatch: the opt-out marker IS a comment, so the lookup must stay on the RAW lines.
    // Repointing it at `stripped` reds exactly here.
    const fixture = [
      "import { vi } from 'vitest';",
      '  vi.resetModules();',
      '  // timeout-opt-out: fixture — in-memory string, no module is ever loaded',
      IMPORT_LINE,
    ].join('\n');
    expect(findLargeModuleReimports(fixture, SELF_FILE)).toEqual([]);
  });

  it('OPT-OUT ABOVE THE RESET — the four-slot lookup contract is preserved', () => {
    assertFixturePrecondition();
    const fixture = [
      "import { vi } from 'vitest';",
      '  // timeout-opt-out: fixture — in-memory string, no module is ever loaded',
      '  vi.resetModules();',
      IMPORT_LINE,
    ].join('\n');
    expect(findLargeModuleReimports(fixture, SELF_FILE)).toEqual([]);
  });

  it('OPT-OUT GRAMMAR — a marker with an empty reason does NOT suppress', () => {
    const fixture = [
      "import { vi } from 'vitest';",
      '  vi.resetModules();',
      '  // timeout-opt-out:',
      IMPORT_LINE,
    ].join('\n');
    const violations = findLargeModuleReimports(fixture, SELF_FILE);
    expect(violations).toHaveLength(1);
    expect(violations[0].importPath).toBe(LARGE_MODULE);
  });
});

describe('AC5 rule (b) — repo-scope witness for the two files the threshold crossing surfaced', () => {
  it('git-release-ff-fail-rollback.test.mjs (false positive) is absent from the offender map', () => {
    expect(largeReimportViolations.get('tests/unit/git-release-ff-fail-rollback.test.mjs')).toBeUndefined();
  });

  it('git-release.gh-release.test.mjs (true positive, opt-out marked) is absent from the offender map', () => {
    expect(largeReimportViolations.get('tests/unit/git-release.gh-release.test.mjs')).toBeUndefined();
  });
});

describe('AC6 — tests/unit/README.md exists with the right pointers', () => {
  const READMEPath = path.join(UNIT_DIR, 'README.md');

  it('tests/unit/README.md exists on disk', () => {
    expect(fs.existsSync(READMEPath), 'tests/unit/README.md missing').toBe(true);
  });

  it('README contains the definitional keywords', () => {
    const src = fs.readFileSync(READMEPath, 'utf8');
    expect(src.toLowerCase()).toContain('unit test');
    expect(src.toLowerCase()).toContain('audit paper');
    expect(src).toContain('unit-tier-purity');
  });
});

describe('AC4 invariant — subprocess-timeout-convention ALLOWLIST stays <=3', () => {
  // Defensive cross-check: import the ALLOWLIST size from the canonical file
  // and pin the cap here too so a regression cannot land by only loosening one
  // assertion. The same expectation lives inline in
  // subprocess-timeout-convention.test.mjs; the duplication is intentional.
  it('ALLOWLIST in subprocess-timeout-convention.test.mjs has <=3 entries', () => {
    const src = fs.readFileSync(
      path.join(UNIT_DIR, 'subprocess-timeout-convention.test.mjs'),
      'utf8',
    );
    // Crude line-count of the ALLOWLIST array. Each entry is one line of
    // the form `['filepath', 'reason'],`. We count lines starting with `['`
    // inside the ALLOWLIST block.
    const allowlistStart = src.indexOf('const ALLOWLIST = new Map([');
    const allowlistEnd = src.indexOf(']);', allowlistStart);
    expect(allowlistStart, 'ALLOWLIST declaration not found').toBeGreaterThan(-1);
    const block = src.slice(allowlistStart, allowlistEnd);
    const entryCount = (block.match(/^\s*\[\s*['"]/gm) || []).length;
    expect(entryCount, `ALLOWLIST has ${entryCount} entries; cap is 3.`).toBeLessThanOrEqual(3);
  });
});

describe('AC2 — vitest.config.unit.mjs edits stayed in scope', () => {
  // Tier-2 was permitted exactly one edit to vitest.config.unit.mjs: removing
  // the `exclude: ["tests/unit/git-release.test.mjs"]` entry (now redundant
  // because the file moved to tests/integration/). Anything broader would
  // amount to glob-coverage drift.
  it('vitest.config.unit.mjs no longer excludes git-release.test.mjs', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.unit.mjs'), 'utf8');
    expect(src).not.toContain('git-release.test.mjs');
  });

  it('vitest.config.unit.mjs include globs still cover tests/unit/** + tests/*', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.unit.mjs'), 'utf8');
    expect(src).toContain('tests/unit/**/*.test.*');
    expect(src).toContain('tests/*.test.*');
  });

  it('vitest.config.mock.mjs was not edited (still sweeps tests/integration/**)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.mock.mjs'), 'utf8');
    expect(src).toContain('tests/integration/**/*.test.*');
  });
});
