/**
 * Tests for `gh release create` integration in runRelease().
 * Uses real git repos but mocks the `gh` CLI command.
 *
 * Mock strategy: vi.doMock + vi.resetModules() per test via loadRunRelease().
 * Module-level vi.mock hoisting is unreliable for child_process in pool:forks —
 * the per-test doMock pattern is the correct approach for this file.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawnSync as realSpawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-gh-release-'));
  const bareDir = path.join(base, 'origin.git');
  const workDir = path.join(base, 'work');

  realSpawnSync('git', ['init', '--bare', '--initial-branch', 'main', bareDir]);
  realSpawnSync('git', ['clone', bareDir, workDir]);
  realSpawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir });
  realSpawnSync('git', ['config', 'user.name', 'Test'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.1.0' }, null, 2) + '\n');
  fs.mkdirSync(path.join(workDir, 'notes'), { recursive: true });

  realSpawnSync('git', ['add', '.'], { cwd: workDir });
  realSpawnSync('git', ['commit', '-m', 'initial'], { cwd: workDir });
  realSpawnSync('git', ['push', 'origin', 'main'], { cwd: workDir });

  realSpawnSync('git', ['checkout', '-b', 'staging'], { cwd: workDir });
  realSpawnSync('git', ['push', '-u', 'origin', 'staging'], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'feature.txt'), 'new feature\n');
  realSpawnSync('git', ['add', '.'], { cwd: workDir });
  realSpawnSync('git', ['commit', '-m', 'feat: add feature'], { cwd: workDir });
  realSpawnSync('git', ['push', 'origin', 'staging'], { cwd: workDir });

  return { base, workDir };
}

function cleanup(base) {
  fs.rmSync(base, { recursive: true, force: true });
}

// Track gh release create calls by wrapping spawnSync
function makeSpawnSyncSpy(ghExitCode = 0, ghStderr = '') {
  const ghCalls = [];
  return {
    ghCalls,
    spyFn: vi.fn((cmd, args, opts) => {
      if (cmd === 'gh' && args?.[0] === 'release') {
        ghCalls.push({ cmd, args: [...args], opts });
        return { status: ghExitCode, stdout: '', stderr: ghStderr, signal: null };
      }
      // CI check — mock to return success so release proceeds
      if (cmd === 'gh' && args?.[0] === 'run') {
        return {
          status: 0,
          stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc123' }]),
          stderr: '',
          signal: null
        };
      }
      // All other commands (git) run for real
      return realSpawnSync(cmd, args, opts);
    })
  };
}

// SKIPPED 2026-06-04: 8 tests time out at 5s each because the vi.doMock + vi.resetModules
// + dynamic-import pattern in loadRunRelease() does NOT intercept the spawnSync call
// inside packages/mcp-rks/src/server/git/git-release.mjs. The tests run the real
// `gh release create v0.1.1` and hit GitHub's API — the release already exists, the
// commands take ~10s each, and the suite stalls.
//
// The mock pattern was chosen deliberately (pool:forks + child_process can't use hoisted
// vi.mock), but the underlying ESM binding-vs-mock interaction means the production code
// gets the real spawnSync reference at module-init time. Needs a structural fix —
// either move the gh release create step behind a thin injectable adapter, or use a
// different mocking strategy (sinon stub on require cache, etc.).
//
// Follow-up: backlog.fix.gh-release-test-mock-doesnt-intercept (TBD stub).
describe.skip('runRelease gh release create', () => {
  let base, workDir;

  beforeEach(() => {
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    vi.unmock('child_process');
    vi.resetModules();
    vi.restoreAllMocks();
    if (base) cleanup(base);
  });

  afterAll(() => {
    vi.unmock('child_process');
    vi.resetModules();
  });

  async function loadRunRelease(spyFn) {
    vi.resetModules();
    vi.doMock('child_process', () => ({
      spawnSync: spyFn,
      execSync: realSpawnSync
    }));
    const mod = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');
    return mod.runRelease;
  }

  it('calls gh release create after successful push', async () => {
    const { ghCalls, spyFn } = makeSpawnSyncSpy(0);
    const runRelease = await loadRunRelease(spyFn);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    // Still exactly one gh release call: the public Step 7b release is gated on
    // publishResult.ok, and this fixture has no rks-public publish profile, so the
    // public release is skipped. Only the private Step 6 gh release create fires.
    expect(ghCalls.length).toBe(1);
    expect(ghCalls[0].args[0]).toBe('release');
    expect(ghCalls[0].args[1]).toBe('create');
    expect(ghCalls[0].args[2]).toBe('v0.1.1');
  });

  it('gh release create is called with --title and --notes', async () => {
    const { ghCalls, spyFn } = makeSpawnSyncSpy(0);
    const runRelease = await loadRunRelease(spyFn);

    await runRelease({ projectRoot: workDir, version: 'patch', changelog: 'My release notes' });

    expect(ghCalls[0].args).toContain('--title');
    expect(ghCalls[0].args).toContain('v0.1.1');
    expect(ghCalls[0].args).toContain('--notes');
    expect(ghCalls[0].args).toContain('My release notes');
  });

  it('uses changelog content when provided', async () => {
    const { ghCalls, spyFn } = makeSpawnSyncSpy(0);
    const runRelease = await loadRunRelease(spyFn);

    await runRelease({ projectRoot: workDir, version: 'patch', changelog: 'Custom notes here' });

    const notesIdx = ghCalls[0].args.indexOf('--notes');
    expect(ghCalls[0].args[notesIdx + 1]).toBe('Custom notes here');
  });

  it('derives notes from git log when changelog is null (never the bare "Release <version>")', async () => {
    const { ghCalls, spyFn } = makeSpawnSyncSpy(0);
    const runRelease = await loadRunRelease(spyFn);

    await runRelease({ projectRoot: workDir, version: 'patch' });

    const notesIdx = ghCalls[0].args.indexOf('--notes');
    const notes = ghCalls[0].args[notesIdx + 1];
    // No tags in the fixture → notes derive from `git log HEAD` commit subjects.
    expect(notes).toContain('feat: add feature');
    expect(notes).not.toBe('Release 0.1.1');
  });

  it('on success, return has ok: true with no warning', async () => {
    const { spyFn } = makeSpawnSyncSpy(0);
    const runRelease = await loadRunRelease(spyFn);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('on gh failure, return still has ok: true', async () => {
    const { spyFn } = makeSpawnSyncSpy(1, 'gh: command failed');
    const runRelease = await loadRunRelease(spyFn);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
  });

  it('on gh failure, return includes warning string', async () => {
    const { spyFn } = makeSpawnSyncSpy(1, 'release already exists');
    const runRelease = await loadRunRelease(spyFn);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('release already exists');
  });

  it('on gh failure, no rollback occurs — tag remains', async () => {
    const { spyFn } = makeSpawnSyncSpy(1, 'gh failed');
    const runRelease = await loadRunRelease(spyFn);

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(true);
    expect(result.tag).toBe('v0.1.1');
    // Tag should still exist
    const tags = realSpawnSync('git', ['tag', '-l'], { cwd: workDir, encoding: 'utf8' });
    expect(tags.stdout).toContain('v0.1.1');
  });
});
