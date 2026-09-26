/**
 * Test Runner — extracted from exec.mjs
 *
 * Contains test-related helpers, divergence detection, branch cleanup,
 * and rollback orchestration. Used by exec.mjs after step application.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getUncommittedFiles, runGit } from "../utils/git.mjs";
import { restoreBackup, capturePartialDiff, cleanupWorkingTree } from "../exec/backup.mjs";
import { guardrailsOn } from "./guardrails-audit.mjs";
import { planDependencyAdditions } from "./plan-quality.mjs";
// Same specifier exec.mjs uses. tests/setup.mjs mocks this barrel into TWO
// distinct objects — ensureTelemetryStorage() and getTelemetryCollector() return
// different stubs — so a test must read the one the code under test actually
// calls, or it asserts against an object nothing ever wrote to.
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { recordIntervention } from "../shared/intervention-record.mjs";
import { parseDeclaredEntry, invalidDeclaredFiles, evaluateDeclaredRed } from "../exec/test-results.mjs";

export const MAX_RETRY_ATTEMPTS = 2; // 3 total attempts (1 initial + 2 retries)

// ── Helper utilities ─────────────────────────────────────────────────

/**
 * Compute implicit parent directories from a set of expected files.
 * Used by divergence detection to avoid false positives on directory creation.
 */
export const computeImplicitDirs = (expectedFiles) => {
  const dirs = new Set();
  for (const filePath of expectedFiles) {
    let dir = path.dirname(filePath);
    while (dir && dir !== '.' && dir !== '/') {
      dirs.add(dir);
      dirs.add(dir + '/'); // Handle both with and without trailing slash
      dir = path.dirname(dir);
    }
  }
  return dirs;
};

/**
 * Check if a file path is a test file.
 *
 * Paths are repo-relative, so a root-level `tests/` directory has NO leading slash —
 * `/tests/` alone never matched `tests/unit/test_foo.py`. The pytest forms (`test_*.py`,
 * `*_test.py`, `conftest.py`) are matched on the basename so an ordinary source file that
 * merely contains "test" (`src/contest.py`, `src/latest.py`) stays a non-test.
 * (backlog.fix.exec-baseline-blocks-non-js-tdd-stories)
 */
export const isTestFile = (filePath) => {
  if (!filePath) return filePath;
  const base = path.basename(filePath);
  return filePath.includes('.test.') || filePath.includes('/tests/') || filePath.startsWith('tests/')
    || filePath.includes('.spec.') || filePath.includes('__tests__')
    || /^test_.+\.py$/.test(base) || /.+_test\.py$/.test(base) || base === 'conftest.py';
};

/**
 * Detect if a plan is for a test-fix story (targets test files or has test-fix intent).
 */
export const isTestFixStory = (plan, storyTargetFiles) => {
  const problemPath = plan?.problemPath || plan?.problemId || '';
  const titleLower = problemPath.toLowerCase();
  const hasTestIntent = titleLower.includes('fix') && (titleLower.includes('test') || titleLower.includes('spec'));

  const targetFiles = (plan?.steps || []).map(s => s.target || s.path).filter(Boolean);
  const targetsTests = targetFiles.some(isTestFile);

  // Test-INFRA bootstrap detection (backlog.fix.exec-test-gate-blocks-test-infra-bootstrap):
  // a story that INSTALLS the test framework cannot pass a baseline that fails precisely because
  // the framework isn't installed yet. Detect from the story's DECLARED frontmatter targetFiles
  // (survives a dropped create_file step — finding-8) plus an explicit id token. Kept NARROW —
  // keyed on CREATING a test config/setup file or an explicit test-setup/test-infra id, NOT merely
  // touching a test file (which an ordinary story may do, and which must still be gated).
  const declaredPaths = (Array.isArray(storyTargetFiles) ? storyTargetFiles : [])
    .map(t => (typeof t === 'string' ? t : t?.path)).filter(Boolean);
  const createsTestConfig = declaredPaths.some(p =>
    /(^|\/)(vitest|jest)\.(config|setup)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(pytest\.ini|conftest\.py)$/.test(p));
  const bootstrapIdToken = /(^|[^a-z])(test-setup|test-infra|testing-setup|test-bootstrap)([^a-z]|$)/.test(titleLower);
  const isTestInfraBootstrap = createsTestConfig || bootstrapIdToken;

  return hasTestIntent || targetsTests || isTestInfraBootstrap;
};

