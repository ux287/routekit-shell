/**
 * Tests for tests/helpers/hook-path.mjs — the hook discovery helper itself.
 *
 * Added by backlog.fix.unit-tier-offrail-hermeticity. Seven suites resolve hooks
 * through `resolveHookPath` and four through `resolveHookByName`, but until now
 * NOTHING tested the helper. Its candidate ORDER is load-bearing — reorder it and
 * every consumer silently resolves a different file, with no test going red.
 *
 * These drive the real functions against synthetic trees in a temp dir, so the
 * order and the throw contract are asserted as behaviour, not as source text.
 *
 * This file must contain no spawn-family call (unit-tier purity guard).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveHookPath,
  resolveHookByName,
  canonicalHookPath,
} from '../helpers/hook-path.mjs';

const REL = 'read/redirect-read-to-agent.mjs';
const dirs = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Build a temp root containing the hook at each of the named roots. */
function makeRoot(roots) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
  dirs.push(dir);
  for (const [root, body] of Object.entries(roots)) {
    const p = path.join(dir, root, REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

describe('resolveHookPath — the candidate ORDER is the contract', () => {
  it('prefers the live deployed tree when all three exist', () => {
    const dir = makeRoot({
      '.routekit/hooks': 'live',
      '.routekit/hooks.bak': 'bak',
      'packages/hooks': 'canonical',
    });
    expect(fs.readFileSync(resolveHookPath(REL, dir), 'utf8')).toBe('live');
  });

  it('falls back to the off-rail backup when the live tree is relocated', () => {
    const dir = makeRoot({
      '.routekit/hooks.bak': 'bak',
      'packages/hooks': 'canonical',
    });
    expect(fs.readFileSync(resolveHookPath(REL, dir), 'utf8')).toBe('bak');
  });

  it('falls back to canonical when neither deployed copy exists', () => {
    const dir = makeRoot({ 'packages/hooks': 'canonical' });
    expect(fs.readFileSync(resolveHookPath(REL, dir), 'utf8')).toBe('canonical');
  });

  it('ANTI-VACUITY — the three cases resolve to three DIFFERENT files', () => {
    // Without this, all three assertions above could be satisfied by a helper that
    // always returned the same path, if the fixtures happened to share content.
    const all = makeRoot({
      '.routekit/hooks': 'live',
      '.routekit/hooks.bak': 'bak',
      'packages/hooks': 'canonical',
    });
    const noLive = makeRoot({
      '.routekit/hooks.bak': 'bak',
      'packages/hooks': 'canonical',
    });
    const canonicalOnly = makeRoot({ 'packages/hooks': 'canonical' });
    const bodies = [all, noLive, canonicalOnly].map((d) =>
      fs.readFileSync(resolveHookPath(REL, d), 'utf8'),
    );
    expect(new Set(bodies).size).toBe(3);
  });

  it('returns the deployed candidate (not a throw) when nothing exists at all', () => {
    // Documented behaviour: falls back to candidates[0]. Callers that need a hard
    // failure use canonicalHookPath instead.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
    dirs.push(dir);
    const p = resolveHookPath(REL, dir);
    expect(p).toBe(path.resolve(dir, '.routekit/hooks', REL));
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('resolveHookByName — searches every root and every tier', () => {
  it('finds a system-tier hook relocated under hooks.bak/system/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
    dirs.push(dir);
    const p = path.join(dir, '.routekit/hooks.bak/system', 'block-plan-mode.mjs');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'relocated');
    expect(resolveHookByName('block-plan-mode.mjs', dir)).toBe(p);
  });

  it('falls back to the canonical system tier when the name is nowhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
    dirs.push(dir);
    expect(resolveHookByName('nope.mjs', dir)).toBe(
      path.resolve(dir, 'packages/hooks/system', 'nope.mjs'),
    );
  });

  // PRECEDENCE, added by backlog.fix.post-ship-review-findings-batch (Finding 4).
  //
  // The two cases above prove DISCOVERY: each uses a single-root, single-tier
  // fixture, so the same name exists in exactly one place and any search order
  // finds it. Reordering HOOK_ROOTS or HOOK_TIERS leaves both green. The cases
  // below place the SAME name in two or more locations, which is the only shape
  // that can witness an order.

  /** Build a temp root placing `name` at each given "<root>/<tier>" key. */
  function makeNamed(name, placements) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
    dirs.push(dir);
    for (const [where, body] of Object.entries(placements)) {
      const p = path.join(dir, where, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return dir;
  }

  const bodyAt = (dir, name) => fs.readFileSync(resolveHookByName(name, dir), 'utf8');

  it('HOOK_ROOTS ORDER: the live tree wins over the backup, which wins over canonical', () => {
    // Goes red if HOOK_ROOTS (tests/helpers/hook-path.mjs:79) is reordered.
    const all = makeNamed('dup.mjs', {
      '.routekit/hooks/system': 'live',
      '.routekit/hooks.bak/system': 'bak',
      'packages/hooks/system': 'canonical',
    });
    expect(bodyAt(all, 'dup.mjs')).toBe('live');

    const noLive = makeNamed('dup.mjs', {
      '.routekit/hooks.bak/system': 'bak',
      'packages/hooks/system': 'canonical',
    });
    expect(bodyAt(noLive, 'dup.mjs')).toBe('bak');

    // ANTI-VACUITY: the two cases resolve to DIFFERENT files. Without this, both
    // assertions would also pass against a helper that always returned canonical
    // if the fixtures happened to share content.
    expect(bodyAt(all, 'dup.mjs')).not.toBe(bodyAt(noLive, 'dup.mjs'));
  });

  it('HOOK_TIERS ORDER: the flat root wins over system, and system wins over read', () => {
    // Goes red if HOOK_TIERS (tests/helpers/hook-path.mjs:81) is reordered. Both
    // fixtures stay inside ONE root, so only the tier order can decide them.
    const flatVsSystem = makeNamed('dup.mjs', {
      '.routekit/hooks': 'flat',
      '.routekit/hooks/system': 'system',
    });
    expect(bodyAt(flatVsSystem, 'dup.mjs')).toBe('flat');

    const systemVsRead = makeNamed('dup.mjs', {
      '.routekit/hooks/system': 'system',
      '.routekit/hooks/read': 'read',
    });
    expect(bodyAt(systemVsRead, 'dup.mjs')).toBe('system');

    const readVsWrite = makeNamed('dup.mjs', {
      '.routekit/hooks/read': 'read',
      '.routekit/hooks/write': 'write',
    });
    expect(bodyAt(readVsWrite, 'dup.mjs')).toBe('read');

    // ANTI-VACUITY: three cases, three different resolutions.
    expect(
      new Set([
        bodyAt(flatVsSystem, 'dup.mjs'),
        bodyAt(systemVsRead, 'dup.mjs'),
        bodyAt(readVsWrite, 'dup.mjs'),
      ]).size,
    ).toBe(3);
  });

  it('NESTING ORDER: root is the OUTER loop — a late tier in the live tree beats system in the backup', () => {
    // The array orders alone do not pin this. If the loops were swapped so tier
    // were outer, HOOK_TIERS would reach 'system' in EVERY root before reaching
    // 'write' in any, and this fixture would resolve to the backup instead.
    const dir = makeNamed('dup.mjs', {
      '.routekit/hooks/write': 'live-write',
      '.routekit/hooks.bak/system': 'bak-system',
    });
    expect(bodyAt(dir, 'dup.mjs')).toBe('live-write');

    // ANTI-VACUITY: the backup copy IS reachable — with the live copy gone, the
    // same lookup finds it. So the assertion above is a precedence result, not an
    // artifact of the backup being invisible to the search.
    const backupOnly = makeNamed('dup.mjs', { '.routekit/hooks.bak/system': 'bak-system' });
    expect(bodyAt(backupOnly, 'dup.mjs')).toBe('bak-system');
  });
});

describe('canonicalHookPath — canonical only, and fails LOUD', () => {
  it('returns the canonical path when it exists', () => {
    const dir = makeRoot({ 'packages/hooks': 'canonical' });
    expect(canonicalHookPath(REL, dir)).toBe(path.resolve(dir, 'packages/hooks', REL));
  });

  it('IGNORES both deployed copies — it never resolves to .routekit/**', () => {
    // The whole point: a spawning test must not silently get a relocated hook
    // (partial import tree) or a mid-session stale deployed copy.
    const dir = makeRoot({
      '.routekit/hooks': 'live',
      '.routekit/hooks.bak': 'bak',
      'packages/hooks': 'canonical',
    });
    const p = canonicalHookPath(REL, dir);
    expect(p).not.toContain('.routekit');
    expect(fs.readFileSync(p, 'utf8')).toBe('canonical');
  });

  it('THROWS a named error when canonical is absent, rather than falling back', () => {
    // Mutation this kills: falling back to .routekit/hooks, or returning the
    // non-existent path. Either would let a spawning test run the wrong code or
    // fail with an empty-stdout symptom that looks like a silent hook.
    const dir = makeRoot({
      '.routekit/hooks': 'live',
      '.routekit/hooks.bak': 'bak',
    });
    expect(() => canonicalHookPath(REL, dir)).toThrow(/CanonicalHookMissing/);
    try {
      canonicalHookPath(REL, dir);
    } catch (e) {
      expect(e.name).toBe('CanonicalHookMissing');
    }
  });

  it('never returns a path that does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-path-helper-'));
    dirs.push(dir);
    expect(() => canonicalHookPath(REL, dir)).toThrow();
  });
});
