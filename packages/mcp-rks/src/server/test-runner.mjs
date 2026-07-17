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
 */
export const isTestFile = (filePath) => {
  return filePath && (filePath.includes('.test.') || filePath.includes('/tests/') || filePath.includes('.spec.') || filePath.includes('__tests__'));
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
  const createsTestConfig = declaredPaths.some(p => /(^|\/)(vitest|jest)\.(config|setup)\.[cm]?[jt]sx?$/.test(p));
  const bootstrapIdToken = /(^|[^a-z])(test-setup|test-infra|testing-setup|test-bootstrap)([^a-z]|$)/.test(titleLower);
  const isTestInfraBootstrap = createsTestConfig || bootstrapIdToken;

  return hasTestIntent || targetsTests || isTestInfraBootstrap;
};

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
const DEPENDENCY_MANIFEST_FILES = new Set([
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
}) {
  const implicitDirs = computeImplicitDirs(expectedFiles);
  const planAddsDependency = planDependencyAdditions({ steps }).size > 0;

  return modifiedFiles.filter((f) => {
    if (expectedFiles.has(f)) return false;
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

export const detectPerStepDivergence = (
  projectRoot,
  expectedFiles,
  preCommandGeneratedFiles = new Set(),
  steps = [],
) => {
  const modifiedFiles = getUncommittedFiles(projectRoot);
  const unexpectedFiles = computeUnexpectedFiles({
    steps,
    modifiedFiles,
    expectedFiles,
    preCommandGeneratedFiles,
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
        console.error(`[rks.exec] Rollback failed: ${backupResult.error}`);
      }
    } catch (e) {
      console.error(`[rks.exec] Restore backup error: ${e.message}`);
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
      await guardrailsOn(projectRoot, { skipAutoShip: true }, projectId);
      result.guardrailsRestored = true;
    } catch (e) {
      console.warn(`[rks.exec] guardrailsOn failed on ${reason} path: ${e.message}`);
    }
  }

  return result;
}
