/**
 * Lockfile-drift guard.
 *
 * CI installs with `npm ci`, which HARD-FAILS if package-lock.json is out of
 * sync with any workspace's package.json. That is exactly what happened when
 * @routekit/whitepaper added markdown-it/mermaid/playwright without the lockfile
 * being regenerated: CI went red with "Missing: <pkg> from lock file".
 *
 * This test catches that drift locally (fast, pure readFileSync + JSON.parse —
 * no npm, no subprocess, no network) so a missing lockfile entry fails a unit
 * test instead of the CI install step.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

const lock = readJson('package-lock.json');
const rootPkg = readJson('package.json');

const lockKeys = Object.keys(lock.packages || {});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A declared dep resolves if ANY lockfile key ends in node_modules/<name> —
 *  hoisting-tolerant: matches root-level, nested, and workspace-linked entries. */
function resolves(name) {
  const re = new RegExp(`(^|/)node_modules/${escapeRe(name)}$`);
  return lockKeys.some((k) => re.test(k));
}

/** Expand the root `workspaces` globs to concrete relative dirs that have a package.json. */
function workspaceDirs() {
  const patterns = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      const base = resolve(ROOT, prefix);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(resolve(base, entry.name, 'package.json'))) {
          dirs.push(`${prefix}/${entry.name}`);
        }
      }
    } else if (existsSync(resolve(ROOT, pattern, 'package.json'))) {
      dirs.push(pattern);
    }
  }
  return dirs.sort();
}

const workspaces = workspaceDirs();

describe('package-lock.json is a valid v3 lockfile', () => {
  it('is lockfileVersion 3 with a packages map', () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages).toBeTypeOf('object');
    expect(lockKeys.length).toBeGreaterThan(0);
  });

  it('discovers the workspaces from the root package.json globs', () => {
    expect(workspaces.length).toBeGreaterThan(0);
    expect(workspaces).toContain('packages/whitepaper');
  });
});

describe('every workspace is present in the lockfile', () => {
  // Catches a brand-new workspace that was never locked — the @routekit/whitepaper case.
  it.each([['<root>', ''], ...workspaces.map((w) => [w, w])])(
    'workspace %s has a lockfile packages entry',
    (_label, key) => {
      expect(lockKeys).toContain(key);
    }
  );
});

describe('every declared dependency is resolvable in the lockfile', () => {
  // Build the full (workspace, depName) list from dependencies + devDependencies.
  const declared = [];
  for (const ws of workspaces) {
    const pkg = readJson(`${ws}/package.json`);
    for (const field of ['dependencies', 'devDependencies']) {
      for (const name of Object.keys(pkg[field] || {})) declared.push({ ws, name });
    }
  }
  for (const field of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(rootPkg[field] || {})) declared.push({ ws: '<root>', name });
  }

  it('has at least one declared dependency to check (sanity)', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it('resolves every declared dependency (run `npm install` to sync if this fails)', () => {
    const missing = declared.filter(({ name }) => !resolves(name));
    const detail = missing.map((m) => `${m.ws} → ${m.name}`).join(', ');
    expect(
      missing,
      `package-lock.json is out of sync — missing: ${detail}. Run \`npm install\` to sync the lockfile.`
    ).toEqual([]);
  });
});

describe('positive sanity — the guard passes on today’s synced lockfile', () => {
  it('resolves the whitepaper deps that previously broke CI', () => {
    expect(resolves('markdown-it')).toBe(true);
    expect(resolves('mermaid')).toBe(true);
    expect(resolves('playwright')).toBe(true);
  });

  it('locks the @routekit/whitepaper workspace', () => {
    expect(lockKeys).toContain('packages/whitepaper');
  });
});
