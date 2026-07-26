import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies
vi.mock('./git-tools.mjs', () => ({
  runGitPR: vi.fn(),
  runStagingMerge: vi.fn(),
  runCycleComplete: vi.fn(),
}));

vi.mock('./project.mjs', () => ({
  loadContext: vi.fn(() => ({ record: { root: '/test/project' } })),
}));

vi.mock('./telemetry/collector.mjs', () => ({
  getTelemetryCollector: vi.fn(() => ({
    emit: vi.fn(),
  })),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'feature-branch\n' })),
}));

describe('runStoryShipTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates PR when none exists', async () => {
    const { spawnSync } = await import('child_process');
    const { runGitPR, runStagingMerge, runCycleComplete } = await import('./git-tools.mjs');
    
    // Mock: no existing PR
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'branch') {
        return { status: 0, stdout: 'feature-branch\n' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { status: 1, stdout: '' }; // No PR exists
      }
      return { status: 0, stdout: '' };
    });
    
    runGitPR.mockResolvedValue({ ok: true, url: 'https://github.com/test/pr/1' });
    runStagingMerge.mockResolvedValue({ ok: true, commitId: 'abc123' });
    runCycleComplete.mockResolvedValue({ ok: true, branch: 'staging' });
    
    const { runStoryShipTool } = await import('./story-ship.mjs');
    const result = await runStoryShipTool({ projectId: 'test', problemId: 'backlog.test' });
    
    expect(result.ok).toBe(true);
    expect(runGitPR).toHaveBeenCalled();
  });

  it('skips PR creation when PR exists', async () => {
    const { spawnSync } = await import('child_process');
    const { runGitPR, runStagingMerge, runCycleComplete } = await import('./git-tools.mjs');
    
    // Mock: existing OPEN PR
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'branch') {
        return { status: 0, stdout: 'feature-branch\n' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ url: 'https://github.com/test/pr/1', state: 'OPEN' }) };
      }
      return { status: 0, stdout: '' };
    });
    
    runStagingMerge.mockResolvedValue({ ok: true, commitId: 'abc123' });
    runCycleComplete.mockResolvedValue({ ok: true, branch: 'staging' });
    
    const { runStoryShipTool } = await import('./story-ship.mjs');
    const result = await runStoryShipTool({ projectId: 'test', problemId: 'backlog.test' });
    
    expect(result.ok).toBe(true);
    expect(runGitPR).not.toHaveBeenCalled();
    expect(result.stepsSkipped).toBeGreaterThan(0);
  });

  it('succeeds when PR already merged (idempotent)', async () => {
    const { spawnSync } = await import('child_process');
    const { runGitPR, runStagingMerge, runCycleComplete } = await import('./git-tools.mjs');
    
    // Mock: already merged PR
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'branch') {
        return { status: 0, stdout: 'feature-branch\n' };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ url: 'https://github.com/test/pr/1', state: 'MERGED' }) };
      }
      return { status: 0, stdout: '' };
    });
    
    runCycleComplete.mockResolvedValue({ ok: true, branch: 'staging' });
    
    const { runStoryShipTool } = await import('./story-ship.mjs');
    const result = await runStoryShipTool({ projectId: 'test', problemId: 'backlog.test' });
    
    expect(result.ok).toBe(true);
    expect(runGitPR).not.toHaveBeenCalled();
    expect(runStagingMerge).not.toHaveBeenCalled();
  });

  it('returns success when already on staging', async () => {
    const { spawnSync } = await import('child_process');
    
    // Mock: already on staging
    spawnSync.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'branch') {
        return { status: 0, stdout: 'staging\n' };
      }
      return { status: 0, stdout: '' };
    });
    
    const { runStoryShipTool } = await import('./story-ship.mjs');
    const result = await runStoryShipTool({ projectId: 'test', problemId: 'backlog.test' });
    
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
  });
});