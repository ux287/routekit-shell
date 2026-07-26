/**
 * Tests for the lazy SELF_PROJECT_ID resolver in packages/mcp-rks/src/server.mjs.
 *
 * Before this fix, `SELF_PROJECT_ID` was computed inside a module-load IIFE that
 * threw if neither ROUTEKIT_PROJECT_ID nor `<repoRoot>/.rks/project.json` was
 * available. The CLI transitively imported server.mjs, so any `routekit` verb
 * launched from a CWD without identity emitted `[rks-mcp] FATAL` and exited.
 *
 * The fix replaces the IIFE with a memoized `getSelfProjectId()` function. Import
 * is always safe; the throw is deferred until a request handler actually needs
 * SELF_PROJECT_ID. These tests pin that contract.
 *
 * Each test re-imports server.mjs via vi.resetModules() to get a fresh
 * `_selfProjectIdCache` so the memoization tests are isolated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const SERVER_MODULE = '../../packages/mcp-rks/src/server.mjs';

async function freshImport() {
  vi.resetModules();
  return await import(SERVER_MODULE);
}

describe('getSelfProjectId — lazy resolver', () => {
  let savedEnvId;

  beforeEach(() => {
    savedEnvId = process.env.ROUTEKIT_PROJECT_ID;
    delete process.env.ROUTEKIT_PROJECT_ID;
  });

  afterEach(() => {
    if (savedEnvId !== undefined) process.env.ROUTEKIT_PROJECT_ID = savedEnvId;
    else delete process.env.ROUTEKIT_PROJECT_ID;
    vi.restoreAllMocks();
  });

  it('module load does not throw when identity is unresolvable (deferred resolution)', async () => {
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (typeof p === 'string' && p.endsWith('.rks/project.json')) {
        throw new Error('ENOENT (simulated)');
      }
      return real(p, ...rest);
    });
    await expect(freshImport()).resolves.toBeDefined();
  }, 60_000);

  it('returns ROUTEKIT_PROJECT_ID env var value when set (env-var precedence)', async () => {
    process.env.ROUTEKIT_PROJECT_ID = 'test-project-from-env';
    const mod = await freshImport();
    expect(mod.getSelfProjectId()).toBe('test-project-from-env');
  }, 60_000);

  it('trims whitespace around the env var value', async () => {
    process.env.ROUTEKIT_PROJECT_ID = '  padded-id  ';
    const mod = await freshImport();
    expect(mod.getSelfProjectId()).toBe('padded-id');
  }, 60_000);

  it('falls back to `<repoRoot>/.rks/project.json` id when env var is unset (file-fallback precedence)', async () => {
    const mod = await freshImport();
    // The repo's own .rks/project.json has id: routekit-shell-core.
    expect(mod.getSelfProjectId()).toBe('routekit-shell-core');
  }, 60_000);

  it('throws the existing diagnostic when both env and file lookup fail AND the resolver is actually invoked', async () => {
    const real = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (typeof p === 'string' && p.endsWith('.rks/project.json')) {
        throw new Error('ENOENT (simulated)');
      }
      return real(p, ...rest);
    });
    const mod = await freshImport();
    expect(() => mod.getSelfProjectId()).toThrow(/Cannot determine SELF_PROJECT_ID/);
  }, 60_000);

  it('memoizes its result — a second call does not re-read .rks/project.json', async () => {
    const mod = await freshImport();
    // First call to prime the cache.
    const first = mod.getSelfProjectId();
    expect(first).toBe('routekit-shell-core');
    // Spy AFTER first call. Second call should not invoke readFileSync at all.
    const spy = vi.spyOn(fs, 'readFileSync');
    const second = mod.getSelfProjectId();
    expect(second).toBe('routekit-shell-core');
    expect(spy).not.toHaveBeenCalled();
  }, 60_000);
});

describe('getSelfProjectId — TOOL_TO_AGENT_MAP integration (source structure)', () => {
  const SERVER_SRC = fs.readFileSync(
    new URL('../../packages/mcp-rks/src/server.mjs', import.meta.url),
    'utf8',
  );

  it('no bare `SELF_PROJECT_ID` identifier survives in TOOL_TO_AGENT_MAP read sites', () => {
    // Source mentions SELF_PROJECT_ID only in comments/diagnostics — never as a
    // bare expression in an `||` fallback (which would mean an eager const got
    // re-introduced). Match the exact pattern from before the fix.
    expect(SERVER_SRC).not.toMatch(/\|\|\s*SELF_PROJECT_ID\b/);
  });

  it('all dendron-tool read sites in TOOL_TO_AGENT_MAP use getSelfProjectId() lazily', () => {
    const dendronEntries = [
      'dendron_create_note', 'dendron_fix_frontmatter', 'dendron_validate_schema',
      'dendron_edit_note', 'dendron_read_note', 'dendron_update_field',
      'dendron_mark_implemented',
    ];
    for (const tool of dendronEntries) {
      // Each entry line must include `a.projectId || getSelfProjectId()`.
      const re = new RegExp(`${tool}:.*a\\.projectId\\s*\\|\\|\\s*getSelfProjectId\\(\\)`);
      expect(SERVER_SRC, `expected ${tool} to use getSelfProjectId() fallback`).toMatch(re);
    }
  });

  it('verifyHooksPresent hooks-health block (out-of-scope guard) is intact', () => {
    // Check the named symbol is still wired — the lazy refactor must not have
    // collateral-damaged the hooks-health block at ~3560-3575.
    expect(SERVER_SRC).toMatch(/verifyHooksPresent\(/);
  });

  it('exports getSelfProjectId as a named export', () => {
    expect(SERVER_SRC).toMatch(/export\s+function\s+getSelfProjectId\s*\(\s*\)/);
  });
});
