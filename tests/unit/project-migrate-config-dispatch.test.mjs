/**
 * Unit tests for the `sub === 'migrate-config'` branch in handleProjectCommand.
 *
 * Uses deps injection (deps.migrateConfig, deps.processExit, deps.getProjectById).
 */
import { describe, it, expect, vi } from 'vitest';
import { handleProjectCommand } from '../../packages/cli/src/cli/project.js';

const SHELL_ROOT = '/tmp/shell-root';
const REGISTRY_RECORD = { id: 'fixture-child', root: '/tmp/child-root' };

function makeDeps(overrides = {}) {
  return {
    processExit: vi.fn(),
    migrateConfig: vi.fn(() => ({ ok: true, applied: ['1→2'], fromVersion: 1, currentVersion: 2, noOp: false })),
    getProjectById: vi.fn(() => REGISTRY_RECORD),
    ...overrides,
  };
}

describe('handleProjectCommand — sub === "migrate-config"', () => {
  it('routes the migrate-config subcommand and invokes migrateConfig with the resolved project root', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'migrate-config', kv: { id: 'fixture-child' }, SHELL_ROOT },
      deps,
    );
    expect(deps.getProjectById).toHaveBeenCalledWith('fixture-child', SHELL_ROOT);
    expect(deps.migrateConfig).toHaveBeenCalledWith({ projectRoot: REGISTRY_RECORD.root });
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when --id is missing', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'migrate-config', kv: {}, SHELL_ROOT },
      deps,
    );
    expect(deps.migrateConfig).not.toHaveBeenCalled();
    const exitCall = deps.processExit.mock.calls[0];
    expect(exitCall[0]).not.toBe(0);
  });

  it('exits non-zero when getProjectById returns null', async () => {
    const deps = makeDeps({ getProjectById: vi.fn(() => null) });
    await handleProjectCommand(
      { sub: 'migrate-config', kv: { id: 'unknown' }, SHELL_ROOT },
      deps,
    );
    expect(deps.migrateConfig).not.toHaveBeenCalled();
    const exitCall = deps.processExit.mock.calls[0];
    expect(exitCall[0]).not.toBe(0);
  });

  it('applied-migrations success → prints summary including from/to versions; exits 0', async () => {
    const deps = makeDeps();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleProjectCommand(
        { sub: 'migrate-config', kv: { id: 'fixture-child' }, SHELL_ROOT },
        deps,
      );
      const messages = logSpy.mock.calls.map((c) => c.join(' '));
      const joined = messages.join('\n');
      expect(joined).toMatch(/1.*2|2|migrated/i);
      expect(deps.processExit).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('no-op (already at latest) → prints "already at latest schemaVersion N"; exits 0', async () => {
    const deps = makeDeps({
      migrateConfig: vi.fn(() => ({ ok: true, applied: [], fromVersion: 1, currentVersion: 1, noOp: true })),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleProjectCommand(
        { sub: 'migrate-config', kv: { id: 'fixture-child' }, SHELL_ROOT },
        deps,
      );
      const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(joined).toMatch(/already at latest schemaVersion 1/);
      expect(deps.processExit).toHaveBeenCalledWith(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('migrateConfig throws → prints error and exits non-zero', async () => {
    const err = new Error('migration boom');
    const deps = makeDeps({ migrateConfig: vi.fn(() => { throw err; }) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleProjectCommand(
        { sub: 'migrate-config', kv: { id: 'fixture-child' }, SHELL_ROOT },
        deps,
      );
      const exitCall = deps.processExit.mock.calls[0];
      expect(exitCall[0]).not.toBe(0);
      const messages = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(messages).toContain('migration boom');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
