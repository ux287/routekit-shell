/**
 * Tests for the `--all` flag in handleProjectCommand's sync subcommand.
 *
 * `routekit project sync --all` iterates the invoking shell's registry and
 * runs syncProject() against every registered child. Per-child failures must
 * not abort the batch.
 *
 * All tests use deps injection to mock syncProject, loadProjects, and
 * processExit — no real subprocess, no real registry file I/O.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleProjectCommand } from '../../packages/cli/src/cli/project.js';

function makeFakeChild(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), `sync-all-${prefix}-`));
  mkdirSync(root, { recursive: true });
  return root;
}

describe('handleProjectCommand — sync --all', () => {
  let SHELL_ROOT;
  let childA, childB, childC;
  let processExit, syncProject, loadProjects;

  beforeEach(() => {
    SHELL_ROOT = mkdtempSync(path.join(os.tmpdir(), 'sync-all-shell-'));
    childA = makeFakeChild('a');
    childB = makeFakeChild('b');
    childC = makeFakeChild('c');
    processExit = vi.fn();
    syncProject = vi.fn(() => ['file1.txt', 'file2.txt']);
  });

  afterEach(() => {
    for (const dir of [SHELL_ROOT, childA, childB, childC]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupRegistry(records) {
    loadProjects = vi.fn(() => records);
  }

  it('iterates every registered project and invokes syncProject once per child', async () => {
    setupRegistry([
      { id: 'child-a', root: childA, stack: 'app' },
      { id: 'child-b', root: childB, stack: 'app' },
      { id: 'child-c', root: childC, stack: 'app' },
    ]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(loadProjects).toHaveBeenCalledWith(SHELL_ROOT);
    expect(syncProject).toHaveBeenCalledTimes(3);
  });

  // backlog.feat.child-lifecycle.upgrade-all-from-release — --from-release also applies to sync.
  it('--from-release overrides the CONTENT shellRoot; children still resolve from SHELL_ROOT', async () => {
    const release = mkdtempSync(path.join(os.tmpdir(), 'sync-rel-'));
    writeFileSync(path.join(release, 'package.json'), '{"name":"routekit-shell","version":"0.20.39"}');
    try {
      setupRegistry([{ id: 'child-a', root: childA, stack: 'app' }]);
      await handleProjectCommand(
        { sub: 'sync', kv: { all: true, 'from-release': release }, SHELL_ROOT },
        { processExit, syncProject, loadProjects },
      );
      expect(loadProjects).toHaveBeenCalledWith(SHELL_ROOT); // registry from the default shell root
      expect(syncProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: childA, shellRoot: path.resolve(release) }),
      ); // content copied FROM the release
    } finally {
      rmSync(release, { recursive: true, force: true });
    }
  });

  it('passes projectRoot from record.root, projectId from record.id, and shellRoot=SHELL_ROOT to each syncProject', async () => {
    setupRegistry([{ id: 'child-a', root: childA, stack: 'app' }]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(syncProject).toHaveBeenCalledWith({
      projectRoot: childA,
      projectId: 'child-a',
      shellRoot: SHELL_ROOT,
    });
  });

  it('falls back to record.path when record.root is absent', async () => {
    setupRegistry([{ id: 'child-x', path: childA, stack: 'app' }]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(syncProject).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: childA }));
  });

  it('continues the batch when a per-child syncProject throws — subsequent children still process', async () => {
    setupRegistry([
      { id: 'child-a', root: childA, stack: 'app' },
      { id: 'child-b', root: childB, stack: 'app' },
      { id: 'child-c', root: childC, stack: 'app' },
    ]);
    let callCount = 0;
    syncProject = vi.fn(() => {
      callCount += 1;
      if (callCount === 2) throw new Error('simulated failure');
      return ['file.txt'];
    });
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(syncProject).toHaveBeenCalledTimes(3);
  });

  it('exit code is 0 when every child succeeded', async () => {
    setupRegistry([
      { id: 'child-a', root: childA, stack: 'app' },
      { id: 'child-b', root: childB, stack: 'app' },
    ]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(processExit).toHaveBeenCalledWith(0);
  });

  it('exit code is non-zero when at least one child failed', async () => {
    setupRegistry([
      { id: 'child-a', root: childA, stack: 'app' },
      { id: 'child-b', root: childB, stack: 'app' },
    ]);
    syncProject = vi.fn(() => { throw new Error('boom'); });
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    const codes = processExit.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });

  it('reports a child as failed when its resolved root does not exist on disk; batch continues', async () => {
    setupRegistry([
      { id: 'missing-root', root: '/var/empty/definitely-does-not-exist-' + Date.now() },
      { id: 'child-b', root: childB, stack: 'app' },
    ]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    // syncProject was not invoked for the missing one, but was for the survivor.
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(syncProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'child-b' }));
  });

  it('empty registry prints "No projects to sync." and exits 0', async () => {
    setupRegistry([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleProjectCommand(
        { sub: 'sync', kv: { all: true }, SHELL_ROOT },
        { processExit, syncProject, loadProjects },
      );
      const messages = logSpy.mock.calls.map((c) => c.join(' '));
      expect(messages.join('\n')).toContain('No projects to sync');
      expect(processExit).toHaveBeenCalledWith(0);
      expect(syncProject).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('--all combined with --id is rejected; syncProject never invoked', async () => {
    setupRegistry([{ id: 'child-a', root: childA }]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true, id: 'child-a' }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(syncProject).not.toHaveBeenCalled();
    const codes = processExit.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });

  it('--all combined with --path is rejected; syncProject never invoked', async () => {
    setupRegistry([{ id: 'child-a', root: childA }]);
    await handleProjectCommand(
      { sub: 'sync', kv: { all: true, path: childA }, SHELL_ROOT },
      { processExit, syncProject, loadProjects },
    );
    expect(syncProject).not.toHaveBeenCalled();
    const codes = processExit.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });
});

describe('handleProjectCommand — sync (single-project mode preserved)', () => {
  let SHELL_ROOT, childA;
  let processExit, syncProject, getProjectById;

  beforeEach(() => {
    SHELL_ROOT = mkdtempSync(path.join(os.tmpdir(), 'sync-single-shell-'));
    childA = mkdtempSync(path.join(os.tmpdir(), 'sync-single-child-'));
    processExit = vi.fn();
    syncProject = vi.fn(() => ['x.txt']);
    getProjectById = vi.fn(() => ({ id: 'child-a', root: childA }));
  });

  afterEach(() => {
    rmSync(SHELL_ROOT, { recursive: true, force: true });
    rmSync(childA, { recursive: true, force: true });
  });

  it('--id <id> --path <root> still invokes syncProject exactly once (unchanged single-project behavior)', async () => {
    await handleProjectCommand(
      { sub: 'sync', kv: { id: 'child-a', path: childA }, SHELL_ROOT },
      { processExit, syncProject, getProjectById },
    );
    expect(syncProject).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(0);
  });

  it('sync without --all, --id, or --path emits the usage error and exits non-zero', async () => {
    await handleProjectCommand(
      { sub: 'sync', kv: {}, SHELL_ROOT },
      { processExit, syncProject, getProjectById },
    );
    expect(syncProject).not.toHaveBeenCalled();
    const codes = processExit.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });
});
