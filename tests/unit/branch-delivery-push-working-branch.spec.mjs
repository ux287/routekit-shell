/**
 * backlog.fix.story-ship-mark-implemented-commit-stranded-after-push
 *
 * pushWorkingBranch is the one push primitive in git/branch-delivery.mjs. It must report
 * the OBSERVED push outcome, refuse a missing branch before spawning anything, and
 * deliverFeatureBranch must still emit the identical push_working record after delegating
 * its push to it (off-rail delivery regression).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// branch-delivery.mjs imports "node:child_process"; local-merge.mjs imports "child_process".
// Vitest resolves both specifiers to the same mocked module id here (measured: with two
// separate fns, the node:-prefixed import reached the bare mock), so both delegate to ONE fn.
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a) => spawnSyncMock(...a) }));
vi.mock('child_process', () => ({ spawnSync: (...a) => spawnSyncMock(...a) }));
const pushCalls = () => spawnSyncMock.mock.calls.filter(([, args]) => args && args[0] === 'push');

const MODULE = '../../packages/mcp-rks/src/server/git/branch-delivery.mjs';
const branchConfig = { working: 'staging', integration: 'staging', production: 'main' };
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe('branch-delivery.mjs — one push spawn, exported helper', () => {
  it('exports pushWorkingBranch and keeps exactly one git push spawn in code', () => {
    const code = codeOnly(fs.readFileSync(path.resolve('packages/mcp-rks/src/server/git/branch-delivery.mjs'), 'utf8'));
    expect(code).toMatch(/export\s+function\s+pushWorkingBranch\s*\(/);
    expect(code.match(/spawnSync\(\s*"git",\s*\[\s*"push"/g)).toHaveLength(1);
  });
});

describe('pushWorkingBranch — observed push outcome', () => {
  it('throws a TypeError for a missing, empty or non-string branch, and spawns nothing', async () => {
    const { pushWorkingBranch } = await import(MODULE);
    for (const branch of [undefined, '', null, 0, 123, {}, []]) {
      expect(() => pushWorkingBranch({ projectRoot: '/tmp/x', branch })).toThrow(TypeError);
    }
    expect(() => pushWorkingBranch({ projectRoot: '/tmp/x' })).toThrow(/branch/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('spawns git push origin <branch> with an explicit refspec, the caller cwd and a timeout', async () => {
    const { pushWorkingBranch } = await import(MODULE);
    spawnSyncMock.mockImplementation(() => ({ status: 0, stdout: '', stderr: '' }));
    pushWorkingBranch({ projectRoot: '/tmp/x', branch: 'staging' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['push', 'origin', 'staging']);
    expect(opts.cwd).toBe('/tmp/x');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('status 0 yields ok true with no error', async () => {
    const { pushWorkingBranch } = await import(MODULE);
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    expect(pushWorkingBranch({ projectRoot: '/tmp/x', branch: 'staging' }))
      .toEqual({ ok: true, branch: 'staging', remote: 'origin' });
  });

  it('non-zero status yields ok false with error taken from trimmed stderr', async () => {
    const { pushWorkingBranch } = await import(MODULE);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: '  ! [remote rejected] staging (pre-receive hook declined)\n' });
    const result = pushWorkingBranch({ projectRoot: '/tmp/x', branch: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.branch).toBe('staging');
    expect(result.remote).toBe('origin');
    expect(result.error).toBe('! [remote rejected] staging (pre-receive hook declined)');
  });

  it('non-zero status with empty stderr is still ok false with a non-empty error', async () => {
    const { pushWorkingBranch } = await import(MODULE);
    spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: '' });
    const result = pushWorkingBranch({ projectRoot: '/tmp/x', branch: 'staging' });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe('deliverFeatureBranch — push_working record unchanged after delegation', () => {
  function arrange(pushResult) {
    // localMerge (checkout, merge, branch -d) and the branch --list probe all succeed
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (args[0] === 'push') return pushResult;
      return { status: 0, stdout: '', stderr: '' }; // branch --list empty -> delete_branch ok
    });
  }

  it('success: identical push_working record, delivery ok, one push spawn', async () => {
    const { deliverFeatureBranch } = await import(MODULE);
    arrange({ status: 0, stdout: '', stderr: '' });
    const result = deliverFeatureBranch({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig, target: 'staging' });
    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.kind === 'push_working'))
      .toEqual({ kind: 'push_working', ok: true, branch: 'staging', remote: 'origin' });
    const pushes = pushCalls();
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toEqual(['push', 'origin', 'staging']);
  });

  it('failure: identical push_working record with stderr error, delivery not ok', async () => {
    const { deliverFeatureBranch } = await import(MODULE);
    arrange({ status: 1, stdout: '', stderr: 'denied\n' });
    const result = deliverFeatureBranch({ projectRoot: '/tmp/x', featureBranch: 'f', branchConfig, target: 'staging' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('denied');
    expect(result.steps.find((s) => s.kind === 'push_working'))
      .toEqual({ kind: 'push_working', ok: false, branch: 'staging', remote: 'origin', error: 'denied' });
  });
});
