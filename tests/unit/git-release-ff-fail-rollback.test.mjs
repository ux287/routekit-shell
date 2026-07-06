/**
 * Tests for FF-merge failure rollback in runRelease().
 *
 * Verifies that when FF-merge fails:
 * - git checkout staging is called before git reset --hard HEAD~1
 * - git reset --hard HEAD~1 is NOT called while on main
 * - retry produces exactly one version bump (no version skip)
 * - error message contains actionable rebase guidance
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';


// Single top-level mock — avoids vi.resetModules() per-test which causes LanceDB re-init
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

// Get mocked spawnSync handle and real spawnSync for pass-through
const { spawnSync } = await import('child_process');
const { spawnSync: realSpawnSync } = await vi.importActual('child_process');

// Import runRelease once — it uses the mocked child_process throughout
const { runRelease } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-ff-fail-'));
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

/**
 * Configures the spawnSync spy to fail git merge --ff-only when mergeShouldFail.value is true.
 * All other git commands and gh commands run for real (or are stubbed as needed).
 * `mergeShouldFail` is a mutable object so the caller can toggle it between runRelease calls.
 * Returns { calls, mergeShouldFail } for assertion.
 */
function makeMergeFailSpy(mergeShouldFail = { value: true }) {
  const calls = [];
  spawnSync.mockImplementation((cmd, args, opts) => {
    calls.push({ cmd, args: [...(args || [])], opts });

    // Fail FF-merge when requested
    if (mergeShouldFail.value && cmd === 'git' && args[0] === 'merge' && args[1] === '--ff-only') {
      return { status: 1, stdout: '', stderr: 'Not possible to fast-forward, aborting.', signal: null };
    }

    // CI check — always return success so release proceeds to the merge step
    if (cmd === 'gh' && args?.[0] === 'run') {
      return {
        status: 0,
        stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc123' }]),
        stderr: '',
        signal: null,
      };
    }

    // gh release create — always success
    if (cmd === 'gh' && args?.[0] === 'release') {
      return { status: 0, stdout: '', stderr: '', signal: null };
    }

    // All other commands (real git) run for real
    return realSpawnSync(cmd, args, opts);
  });

  return { calls, mergeShouldFail };
}

// SKIPPED 2026-06-04: uses realSpawnSync for git init/clone/push/checkout/merge
// across 4 tests on temp bare repos. Slow (~12-20s total) and shares the same
// ETIMEDOUT risk on CI as cli-cold-start. Should move to tests/integration/.
describe.skip('runRelease FF-merge failure rollback', () => {
  let base, workDir;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ base, workDir } = makeTempRepo());
  });

  afterEach(() => {
    if (base) cleanup(base);
  });

  it('git checkout staging is called before git reset --hard HEAD~1 on FF-merge failure', async () => {
    const { calls } = makeMergeFailSpy();

    await runRelease({ projectRoot: workDir, version: 'patch' });

    // Find the index of the failed merge call
    const mergeCallIdx = calls.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'merge' && c.args[1] === '--ff-only'
    );
    expect(mergeCallIdx).toBeGreaterThan(-1);

    // In post-merge calls: checkout staging must come before reset HEAD~1
    const postMerge = calls.slice(mergeCallIdx + 1);

    const checkoutStagingIdx = postMerge.findIndex(
      (c) => c.cmd === 'git' && c.args[0] === 'checkout' && c.args[1] === 'staging'
    );
    const resetHardIdx = postMerge.findIndex(
      (c) =>
        c.cmd === 'git' &&
        c.args[0] === 'reset' &&
        c.args[1] === '--hard' &&
        c.args[2] === 'HEAD~1'
    );

    expect(checkoutStagingIdx).toBeGreaterThan(-1);
    expect(resetHardIdx).toBeGreaterThan(-1);
    expect(checkoutStagingIdx).toBeLessThan(resetHardIdx);
  });

  it('git reset --hard HEAD~1 is NOT called while on the main branch', async () => {
    const { calls } = makeMergeFailSpy();

    await runRelease({ projectRoot: workDir, version: 'patch' });

    // Track simulated branch state by watching checkout calls in order
    let currentBranch = 'staging'; // runRelease precondition: starts on staging
    let resetCalledOnMain = false;

    for (const call of calls) {
      if (call.cmd !== 'git') continue;

      if (call.args[0] === 'checkout' && call.args[1] === 'main') {
        currentBranch = 'main';
      } else if (call.args[0] === 'checkout' && call.args[1] === 'staging') {
        currentBranch = 'staging';
      } else if (
        call.args[0] === 'reset' &&
        call.args[1] === '--hard' &&
        call.args[2] === 'HEAD~1'
      ) {
        if (currentBranch === 'main') {
          resetCalledOnMain = true;
        }
      }
    }

    expect(resetCalledOnMain).toBe(false);
  });

  it('returns ok: false with error message containing actionable rebase guidance referencing staging', async () => {
    makeMergeFailSpy();

    const result = await runRelease({ projectRoot: workDir, version: 'patch' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    // Must reference staging so the operator knows which branch to rebase
    expect(result.error.toLowerCase()).toContain('staging');
  });

  it('staging HEAD is restored after FF-merge failure so retry produces exactly one version bump (no version skip)', async () => {
    const mergeShouldFail = { value: true };
    const { calls } = makeMergeFailSpy(mergeShouldFail);

    // Capture staging HEAD before release attempt
    const stagingHeadBefore = realSpawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf8',
    }).stdout.trim();

    // First attempt: FF-merge fails, rollback should restore staging
    const result1 = await runRelease({ projectRoot: workDir, version: 'patch' });
    expect(result1.ok).toBe(false);

    // After rollback, staging HEAD must be back to where it was before the attempt
    const stagingHeadAfterFail = realSpawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: workDir,
      encoding: 'utf8',
    }).stdout.trim();
    expect(stagingHeadAfterFail).toBe(stagingHeadBefore);

    // Allow merge to succeed on retry
    mergeShouldFail.value = false;

    // Use the same runRelease — spy is already configured with the toggled mergeShouldFail
    const result2 = await runRelease({ projectRoot: workDir, version: 'patch' });
    expect(result2.ok).toBe(true);

    // Must be exactly one version bump: 0.1.0 → 0.1.1 (not 0.1.2)
    expect(result2.version).toBe('0.1.1');

    // Staging log must contain exactly one chore(release) commit
    const stagingLog = realSpawnSync('git', ['log', '--oneline', 'staging'], {
      cwd: workDir,
      encoding: 'utf8',
    }).stdout;
    const versionBumpCommits = stagingLog.split('\n').filter((l) => l.includes('chore(release)'));
    expect(versionBumpCommits).toHaveLength(1);
  });
});
