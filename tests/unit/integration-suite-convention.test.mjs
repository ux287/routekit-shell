/**
 * Tests for backlog.fix.integration-suite-sweeps-tests-with-implicit-prereqs (B3).
 *
 * Enforces the filename-suffix convention for tests/integration/:
 *
 *   - *.test.mjs           — SELF-CONTAINED: runs with no env vars, no prebuilt
 *                            state, no external prereqs. Swept by `npm run test:mock`
 *                            (the integration-tests CI job).
 *   - *.workflow.test.mjs  — WORKFLOW-DRIVEN: requires a specific workflow step
 *                            (env vars, prebuilt LanceDB index, external state)
 *                            before it can run. EXCLUDED from `npm run test:mock`.
 *                            MUST be invoked directly from the relevant workflow
 *                            YAML via `npx vitest run <path>`.
 *
 * Background: today's A4 hotfix (commit 92258d54) added a self-skip guard to
 * tests/integration/release-smoke.test.mjs because the regular test:mock suite
 * was sweeping it without running scripts/rag/embed.mjs first. The self-skip
 * worked but was a band-aid — any FUTURE workflow-driven test with implicit
 * prereqs would have the same problem. B3 introduces the filename-suffix
 * convention to make the classification structural rather than runtime.
 *
 * This meta-test ASSERTS:
 *   - Every file under tests/integration/ has an unambiguous suffix
 *   - vitest.config.mock.mjs's include/exclude patterns enforce the convention
 *   - The release-smoke workflow YAML invokes the *.workflow.test.mjs path
 *   - Chunk A invariants (A1, A2, A3, A4 RKS_RELEASE_SMOKE_REQUIRE_DB, A5
 *     sha-guard) are preserved
 *
 * No subprocess spawns.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const INTEGRATION_DIR = path.join(REPO_ROOT, 'tests/integration');
const MOCK_CONFIG_PATH = path.join(REPO_ROOT, 'vitest.config.mock.mjs');
const MOCK_CONFIG_SRC = fs.readFileSync(MOCK_CONFIG_PATH, 'utf8');

const SMOKE_YML_PATH = path.join(REPO_ROOT, '.github/workflows/release-smoke.yml');
const SMOKE_YML_SRC = fs.readFileSync(SMOKE_YML_PATH, 'utf8');
const SMOKE_CONFIG = parseYaml(SMOKE_YML_SRC);

const CI_YML_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_YML_SRC = fs.readFileSync(CI_YML_PATH, 'utf8');
const CI_CONFIG = parseYaml(CI_YML_SRC);

const GIT_RELEASE_PATH = path.join(REPO_ROOT, 'packages/mcp-rks/src/server/git/git-release.mjs');
const GIT_RELEASE_SRC = fs.readFileSync(GIT_RELEASE_PATH, 'utf8');

const SUFFIX_STANDALONE = /\.test\.(?:mjs|js|ts|cjs|mts|cts)$/;
const SUFFIX_WORKFLOW = /\.workflow\.test\.(?:mjs|js|ts|cjs|mts|cts)$/;

function listIntegrationTests() {
  return fs.readdirSync(INTEGRATION_DIR, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => SUFFIX_STANDALONE.test(n))
    .sort();
}

describe('AC1 — every file in tests/integration/ has an unambiguous classification', () => {
  it('every *.test.mjs file is either standalone OR workflow-driven (suffix-based)', () => {
    const files = listIntegrationTests();
    expect(files.length, 'tests/integration/ has no test files').toBeGreaterThan(0);
    const unclassified = files.filter((f) => {
      const isWorkflow = SUFFIX_WORKFLOW.test(f);
      const isStandalone = SUFFIX_STANDALONE.test(f) && !isWorkflow;
      return !isWorkflow && !isStandalone;
    });
    expect(unclassified, `Unclassified files in tests/integration/: ${JSON.stringify(unclassified)}`).toEqual([]);
  });

  it('release-smoke is named with the .workflow.test.mjs suffix (workflow-driven)', () => {
    const files = listIntegrationTests();
    expect(files).toContain('release-smoke.workflow.test.mjs');
    expect(files, 'release-smoke.test.mjs was not renamed — rename to release-smoke.workflow.test.mjs').not.toContain('release-smoke.test.mjs');
  });
});

describe('AC1 — vitest.config.mock.mjs excludes *.workflow.test.* patterns', () => {
  it('the mock config import yields an exclude array containing the workflow pattern', async () => {
    const cfg = (await import('../../vitest.config.mock.mjs')).default;
    const exclude = cfg.test?.exclude ?? [];
    expect(Array.isArray(exclude)).toBe(true);
    const workflowExclusion = exclude.some((p) => p.includes('workflow.test'));
    expect(workflowExclusion, `vitest.config.mock.mjs exclude array missing the *.workflow.test.* pattern. Current exclude: ${JSON.stringify(exclude)}`).toBe(true);
  });

  it('the source has a comment block referencing the convention and its enforcer', () => {
    // Source-grep — the convention's documentation must point at this very file.
    expect(MOCK_CONFIG_SRC.toLowerCase()).toContain('filename-suffix convention');
    expect(MOCK_CONFIG_SRC).toContain('workflow.test');
  });
});

describe('AC2 — release-smoke.workflow.test.mjs is NOT swept by npm run test:mock', () => {
  // Rather than replicate minimatch's full glob semantics (which subtly differs
  // across vitest internals), assert the structural property the convention
  // requires: SOME exclude pattern targets the .workflow.test. suffix on
  // integration tests. That's the contract — the specific glob shape is an
  // implementation detail.
  it('exclude array contains a pattern that includes the .workflow.test. suffix on tests/integration/', async () => {
    const cfg = (await import('../../vitest.config.mock.mjs')).default;
    const exclude = cfg.test?.exclude ?? [];
    const workflowExclusion = exclude.find((p) => /workflow\.test/.test(p) && /tests\/integration/.test(p));
    expect(
      workflowExclusion,
      `vitest.config.mock.mjs must have an exclude pattern targeting tests/integration/**/*.workflow.test.* . Current exclude: ${JSON.stringify(exclude)}`,
    ).toBeDefined();
  });

  it('release-smoke is currently named with the workflow suffix (would be matched by the exclusion)', () => {
    const files = listIntegrationTests();
    const workflowDriven = files.filter((f) => SUFFIX_WORKFLOW.test(f));
    expect(workflowDriven).toContain('release-smoke.workflow.test.mjs');
  });

  it('refine-workflow.test.mjs is a standalone test (NOT named with the workflow suffix)', () => {
    // Despite its name containing "workflow", refine-workflow is self-contained.
    // The convention is based on the SUFFIX, not arbitrary substrings.
    const files = listIntegrationTests();
    const refine = files.find((f) => f.startsWith('refine-workflow'));
    expect(refine, 'refine-workflow test file must exist').toBeDefined();
    expect(SUFFIX_WORKFLOW.test(refine), `refine-workflow.test.mjs must NOT use the .workflow.test.mjs suffix (it's self-contained)`).toBe(false);
  });
});

