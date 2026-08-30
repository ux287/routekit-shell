/**
 * tests/_helpers/with-temp-dir.mjs
 *
 * Shared scratch-directory helper that wraps mkdtempSync + try/finally cleanup
 * so callers cannot forget to remove their temp dir. Introduced by Tier 2
 * (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit) to fix the scratch-dir
 * accumulation problem identified in the audit paper §3.
 *
 * Usage:
 *   import { withTempDir } from '../_helpers/with-temp-dir.mjs';
 *
 *   await withTempDir('my-test-', async (dir) => {
 *     // ... test body using dir ...
 *   });
 *
 * The helper handles both sync and async callbacks via Promise.resolve(fn(dir)).
 * The directory is removed in `finally`, so cleanup happens even if the
 * callback throws.
 *
 * By default the helper uses os.tmpdir() (process-level temp). Pass an explicit
 * `parent` option to root the scratch dir elsewhere — most commonly SWEEP_BASE,
 * so leftover artifacts from a crashed run are reclaimed by the globalTeardown
 * sweep at the bottom of this file.
 *
 * backlog.fix.test-fixture-repo-containment: `parent` must NEVER be a path inside
 * the repository working tree. Git resolves a repository by walking UP from cwd,
 * so a fixture placed in-tree whose `git init` failed silently becomes a handle on
 * the developer's own repo — which is how a test suite hard-reset this repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The single shared fixture base. Imported, never re-derived — see globalTeardown below.
import { TEMP_BASE } from '../helpers/tmp.mjs';

/**
 * The directory globalTeardown sweeps. Exported so a test can assert this side and
 * makeTempDir's side are the SAME VALUE by identity, rather than comparing two string
 * literals that happen to match today.
 */
export const SWEEP_BASE = TEMP_BASE;

/**
 * Create a temp directory, invoke fn(dir), then remove the directory.
 * Returns whatever fn returns.
 *
 * @param {string} prefix - mkdtemp prefix (e.g. 'my-test-')
 * @param {(dir: string) => any | Promise<any>} fn - callback receiving the temp dir path
 * @param {{ parent?: string }} [opts] - parent directory; defaults to os.tmpdir()
 * @returns {Promise<any>} the resolved value of fn(dir)
 */
export async function withTempDir(prefix, fn, opts = {}) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('withTempDir: prefix must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withTempDir: fn must be a function');
  }
  const parent = opts.parent || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  try {
    return await Promise.resolve(fn(dir));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; do not mask the original error from fn.
    }
  }
}

/**
 * Synchronous variant. Use when the callback is purely synchronous and you
 * need to avoid promise overhead. Most call sites should prefer withTempDir.
 */
export function withTempDirSync(prefix, fn, opts = {}) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('withTempDirSync: prefix must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withTempDirSync: fn must be a function');
  }
  const parent = opts.parent || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  try {
    return fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Create a temp directory and return { dir, cleanup }. Use when the
 * test framework's lifecycle (afterEach / afterAll) needs to hold the cleanup
 * handle rather than scoping it to a single callback.
 */
export function makeTempDirWithCleanup(prefix, opts = {}) {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('makeTempDirWithCleanup: prefix must be a non-empty string');
  }
  const parent = opts.parent || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    },
  };
}

/**
 * Vitest globalTeardown — invoked ONCE after every fork in the active vitest
 * run has finished. Sweeps the shared fixture base so leftover scratch dirs
 * from non-withTempDir call sites do not accumulate across sessions (audit
 * paper §3 identified 1.9 GB of leftover fixtures).
 *
 * Wire-up: vitest.config.unit.mjs sets
 *   test: { globalTeardown: 'tests/_helpers/with-temp-dir.mjs' }
 *
 * backlog.fix.test-fixture-repo-containment: that wire-up is ONE tier, not two.
 * This comment previously claimed unit + mock; only vitest.config.unit.mjs
 * declares globalTeardown, so mock-tier fixtures are already unswept. Adding it
 * to the mock / e2e / fallback configs is deliberately NOT done here — three
 * byte-compare config fixtures pin those files.
 *
 * IMPORTANT: this cannot live in tests/setup.mjs because setupFiles run
 * inside each fork; their afterAll hooks race against parallel forks and
 * unlink directories another fork is still using.
 */
export default async function globalTeardown() {
  // backlog.fix.test-fixture-repo-containment: IMPORTED, never re-derived.
  //
  // This sweep reads the base's entries and rmSync's each one recursively. It is therefore only
  // ever as safe as the value it is pointed at — aimed at `os.tmpdir()` it would delete the
  // entire system temp directory, including live fixtures of parallel forks. Importing the one
  // exported constant makes it impossible for this path and makeTempDir's to drift apart; a
  // re-derived string literal here would agree only by coincidence.
  const tmpDir = SWEEP_BASE;
  if (!fs.existsSync(tmpDir)) return;
  // Refuse to sweep the system temp root itself, whatever the constant says. realpath both sides:
  // on macOS TMPDIR resolves through /var -> /private/var, so a raw string compare would miss.
  if (fs.realpathSync(tmpDir) === fs.realpathSync(os.tmpdir())) {
    throw new Error(
      `globalTeardown refused: sweep base resolves to the system temp root (${tmpDir}). ` +
        `It must be a dedicated subdirectory.`,
    );
  }
  let entries;
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(tmpDir, entry);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; do not throw out of globalTeardown.
    }
  }
}