// ── Pre-apply baseline ───────────────────────────────────────────────

/**
 * Return only the entries of `testPaths` that exist on disk under `projectRoot`,
 * preserving input order. null / empty input → [].
 */
export function filterExistingTestPaths(projectRoot, testPaths) {
  if (!Array.isArray(testPaths) || testPaths.length === 0) return [];
  return testPaths.filter(p => typeof p === 'string' && fs.existsSync(path.join(projectRoot, p)));
}

/**
 * The PRE-apply baseline decision (backlog.fix.exec-baseline-blocks-non-js-tdd-stories).
 *
 * A story's `testFiles` legitimately lists files the story will CREATE. Before apply those
 * paths do not exist, and handing them to the runner makes it fail on a usage error (pytest
 * exits 4, "file or directory not found") that `status === 0` cannot tell from a red test.
 * So the baseline runs only against the story test files that already exist; when none do,
 * it is SKIPPED with a reason naming them — never reported as passed, never widened to the
 * full suite. `storyTestFiles` null keeps the old unscoped run.
 *
 * `runTests` is injected (exec passes runProjectTests) so this never spawns a process in tests.
 *
 * A failing baseline is RETURNED as a refusal, not thrown: a throw reaches the tool handler as
 * `exec.error` (chain → planned, no payload), while an `ok: false` return records `exec.failed`.
 * `stage: "pre_apply_baseline"` tells the Build Governor the failure predates apply, so refining
 * the story cannot fix it. `testsFailedLog` is reported only once the file is observed on disk.
 *
 * A non-empty `baselineRedTests` (backlog.feat.exec-declared-red-baseline-tests) replaces the
 * pass/fail decision with the declared-red proof in runDeclaredRedBaseline below. Absent or
 * empty, this function — including its single runTests call — is exactly what it was.
 *
 * @returns {{ proceed: true, baselineSkipped: boolean, baselineSkipReason: string|null,
 *             baselineAbsentPaths: string[], baselineTestPaths: string[]|null, baselineRed?: object }
 *          | { proceed: false, refusal: object }}
 */
export function runPreApplyBaseline({ projectRoot, storyTestFiles, runDir, runTests, baselineRedTests }) {
  const declared = Array.isArray(baselineRedTests)
    ? baselineRedTests.filter(e => typeof e === 'string' && e.trim() !== '')
    : [];
  if (declared.length > 0) {
    return runDeclaredRedBaseline({ projectRoot, storyTestFiles, runDir, runTests, entries: declared });
  }

  let testPaths = null;
  let baselineAbsentPaths = [];
  if (Array.isArray(storyTestFiles) && storyTestFiles.length > 0) {
    testPaths = filterExistingTestPaths(projectRoot, storyTestFiles);
    baselineAbsentPaths = storyTestFiles.filter(p => !testPaths.includes(p));
    if (testPaths.length === 0) {
      return {
        proceed: true,
        baselineSkipped: true,
        baselineSkipReason: `story_test_files_absent: ${baselineAbsentPaths.join(', ')}`,
        baselineAbsentPaths,
        baselineTestPaths: [],
      };
    }
  }

  const baseline = runTests(projectRoot, { testPaths });

  if (baseline?.skipped) {
    return {
      proceed: true,
      baselineSkipped: true,
      baselineSkipReason: `runner_skipped: ${baseline.reason || 'no reason given'}`,
      baselineAbsentPaths,
      baselineTestPaths: testPaths,
    };
  }
  if (baseline?.passed) {
    return {
      proceed: true,
      baselineSkipped: false,
      baselineSkipReason: null,
      baselineAbsentPaths,
      baselineTestPaths: testPaths,
    };
  }

  return {
    proceed: false,
    refusal: baselineRefusal({
      reason: 'baseline_failed', baseline, runDir, testPaths, baselineAbsentPaths,
      hint: 'Tests were failing BEFORE any change was applied (pre-apply baseline): nothing was applied and no branch was created. '
        + 'Refining this story cannot fix a failure that predates it — repair the red tests first',
    }),
  };
}