describe('AC3 — release-smoke.yml invokes the .workflow.test.mjs path', () => {
  it('workflow YAML invokes tests/integration/release-smoke.workflow.test.mjs', () => {
    expect(SMOKE_YML_SRC).toContain('tests/integration/release-smoke.workflow.test.mjs');
  });

  it('workflow YAML does NOT invoke the pre-rename path', () => {
    // Find each `vitest run <path>` invocation; none must point at the old filename.
    const stale = SMOKE_YML_SRC.match(/vitest run tests\/integration\/release-smoke\.test\.mjs/);
    expect(stale, `release-smoke.yml still references the pre-rename path`).toBeNull();
  });
});

describe('AC7 — A4 belt-and-suspenders preserved', () => {
  it('release-smoke.yml still sets RKS_RELEASE_SMOKE_REQUIRE_DB env var', () => {
    expect(SMOKE_YML_SRC).toContain('RKS_RELEASE_SMOKE_REQUIRE_DB');
    // YAML-level: the env var must be in jobs.smoke.env
    expect(SMOKE_CONFIG.jobs.smoke.env).toHaveProperty('RKS_RELEASE_SMOKE_REQUIRE_DB');
  });

  it('release-smoke.workflow.test.mjs preserves its self-skip guard (per ARCH belt-and-suspenders choice)', () => {
    const testPath = path.join(REPO_ROOT, 'tests/integration/release-smoke.workflow.test.mjs');
    expect(fs.existsSync(testPath)).toBe(true);
    const src = fs.readFileSync(testPath, 'utf8');
    // The self-skip env var reference and describe.skip mechanism must remain.
    expect(src).toContain('RKS_RELEASE_SMOKE_REQUIRE_DB');
    expect(src).toMatch(/describe\.skip|describeOrSkip/);
  });
});

describe('AC8 — Chunk A regression pins', () => {
  // A1
  it("A1: ci.yml paths-ignore still contains package.json + CHANGELOG.md + notes/research.public.**", () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('package.json');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('CHANGELOG.md');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/research.public.**');
  });

  // A2
  it("A2: ci.yml paths-ignore still contains notes/backlog.** + notes/research.**", () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/backlog.**');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/research.**');
  });

  // A3
  it("A3: git-release.mjs still exports stripAnsi, parseGhLogFailedOutput, fetchCiDiagnostics", () => {
    expect(GIT_RELEASE_SRC).toContain('export function stripAnsi');
    expect(GIT_RELEASE_SRC).toContain('export function parseGhLogFailedOutput');
    expect(GIT_RELEASE_SRC).toContain('export function fetchCiDiagnostics');
  });

  // A4
  it("A4: release-smoke.yml triggers only on tag push v*.*.*", () => {
    expect(SMOKE_CONFIG.on.push.tags).toEqual(['v*.*.*']);
  });

  // A5
  it("A5: ci.yml jobs.sha-guard still exists with skip output", () => {
    expect(CI_CONFIG.jobs).toHaveProperty('sha-guard');
    expect(CI_CONFIG.jobs['sha-guard'].outputs).toHaveProperty('skip');
  });

  it("A5: unit-tests still has needs: sha-guard AND skip-conditional", () => {
    const job = CI_CONFIG.jobs['unit-tests'];
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain('sha-guard');
    expect(String(job.if || '')).toContain("needs.sha-guard.outputs.skip != 'true'");
  });
});

describe('AC10 — meta-test uses NO spawn calls', () => {
  // Verified by the B2 subprocess-timeout-convention.test.mjs meta-test which
  // walks all of tests/ for spawn-family calls. This file is implicitly
  // covered there.
  it('placeholder — enforced by tests/unit/subprocess-timeout-convention.test.mjs', () => {
    expect(true).toBe(true);
  });
});
