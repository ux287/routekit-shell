import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process');
vi.mock('@routekit/rag/tools');

import { execSync, execFileSync } from 'node:child_process';
import { runRagEmbed } from '@routekit/rag/tools';
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

// commitAndEmbed suppresses the embed whenever VITEST or RKS_SKIP_BACKGROUND_EMBED
// is set — which is ALWAYS true in here, since vitest sets VITEST itself. Every
// test that exercises the embed path must therefore lift the guard first.
const EMBED_GUARD_VARS = ['VITEST', 'RKS_SKIP_BACKGROUND_EMBED'];
const savedEnv = {};

/** Lift the guard so the embed path actually runs. */
function enableEmbed() {
  for (const k of EMBED_GUARD_VARS) delete process.env[k];
}

describe('commitAndEmbed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 5 });
    for (const k of EMBED_GUARD_VARS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of EMBED_GUARD_VARS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('successful commit returns { commitId } as 40-char SHA', async () => {
    setupExecSync();
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBeUndefined();
  });

  it('calls runRagEmbed with file list from git diff after commit', async () => {
    enableEmbed();
    setupExecSync('notes/foo.md\nnotes/bar.md');
    await commitAndEmbed('/proj', 'test message');
    expect(runRagEmbed).toHaveBeenCalledWith('/proj', {
      files: ['notes/foo.md', 'notes/bar.md'],
    });
  });

  it('embed throws → returns { commitId, ragEmbedWarning } without rethrowing', async () => {
    enableEmbed();
    setupExecSync();
    runRagEmbed.mockRejectedValueOnce(new Error('embed crashed'));
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(result.ragEmbedWarning).toBe('embed crashed');
  });

  it('embed returns ok:false → returns { commitId, ragEmbedWarning }', async () => {
    enableEmbed();
    setupExecSync();
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'embed lock held' });
    const result = await commitAndEmbed('/proj', 'test message');
    expect(result.commitId).toBe(FAKE_SHA);
    expect(typeof result.ragEmbedWarning).toBe('string');
    expect(result.ragEmbedWarning.length).toBeGreaterThan(0);
  });

  describe('test-embed guard', () => {
    it('suppresses the embed under VITEST and reports ragEmbedSkipped', async () => {
      setupExecSync();
      process.env.VITEST = 'true';
      const result = await commitAndEmbed('/proj', 'test message');
      expect(runRagEmbed).not.toHaveBeenCalled();
      expect(result.ragEmbedSkipped).toBe(true);
      // Suppression is not a warning — nothing went wrong.
      expect(result.ragEmbedWarning).toBeUndefined();
      // The commit is load-bearing and still happened.
      expect(result.commitId).toBe(FAKE_SHA);
    });

    it('suppresses the embed under RKS_SKIP_BACKGROUND_EMBED alone', async () => {
      setupExecSync();
      delete process.env.VITEST;
      process.env.RKS_SKIP_BACKGROUND_EMBED = '1';
      const result = await commitAndEmbed('/proj', 'test message');
      expect(runRagEmbed).not.toHaveBeenCalled();
      expect(result.ragEmbedSkipped).toBe(true);
    });

    // POSITIVE CONTROL. Without this passing, both negative assertions above are
    // vacuous — they would also hold if commitAndEmbed simply never embedded.
    it('embeds once the guard is lifted, and sets no ragEmbedSkipped', async () => {
      enableEmbed();
      setupExecSync();
      const result = await commitAndEmbed('/proj', 'test message');
      expect(runRagEmbed).toHaveBeenCalledTimes(1);
      expect(result.ragEmbedSkipped).toBeUndefined();
    });
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
