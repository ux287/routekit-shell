/**
 * Tests for the npm lifecycle wiring of scripts/sync-hooks.mjs.
 *
 * Before this story, the root package.json had only a manual `sync-hooks`
 * script. Templates could silently drift from canonical between releases.
 *
 * This story binds sync-hooks.mjs to:
 *   prepare        → sync mode
 *   postinstall    → sync mode
 *   prepublishOnly → --check mode
 *
 * Tests fall into two groups:
 * 1. Static structure: package.json declares the right entries.
 * 2. Behavioral: sync mode + --check mode behave correctly against
 *    temp-fixture repos (no global npm install required).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SPAWN_TIMEOUT = 30_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG_JSON = path.join(REPO_ROOT, 'package.json');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts/sync-hooks.mjs');
const CANONICAL_HOOKS = path.join(REPO_ROOT, 'packages/hooks');

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
}

describe('package.json lifecycle wiring', () => {
  it('declares a `prepare` script that invokes sync-hooks.mjs in sync mode', () => {
    const pkg = readPkg();
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts.prepare).toBe('node scripts/sync-hooks.mjs');
  });

  it('declares a `postinstall` script that invokes sync-hooks.mjs in sync mode', () => {
    const pkg = readPkg();
    expect(pkg.scripts.postinstall).toBe('node scripts/sync-hooks.mjs');
  });

  it('declares a `prepublishOnly` script that invokes sync-hooks.mjs in --check mode', () => {
    const pkg = readPkg();
    expect(pkg.scripts.prepublishOnly).toBe('node scripts/sync-hooks.mjs --check');
  });

  it('preserves the pre-existing `sync-hooks` script entry', () => {
    const pkg = readPkg();
    expect(pkg.scripts['sync-hooks']).toBe('node scripts/sync-hooks.mjs');
  });

  it('declares the `setup` onboarding script', () => {
    const pkg = readPkg();
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
  });
});

describe('sync-hooks.mjs behavior — against a temp fixture repo', () => {
  let tmpRepo;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hooks-lifecycle-'));
    // Build a minimal mirror of the repo so the script's hard-coded path
    // resolution works inside the temp dir.
    fs.mkdirSync(path.join(tmpRepo, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'packages', 'hooks', 'write'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'templates', 'generic', '.routekit', 'hooks'), { recursive: true });
    fs.copyFileSync(SYNC_SCRIPT, path.join(tmpRepo, 'scripts', 'sync-hooks.mjs'));
    // Plant one canonical hook to copy.
    fs.writeFileSync(
      path.join(tmpRepo, 'packages', 'hooks', 'write', 'example.mjs'),
      '#!/usr/bin/env node\n// canonical fixture hook\nconsole.log("ok");\n',
    );
  });

  afterEach(() => {
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  function runScript(args = []) {
    return spawnSync('node', ['scripts/sync-hooks.mjs', ...args], {
      cwd: tmpRepo,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
    });
  }

  it('sync mode against an empty template directory populates it byte-for-byte from canonical', () => {
    const result = runScript([]);
    expect(result.status).toBe(0);
    const copied = path.join(tmpRepo, 'templates/generic/.routekit/hooks/write/example.mjs');
    expect(fs.existsSync(copied)).toBe(true);
    const canonical = fs.readFileSync(path.join(tmpRepo, 'packages/hooks/write/example.mjs'), 'utf8');
    const dest = fs.readFileSync(copied, 'utf8');
    expect(dest).toBe(canonical);
  });

  it('--check mode passes (exit 0, no DRIFT) when template matches canonical', () => {
    // First sync to make them match.
    expect(runScript([]).status).toBe(0);
    // Now check should pass clean.
    const result = runScript(['--check']);
    expect(result.status).toBe(0);
    expect(result.stderr || '').not.toContain('DRIFT:');
  });

  it('--check mode fails (exit 1, DRIFT on stderr) when template is missing a canonical file', () => {
    // Plant the template state but skip the canonical-mirroring copy.
    // The temp fixture has canonical files but an empty template — exactly the
    // "drifted" case (canonical file present, template missing it).
    const result = runScript(['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr || '').toContain('DRIFT:');
    expect(result.stderr || '').toContain('example.mjs');
  });

  it('--check mode fails when the template has stale content vs canonical', () => {
    // Sync first.
    expect(runScript([]).status).toBe(0);
    // Mutate the template copy.
    const copied = path.join(tmpRepo, 'templates/generic/.routekit/hooks/write/example.mjs');
    fs.writeFileSync(copied, '// drifted content\n');
    const result = runScript(['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr || '').toContain('DRIFT:');
    expect(result.stderr || '').toMatch(/content differs/);
  });

  it('--check mode fails when the template has extra files not present in canonical', () => {
    // Sync first.
    expect(runScript([]).status).toBe(0);
    // Plant an extra file in the template that has no canonical counterpart.
    const extraDir = path.join(tmpRepo, 'templates/generic/.routekit/hooks/write');
    fs.writeFileSync(path.join(extraDir, 'stowaway.mjs'), '// not in canonical\n');
    const result = runScript(['--check']);
    expect(result.status).toBe(1);
    expect(result.stderr || '').toContain('DRIFT:');
    expect(result.stderr || '').toMatch(/extra in dest/);
  });
});

describe('sync-hooks.mjs end-to-end via the real repo', () => {
  // Sanity check that the actual repo's template is currently in sync. If this
  // fails on main, sync-hooks has not been run since canonical was last edited
  // — exactly the gap this story closes via lifecycle bindings.
  it('the real templates/generic/.routekit/hooks matches packages/hooks (--check passes against the live repo)', () => {
    const result = spawnSync('node', [SYNC_SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });

  it('canonical hooks directory exists at packages/hooks (sanity)', () => {
    expect(fs.existsSync(CANONICAL_HOOKS)).toBe(true);
  });
});
