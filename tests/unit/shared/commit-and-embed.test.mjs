import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process');
vi.mock('../../../packages/mcp-rks/src/rag/tools.mjs');

import { execSync, execFileSync } from 'node:child_process';
import { runRagEmbed } from '../../../packages/mcp-rks/src/rag/tools.mjs';
import { commitAndEmbed } from '../../../packages/mcp-rks/src/shared/commit-and-embed.mjs';

const FAKE_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

function setupExecSync(files = 'notes/foo.md\nnotes/bar.md') {
  // The commit now goes through execFileSync (`git commit --cleanup=verbatim -F -`),
  // not execSync — so stub it there. rev-parse + diff still use execSync.
  execFileSync.mockReturnValueOnce(undefined); // git commit
  execSync
    .mockReturnValueOnce(`${FAKE_SHA}\n`)    // git rev-parse HEAD
    .mockReturnValueOnce(`${files}\n`);      // git diff --name-only
}

describe('commitAndEmbed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 5 });
  });

  it('successful commit returns { commitId } as 40-char SHA', async () => {
    setupExecSync();
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBeUndefined();
  });

  it('calls runRagEmbed with file list from git diff after commit', async () => {
    setupExecSync('notes/foo.md\nnotes/bar.md');
    await commitAndEmbed('/proj', 'test message');
    expect(runRagEmbed).toHaveBeenCalledWith('/proj', {
      files: ['notes/foo.md', 'notes/bar.md'],
    });
  });

  it('embed throws → returns { commitId, ragEmbedWarning } without rethrowing', async () => {
    setupExecSync();
    runRagEmbed.mockRejectedValueOnce(new Error('embed crashed'));
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBe('embed crashed');
  });

  it('embed returns ok:false → returns { commitId, ragEmbedWarning }', async () => {
    setupExecSync();
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'embed lock held' });
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(typeof result.ragEmbedWarning).toBe('string');
    expect(result.ragEmbedWarning.length).toBeGreaterThan(0);
  });

  it('git commit failure propagates and runRagEmbed is never called', async () => {
    execFileSync.mockImplementationOnce(() => { throw new Error('nothing to commit'); });
    await expect(commitAndEmbed('/proj', 'test message')).rejects.toThrow('nothing to commit');
    expect(runRagEmbed).not.toHaveBeenCalled();
  });

  it('options parameter accepted without error', async () => {
    setupExecSync();
    const result = await commitAndEmbed('/proj', 'msg', { skipEmbed: true });
    expect(result.commitId).toBe(FAKE_SHA);
  });
});
