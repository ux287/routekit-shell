/**
 * Tests for backlog.feat.capture-per-test-timing-in-ci (B1).
 *
 * Source-grep + structural assertions for:
 *   - scripts/vitest-runner.mjs --json-output flag passthrough
 *   - scripts/vitest-runner.mjs ROUTEKIT_VITEST_JSON_OUTPUT env var passthrough
 *   - Multi-reporter form preserves default reporter alongside json
 *   - Default output path pattern .rks/test-reports/vitest-${tier}-${timestamp}.json
 *   - Zero disk side effect when neither flag nor env is set
 *   - Hotfix #6 --timeout 3600000 preserved in package.json (NOT the runner)
 *   - Hotfix #10 maxForks: 2 preserved in vitest.config.unit.mjs (NOT the runner)
 *   - scripts/analyze-vitest-report.mjs: graceful missing-file handling
 *   - .github/workflows/ci.yml: env var set, artifact upload step, step summary emit
 *   - Chunk A regression pins (A1+A2 paths-ignore, A5 sha-guard job)
 *
 * No subprocess spawns in this file — pure file read + structural inspection.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const RUNNER_PATH = path.join(REPO_ROOT, 'scripts/vitest-runner.mjs');
const RUNNER_SRC = fs.readFileSync(RUNNER_PATH, 'utf8');

const ANALYZER_PATH = path.join(REPO_ROOT, 'scripts/analyze-vitest-report.mjs');
const ANALYZER_SRC = fs.readFileSync(ANALYZER_PATH, 'utf8');

const CI_YML_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml');
const CI_YML_SRC = fs.readFileSync(CI_YML_PATH, 'utf8');
const CI_CONFIG = parseYaml(CI_YML_SRC);

const PKG_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const PKG_JSON_SRC = fs.readFileSync(PKG_JSON_PATH, 'utf8');
const PKG_JSON = JSON.parse(PKG_JSON_SRC);

const UNIT_CONFIG_PATH = path.join(REPO_ROOT, 'vitest.config.unit.mjs');
const UNIT_CONFIG_SRC = fs.readFileSync(UNIT_CONFIG_PATH, 'utf8');

describe('AC1 — multi-reporter form preserves default reporter alongside json', () => {
  it("runner pushes '--reporter=default' literal when JSON output is enabled", () => {
    expect(RUNNER_SRC).toContain('--reporter=default');
  });

  it("runner pushes '--reporter=json' literal when JSON output is enabled", () => {
    expect(RUNNER_SRC).toContain('--reporter=json');
  });

  it("runner pushes '--outputFile.json=' to scope the path to the json reporter", () => {
    expect(RUNNER_SRC).toContain('--outputFile.json=');
  });

  it('the multi-reporter args are gated behind a conditional (not always emitted)', () => {
    // AC6 — zero side effect when neither flag nor env is set. Confirm the
    // push happens inside an if/conditional, not at unconditional top level.
    expect(RUNNER_SRC).toMatch(/if\s*\(\s*jsonOutputPath\s*\)\s*{/);
  });
});

describe('AC1 + AC2 — activation surfaces (flag + env var) and default path', () => {
  it('runner declares the --json-output flag in parseArgs options', () => {
    expect(RUNNER_SRC).toMatch(/"json-output"\s*:\s*{\s*type\s*:\s*"string"/);
  });

  it('runner reads ROUTEKIT_VITEST_JSON_OUTPUT from process.env', () => {
    expect(RUNNER_SRC).toContain('ROUTEKIT_VITEST_JSON_OUTPUT');
    expect(RUNNER_SRC).toMatch(/process\.env\.ROUTEKIT_VITEST_JSON_OUTPUT/);
  });

  it('default output path template references .rks/test-reports/ and tier + timestamp', () => {
    // Pin the path template shape — change to the scheme breaks downstream tooling.
    expect(RUNNER_SRC).toContain('.rks');
    expect(RUNNER_SRC).toContain('test-reports');
    expect(RUNNER_SRC).toMatch(/vitest-\$\{[^}]+\}-\$\{[^}]+\}\.json/);
  });
});

describe('AC6 — zero disk side effect when neither flag nor env is set', () => {
  it("runner returns null from resolveJsonOutputPath when both inputs are absent", () => {
    // Source-grep for the guard. The function MUST exit early.
    expect(RUNNER_SRC).toMatch(/if\s*\(\s*flagVal\s*===\s*undefined\s*&&\s*!envVal\s*\)\s*return\s+null/);
  });

  it("package.json's test:unit script does NOT set ROUTEKIT_VITEST_JSON_OUTPUT or pass --json-output", () => {
    // Local invocations of `npm run test:unit` must produce zero JSON write.
    // CI is the only place the env var is set.
    const testUnitScript = PKG_JSON.scripts?.['test:unit'] || '';
    expect(testUnitScript).not.toContain('ROUTEKIT_VITEST_JSON_OUTPUT');
    expect(testUnitScript).not.toContain('--json-output');
  });
});

describe('AC7 — Hotfix #6 (--timeout 3600000) preserved in package.json scripts', () => {
  it("test:unit script still contains the literal '--timeout 3600000'", () => {
    const testUnitScript = PKG_JSON.scripts?.['test:unit'] || '';
    expect(testUnitScript).toContain('--timeout 3600000');
  });
});

describe('AC7 — Hotfix #10 (maxForks: 2) preserved in vitest.config.unit.mjs', () => {
  it("vitest.config.unit.mjs still declares maxForks: 2", () => {
    expect(UNIT_CONFIG_SRC).toMatch(/maxForks\s*:\s*2\b/);
  });
});

describe('AC3 + AC4 — CI workflow wiring (env var, step summary, artifact upload)', () => {
  const unitTestsJob = CI_CONFIG.jobs['unit-tests'];

  it("unit-tests.steps includes a 'Run unit tests' step with ROUTEKIT_VITEST_JSON_OUTPUT env var", () => {
    // Tier 1 (notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md §6):
    // the step name now includes the shard suffix via matrix interpolation, e.g.
    // "Run unit tests (shard ${{ matrix.shard }}/2)". Match by prefix so this test
    // survives the matrix rename without churn.
    const runStep = unitTestsJob.steps.find((s) => typeof s.name === 'string' && s.name.startsWith('Run unit tests'));
    expect(runStep).toBeDefined();
    expect(runStep.env).toBeDefined();
    expect(runStep.env).toHaveProperty('ROUTEKIT_VITEST_JSON_OUTPUT');
    expect(String(runStep.env.ROUTEKIT_VITEST_JSON_OUTPUT)).toMatch(/\.rks\/test-reports\/vitest-unit-/);
  });

  it("unit-tests.steps includes a step that invokes scripts/analyze-vitest-report.mjs", () => {
    const summaryStep = unitTestsJob.steps.find((s) => s.name === 'Post vitest timing summary');
    expect(summaryStep).toBeDefined();
    expect(String(summaryStep.run || '')).toContain('node scripts/analyze-vitest-report.mjs');
  });

  it("the summary step runs on both pass and fail (if: always())", () => {
    const summaryStep = unitTestsJob.steps.find((s) => s.name === 'Post vitest timing summary');
    expect(summaryStep.if).toBe('always()');
  });

  it("unit-tests.steps includes an actions/upload-artifact@v4 step", () => {
    const uploadStep = unitTestsJob.steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'),
    );
    expect(uploadStep).toBeDefined();
    expect(uploadStep.uses).toMatch(/^actions\/upload-artifact@v4/);
    expect(uploadStep.with).toBeDefined();
    expect(String(uploadStep.with.path)).toMatch(/\.rks\/test-reports\/vitest-unit-/);
    expect(uploadStep.with['if-no-files-found']).toBe('warn');
  });

  it("the upload-artifact step also runs on both pass and fail", () => {
    const uploadStep = unitTestsJob.steps.find(
      (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/upload-artifact@'),
    );
    expect(uploadStep.if).toBe('always()');
  });
});

describe('AC5 — analyze-vitest-report.mjs graceful missing-file handling', () => {
  it('analyzer source has a missing-file branch that emits "No JSON report found"', () => {
    expect(ANALYZER_SRC).toContain('No JSON report found');
  });

  it('analyzer exits 0 (not 1) when the file is missing', () => {
    // The missing-file branch must exit 0 so the workflow does not turn red
    // on missing artifact. Anchor on the existsSync guard (which lives in
    // code, not the header comment) and check that the next process.exit
    // within ~300 chars is exit(0).
    const guardIdx = ANALYZER_SRC.indexOf('if (!fs.existsSync(reportPath))');
    expect(guardIdx, 'existsSync guard must exist').toBeGreaterThan(-1);
    const branchBody = ANALYZER_SRC.slice(guardIdx, guardIdx + 500);
    expect(branchBody).toContain('No JSON report found');
    expect(branchBody).toMatch(/process\.exit\(0\)/);
  });

  it('analyzer handles malformed JSON gracefully (try/catch around JSON.parse)', () => {
    expect(ANALYZER_SRC).toMatch(/try\s*\{[\s\S]+JSON\.parse[\s\S]+\}\s*catch/);
  });
});

describe('AC8 — top-10 table format (file, duration_ms, tests_run, tests_failed)', () => {
  it('analyzer emits a markdown table with the 4 required columns', () => {
    // Source-grep the table header.
    expect(ANALYZER_SRC).toContain('| file | duration_ms | tests_run | tests_failed |');
  });

  it('analyzer filters files under 1000ms', () => {
    expect(ANALYZER_SRC).toMatch(/duration_ms\s*>=\s*1000/);
  });

  it('analyzer sorts by duration_ms descending and slices top 10', () => {
    expect(ANALYZER_SRC).toMatch(/sort\(\s*\(a,\s*b\)\s*=>\s*b\.duration_ms\s*-\s*a\.duration_ms\s*\)/);
    expect(ANALYZER_SRC).toContain('.slice(0, 10)');
  });
});

describe('B1 follow-up — Failures section emitted ahead of slowness watch', () => {
  it("analyzer source has a '✖ Failures' heading", () => {
    expect(ANALYZER_SRC).toContain('✖ Failures');
  });

  it('analyzer iterates assertionResults filtering for status === "failed"', () => {
    expect(ANALYZER_SRC).toMatch(/a\.status\s*===\s*["']failed["']/);
  });

  it('analyzer surfaces ancestorTitles + title for each failure', () => {
    expect(ANALYZER_SRC).toContain('ancestorTitles');
    // The failure's title comes from `a.title`.
    expect(ANALYZER_SRC).toMatch(/a\.title/);
  });

  it('analyzer caps failures at 5 with "+N more" overflow', () => {
    expect(ANALYZER_SRC).toMatch(/regularFailures\.slice\(0,\s*5\)/);
    expect(ANALYZER_SRC).toContain('+');
    expect(ANALYZER_SRC).toContain('more');
  });

  it('analyzer extracts the first non-empty line of the failure message', () => {
    expect(ANALYZER_SRC).toMatch(/function\s+firstLine\b/);
  });
});

describe('B1 follow-up — Timeouts section distinguishes timeout failures from regular failures', () => {
  it("analyzer source has a '⚠ Timeouts' heading", () => {
    expect(ANALYZER_SRC).toContain('⚠ Timeouts');
  });

  it('analyzer detects timeout failures via "timed out" / "timeout" regex', () => {
    expect(ANALYZER_SRC).toMatch(/\\btimed out\|.*timeout/i);
  });

  it('analyzer routes regular vs timeout failures into separate sections', () => {
    expect(ANALYZER_SRC).toContain('regularFailures');
    expect(ANALYZER_SRC).toContain('timeoutFailures');
  });
});

describe('B1 follow-up — Run summary line', () => {
  it("analyzer emits a 'Run summary' heading", () => {
    expect(ANALYZER_SRC).toContain('### Run summary');
  });

  it('analyzer counts total tests, passed, failed, skipped', () => {
    expect(ANALYZER_SRC).toContain('totalRun');
    expect(ANALYZER_SRC).toContain('totalPassed');
    expect(ANALYZER_SRC).toContain('totalFailed');
    expect(ANALYZER_SRC).toContain('totalSkipped');
  });

  it('analyzer derives tier from report filename (vitest-<tier>-<id>.json)', () => {
    expect(ANALYZER_SRC).toMatch(/function\s+deriveTier\b/);
    expect(ANALYZER_SRC).toMatch(/vitest-\(\[a-z\]\+\)-/);
  });

  it('analyzer computes wall-clock from min(startTime), max(endTime)', () => {
    expect(ANALYZER_SRC).toContain('minStartTime');
    expect(ANALYZER_SRC).toContain('maxEndTime');
  });
});

describe('B1 follow-up — Long-tail warning at >30min wall-clock', () => {
  it("analyzer has a 'Long-tail warning' section gated by wallClockMin > 30", () => {
    expect(ANALYZER_SRC).toContain('Long-tail warning');
    expect(ANALYZER_SRC).toMatch(/wallClockMin\s*>\s*30/);
  });

  it('analyzer references the 60min spawn-managed wrapper cap', () => {
    expect(ANALYZER_SRC).toMatch(/cap\s*=\s*60/);
    // The headroom calculation uses (cap - wallClockMin).
    expect(ANALYZER_SRC).toMatch(/cap\s*-\s*wallClockMin/);
  });

  it('analyzer escalates emoji from ⚠️ to 🚨 above 50min', () => {
    expect(ANALYZER_SRC).toContain('🚨');
    expect(ANALYZER_SRC).toContain('⚠️');
    expect(ANALYZER_SRC).toMatch(/wallClockMin\s*>\s*50/);
  });
});

describe('AC10 — analyzer + this test file use NO subprocess spawns', () => {
  it('analyzer source has no spawn-family calls', () => {
    expect(ANALYZER_SRC).not.toMatch(/\b(spawnSync|spawn|execSync|exec|fork)\s*\(/);
    expect(ANALYZER_SRC).not.toContain('child_process');
  });

  // (Self-grep meta-checks are self-defeating in a test file that mentions
  // spawn-family identifiers in assertion strings. The B2 subprocess-timeout
  // meta-test enforces the no-spawn rule across all of tests/, including
  // this file, so this story doesn't need a redundant self-grep here.)
});

describe('Chunk A regression pins (must not be broken by B1)', () => {
  // A1: bump-skip CI
  it("A1: ci.yml on.push.paths-ignore still contains package.json + CHANGELOG.md + notes/research.public.**", () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('package.json');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('CHANGELOG.md');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/research.public.**');
  });

  // A2: docs/config skip
  it("A2: ci.yml on.push.paths-ignore still contains notes/backlog.** + notes/research.** + .rks/project.json", () => {
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/backlog.**');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('notes/research.**');
    expect(CI_CONFIG.on.push['paths-ignore']).toContain('.rks/project.json');
  });

  // A5: sha-guard
  it("A5: ci.yml jobs.sha-guard still exists", () => {
    expect(CI_CONFIG.jobs).toHaveProperty('sha-guard');
  });

  it("A5: unit-tests still has needs: sha-guard AND if: needs.sha-guard.outputs.skip != 'true'", () => {
    const job = CI_CONFIG.jobs['unit-tests'];
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain('sha-guard');
    expect(String(job.if || '')).toContain("needs.sha-guard.outputs.skip != 'true'");
  });
});

describe('Runner preserves original behavior shape (regression)', () => {
  it("runner still uses spawnManagedInherit from ./lib/spawn-managed.mjs", () => {
    expect(RUNNER_SRC).toContain('spawnManagedInherit');
    expect(RUNNER_SRC).toMatch(/from\s+["']\.\/lib\/spawn-managed\.mjs["']/);
  });

  it("runner still accepts --config and --timeout flags via parseArgs", () => {
    expect(RUNNER_SRC).toMatch(/config:\s*{\s*type:\s*"string"/);
    expect(RUNNER_SRC).toMatch(/timeout:\s*{\s*type:\s*"string"/);
  });

  it("runner still defaults timeoutMs to 900_000 when --timeout not passed", () => {
    expect(RUNNER_SRC).toMatch(/timeout\s*\?\s*parseInt[\s\S]+:\s*900_000/);
  });
});
