/**
 * tests/_helpers/with-temp-dir.mjs
 *
 * Shared scratch-directory helper that wraps mkdtempSync + try/finally cleanup
 * so callers cannot forget to remove their temp dir. Introduced by Tier 2
 * (backlog.feat.test-suite-tier-2-unit-tier-bloat-audit) to fix the
 * tests/.tmp/ accumulation problem identified in the audit paper §3.
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
 * `parent` option to root the scratch dir elsewhere — most commonly
 * `tests/.tmp/` so leftover artifacts from a crashed run are visible to the
 * global afterAll sweep in tests/setup.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 * run has finished. Sweeps tests/.tmp/ so leftover scratch dirs from
 * non-withTempDir call sites do not accumulate across sessions (audit paper
 * §3 identified 1.9 GB of leftover fixtures).
 *
 * Wire-up: vitest.config.unit.mjs / vitest.config.mock.mjs set
 *   test: { globalTeardown: 'tests/_helpers/with-temp-dir.mjs' }
 *
 * IMPORTANT: this cannot live in tests/setup.mjs because setupFiles run
 * inside each fork; their afterAll hooks race against parallel forks and
 * unlink directories another fork is still using.
 */
export default async function globalTeardown() {
  const repoRoot = process.cwd();
  const tmpDir = path.join(repoRoot, 'tests', '.tmp');
  if (!fs.existsSync(tmpDir)) return;
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
