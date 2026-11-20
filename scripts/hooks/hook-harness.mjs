import { spawn } from 'child_process';
import path from 'path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOKS_DIR = path.join(PROJECT_ROOT, '.routekit/hooks');

/**
 * Simulate a hook call and return the result
 *
 * @param {string} hookName - Name of the hook file (e.g., 'enforce-plan-scope.mjs')
 * @param {string} toolName - Tool name ('Edit', 'Write', 'Bash')
 * @param {object} toolInput - Tool input (e.g., { file_path: '...' } or { command: '...' })
 * @param {object} env - Additional environment variables
 * @returns {Promise<{code: number, stdout: string, stderr: string, blocked: boolean}>}
 */
export async function callHook(hookName, toolName, toolInput, env = {}) {
  const hookPath = path.join(HOOKS_DIR, hookName);
  const input = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
  });

  return new Promise((resolve) => {
    const proc = spawn('node', [hookPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_ROOT, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.stdin.write(input);
    proc.stdin.end();

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr, blocked: code === 2 });
    });
  });
}
