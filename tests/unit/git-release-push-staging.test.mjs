/**
 * Tests for push-staging-after-release and rollback-on-ff-merge-failure
 * behaviors in runRelease().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })) };
});

vi.mock('../../packages/mcp-rks/src/server/git/git-utils.mjs', () => ({
  runGit: vi.fn(),
  getCurrentBranch: vi.fn(() => 'staging'),
  isProductionBranch: vi.fn(() => false),
}));


vi.mock('../../packages/mcp-rks/src/server/guardrails-audit.mjs', () => ({
  isGuardrailsOffSession: vi.fn(() => true),
}));

const { spawnSync } = await import('child_process');
const { runGit } = await import('../../packages/mcp-rks/src/server/git/git-utils.mjs');
const { runRelease } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

const FAKE_ROOT = '/tmp/fake-project-release-push';

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(FAKE_ROOT, { recursive: true });
  fs.mkdirSync(`${FAKE_ROOT}/notes`, { recursive: true });
  fs.writeFileSync(`${FAKE_ROOT}/package.json`, JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2));

  // Default spawnSync: everything succeeds
  spawnSync.mockImplementation((cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
    if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
      return { stdout: '0\t0', stderr: '', status: 0 };
    }
    if (cmd === 'gh' && args[0] === 'run') {
      return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc' }]), stderr: '', status: 0 };
    }
    return { stdout: '', stderr: '', status: 0 };
  });

  runGit.mockImplementation((root, args) => {
    if (args[0] === 'branch' && args[1] === '--show-current') return 'staging';
    if (args[0] === 'rev-parse' && args[1] === 'main') return 'sha-main';
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return 'sha-main';
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'sha-premain';
    // Story 2's pre-mutation gate: `merge-base origin/main staging` must equal
    // `rev-parse origin/main` (sha-main) for the ff-ability check to pass — without
    // this the gate aborts before the ff-merge step the rollback tests exercise.
    if (args[0] === 'merge-base') return 'sha-main';
    // Story 1-3 tag-existence / idempotent-tag checks: no release tag in these fixtures.
    if (args[0] === 'tag' && args[1] === '--list') return '';
    return 'sha-default';
  });
});

describe('runRelease — push staging after release', () => {
  it('pushes origin main, then the single release tag, then origin staging (no --tags bulk push)', async () => {
    await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });

    const allCalls = spawnSync.mock.calls;
    // Story 1 replaced `git push origin main --tags` with a branch push followed by a
    // single-tag push `git push origin v<version>`.
    const mainPushIdx = allCalls.findIndex(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('main') && !c[1]?.includes('--tags'));
    const tagPushIdx = allCalls.findIndex(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.some(a => /^v\d/.test(a)));
    const stagingPushIdx = allCalls.findIndex(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('staging'));

    // No `git push ... --tags` bulk push anywhere.
    expect(allCalls.some(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('--tags'))).toBe(false);
    expect(mainPushIdx).toBeGreaterThan(-1);
    expect(tagPushIdx).toBeGreaterThan(-1);
    expect(stagingPushIdx).toBeGreaterThan(-1);
    expect(stagingPushIdx).toBeGreaterThan(mainPushIdx);
  });
});

describe('runRelease — sync guard direction-aware messages', () => {
  // backlog.fix.governed-push-staging-gap: a clean fast-forward-ahead integration branch is now
  // self-pushed by the release preflight (a guaranteed remote FF), instead of dead-ending and
  // telling the user to `git push` manually.
  it('self-pushes origin staging when local staging is ahead (clean FF), does not dead-end', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '1\t0', stderr: '', status: 0 };
      }
      if (cmd === 'gh' && args[0] === 'run') {
        return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc' }]), stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const result = await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });

    // The preflight pushed origin staging itself (a plain, non-force push).
    const aheadPush = spawnSync.mock.calls.find(
      c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('origin') && c[1]?.includes('staging') && !c[1]?.includes('--force'),
    );
    expect(aheadPush).toBeDefined();
    // No force-push anywhere.
    expect(spawnSync.mock.calls.some(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('--force'))).toBe(false);
    // It did NOT dead-end on the old "unpushed commits" error.
    if (result.error) expect(result.error).not.toMatch(/unpushed commits/i);
  });

  it('aborts (no force-push, no version bump) when the FF self-push fails', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '1\t0', stderr: '', status: 0 };
      }
      // The self-push of the integration branch fails.
      if (cmd === 'git' && args[0] === 'push' && args.includes('staging')) {
        return { stdout: '', stderr: 'remote rejected', status: 1 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const result = await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to push/i);
    // No force-push fallback, and it aborted before the version-bump commit / tag push.
    expect(spawnSync.mock.calls.some(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.includes('--force'))).toBe(false);
    expect(spawnSync.mock.calls.some(c => c[0] === 'git' && c[1]?.[0] === 'push' && c[1]?.some(a => /^v\d/.test(a)))).toBe(false);
  });

  it('returns error containing "Pull first" when local staging is behind origin/staging', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '0\t1', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const result = await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Pull first/i);
  });

  it('returns error containing "diverged" when staging has diverged', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '2\t1', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });
    const result = await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/diverged/i);
  });
});

describe('runRelease — rollback on ff-merge failure', () => {
  it('performs git reset --hard HEAD~1 on staging when ff-merge fails and last commit contains the version string', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '0\t0', stderr: '', status: 0 };
      }
      if (cmd === 'gh' && args[0] === 'run') {
        return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc' }]), stderr: '', status: 0 };
      }
      if (cmd === 'git' && args[0] === 'merge' && args.includes('--ff-only')) {
        return { stdout: '', stderr: 'merge failed', status: 1 };
      }
      if (cmd === 'git' && args[0] === 'log' && args.includes('--format=%s')) {
        return { stdout: 'chore(release): 1.0.1', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });

    await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });

    const resetCall = spawnSync.mock.calls.find(c => c[0] === 'git' && c[1]?.[0] === 'reset' && c[1]?.includes('--hard') && c[1]?.includes('HEAD~1'));
    expect(resetCall).toBeDefined();
  });

  it('always performs git reset --hard HEAD~1 on staging when ff-merge fails, regardless of last commit message', async () => {
    // The conditional guard (checking last commit message) was removed — the version bump commit
    // is always created before the merge attempt, so we always need to roll it back on failure.
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'status') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--left-right')) {
        return { stdout: '0\t0', stderr: '', status: 0 };
      }
      if (cmd === 'gh' && args[0] === 'run') {
        return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success', headSha: 'abc' }]), stderr: '', status: 0 };
      }
      if (cmd === 'git' && args[0] === 'merge' && args.includes('--ff-only')) {
        return { stdout: '', stderr: 'merge failed', status: 1 };
      }
      return { stdout: '', stderr: '', status: 0 };
    });

    await runRelease({ projectRoot: FAKE_ROOT, version: 'patch' });

    const resetCall = spawnSync.mock.calls.find(c => c[0] === 'git' && c[1]?.[0] === 'reset' && c[1]?.includes('--hard') && c[1]?.includes('HEAD~1'));
    expect(resetCall).toBeDefined();
  });
});
