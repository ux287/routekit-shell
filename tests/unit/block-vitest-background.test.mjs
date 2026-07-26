import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const HOOK = path.resolve('.routekit/hooks/system/block-vitest-background.mjs');

function runHook(toolInput) {
  const hookData = {
    tool_name: 'Bash',
    tool_input: toolInput,
  };
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify(hookData),
    encoding: 'utf8',
    timeout: 5000,
  });
  return result;
}

describe('block-vitest-background hook', () => {
  it('denies vitest run with run_in_background: true', () => {
    const result = runHook({ command: 'npx vitest run', run_in_background: true });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/BLOCKED/);
  });

  it('allows vitest run with run_in_background: false', () => {
    const result = runHook({ command: 'npx vitest run', run_in_background: false });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows vitest run without run_in_background field', () => {
    const result = runHook({ command: 'npx vitest run' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('allows non-vitest background commands', () => {
    const result = runHook({ command: 'npm run build', run_in_background: true });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('ignores non-Bash tools', () => {
    const hookData = { tool_name: 'Write', tool_input: { command: 'vitest run', run_in_background: true } };
    const result = spawnSync('node', [HOOK], {
      input: JSON.stringify(hookData),
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('denial message references CLAUDE.md § Test Execution', () => {
    const result = runHook({ command: 'npx vitest run --reporter=verbose', run_in_background: true });
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/CLAUDE\.md/);
    expect(output.hookSpecificOutput.permissionDecisionReason).toMatch(/Test Execution/);
  });
});
