/**
 * Tests for runSyncStaging push-when-ahead behavior.
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
const { runSyncStaging } = await import('../../packages/mcp-rks/src/server/git/git-release.mjs');

const FAKE_ROOT = '/tmp/fake-project-sync-staging';

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(FAKE_ROOT, { recursive: true });
  runGit.mockImplementation((root, args) => {
    if (args[0] === 'branch' && args[1] === '--show-current') return 'staging';
    return '';
  });
});

describe('runSyncStaging — push when ahead', () => {
  it('returns { ok: true, state: "ahead", action: "pushed" } when local staging is ahead and push succeeds', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--count')) {
        return { stdout: '2\t0', stderr: '', status: 0 };
      }
      if (cmd === 'git' && args[0] === 'push') return { stdout: '', stderr: '', status: 0 };
      return { stdout: '', stderr: '', status: 0 };
    });

    const result = await runSyncStaging({ projectRoot: FAKE_ROOT });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('ahead');
    expect(result.action).toBe('pushed');
  });

  it('returns { ok: false, error: "staging_ahead_push_failed" } when local staging is ahead and push fails', async () => {
    spawnSync.mockImplementation((cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'fetch') return { stdout: '', stderr: '', status: 0 };
      if (cmd === 'git' && args[0] === 'rev-list' && args.includes('--count')) {
        return { stdout: '1\t0', stderr: '', status: 0 };
      }
      if (cmd === 'git' && args[0] === 'push') return { stdout: '', stderr: 'push rejected', status: 1 };
      return { stdout: '', stderr: '', status: 0 };
    });

    const result = await runSyncStaging({ projectRoot: FAKE_ROOT });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('staging_ahead_push_failed');
  });
});
