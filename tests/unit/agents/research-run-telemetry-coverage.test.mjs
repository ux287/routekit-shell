/**
 * backlog.feat.research-agent-run-telemetry-coverage — read_file tool_call read window and
 * selectAgentTools telemetryId forwarding. Unit tier: fake tools, a recording collector and a
 * stepping clock are injected. No I/O, no subprocess.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createToolHandlers, selectAgentTools } from '../../../packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs';

const WINDOW_KEYS = ['offset', 'limit', 'totalLines', 'truncatedWindow'];

function recordingCollector() {
  const events = [];
  return { events, emit: (event, projectId, data) => { events.push({ event, projectId, data }); }, flush: async () => {} };
}
const fakeTool = (name, execute) => ({ name, description: name, inputSchema: z.object({}).passthrough(), execute });
function handlersFor(tools) {
  const collector = recordingCollector();
  let t = 0;
  const handlers = createToolHandlers({
    tools, agent: 'research', projectId: 'proj-w', telemetryId: 'tid-w', model: 'model-w', collector, now: () => (t += 10),
  });
  return { handlers, collector };
}
const callFor = (collector, tool) =>
  collector.events.filter((e) => e.event === 'agent.research.tool_call' && e.data.tool === tool).at(-1)?.data;
const expectNoWindow = (data) => { for (const k of WINDOW_KEYS) expect(k in data, k).toBe(false); };

describe('read_file tool_call read window', () => {
  it('carries offset, limit and totalLines from the returned result and truncatedWindow true when offset + limit < totalLines', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ path: 'a.md', totalLines: 450, offset: 0, limit: 200, content: 'x' }))]);
    await handlers.callTool('read_file', { path: 'a.md' });
    expect(callFor(collector, 'read_file')).toMatchObject({ offset: 0, limit: 200, totalLines: 450, truncatedWindow: true });
  });

  it('truncatedWindow is false when offset + limit reaches totalLines', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ path: 'a.md', totalLines: 150, offset: 0, limit: 200, content: 'x' }))]);
    await handlers.callTool('read_file', { path: 'a.md' });
    expect(callFor(collector, 'read_file')).toMatchObject({ offset: 0, limit: 200, totalLines: 150, truncatedWindow: false });
  });

  it('window fields are taken from the result, not the input', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ path: 'a.md', totalLines: 100, offset: 5, limit: 10, content: 'x' }))]);
    await handlers.callTool('read_file', { path: 'a.md', offset: 0, limit: 999 });
    expect(callFor(collector, 'read_file')).toMatchObject({ offset: 5, limit: 10, totalLines: 100, truncatedWindow: true });
  });

  it('a read_file that returns an error result carries none of the window fields', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ error: 'File not found: a.md' }))]);
    await handlers.callTool('read_file', { path: 'a.md', offset: 3, limit: 4 });
    expectNoWindow(callFor(collector, 'read_file'));
  });

  it('a read_file that throws carries none of the window fields', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => { throw new Error('boom'); })]);
    await handlers.callTool('read_file', { path: 'a.md', offset: 3, limit: 4 });
    const data = callFor(collector, 'read_file');
    expect(data.ok).toBe(false);
    expectNoWindow(data);
  });

  it('a redacted dotenv result carries none of the window fields', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ path: '.env', redacted: true, variableNames: ['A'], content: '[REDACTED]' }))]);
    await handlers.callTool('read_file', { path: '.env' });
    expectNoWindow(callFor(collector, 'read_file'));
  });

  it('existing read_file and rag_query tool_call fields are unchanged and rag_query carries no window fields', async () => {
    const { handlers, collector } = handlersFor([
      fakeTool('read_file', async () => ({ path: 'a.md', totalLines: 10, offset: 0, limit: 200, content: 'x' })),
      fakeTool('rag_query', async () => ({ ok: true, matches: [{ file: 'a' }] })),
    ]);
    await handlers.callTool('read_file', { path: 'a.md' });
    await handlers.callTool('rag_query', { q: 'needle' });
    const read = callFor(collector, 'read_file');
    expect(read).toMatchObject({ tool: 'read_file', ok: true, path: 'a.md', telemetryId: 'tid-w', model: 'model-w' });
    expect(typeof read.durationMs).toBe('number');
    const rag = callFor(collector, 'rag_query');
    expect(rag).toMatchObject({ tool: 'rag_query', ok: true, query: 'needle', hitCount: 1, telemetryId: 'tid-w' });
    expect(typeof rag.durationMs).toBe('number');
    expectNoWindow(rag);
  });
});

describe('selectAgentTools telemetryId forwarding', () => {
  it('forwards telemetryId to the agent factory when supplied', () => {
    const factory = vi.fn(() => ({ tools: [] }));
    selectAgentTools({ agent: 'research', projectId: 'p', projectRoot: '/r', telemetryId: 'tid-f', factories: { research: factory } });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ telemetryId: 'tid-f' }));
  });
});
