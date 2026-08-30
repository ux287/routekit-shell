import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureClaudeSettings,
  buildHookRegistration,
} from '../../packages/cli/src/project/bootstrap.mjs';

// backlog.fix.child-bash-read-boundary-bypass — Parts 1 & 2.
// A fresh child's generated .claude/settings.json must register every hook at its
// TIERED deploy path (.routekit/hooks/<tier>/<name>.mjs), sourced from the hook
// manifest. A flat path (.routekit/hooks/<name>.mjs) fails to load and silently
// disables every hook — the root-cause bug. The regression guard here would have
// failed against the old flat-path generator.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, '.routekit', 'hooks-manifest.json'), 'utf8')
);

// Pull "<tier>/<name>.mjs" out of every hook command in the generated settings.
function hookCommandPaths(settings) {
  const out = [];
  const events = settings.hooks || {};
  for (const ev of Object.keys(events)) {
    for (const group of events[ev] || []) {
      for (const h of group.hooks || []) {
        const m = /\.routekit\/hooks\/(\S+\.mjs)/.exec(h.command || '');
        if (m) out.push(m[1]);
      }
    }
  }
  return out;
}

let settings;
let tmpDir;
let hookPaths;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-child-settings-'));
  const settingsPath = ensureClaudeSettings({ projectRoot: tmpDir, shellRoot: REPO_ROOT });
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  hookPaths = hookCommandPaths(settings);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('child settings hook registrations (Part 1: tiered paths)', () => {
  it('registers some hooks (sanity)', () => {
    expect(hookPaths.length).toBeGreaterThan(20);
  });

  it('registers ZERO flat hook paths — every path is tiered', () => {
    const flat = hookPaths.filter((p) => !p.includes('/'));
    expect(flat).toEqual([]);
  });

  it('pins concrete tier paths across read / system / write', () => {
    const joined = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).join('\n');
    expect(joined).toContain('.routekit/hooks/read/redirect-read-to-agent.mjs');
    expect(joined).toContain('.routekit/hooks/system/guardrails-gate.mjs');
    expect(joined).toContain('.routekit/hooks/system/enforce-targetfile-scope.mjs');
    // none of those appear as a flat path
    expect(joined).not.toContain('.routekit/hooks/redirect-read-to-agent.mjs');
    expect(joined).not.toContain('.routekit/hooks/guardrails-gate.mjs');
  });
});

describe('child settings regression guard (Part 2: resolves + matches manifest)', () => {
  it('every registered path equals its manifest tier path', () => {
    for (const p of hookPaths) {
      const name = p.split('/').pop().replace(/\.mjs$/, '');
      expect(manifest[name], `hook "${name}" missing from manifest`).toBeTruthy();
      expect(p).toBe(manifest[name].path);
    }
  });

  it('every registered path resolves to a real deployed hook source file', () => {
    // Children deploy from packages/hooks (canonical) verbatim, so source
    // existence proves child resolvability.
    for (const p of hookPaths) {
      const src = path.join(REPO_ROOT, 'packages', 'hooks', p);
      expect(fs.existsSync(src), `hook source missing: packages/hooks/${p}`).toBe(true);
    }
  });
});

// backlog.fix.child-hook-registration-repair-and-audit — SINGLE AUTHORITY.
// The hooks block used to be an inline literal inside ensureClaudeSettings, reachable
// only from `attach`. That inaccessibility is why no update path could repair a child
// whose hooks were never registered: there was nothing to call. buildHookRegistration is
// now the one producer, and fresh-attach output must be provably the same object the
// repair path writes — otherwise the two drift and "repaired" stops meaning "correct".
describe('single authority: buildHookRegistration produces the fresh-attach block', () => {
  it('is exported', () => {
    expect(typeof buildHookRegistration).toBe('function');
  });

  it('deep-equals the hooks block fresh-attach ensureClaudeSettings writes for the same manifest', () => {
    expect(settings.hooks).toEqual(buildHookRegistration(manifest));
  });
});

describe('graceful when the manifest is absent (attach must not crash)', () => {
  // Regression: a synthetic shellRoot with no .routekit/hooks-manifest.json must
  // not throw (it crashed `routekit project attach` in project-attach-stack).
  it('produces settings without throwing when shellRoot has no manifest', () => {
    const child = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-nomani-child-'));
    const fakeShell = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-nomani-shell-'));
    try {
      const sp = ensureClaudeSettings({ projectRoot: child, shellRoot: fakeShell });
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      expect(s.env.RKS_GUARDRAILS).toBe('on');
      expect(hookCommandPaths(s).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(child, { recursive: true, force: true });
      fs.rmSync(fakeShell, { recursive: true, force: true });
    }
  });

  it('buildHookRegistration(null) still yields the FLAT fallback', () => {
    const flatOnly = hookCommandPaths({ hooks: buildHookRegistration(null) });
    expect(flatOnly.length).toBeGreaterThan(20);
    expect(flatOnly.every((p) => !p.includes('/'))).toBe(true);
  });

  // NOT A CONTRADICTION with doctor's fail-closed Check 6, and the two must not be
  // conflated. That flat-degrade output is EXPECTED to later FAIL Check 6 condition (d)
  // in a real shell: a real child carries the TIERED payload on disk, so a flat
  // .routekit/hooks/guardrails-gate.mjs does not resolve there and the hook silently does
  // not run. Doctor SHOULD flag such a child. Bootstrap degrades so `attach` does not
  // hard-fail on a partially built shell; doctor fails closed so the degraded state is
  // never certified healthy. The asymmetry is deliberate — do not "reconcile" it by
  // softening either side.
  it('the flat fallback does NOT resolve against a child carrying the tiered payload', () => {
    const child = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-flat-degrade-'));
    try {
      // A real child's layout: tiered.
      for (const rel of [...new Set(Object.values(manifest).map((e) => e.path))]) {
        const p = path.join(child, '.routekit', 'hooks', rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, '// stub hook\n');
      }
      const flat = hookCommandPaths({ hooks: buildHookRegistration(null) });
      const unresolved = flat.filter(
        (p) => !fs.existsSync(path.join(child, '.routekit', 'hooks', p)),
      );
      expect(unresolved.length).toBe(flat.length); // every one of them is dead
    } finally {
      fs.rmSync(child, { recursive: true, force: true });
    }
  });
});
