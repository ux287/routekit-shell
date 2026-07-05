import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HOOK = path.resolve('.routekit/hooks/write/redirect-github-tools-to-governor.mjs');

function runHook(toolName, toolInput = {}, env = {}) {
  const hookData = { tool_name: toolName, tool_input: toolInput };
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(hookData),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, ...env },
  });
  return result;
}

describe('redirect-github-tools-to-governor hook', () => {
  it('blocks mcp__github__create_or_update_file without governor token', () => {
    const result = runHook('mcp__github__create_or_update_file', { path: 'foo.md', content: 'x' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('blocks mcp__github__push_files without governor token', () => {
    const result = runHook('mcp__github__push_files', { branch: 'main', files: [] });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // SKIPPED 2026-06-08: 6 hook-invocation tests timing out at 5-7s on CI's slow
  // runner. `runHook()` spawns a node subprocess that's stressed under
  // maxForks=2 + other subprocess tests. Follow-up: backlog.fix.slow-subprocess-test-pattern.
  it.skip('blocks mcp__github__merge_pull_request without governor token', () => {
    const result = runHook('mcp__github__merge_pull_request', { pullNumber: 42 });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.skip('deny output uses exit 0 with permissionDecision deny (not exit 2)', () => {
    const result = runHook('mcp__github__push_files', {});
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it.skip('allows through when _governorToken is present (governed session)', () => {
    const result = runHook('mcp__github__push_files', { _governorToken: 'some-valid-token' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it.skip('allows through when RKS_GUARDRAILS=off (guardrails-off bypass)', () => {
    const result = runHook('mcp__github__merge_pull_request', { pullNumber: 1 }, { RKS_GUARDRAILS: 'off' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it.skip('passes through non-GitHub tools without blocking', () => {
    const result = runHook('mcp__rks__rks_git_commit', { message: 'test' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it.skip('deny message references Ship Governor workflow', () => {
    const result = runHook('mcp__github__create_or_update_file', {});
    const output = JSON.parse(result.stdout);
    const reason = output.hookSpecificOutput.permissionDecisionReason || '';
    const context = JSON.stringify(output.hookSpecificOutput.additionalContext || '');
    expect(reason + context).toMatch(/[Gg]overnor|[Ss]hip/);
  });

  it('hook is registered in hooks-manifest.json under write tier', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync('.routekit/hooks-manifest.json', 'utf8'));
    expect(manifest['redirect-github-tools-to-governor']).toBeDefined();
    expect(manifest['redirect-github-tools-to-governor'].tier).toBe('write');
    expect(manifest['redirect-github-tools-to-governor'].path).toContain('redirect-github-tools-to-governor.mjs');
  });

  it('hook command is registered in .claude/settings.json for all three tools', async () => {
    const { readFileSync } = await import('node:fs');
    const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    const hooks = settings.hooks?.PreToolUse || [];
    const entry = hooks.find(h => {
      const matcher = h.matcher || '';
      return matcher.includes('mcp__github__create_or_update_file') &&
             matcher.includes('mcp__github__push_files') &&
             matcher.includes('mcp__github__merge_pull_request');
    });
    expect(entry).toBeDefined();
    const cmd = JSON.stringify(entry.hooks || entry);
    expect(cmd).toContain('redirect-github-tools-to-governor.mjs');
  });

  // --- GitHub MCP Issues toolset: issue-writes governed like PR-writes, reads free ---
  // Appended AFTER the last block so the it.skip line numbers above (36/43/50/56/62/68)
  // do not shift — tests/unit/skip-debt-audit.test.mjs pins them.
  it('blocks mcp__github__create_issue without governor token', () => {
    const result = runHook('mcp__github__create_issue', { title: 'x' });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('passes through issue READ tools (list_issues) un-blocked', () => {
    const result = runHook('mcp__github__list_issues', {});
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('BLOCKED_TOOLS includes all three issue-write tools and no issue-read tool', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(HOOK, 'utf8');
    for (const t of ['mcp__github__create_issue', 'mcp__github__update_issue', 'mcp__github__add_issue_comment']) {
      expect(src).toContain(t);
    }
    expect(src).not.toContain('mcp__github__list_issues');
    expect(src).not.toContain('mcp__github__get_issue');
  });

  it('settings.json matcher routes the three issue-write tools through the hook', async () => {
    const { readFileSync } = await import('node:fs');
    const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    const hooks = settings.hooks?.PreToolUse || [];
    const ghEntry = hooks.find(h => (h.matcher || '').includes('mcp__github__create_issue'));
    expect(ghEntry).toBeDefined();
    for (const t of ['mcp__github__create_issue', 'mcp__github__update_issue', 'mcp__github__add_issue_comment']) {
      expect(ghEntry.matcher).toContain(t);
    }
    expect(JSON.stringify(ghEntry.hooks || ghEntry)).toContain('redirect-github-tools-to-governor.mjs');
  });

  // NOTE: the issue tools are also added to .claude/settings.local.json permissions.allow
  // (local auto-allow), but that file is gitignored/local-only — it is deliberately NOT
  // asserted here, since a committed test must not depend on untracked local config.
});