/**
 * The returned (never thrown) pre-apply refusal. `reason` names which rule refused, so exec
 * reports it instead of a fixed literal. `testsFailedLog` is reported only once it exists.
 */
function baselineRefusal({ reason, baseline, runDir, testPaths, baselineAbsentPaths, hint, extra = {} }) {
  let testsFailedLog = null;
  if (runDir && baseline) {
    const logPath = path.join(runDir, 'baseline-tests-failed.log');
    try {
      fs.writeFileSync(logPath, `${baseline?.summary || ''}\n${baseline?.output || ''}`);
      if (fs.existsSync(logPath)) testsFailedLog = logPath;
    } catch { /* unwritable runDir — report null, never a path to a missing file */ }
  }

  return {
    ok: false,
    testsFailed: true,
    reason,
    stage: 'pre_apply_baseline',
    applied: false,
    rolledBack: false,
    partialDiffPath: null,
    refinementSuggestions: [],
    attempts: 0,
    testPaths,
    exitCode: baseline?.exitCode ?? null,
    summary: baseline?.summary || null,
    testsFailedLog,
    baselineSkipped: false,
    baselineSkipReason: null,
    baselineAbsentPaths,
    baselineTestPaths: testPaths,
    ...extra,
    hint: hint + (testsFailedLog ? `; see ${testsFailedLog}.` : '.'),
  };
}

/**
 * The declared-red proof (backlog.feat.exec-declared-red-baseline-tests).
 *
 * 1. Validate: every entry's file is in testFiles and on disk.
 * 2. Observe: one collecting run over the existing testFiles. A per-test entry with unavailable
 *    results refuses `baseline_red_results_unavailable` — it NEVER degrades to file-level.
 * 3-5. evaluateDeclaredRed: subset, existence, stale.
 *
 * An all-file-level declaration is checked in two runs instead — the remaining testFiles, then the
 * declared files — so that when the runner has no adapter the exit codes alone still prove it:
 * the remaining files must pass and the declared files must not (else stale).
 */
