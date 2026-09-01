import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runGitShow,
  runGitBlame,
  runGitDescribe,
  runGitBranchList,
  runGitRemoteList,
} from '../../packages/mcp-rks/src/server/git-tools.mjs';
import { createGitAgent } from '../../packages/mcp-rks/src/agents/git.mjs';

// ---------------------------------------------------------------------------
// Temp repo setup
// ---------------------------------------------------------------------------
let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-git-read-tools-'));
  spawnSync('git', ['init', '--initial-branch=main', tmpDir], { timeout: 10000 });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, timeout: 5000 });
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'line one\nline two\nline three\n');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['tag', 'v0.1.0'], { cwd: tmpDir, timeout: 5000 });
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'], { cwd: tmpDir, timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Exports from git-tools.mjs
// ---------------------------------------------------------------------------
describe('git-tools.mjs exports', () => {
  it('exports runGitShow', () => expect(typeof runGitShow).toBe('function'));
  it('exports runGitBlame', () => expect(typeof runGitBlame).toBe('function'));
  it('exports runGitDescribe', () => expect(typeof runGitDescribe).toBe('function'));
  it('exports runGitBranchList', () => expect(typeof runGitBranchList).toBe('function'));
  it('exports runGitRemoteList', () => expect(typeof runGitRemoteList).toBe('function'));
});

// ---------------------------------------------------------------------------
// runGitShow
// ---------------------------------------------------------------------------
describe('runGitShow', () => {
  it('returns commit content for HEAD', () => {
    const result = runGitShow(tmpDir);
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/initial commit/);
  });

  it('returns file content when path is provided', () => {
    const result = runGitShow(tmpDir, { path: 'hello.txt' });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatch(/line one/);
  });

  it('returns error for invalid ref', () => {
    const result = runGitShow(tmpDir, { ref: 'nonexistent-sha-abc123' });
    expect(result.error).toBeDefined();
  });

  it('never throws — catches errors', () => {
    expect(() => runGitShow(tmpDir, { ref: 'bad-ref' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runGitBlame
// ---------------------------------------------------------------------------
describe('runGitBlame', () => {
  it('returns blame entries with sha, author, line fields', () => {
    const result = runGitBlame(tmpDir, { path: 'hello.txt' });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.blame)).toBe(true);
    expect(result.blame.length).toBeGreaterThan(0);
    const entry = result.blame[0];
    expect(entry).toHaveProperty('sha');
    expect(entry).toHaveProperty('author');
    expect(entry).toHaveProperty('line');
  });

  it('returns error when path is missing', () => {
    const result = runGitBlame(tmpDir, {});
    expect(result.error).toBeDefined();
  });

  it('never throws', () => {
    expect(() => runGitBlame(tmpDir, { path: 'nonexistent.txt' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runGitDescribe
// ---------------------------------------------------------------------------
describe('runGitDescribe', () => {
  it('returns a description string including the tag', () => {
    // v0.1.0 is a lightweight tag — requires --tags flag
    const result = runGitDescribe(tmpDir, { tagsOnly: true });
    expect(result.error).toBeUndefined();
    expect(result.description).toMatch(/v0\.1\.0/);
  });

  it('never throws', () => {
    expect(() => runGitDescribe(tmpDir, { ref: 'nonexistent' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runGitBranchList
// ---------------------------------------------------------------------------
describe('runGitBranchList', () => {
  it('returns branches array', () => {
    const result = runGitBranchList(tmpDir);
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.branches)).toBe(true);
    expect(result.branches.length).toBeGreaterThan(0);
  });

  it('each branch has name and current fields', () => {
    const result = runGitBranchList(tmpDir);
    for (const b of result.branches) {
      expect(b).toHaveProperty('name');
      expect(b).toHaveProperty('current');
    }
  });

  it('marks the active branch as current', () => {
    const result = runGitBranchList(tmpDir);
    const current = result.branches.filter(b => b.current);
    expect(current.length).toBe(1);
    expect(current[0].name).toBe('main');
  });

  it('never throws', () => {
    expect(() => runGitBranchList(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runGitRemoteList
// ---------------------------------------------------------------------------
describe('runGitRemoteList', () => {
  it('returns remotes array', () => {
    const result = runGitRemoteList(tmpDir);
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.remotes)).toBe(true);
    expect(result.remotes[0].name).toBe('origin');
  });

  it('with verbose=true, includes fetch/push URLs', () => {
    const result = runGitRemoteList(tmpDir, { verbose: true });
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.remotes)).toBe(true);
    const origin = result.remotes.find(r => r.name === 'origin');
    expect(origin).toBeDefined();
    expect(origin.fetch || origin.push).toBeDefined();
  });

  it('never throws', () => {
    expect(() => runGitRemoteList(tmpDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// git agent tool registration
// ---------------------------------------------------------------------------
describe('createGitAgent — tool registration', () => {
  let agent;

  beforeAll(() => {
    agent = createGitAgent({ projectId: 'test', request: 'test', projectRoot: tmpDir });
  });

  it('registers git_show', () => {
    expect(agent.tools.some(t => t.name === 'git_show')).toBe(true);
  });

  it('registers git_blame', () => {
    expect(agent.tools.some(t => t.name === 'git_blame')).toBe(true);
  });

  it('registers git_describe', () => {
    expect(agent.tools.some(t => t.name === 'git_describe')).toBe(true);
  });

  it('registers git_branch_list', () => {
    expect(agent.tools.some(t => t.name === 'git_branch_list')).toBe(true);
  });

  it('registers git_remote', () => {
    expect(agent.tools.some(t => t.name === 'git_remote')).toBe(true);
  });

  it('existing git_branch tool still registered and unchanged', () => {
    const branch = agent.tools.find(t => t.name === 'git_branch');
    expect(branch).toBeDefined();
    expect(branch.inputSchema.shape.name).toBeDefined();
  });

  it('all read tools have read-only execute (no mutation flags verifiable from name)', () => {
    const readTools = ['git_show', 'git_blame', 'git_describe', 'git_branch_list', 'git_remote'];
    for (const name of readTools) {
      const tool = agent.tools.find(t => t.name === name);
      expect(tool).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    }
  });
});
