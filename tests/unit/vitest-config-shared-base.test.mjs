/**
 * Tests for backlog.fix.vitest-config-drift-reconcile (B5).
 *
 * Asserts the byte-identical-behavior invariant: each tier's effective merged
 * vitest config must equal the corresponding pre-refactor fixture snapshot.
 *
 * Also asserts:
 *   - vitest.config.base.mjs exists and exports the documented cross-tier keys
 *   - Each tier extends the base via mergeConfig
 *   - Every tier-specific override has a `// OVERRIDE-REASON:` comment
 *   - B1 (env passthrough), B3 (workflow exclude), B4 (skip-debt exclude) couplings preserved
 *   - Chunk A invariants survive (A1, A2, A3, A4, A5)
 *
 * No subprocess spawns.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const TIERS = [
  { name: 'fallback', configPath: 'vitest.config.mjs', fixturePath: 'tests/fixtures/vitest-config-pre-refactor.fallback.json' },
  { name: 'unit', configPath: 'vitest.config.unit.mjs', fixturePath: 'tests/fixtures/vitest-config-pre-refactor.unit.json' },
  { name: 'mock', configPath: 'vitest.config.mock.mjs', fixturePath: 'tests/fixtures/vitest-config-pre-refactor.mock.json' },
  { name: 'e2e', configPath: 'vitest.config.e2e.mjs', fixturePath: 'tests/fixtures/vitest-config-pre-refactor.e2e.json' },
];

// B5 hotfix: load all tier configs ONCE in beforeAll, cache by tier name.
// Importing vitest configs inside individual tests triggers Vite re-resolution
// which is slow under CI fork-contention (caused the 5734ms timeout that
// killed vitest-tiers.test.mjs in CI #1939's re-run).
let CONFIG_BY_TIER = {};
let BASE_CONFIG;

beforeAll(async () => {
  const [base, fallback, unit, mock, e2e] = await Promise.all([
    import('../../vitest.config.base.mjs').then((m) => m.default),
    import('../../vitest.config.mjs').then((m) => m.default),
    import('../../vitest.config.unit.mjs').then((m) => m.default),
    import('../../vitest.config.mock.mjs').then((m) => m.default),
    import('../../vitest.config.e2e.mjs').then((m) => m.default),
  ]);
  BASE_CONFIG = base;
  CONFIG_BY_TIER = { fallback, unit, mock, e2e };
}, 60_000);

// Subset of `test` fields the fixture pins. We compare only these keys so
// adding new vitest features that default to safe values doesn't break the
// regression check.
const PINNED_KEYS = [
  'include',
  'exclude',
  'bail',
  'isolate',
  'pool',
  'poolOptions',
  'setupFiles',
  'clearMocks',
  'env',
  'hookTimeout',
  'testTimeout',
];

function projectConfig(test) {
  const out = {};
  for (const k of PINNED_KEYS) {
    out[k] = test[k] ?? null;
  }
  return out;
}

function loadFixture(rel) {
  const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const obj = JSON.parse(raw);
  // Strip the doc-only field; it's metadata not behavior.
  delete obj._comment;
  return obj;
}

describe('AC1 + AC2 — base config exists and is imported by each tier', () => {
  it('vitest.config.base.mjs exists at repo root', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'vitest.config.base.mjs'))).toBe(true);
  });

  it('base config exports the documented cross-tier defaults', () => {
    const t = BASE_CONFIG.test ?? {};
    expect(t.pool).toBe('forks');
    expect(t.poolOptions?.forks?.minForks).toBe(1);
    expect(t.setupFiles).toEqual(['tests/setup.mjs']);
    expect(t.clearMocks).toBe(true);
    expect(t.exclude).toEqual(['tests/.tmp/**']);
    expect(t.env).toEqual({ NODE_NO_WARNINGS: '1', ROUTEKIT_SKIP_GLOBAL_CONFIG: 'true' });
  });

  for (const tier of TIERS) {
    it(`vitest.config.${tier.name === 'fallback' ? '' : tier.name + '.'}mjs imports the base via mergeConfig`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, tier.configPath), 'utf8');
      expect(src).toMatch(/import\s*{[^}]*mergeConfig[^}]*}\s*from\s*["']vitest\/config["']/);
      expect(src).toMatch(/import\s+base\s+from\s+["']\.\/vitest\.config\.base\.mjs["']/);
      expect(src).toMatch(/mergeConfig\s*\(\s*base/);
    });
  }
});

describe('AC4 — byte-identical regression vs pre-refactor fixture snapshots', () => {
  for (const tier of TIERS) {
    it(`${tier.name} tier's effective merged config matches ${path.basename(tier.fixturePath)}`, () => {
      const cfg = CONFIG_BY_TIER[tier.name];
      const effective = projectConfig(cfg.test ?? {});
      const fixture = loadFixture(tier.fixturePath);
      expect(effective).toEqual(fixture);
    });
  }
});

describe('AC3 — every tier-specific override carries a // OVERRIDE-REASON: comment', () => {
  for (const tier of TIERS) {
    it(`${tier.configPath}: every tier-specific override has an OVERRIDE-REASON nearby`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, tier.configPath), 'utf8');
      const lines = src.split('\n');

      // Heuristic: any line that contains a likely-override key (bail, isolate,
      // maxForks, hookTimeout, testTimeout, exclude-with-array) MUST have an
      // OVERRIDE-REASON comment within 2 lines above or on the same line.
      const overrideKeys = ['bail:', 'isolate:', 'maxForks:', 'hookTimeout:', 'testTimeout:'];

      const violations = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines inside block comments or doc headers (rough heuristic: line starts with " * " or "//").
        if (/^\s*(\/\/|\*)/.test(line)) continue;

        for (const key of overrideKeys) {
          if (line.includes(key) && !line.includes('//')) {
            // Look at the same line + 2 lines above for OVERRIDE-REASON.
            const window = [lines[i - 2] || '', lines[i - 1] || '', line];
            const hasReason = window.some((l) => /OVERRIDE-REASON:/.test(l));
            if (!hasReason) {
              violations.push(`${tier.configPath}:${i + 1} — '${key.trim()}' override without OVERRIDE-REASON within 2 lines above`);
            }
            break;
          }
        }
      }

      // Some tiers (fallback) have no overrides for these keys — that's fine.
      // We're only flagging cases where an override exists WITHOUT a reason.
      expect(violations, `Missing OVERRIDE-REASON comments:\n${violations.join('\n')}`).toEqual([]);
    });
  }

  it('every OVERRIDE-REASON comment has a non-empty rationale', () => {
    for (const tier of TIERS) {
      const src = fs.readFileSync(path.join(REPO_ROOT, tier.configPath), 'utf8');
      const matches = [...src.matchAll(/\/\/\s*OVERRIDE-REASON:\s*(\S.*)/g)];
      // Each match's capture group must be non-empty (the \S anchors at least one non-space char).
      for (const m of matches) {
        expect(m[1].trim().length, `Empty OVERRIDE-REASON in ${tier.configPath}`).toBeGreaterThan(5);
      }
    }
  });
});

describe('Cross-story coupling — B1 + B3 + B4 preservation', () => {
  it('B1: vitest.config.unit.mjs preserves the env settings B1 relies on (no env override that drops base defaults)', () => {
    const env = CONFIG_BY_TIER.unit.test?.env ?? {};
    // The B1 runner uses ROUTEKIT_VITEST_JSON_OUTPUT as a runtime env var (not config-level),
    // but it relies on the base's NODE_NO_WARNINGS + ROUTEKIT_SKIP_GLOBAL_CONFIG being intact.
    expect(env.NODE_NO_WARNINGS).toBe('1');
    expect(env.ROUTEKIT_SKIP_GLOBAL_CONFIG).toBe('true');
  });

  it('B3: vitest.config.mock.mjs preserves the *.workflow.test.* exclude', () => {
    const exclude = CONFIG_BY_TIER.mock.test?.exclude ?? [];
    expect(exclude.some((p) => p.includes('workflow.test'))).toBe(true);
  });

  it('Tier-2: vitest.config.unit.mjs no longer excludes git-release.test.mjs (moved to integration tier)', () => {
    // backlog.feat.test-suite-tier-2-unit-tier-bloat-audit relocated
    // tests/unit/git-release.test.mjs to tests/integration/. The per-tier
    // exclude entry became redundant in the same commit; this regression pin
    // ensures a future change does not silently re-add the entry.
    const exclude = CONFIG_BY_TIER.unit.test?.exclude ?? [];
    expect(exclude).not.toContain('tests/unit/git-release.test.mjs');
  });

  it('Hotfix #10: vitest.config.unit.mjs preserves maxForks: 2', () => {
    expect(CONFIG_BY_TIER.unit.test?.poolOptions?.forks?.maxForks).toBe(2);
  });

  it('Hotfix #6: package.json test:unit script still passes --timeout 3600000', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['test:unit']).toContain('--timeout 3600000');
  });
});

describe('AC10 — Chunk A invariants survive B5', () => {
  // Sanity-check via source-grep that no Chunk A targetFile is in this story's
  // diff. B5 only touches vitest configs + tests/unit/vitest-config-shared-base.test.mjs
  // + tests/unit/vitest-tiers.test.mjs (B3's earlier edit) + fixtures.
  const CI_YML_SRC = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
  const SMOKE_YML_SRC = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/release-smoke.yml'), 'utf8');
  const GIT_RELEASE_SRC = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs'), 'utf8');

  it('A1: ci.yml still has [skip ci] paths-ignore for package.json + CHANGELOG.md', () => {
    expect(CI_YML_SRC).toContain('package.json');
    expect(CI_YML_SRC).toContain('CHANGELOG.md');
  });

  it('A2: ci.yml still has notes/backlog.** paths-ignore entry', () => {
    expect(CI_YML_SRC).toContain('notes/backlog.**');
  });

  it('A3: git-release.mjs still exports stripAnsi + parseGhLogFailedOutput + fetchCiDiagnostics', () => {
    expect(GIT_RELEASE_SRC).toContain('export function stripAnsi');
    expect(GIT_RELEASE_SRC).toContain('export function parseGhLogFailedOutput');
    expect(GIT_RELEASE_SRC).toContain('export function fetchCiDiagnostics');
  });

  it('A4: release-smoke.yml triggers on tag push v*.*.*', () => {
    expect(SMOKE_YML_SRC).toContain("'v*.*.*'");
  });

  it('A5: ci.yml has sha-guard job + downstream needs/if', () => {
    expect(CI_YML_SRC).toContain('sha-guard');
    expect(CI_YML_SRC).toContain("needs.sha-guard.outputs.skip != 'true'");
  });
});