function runDeclaredRedBaseline({ projectRoot, storyTestFiles, runDir, runTests, entries }) {
  const testFiles = Array.isArray(storyTestFiles) ? storyTestFiles : [];
  const existing = filterExistingTestPaths(projectRoot, testFiles);
  const baselineAbsentPaths = testFiles.filter(p => !existing.includes(p));
  const parsed = entries.map(e => parseDeclaredEntry(e));
  const hasPerTest = parsed.some(p => p.testId);
  const collect = (name) => ({ reportDir: runDir || undefined, reportName: name });

  const record = (fields) => ({
    declared: entries,
    granularity: null,
    runner: null,
    resultsSource: null,
    observedFailing: [],
    stale: [],
    ...fields,
  });
  const refuse = (reason, { baseline = null, testPaths = existing, hint, extra = {}, baselineRed }) => ({
    proceed: false,
    refusal: baselineRefusal({
      reason, baseline, runDir, testPaths, baselineAbsentPaths,
      hint: `Pre-apply baseline refused (${reason}): nothing was applied and no branch was created. ${hint}`,
      extra: { ...extra, baselineRed: baselineRed || record({}) },
    }),
  });
  const proceed = (testPaths, baselineRed) => ({
    proceed: true,
    baselineSkipped: false,
    baselineSkipReason: null,
    baselineAbsentPaths,
    baselineTestPaths: testPaths,
    baselineRed,
  });
  const fromEvaluation = (ev, results, baseline, testPaths) => {
    const baselineRed = record({
      granularity: 'test',
      runner: results.runner || null,
      resultsSource: results.source || null,
      observedFailing: ev.observedFailing || [],
      stale: ev.stale || [],
    });
    if (ev.ok) return proceed(testPaths, baselineRed);
    const extra = {};
    if (ev.undeclaredFailing) extra.undeclaredFailing = ev.undeclaredFailing;
    if (ev.invalidDeclarations) extra.invalidDeclarations = ev.invalidDeclarations;
    const hint = ev.reason === 'baseline_failed'
      ? `Tests were failing BEFORE any change was applied that baselineRedTests does not declare: ${ev.undeclaredFailing.join(', ')}. Repair them or declare them`
      : `Invalid baselineRedTests entries: ${(ev.invalidDeclarations || []).map(d => `${d.entry} (${d.why}${d.cause ? `: ${d.cause}` : ''}${d.outcome ? `: ${d.outcome}` : ''})`).join(', ')}`;
    return refuse(ev.reason, { baseline, testPaths, hint, extra, baselineRed });
  };

  const fileInvalid = invalidDeclaredFiles({ entries, testFiles, existingTestFiles: existing });
  if (fileInvalid.length > 0) {
    return refuse('baseline_red_declaration_invalid', {
      hint: `Invalid baselineRedTests entries: ${fileInvalid.map(d => `${d.entry} (${d.why})`).join(', ')}`,
      extra: { invalidDeclarations: fileInvalid },
    });
  }

  const unavailable = (baseline, results) => refuse('baseline_red_results_unavailable', {
    baseline,
    hint: 'Per-test results could not be observed, so the declared-red tests cannot be proven red'
      + (results?.reason ? ` (${results.reason})` : ''),
    extra: { runner: results?.runner ?? null, resultsUnavailableReason: results?.reason ?? null },
    baselineRed: record({ runner: results?.runner ?? null }),
  });
  const skippedResults = (baseline) => ({ available: false, runner: null, reason: `runner_skipped: ${baseline.reason || 'no reason given'}` });

  if (hasPerTest) {
    const baseline = runTests(projectRoot, { testPaths: existing, collectTestResults: collect('baseline-test-results.json') });
    if (baseline?.skipped) return unavailable(baseline, skippedResults(baseline));
    const results = baseline?.testResults;
    if (!results?.available) return unavailable(baseline, results);
    return fromEvaluation(
      evaluateDeclaredRed({ entries, testFiles, existingTestFiles: existing, results }),
      results, baseline, existing,
    );
  }

  // All file-level: the remaining existing testFiles, then the declared files.
  const declaredFiles = [...new Set(parsed.map(p => p.file))];
  const remaining = existing.filter(p => !declaredFiles.includes(p));
  const remainingRun = remaining.length > 0
    ? runTests(projectRoot, { testPaths: remaining, collectTestResults: collect('baseline-test-results-remaining.json') })
    : null;
  const declaredRun = runTests(projectRoot, { testPaths: declaredFiles, collectTestResults: collect('baseline-test-results.json') });
  for (const run of [remainingRun, declaredRun]) {
    if (run?.skipped) return unavailable(run, skippedResults(run));
  }

  const runs = [remainingRun, declaredRun].filter(Boolean);
  if (runs.every(r => r?.testResults?.available)) {
    const results = mergeResults(runs.map(r => r.testResults));
    return fromEvaluation(
      evaluateDeclaredRed({ entries, testFiles, existingTestFiles: existing, results }),
      results, remainingRun && !remainingRun.passed ? remainingRun : declaredRun, existing,
    );
  }

  // Results unavailable (no adapter for this runner): exit codes only, granularity "file".
  const runner = declaredRun?.testResults?.runner ?? null;
  const fileRecord = (stale) => record({ granularity: 'file', runner, resultsSource: 'exit_code', observedFailing: [], stale });
  if (remainingRun && !remainingRun.passed) {
    return refuse('baseline_failed', {
      baseline: remainingRun,
      testPaths: remaining,
      hint: `Test files NOT declared in baselineRedTests were failing BEFORE any change was applied: ${remaining.join(', ')}. Repair them or declare them`,
      extra: { undeclaredFailing: remaining },
      baselineRed: fileRecord([]),
    });
  }
  return proceed(existing, fileRecord(declaredRun?.passed ? declaredFiles : []));
}

/** Concatenate the per-test results of several runs into one observed set. */
function mergeResults(list) {
  const cat = (k) => [...new Set(list.flatMap(r => r[k] || []))];
  return {
    available: true,
    runner: list[0]?.runner || null,
    source: list[0]?.source || null,
    passed: cat('passed'),
    failed: cat('failed'),
    error: cat('error'),
    failing: [...new Set([...cat('failing'), ...cat('failed'), ...cat('error')])],
    xfailed: cat('xfailed'),
    xpassed: cat('xpassed'),
    skipped: cat('skipped'),
    skippedCount: list.reduce((n, r) => n + (r.skippedCount || 0), 0),
    deselectedCount: list.reduce((n, r) => n + (r.deselectedCount || 0), 0),
  };
}

