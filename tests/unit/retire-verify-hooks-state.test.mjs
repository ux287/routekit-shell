import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = 'verify-' + 'hooks-state';
const FILE = NAME + '.mjs';
const COPIES = [
  'packages/hooks/system/' + FILE,
  '.routekit/hooks/system/' + FILE,
  '.routekit/hooks.bak/system/' + FILE,
  'templates/generic/.routekit/hooks/system/' + FILE,
];
const OLD_TEST = 'tests/unit/hooks-state-' + 'preflight.spec.mjs';
const offRail = fs.existsSync(path.join(REPO_ROOT, '.routekit', 'hooks.bak'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.tmp') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js|ts)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('retire the flat-layout hooks-state preflight', () => {
  it('no copy of the hook exists (canonical, deployed, hooks.bak, template)', () => {
    for (const rel of COPIES) expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(false);
  });

  it('the manifest parses and has no entry for the hook', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8');
    const m = JSON.parse(raw);
    expect(Object.keys(m)).not.toContain(NAME);
    expect(Object.values(m).map((e) => e.path)).not.toContain('system/' + FILE);
    expect(raw).not.toContain(NAME);
    expect(Object.keys(m).length).toBeGreaterThan(0);
  });

  it('the old non-exercising spec is gone', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, OLD_TEST))).toBe(false);
  });

  it('no file under tests/ names the hook', () => {
    const offenders = walk(path.join(REPO_ROOT, 'tests')).filter((f) => fs.readFileSync(f, 'utf8').includes(NAME));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it.skipIf(offRail)('node scripts/sync-hooks.mjs --check exits 0 (no drift, no orphans)', () => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'sync-hooks.mjs'), '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
