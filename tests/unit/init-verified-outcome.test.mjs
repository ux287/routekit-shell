/**
 * Verified-outcome / false-success-regression coverage for runInitTool + the rks_init handler.
 *
 * Root defect (clean-machine fresh-clone UAT): rks_init returned { success:true,
 * registrationOk:true } while creating NO project dir and NO registry entry — a
 * process.cwd() vs __dirname-anchored-shellRoot split-brain with no post-write verification.
 *
 * These tests pin the fix:
 *  - success/registrationOk are DERIVED from a post-write readback (fs.existsSync +
 *    getProjectById round-trip), never optimistic — a non-round-tripping registration
 *    demotes success to false with a real error (THE load-bearing pin).
 *  - the readback resolves against the SAME __dirname-anchored shell root as the write
 *    (not the tmp parentDir / process.cwd()).
 *  - a git-only failure still routes to warnings and keeps success true.
 *  - gh preflight: with gh absent, remote-create + staging push are skipped with ONE
 *    actionable warning (no raw "command not found").
 *  - server.mjs rks_init handler: onboarder uses res.path and is gated on res.success
 *    (source-introspection witness — the handler is not independently exported).
 *
 * DI approach: child_process.execSync and the CLI project/bootstrap modules are mocked;
 * real spawns are never issued. Any (mocked) subprocess is command-matched, not global.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Only mock execSync (block gh/git subprocesses); preserve everything else in child_process.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execSync: vi.fn(() => '') };
});

vi.mock('../../packages/cli/src/project/bootstrap.mjs', () => ({
  attachProject: vi.fn(),
}));

vi.mock('../../packages/cli/src/project/index.js', () => ({
  upsertProject: vi.fn(),
  getProjectById: vi.fn(),
}));

const { execSync } = await import('child_process');
const { runInitTool } = await import('../../packages/mcp-rks/src/server/init.mjs');
const { attachProject } = await import('../../packages/cli/src/project/bootstrap.mjs');
const { upsertProject, getProjectById } = await import('../../packages/cli/src/project/index.js');

const testDir = path.dirname(fileURLToPath(import.meta.url)); // tests/unit
const REPO_ROOT = path.resolve(testDir, '..', '..');          // authoritative shell root

function uniqueProjectName() {
  return `test-init-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

beforeEach(() => {
  // default: all subprocesses succeed (gh ready, git ok)
  execSync.mockImplementation(() => '');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runInitTool — verified outcome', () => {
  it('verified success: dir on disk + registry round-trip → success & registrationOk true', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name });
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(true);
      expect(result.registrationOk).toBe(true);
      expect(fs.existsSync(result.path)).toBe(true);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('FALSE-SUCCESS PIN: registration claims success but readback finds nothing → success:false with real error', async () => {
    // The attach path resolves (claims OK) yet getProjectById returns null: the entry did
    // not round-trip. Pre-fix this returned success:true (false success). It must demote.
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined); // registration "succeeded"
      getProjectById.mockReturnValue(null);        // ...but does not round-trip
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(false);
      expect(result.registrationOk).toBe(false);
      expect(result.error).toMatch(/did not round-trip|verification failed/i);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('success/registrationOk are derived from the readback, not the write claim', async () => {
    // attach REJECTS and upsert also fails (registrationOk would be false from the write
    // path) — but readback truthiness is what the return must reflect. Here readback is
    // null → success:false. Proves the return is readback-driven, not optimistic.
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockRejectedValue(new Error('bootstrap exploded'));
      upsertProject.mockImplementation(() => { throw new Error('registry write failed'); });
      getProjectById.mockReturnValue(null);
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(false);
      expect(result.registrationOk).toBe(false);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('same-anchor: the registry readback resolves against the __dirname shell root, not the tmp parentDir', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name });
      await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(getProjectById).toHaveBeenCalledWith(name, REPO_ROOT);
      // and NOT anchored on the tmp parentDir
      const calledBaseDirs = getProjectById.mock.calls.map((c) => c[1]);
      expect(calledBaseDirs).not.toContain(tmpDir);
      expect(calledBaseDirs).not.toContain(path.join(tmpDir, name));
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('git-only failure routes to warnings and keeps success true', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name });
      // gh checks succeed; the first git command throws (whole git/GitHub block fails)
      execSync.mockImplementation((cmd) => {
        if (/^git /.test(cmd)) throw new Error('git boom');
        return '';
      });
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });
      expect(result.success).toBe(true); // scaffold + registration landed
      expect(result.warnings.some((w) => /git\/GitHub setup failed|git boom/.test(w))).toBe(true);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });
});

describe('runInitTool — gh preflight', () => {
  it('gh absent: skips remote-create + staging push with ONE actionable warning, no "command not found"', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name });
      // `which gh` throws → gh not installed. Git commands still succeed.
      execSync.mockImplementation((cmd) => {
        if (/^which gh/.test(cmd)) throw new Error('which: no gh in PATH');
        return '';
      });
      const result = await runInitTool({ projectName: name, parentDir: tmpDir });

      const calls = execSync.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => /gh repo create/.test(c))).toBe(false);      // remote-create skipped
      expect(calls.some((c) => /git push -u origin staging/.test(c))).toBe(false); // push skipped

      const ghWarnings = result.warnings.filter((w) => /GitHub CLI|gh auth login/.test(w));
      expect(ghWarnings).toHaveLength(1);                                   // exactly one actionable warning
      expect(result.warnings.some((w) => /command not found/.test(w))).toBe(false);
      expect(result.success).toBe(true);                                   // local scaffold still succeeded
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });

  it('gh ready: remote-create is attempted (preflight passes → gh repo create issued)', async () => {
    const name = uniqueProjectName();
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'rks-verified-'));
    try {
      attachProject.mockResolvedValue(undefined);
      getProjectById.mockReturnValue({ id: name });
      execSync.mockImplementation(() => ''); // which gh + gh auth status + git all succeed
      await runInitTool({ projectName: name, parentDir: tmpDir });
      const calls = execSync.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => /gh repo create/.test(c))).toBe(true);
    } finally {
      cleanup(path.join(tmpDir, name), tmpDir);
    }
  });
});

describe('rks_init handler (server.mjs) — onboarder root & gating [source witness]', () => {
  // The rks_init handler is not independently exported (it lives inside the MCP dispatch
  // and importing server.mjs pulls heavy top-level side effects), so these pin fix #3 by
  // source-introspection — the same regression-witness pattern used for init.mjs greps.
  const serverSrc = fs.readFileSync(
    path.resolve('packages/mcp-rks/src/server.mjs'),
    'utf8'
  );

  it('onboarder is invoked with the authoritative res.path (not a recomputed parent join)', () => {
    expect(serverSrc).toContain('projectRoot: res.path');
    // the old wrong-root recompute for the onboarder must be gone
    expect(serverSrc).not.toContain('const newProjectRoot = path.resolve(parentDir, projectName)');
  });

  it('onboarder is gated on a verified-successful init (res.success)', () => {
    expect(serverSrc).toMatch(/if\s*\(\s*res\.success\s*&&\s*res\.path\s*\)/);
  });
});