/**
 * Parse pass/fail counts from test runner output (vitest/jest summary lines).
 */
export const parseTestCount = (output, type) => {
  if (!output) return 0;
  const testsLine = output.match(/^\s*Tests\s+(.+)/im);
  if (!testsLine) return 0;
  const countMatch = testsLine[1].match(new RegExp(`(\\d+)\\s+${type}`, 'i'));
  return countMatch ? parseInt(countMatch[1], 10) : 0;
};

// ── Hash-based test file integrity ───────────────────────────────────

/**
 * Hash all test files in the project to detect unauthorized modifications.
 * @param {string} projectRoot
 * @param {string[]} testDirs - directories to scan for test files
 * @returns {Map<string, string>} Map of relative file path → SHA256 hex digest
 */
export function hashTestFiles(projectRoot, testDirs = ['tests', '__tests__']) {
  const hashes = new Map();
  for (const dir of testDirs) {
    const absDir = path.join(projectRoot, dir);
    if (!fs.existsSync(absDir)) continue;
    const files = walkDir(absDir).filter(f => f.match(/\.(test|spec)\.(mjs|js|ts|tsx)$/));
    for (const file of files) {
      const rel = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf8');
      const hash = createHash('sha256').update(content).digest('hex');
      hashes.set(rel, hash);
    }
  }
  return hashes;
}

/**
 * Walk a directory recursively, returning all file paths.
 */
function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Verify test file integrity by comparing current hashes against originals.
 * @param {string} projectRoot
 * @param {Map<string, string>} originalHashes - from hashTestFiles()
 * @returns {{ pass: boolean, changed: Array<{file: string, original: string, current: string}> }}
 */
