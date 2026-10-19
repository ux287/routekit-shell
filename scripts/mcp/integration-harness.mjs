#!/usr/bin/env node
/**
 * MCP Integration Test Harness
 *
 * Spawns the MCP server and invokes tools via JSON-RPC over stdio.
 * @see backlog.test.mcp-integration
 */

import { spawn } from 'child_process';
import readline from 'readline';

/**
 * Create an MCP client that communicates with a subprocess using a simple
 * line-delimited JSON-RPC 2.0 protocol over stdio.
 *
 * Options:
 *  - cmd: command to spawn (default: 'node')
 *  - args: array of args (default: [])
 *  - cwd: working directory
 *  - timeout: per-request timeout ms
 */
export async function createMcpClient({ cmd = 'node', args = [], cwd = process.cwd(), timeout = 5000 } = {}) {
  const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: proc.stdout });
  let nextId = 1;
  const pending = new Map();

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(String(msg.id))) {
        const { resolve } = pending.get(String(msg.id));
        pending.delete(String(msg.id));
        resolve(msg);
      }
    } catch (err) {
      // ignore non-JSON lines
    }
  });

  proc.on('exit', (code, signal) => {
    for (const { reject } of pending.values()) {
      reject(new Error(`mcp process exited: ${code ?? signal}`));
    }
    pending.clear();
  });

  function sendRequest(method, params = {}) {
    const id = String(nextId++);
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('request timeout'));
        }
      }, timeout);

      pending.set(id, {
        resolve: (res) => {
          clearTimeout(timeoutHandle);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timeoutHandle);
          reject(err);
        },
      });

      try {
        proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        pending.delete(id);
        clearTimeout(timeoutHandle);
        reject(err);
      }
    });
  }

  async function close() {
    try { proc.stdin.end(); } catch (e) {}
    await new Promise((resolve) => proc.once('exit', resolve));
  }

  return { sendRequest, close, proc };
}
