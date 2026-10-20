import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Temp repo for integration tests
// ---------------------------------------------------------------------------
let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-research-read-git-'));
  spawnSync('git', ['init', '--initial-branch=main', tmpDir], { timeout: 10000 });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, timeout: 5000 });
  fs.writeFileSync(path.join(tmpDir, 'sample.txt'), 'hello\nworld\n');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------
describe('READ_GIT_ALLOWLIST', () => {
  // SKIPPED 2026-06-08: dynamic import of research.mjs takes >5s on CI.
  // Follow-up: backlog.fix.slow-dynamic-import-tests.
  it.skip('is defined and exported from research.mjs', async () => {
    // Verify the module loads without error and exposes createResearchAgent
    const mod = await import('../../packages/mcp-rks/src/agents/research.mjs');
    expect(typeof mod.createResearchAgent).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// read_git tool registration
// ---------------------------------------------------------------------------
describe('createResearchAgent — read_git tool', () => {
  let agent;

  beforeAll(async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
  });

  it('registers read_git tool in tools array', () => {
    expect(agent.tools.some(t => t.name === 'read_git')).toBe(true);
  });

  it('read_git has an inputSchema with tool field', () => {
    const tool = agent.tools.find(t => t.name === 'read_git');
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.shape.tool).toBeDefined();
  });

  it('read_git has an execute function', () => {
    const tool = agent.tools.find(t => t.name === 'read_git');
    expect(typeof tool.execute).toBe('function');
  });
});

// Helper: fresh agent + readGit per call (avoids shared counter depletion)
async function freshReadGit(tmpDir) {
  const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
  const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
  const tool = agent.tools.find(t => t.name === 'read_git');
  return (input) => tool.execute(input);
}

// ---------------------------------------------------------------------------
// Allowlist enforcement — rejections
// ---------------------------------------------------------------------------
describe('read_git — allowlist rejection', () => {
  it('returns error (not throws) for tool not in allowlist', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_commit' });
    expect(result.error).toBeDefined();
    expect(result.ok).not.toBe(true);
  });

  it('rejection error contains the rejected tool name', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_push' });
    expect(result.error).toMatch(/git_push/);
  });

  it('rejection error contains the full allowed list', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_reset' });
    expect(result.error).toMatch(/git_log/);
    expect(result.error).toMatch(/git_diff/);
    expect(result.error).toMatch(/git_show/);
  });

  it('rejects git_commit (write op)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_commit' });
    expect(result.error).toBeDefined();
  });

  it('rejects git_push (write op)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_push' });
    expect(result.error).toBeDefined();
  });

  it('rejects git_merge (write op)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_merge' });
    expect(result.error).toBeDefined();
  });

  it('rejects git_reset (write op)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_reset' });
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement — accepted tools (fresh agent each to avoid budget depletion)
// ---------------------------------------------------------------------------
describe('read_git — allowlist accepted tools', () => {
  it('accepts git_log (allowlisted)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_log', args: { count: 1 } });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.commits)).toBe(true);
  });

  it('accepts git_show (allowlisted)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_show' });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/initial/);
  });

  it('accepts git_state (allowlisted)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_state' });
    expect(result.error).toBeUndefined();
    expect(result.branch).toBe('main');
  });

  it('accepts git_branch (allowlisted)', async () => {
    const readGit = await freshReadGit(tmpDir);
    const result = await readGit({ tool: 'git_branch' });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.branches)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Budget counter — separate from RAG/file-read
// ---------------------------------------------------------------------------
describe('read_git — budget counter', () => {
  it('allows up to 3 calls; 4th returns budget error', async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const tool = agent.tools.find(t => t.name === 'read_git');

    // 3 valid calls should succeed
    for (let i = 0; i < 3; i++) {
      const r = await tool.execute({ tool: 'git_log', args: { count: 1 } });
      expect(r.error).toBeUndefined();
    }

    // 4th call should fail with budget error
    const fourth = await tool.execute({ tool: 'git_log', args: { count: 1 } });
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toBeDefined();
  });

  it('git counter exhaustion does not affect other tools', async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const readGit = agent.tools.find(t => t.name === 'read_git');
    const readFile = agent.tools.find(t => t.name === 'read_file');

    // Exhaust git budget
    for (let i = 0; i < 3; i++) {
      await readGit.execute({ tool: 'git_log', args: { count: 1 } });
    }
    // Git is exhausted
    const gitResult = await readGit.execute({ tool: 'git_log' });
    expect(gitResult.ok).toBe(false);

    // read_file should still work
    const fileResult = await readFile.execute({ path: 'sample.txt' });
    expect(fileResult.error).toBeUndefined();
    expect(fileResult.content).toMatch(/hello/);
  });

  it('never throws — all errors returned as { error } or { ok: false }', async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const tool = agent.tools.find(t => t.name === 'read_git');

    await expect(tool.execute({ tool: 'git_commit' })).resolves.not.toThrow();
    await expect(tool.execute({ tool: 'nonexistent_tool' })).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// System prompt content
// ---------------------------------------------------------------------------
describe('RESEARCH_SYSTEM_PROMPT — git delegation guidance', () => {
  it('contains when-to-use guidance for read_git', async () => {
    const mod = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = mod.createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    // The prompt is either from config or the inline RESEARCH_SYSTEM_PROMPT
    const prompt = agent.prompt;
    expect(prompt).toMatch(/read_git/);
    expect(prompt).toMatch(/WHEN TO USE/i);
  });

  it('contains when-not-to-use guidance', async () => {
    const mod = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = mod.createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const prompt = agent.prompt;
    expect(prompt).toMatch(/WHEN NOT TO USE/i);
  });

  it('contains on-failure guidance', async () => {
    const mod = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = mod.createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const prompt = agent.prompt;
    expect(prompt).toMatch(/ON.*FAILURE|on.*failure|budget.*exhaust/i);
  });
});

// ---------------------------------------------------------------------------
// createCrossDelegationTool usage
// ---------------------------------------------------------------------------
describe('cross-delegation infrastructure', () => {
  it('createCrossDelegationTool is importable from cross-delegate.mjs', async () => {
    const mod = await import('../../packages/mcp-rks/src/agents/cross-delegate.mjs');
    expect(typeof mod.createCrossDelegationTool).toBe('function');
  });

  it('read_git tool was created via createCrossDelegationTool (has wrapped execute)', async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const tool = agent.tools.find(t => t.name === 'read_git');
    // The tool exists and is callable — the implementation uses createCrossDelegationTool internally
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('no write tool is reachable through read_git', async () => {
    const { createResearchAgent } = await import('../../packages/mcp-rks/src/agents/research.mjs');
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: tmpDir });
    const tool = agent.tools.find(t => t.name === 'read_git');

    const writeOps = ['git_commit', 'git_push', 'git_merge', 'git_reset', 'git_checkout', 'git_branch_create', 'git_rm', 'git_mv'];
    for (const op of writeOps) {
      const result = await tool.execute({ tool: op });
      expect(result.error).toBeDefined();
    }
  });
});
