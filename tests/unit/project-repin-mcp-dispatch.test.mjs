/**
 * Unit tests for the `sub === 'repin-mcp'` branch in handleProjectCommand.
 *
 * Mocks `repinMcpServer` and `getProjectById` via the deps-injection seam to
 * verify the dispatch contract without touching real filesystems or registries.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleProjectCommand } from '../../packages/cli/src/cli/project.js';

const SHELL_ROOT = '/tmp/shell-root';
const REGISTRY_RECORD = { id: 'fixture-child', root: '/tmp/child-root' };

function makeDeps(overrides = {}) {
  const processExit = vi.fn();
  const repinMcpServer = vi.fn(() => ({ ok: true, changed: true, mcpPath: '/tmp/child-root/.mcp.json' }));
  const getProjectById = vi.fn(() => REGISTRY_RECORD);
  return {
    processExit,
    repinMcpServer,
    getProjectById,
    ...overrides,
  };
}

describe('handleProjectCommand — sub === "repin-mcp"', () => {
  it('routes the repin-mcp subcommand and invokes repinMcpServer with the resolved project root and shellRoot', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'fixture-child' }, SHELL_ROOT },
      deps,
    );
    expect(deps.getProjectById).toHaveBeenCalledWith('fixture-child', SHELL_ROOT);
    expect(deps.repinMcpServer).toHaveBeenCalledWith({
      projectRoot: REGISTRY_RECORD.root,
      shellRoot: SHELL_ROOT,
    });
    expect(deps.processExit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when --id is missing', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: {}, SHELL_ROOT },
      deps,
    );
    expect(deps.repinMcpServer).not.toHaveBeenCalled();
    // Exit code argument must be a non-zero value.
    const exitCall = deps.processExit.mock.calls[0];
    expect(exitCall).toBeDefined();
    expect(exitCall[0]).not.toBe(0);
  });

  it('resolves project root via getProjectById from the registry when --path is not provided', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'fixture-child' }, SHELL_ROOT },
      deps,
    );
    expect(deps.getProjectById).toHaveBeenCalledWith('fixture-child', SHELL_ROOT);
    expect(deps.repinMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: REGISTRY_RECORD.root }),
    );
  });

  it('exits non-zero with a clear error when getProjectById returns null', async () => {
    const deps = makeDeps({ getProjectById: vi.fn(() => null) });
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'unknown-child' }, SHELL_ROOT },
      deps,
    );
    expect(deps.repinMcpServer).not.toHaveBeenCalled();
    const exitCall = deps.processExit.mock.calls[0];
    expect(exitCall[0]).not.toBe(0);
  });

  it('uses --shell argument as shellRoot when provided (overrides SHELL_ROOT)', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'fixture-child', shell: '/tmp/explicit-shell' }, SHELL_ROOT },
      deps,
    );
    expect(deps.repinMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ shellRoot: expect.stringContaining('explicit-shell') }),
    );
  });

  it('falls back to SHELL_ROOT when --shell is omitted', async () => {
    const deps = makeDeps();
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'fixture-child' }, SHELL_ROOT },
      deps,
    );
    expect(deps.repinMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ shellRoot: SHELL_ROOT }),
    );
  });

  it('exits non-zero when repinMcpServer throws', async () => {
    const err = new Error('boom');
    const deps = makeDeps({ repinMcpServer: vi.fn(() => { throw err; }) });
    await handleProjectCommand(
      { sub: 'repin-mcp', kv: { id: 'fixture-child' }, SHELL_ROOT },
      deps,
    );
    const exitCall = deps.processExit.mock.calls[0];
    expect(exitCall[0]).not.toBe(0);
  });
});
