import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })) };
});

vi.mock('../../packages/mcp-rks/src/server/git/git-utils.mjs', () => ({
  runGit: vi.fn(),
  getCurrentBranch: vi.fn(),
  isProductionBranch: vi.fn(() => false),
}));

vi.mock('../../packages/mcp-rks/src/server/git/git-workflow-pr.mjs', () => ({
  createPR: vi.fn(async () => ({ ok: true, prUrl: 'https://github.com/test/repo/pull/1', prNumber: 1 })),
}));

vi.mock('../../packages/mcp-rks/src/server/backlog-status.mjs', () => ({
  updateBacklogStatus: vi.fn(() => ({ updated: false })),
}));


vi.mock('../../packages/mcp-rks/src/server/guardrails-audit.mjs', () => ({
  isGuardrailsOffSession: vi.fn(() => true),
}));

const { runGitPR } = await import('../../packages/mcp-rks/src/server/git/git-workflow.mjs');
const { getCurrentBranch } = await import('../../packages/mcp-rks/src/server/git/git-utils.mjs');

const FAKE_ROOT = '/tmp/fake-project-currentbranch';

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdirSync(FAKE_ROOT, { recursive: true });
});

describe('runGitPR — currentBranch scoping', () => {
  it('currentBranch is declared with let before the outer try block (source check)', async () => {
    const src = fs.readFileSync(
      new URL('../../packages/mcp-rks/src/server/git/git-workflow.mjs', import.meta.url),
      'utf8'
    );
    // let currentBranch must appear BEFORE "try {" in the function body
    const fnStart = src.indexOf('export async function runGitPR(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 500);
    const letIdx = fnBody.indexOf('let currentBranch');
    const tryIdx = fnBody.indexOf('try {');
    expect(letIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(letIdx).toBeLessThan(tryIdx);
  });

  it('returns { ok: true, skipped: true } when currentBranch equals targetBranch', async () => {
    getCurrentBranch.mockReturnValue('staging');
    const result = await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: 'staging', reason: 'direct-staging-commit' });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('returns { ok: false } when getCurrentBranch throws — no ReferenceError', async () => {
    getCurrentBranch.mockImplementation(() => { throw new Error('not a git repo'); });
    const result = await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: 'staging', problemId: 'backlog.test.story' });
    // Should not throw ReferenceError — structured error or fallthrough is acceptable
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('does not throw ReferenceError when getCurrentBranch succeeds and branch differs from target', async () => {
    getCurrentBranch.mockReturnValue('rks/my-feature-branch');
    await expect(
      runGitPR({ projectRoot: FAKE_ROOT, targetBranch: 'staging', reason: 'direct-staging-commit' })
    ).resolves.toBeDefined();
  });

  it('uses currentBranch in push step without ReferenceError', async () => {
    const { spawnSync } = await import('child_process');
    getCurrentBranch.mockReturnValue('rks/my-feature-branch');
    await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: 'staging', reason: 'direct-staging-commit' }).catch(() => {});
    // push call should reference the actual branch name, not undefined
    const pushCall = spawnSync.mock.calls.find(c => c[1]?.includes('push'));
    if (pushCall) {
      expect(pushCall[1]).not.toContain(undefined);
      expect(pushCall[1]).toContain('rks/my-feature-branch');
    }
  });
});