export function verifyTestFileIntegrity(projectRoot, originalHashes) {
  const changed = [];
  for (const [relPath, originalHash] of originalHashes) {
    const absPath = path.join(projectRoot, relPath);
    if (!fs.existsSync(absPath)) {
      changed.push({ file: relPath, original: originalHash, current: 'DELETED' });
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    const currentHash = createHash('sha256').update(content).digest('hex');
    if (currentHash !== originalHash) {
      changed.push({ file: relPath, original: originalHash, current: currentHash });
    }
  }
  return { pass: changed.length === 0, changed };
}

// ── Branch cleanup ───────────────────────────────────────────────────

/**
 * Clean up a feature branch after rollback.
 * Safely checks out baseBranch, removes worktree if present, and deletes the branch.
 * Never throws — returns a structured result with per-step status.
 *
 * @param {string} projectRoot
 * @param {string|null} branchName - the feature branch to delete (no-op if null)
 * @param {string} baseBranch - the branch to checkout before deletion
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, checkoutOk?: boolean, worktreeRemoveOk?: boolean, branchDeleteOk?: boolean, errors?: string[] }}
 */
export const cleanupFeatureBranch = (projectRoot, branchName, baseBranch) => {
  if (!branchName) {
    return { ok: true, skipped: true, reason: 'branchName is null or undefined' };
  }
  if (branchName === baseBranch) {
    return { ok: true, skipped: true, reason: 'branchName equals baseBranch' };
  }

  let checkoutOk = true;
  let worktreeRemoveOk = true;
  let branchDeleteOk = true;
  const errors = [];

  // Step 1: Checkout baseBranch
  try {
    runGit(projectRoot, ['checkout', baseBranch]);
  } catch (e) {
    checkoutOk = false;
    const msg = `Failed to checkout ${baseBranch}: ${e.message}`;
    console.warn(`[cleanupFeatureBranch] ${msg}`);
    errors.push(msg);
  }

  // Step 2: Remove worktree if it exists
  try {
    const worktreePath = path.join(projectRoot, '.git', 'worktrees', branchName);
    if (fs.existsSync(worktreePath)) {
      runGit(projectRoot, ['worktree', 'remove', branchName]);
    }
  } catch (e) {
    worktreeRemoveOk = false;
    const msg = `Failed to remove worktree for ${branchName}: ${e.message}`;
    console.warn(`[cleanupFeatureBranch] ${msg}`);
    errors.push(msg);
  }

  // Step 3: Delete branch with git branch -D
  try {
    runGit(projectRoot, ['branch', '-D', branchName]);
  } catch (e) {
    branchDeleteOk = false;
    const msg = `Failed to delete branch ${branchName}: ${e.message}`;
    console.warn(`[cleanupFeatureBranch] ${msg}`);
    errors.push(msg);
  }

  return {
    ok: true,
    branchName,
    baseBranch,
    checkoutOk,
    worktreeRemoveOk,
    branchDeleteOk,
    errors: errors.length > 0 ? errors : undefined,
  };
};

// ── Per-step divergence detection ────────────────────────────────────

/**
 * Detect when a single step modifies unexpected files (mid-loop detection).
 * Returns divergence report if unexpected files were touched.
 *
 * @param {string} projectRoot
 * @param {Set<string>} expectedFiles - files the plan is allowed to modify
 * @param {Set<string>} preCommandGeneratedFiles - files generated by preCommands (allowed)
 * @returns {{ diverged: boolean, unexpectedFiles?: string[], missingFiles?: string[], actualFiles?: string[], expectedFiles?: string[] }}
 */
/**
 * backlog.fix.dependency-add-contract-executable: the files an `npm install` writes.
 *
 * `node_modules/` is not here on purpose — the guards read `git status --porcelain`, and node_modules
 * is gitignored, so it never appears. What DOES appear is the manifest and the lockfile.
 */
export const DEPENDENCY_MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

/**
 * backlog.fix.dependency-add-contract-executable: THE scope rule. One implementation, both guards.
 *
 * THE BUG IT FIXES: the planner is grounded on package.json and is explicitly told — in its own
 * prompt — that if it genuinely needs an undeclared package it should "emit an explicit dependency-add
 * step (an npm install run_command, or a package.json edit) in the same plan". The quality gate
 * recognises such a step and lets the import through.
 *
 * And then exec rolls the plan back for it. Both scope guards build their expected-file set from
 * `step.target || step.path`, and a `run_command` step has NEITHER — so the package.json and
 * package-lock.json that the install writes land in `unexpectedFiles`. The escape hatch was legal to
 * plan and fatal to execute: a planner that obeyed its instructions got punished for it.
 *
 * WHY IT KEYS ON THE PLAN STEP, NEVER THE FILENAME: a blanket "package.json is always fine" pass
 * would let ANY plan silently rewrite the manifest and be waved through — a hole in a guard whose
 * entire job is to catch exactly that. The exemption is granted because the plan SAYS it is adding a
 * dependency, and only then.
 *
 * WHY IT IS ONE FUNCTION: there were already three copies of this set-difference (the final guard in
 * exec, this one, and a local re-implementation in a test) — and two of them disagreed: the per-step
 * caller passed two arguments to a three-parameter function, so it silently never exempted
 * `preCommandGeneratedFiles` while the final guard did. A fourth copy was not the answer.
 */
export function computeUnexpectedFiles({
  steps = [],
  modifiedFiles = [],
  expectedFiles = new Set(),
  preCommandGeneratedFiles = new Set(),
  scopeExemptions = new Set(),
}) {
  const implicitDirs = computeImplicitDirs(expectedFiles);
  const planAddsDependency = planDependencyAdditions({ steps }).size > 0;

  return modifiedFiles.filter((f) => {
    if (expectedFiles.has(f)) return false;
    // Paths exec is entitled to see dirty: the problem-id-scoped story note and
    // its child notes, plus everything that was ALREADY dirty when exec captured
    // its baseline. This is an explicit set of PATHS, never a `notes/` prefix
    // pass — a blanket prefix would let a governed exec silently rewrite any
    // note in the repo while this guard stayed quiet.
    //
    // The baseline half is required, not belt-and-braces: exec's pre-flight gate
    // deliberately ADMITS unrelated dirty notes (multi-story epic work leaves
    // sibling notes dirty on staging), so once the backup stash stops sweeping
    // notes away, those notes reach this guard and would roll back every exec
    // running inside an epic.
    if (scopeExemptions.has(f)) return false;
    if (f.startsWith('.rks/')) return false;
    if (f.startsWith('.routekit/')) return false;
    // Files generated by preCommands (e.g. a lockfile from a preCommand npm install).
    if (preCommandGeneratedFiles.has(f)) return false;
    // The manifest writes a PLAN-DECLARED dependency-add produces. Only when the plan actually
    // declares one.
    if (planAddsDependency && DEPENDENCY_MANIFEST_FILES.has(f)) return false;
    if (implicitDirs.has(f) || implicitDirs.has(f.replace(/\/$/, ''))) return false;
    return true;
  });
}

/**
 * `scopeExemptions` is a FIFTH OPTIONAL POSITIONAL parameter on purpose.
 *
 * This function has existing callers that pass all four arguments positionally
 * (see tests/integration/exec-dependency-add-scope.test.mjs). Refactoring the
 * signature to an options object would silently bind `projectRoot` into the
 * destructured position and break them — so the exemption is appended instead.
 *
 * It MUST be threaded here as well as into the final guard in exec. This is the
 * per-step guard, and it builds its own `modifiedFiles` from the working tree,
 * so it sees the dirty story note on every step. Exempting only the final guard
 * leaves this one returning `diverged: true`, and exec bails on `exec.diverged`
 * BEFORE the final guard ever runs — the identical defect the comment in
 * exec.mjs records having already happened once for preCommandGeneratedFiles.
 */
export const detectPerStepDivergence = (
  projectRoot,
  expectedFiles,
  preCommandGeneratedFiles = new Set(),
  steps = [],
  scopeExemptions = new Set(),
) => {
  const modifiedFiles = getUncommittedFiles(projectRoot);
  const unexpectedFiles = computeUnexpectedFiles({
    steps,
    modifiedFiles,
    expectedFiles,
    preCommandGeneratedFiles,
    scopeExemptions,
  });

  if (unexpectedFiles.length > 0) {
    const actuallyModified = new Set(modifiedFiles);
    const missingFiles = Array.from(expectedFiles).filter(f => !actuallyModified.has(f));

    return {
      diverged: true,
      unexpectedFiles,
      missingFiles,
      actualFiles: modifiedFiles,
      expectedFiles: Array.from(expectedFiles),
    };
  }

  return { diverged: false };
};

// ── Rollback orchestration ───────────────────────────────────────────

/**
 * Consolidated rollback — captures partial diff, restores backup, cleans working tree,
 * removes feature branch, and re-enables guardrails. Used by all failure paths in exec.
 *
 * @param {string} projectRoot
 * @param {string} runDir - run directory for diagnostics
 * @param {string|null} branchName - feature branch to clean up
 * @param {string} baseBranch - branch to restore to
 * @param {object|null} backupMeta - backup metadata from createBackup()
 * @param {object|null} guardrailsSession - guardrails session to restore
 * @param {string} projectId - for guardrails restoration
 * @param {string} reason - rollback reason for logging
 * @returns {{ partialDiffPath: string|null, restored: boolean, cleaned: boolean, branchCleaned: boolean, guardrailsRestored: boolean }}
 */
export async function rollback(projectRoot, { runDir, branchName, baseBranch, backupMeta, guardrailsSession, projectId, reason = 'unspecified' } = {}) {
  const result = {
    reason,
    partialDiffPath: null,
    restored: false,
    cleaned: false,
    branchCleaned: false,
    guardrailsRestored: false,
  };

  // Step 1: Capture partial diff
  if (runDir) {
    const diffResult = capturePartialDiff(projectRoot, runDir);
    if (diffResult.captured) {
      result.partialDiffPath = diffResult.diffPath;
      console.error(`[rks.exec] Partial diff saved: ${diffResult.diffPath}`);
    }
  }

  // Step 2: Restore original branch
  if (branchName && baseBranch) {
    try {
      runGit(projectRoot, ['checkout', baseBranch]);
      console.error(`[rks.exec] Restored to ${baseBranch} after ${reason}`);
    } catch (e) {
      console.warn(`[rks.exec] Failed to restore branch ${baseBranch}: ${e.message}`);
    }
  }

  // Step 3: Restore from backup
  if (backupMeta) {
    try {
      const backupResult = restoreBackup(projectRoot, backupMeta);
      result.restored = backupResult.restored || false;
      if (result.restored) {
        console.error(`[rks.exec] Rollback successful: ${backupResult.msg || 'done'}`);
      } else {
        // Carried onto the result, not just stderr. restoreBackup populates
        // `error`, but this function used to discard it — so a rollback that
        // failed to give the user their work back was indistinguishable from
        // one that succeeded, to every caller.
        result.restoreError = backupResult.error || 'restore reported failure without an error';
        console.error(`[rks.exec] Rollback failed: ${result.restoreError}`);
      }
    } catch (e) {
      result.restoreError = e?.message || String(e);
      console.error(`[rks.exec] Restore backup error: ${result.restoreError}`);
    }
  }

  // Step 4: Preserve story notes before cleanup
  const notesDir = path.join(projectRoot, 'notes');
  let preservedNotes = [];
  if (fs.existsSync(notesDir)) {
    try {
      const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
      // Notes are preserved by cleanupWorkingTree's :!notes pathspec
      preservedNotes = noteFiles;
    } catch { /* best-effort */ }
  }

  // Step 5: Clean working tree
  const cleanup = cleanupWorkingTree(projectRoot);
  result.cleaned = cleanup.cleaned || false;
  if (cleanup.cleaned) console.error(`[rks.exec] Working tree cleaned (${cleanup.method})`);
  else console.warn(`[rks.exec] Working tree cleanup failed: ${cleanup.error}`);

  // Step 6: Remove feature branch
  if (branchName && baseBranch) {
    const branchResult = cleanupFeatureBranch(projectRoot, branchName, baseBranch);
    result.branchCleaned = branchResult.ok && !branchResult.skipped;
  }

  // Step 7: Re-enable guardrails
  if (guardrailsSession?.ok) {
    try {
      // OBSERVED, not "did not throw". This was set to true immediately after
      // the await, so it recorded that the call did not raise — never that it
      // succeeded — while every sibling field is sourced from a real outcome.
      const restore = await guardrailsOn(projectRoot, { skipAutoShip: true }, projectId);
      result.guardrailsRestored = restore?.ok === true;
      if (restore && restore.ok !== true) {
        result.guardrailsRestoreError =
          restore.error || restore.message || 'guardrailsOn returned a non-ok result';
      }
    } catch (e) {
      console.warn(`[rks.exec] guardrailsOn failed on ${reason} path: ${e.message}`);
    }
  }

  // A rolled-back exec used to emit NOTHING. Field evidence: a child project
  // recorded exec.start x5 and exec.complete x2 with no terminal event of any
  // kind — the three runs that rolled back were invisible, and the incident had
  // to be reconstructed by hand from `git stash list`. The only exec.failed
  // emissions live on early-return paths that never reach this function.
  //
  // `reason` is passed through VERBATIM. One call site builds it dynamically as
  // `exec_threw: <message>`, so a closed enum or switch here would silently drop
  // every thrown-error rollback — the exact class of hole this emit closes.
  try {
    const collector = ensureTelemetryStorage(projectRoot);
    collector.emit('exec.rollback', projectId, {
      reason,
      restored: result.restored,
      cleaned: result.cleaned,
      branchCleaned: result.branchCleaned,
      guardrailsRestored: result.guardrailsRestored,
      partialDiffPath: result.partialDiffPath,
      ...(result.restoreError ? { restoreError: result.restoreError } : {}),
      branchName: branchName || null,
    });
    // Rollback is a terminal path: an unflushed buffer is lost exactly when the
    // process goes away, which would reproduce the invisibility being fixed.
    await collector.flush?.();
  } catch (e) {
    console.warn(`[rks.exec] rollback telemetry failed (non-fatal): ${e?.message}`);
  }

  // THE RECEIPT. The telemetry emit above can be lost: the collector buffers
  // until storage binds and flushes on an unref'd timer, and this is a terminal
  // path. The receipt is written synchronously, and — more importantly — it is
  // RETURNED, so the caller puts it in the response the operator is already
  // reading. Every value is taken from `result`, observed above, never restated.
  result.intervention = recordIntervention(projectRoot, {
    kind: 'tree_restore',
    cause: reason,
    restored: result.restored,
    cleaned: result.cleaned,
    branchCleaned: result.branchCleaned,
    guardrailsRestored: result.guardrailsRestored,
    partialDiffPath: result.partialDiffPath,
    restoreError: result.restoreError ?? null,
    branchName: branchName || null,
  });

  return result;
}
