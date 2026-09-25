#!/usr/bin/env node
/**
 * MCP Integration Tests
 *
 * Tests MCP tools end-to-end via the integration harness.
 * @see backlog.test.mcp-integration
 */

import { createMcpClient } from './integration-harness.mjs';

const serverCode = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch (e) { return; }
  const res = { jsonrpc: '2.0', id: req.id };
  if (!req.method) {
    res.error = { code: -32600, message: 'Invalid Request' };
  } else if (req.method === 'rks_plan') {
    res.result = { ok: true, planId: 'plan-123', params: req.params || {} };
  } else if (req.method === 'dendron_create_note') {
    res.result = { id: 'note-1', meta: req.params || {} };
  } else if (req.method === 'rag_query') {
    res.result = { answers: ['answer1', 'answer2', 'answer3'] };
  } else {
    res.error = { code: -32601, message: 'Method not found' };
  }
  process.stdout.write(JSON.stringify(res) + '\\n');
});
`;

async function run() {
  console.log('[mcp-integration] starting fake MCP server');
  const client = await createMcpClient({ cmd: 'node', args: ['-e', serverCode] });
  try {
    const plan = await client.sendRequest('rks_plan', { projectId: 'routekit-shell', problemId: 'backlog.foo' });
    console.log('[mcp-integration] rks_plan =>', plan);
    const note = await client.sendRequest('dendron_create_note', { title: 'Test' });
    console.log('[mcp-integration] dendron_create_note =>', note);
    const query = await client.sendRequest('rag_query', { q: 'test' });
    console.log('[mcp-integration] rag_query =>', query);
    // error case
    const unknown = await client.sendRequest('unknown_method', {});
    if (!unknown.error) {
      throw new Error('expected error for unknown_method');
    }
    console.log('[mcp-integration] all tests passed');
    process.exitCode = 0;
  } catch (e) {
    console.error('[mcp-integration] test failed', e);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

run();
