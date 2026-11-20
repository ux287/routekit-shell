/**
 * backlog.feat.research-agent-run-telemetry-coverage — rag.query join key (telemetryId) and the
 * served read window. Same in-process harness as tests/unit/agents/agent-tools-rag-telemetry.test.mjs:
 * InMemoryTransport, injected recording collector, query() and the RAG path loader mocked. No subprocess.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../../../packages/rag/src/query.mjs', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../../../packages/rag/src/rag-config-loader.mjs', () => ({
  getRagPathsFor: vi.fn(async () => ({ notes: '/nonexistent/rag/notes' })),
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn() }));

import { startAgentToolsServer } from '../../../packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs';
import { runRagQuery, setRagHostHooks } from '../../../packages/rag/src/tools.mjs';

const SLUGS = ['doc.a', 'doc.b', 'doc.c'];
let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-rag-telemetry-id-'));
  for (const s of SLUGS) fs.writeFileSync(path.join(tmp, `${s}.md`), `${s}\n`, 'utf8');
  fs.writeFileSync(path.join(tmp, 'long.md'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'), 'utf8');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => { queryMock.mockReset(); });

const matchesFor = (slugs) => slugs.map((slug, i) => ({ slug, path: `${slug}.md`, text: slug, score: 1 - i / 10 }));
function recordingCollector() {
  const events = [];
  return { events, emit: (event, projectId, data) => { events.push({ event, projectId, data }); }, flush: async () => {} };
}
const eventsOf = (collector, type) => collector.events.filter((e) => e.event === type).map((e) => e.data);
const toolCall = (collector, tool) =>
  collector.events.find((e) => e.event === 'agent.research.tool_call' && e.data.tool === tool)?.data;

async function serve(launchFlags, call) {
  const collector = recordingCollector();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await startAgentToolsServer(
    ['--agent', 'research', '--project', 'proj-tid', '--root', tmp, ...launchFlags],
    { transport: serverTransport, ensureTelemetryStorage: () => collector },
  );
  const client = new Client({ name: 'agent-tools-rag-telemetry-id-test', version: '0.0.0' });
  try {
    await client.connect(clientTransport);
    const res = await call(client);
    return { collector, res };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('runRagQuery telemetryId join key', () => {
  let collector;
  beforeEach(() => {
    collector = recordingCollector();
    setRagHostHooks({ getTelemetryCollector: () => collector });
  });

  it('rag.query carries the telemetryId option when supplied', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: matchesFor(SLUGS) });
    await runRagQuery(tmp, { q: 'probe', k: 3, telemetryId: 'tid-direct' });
    expect(eventsOf(collector, 'rag.query')[0].telemetryId).toBe('tid-direct');
  });

  it('rag.query omits telemetryId when the option is absent', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: matchesFor(SLUGS) });
    await runRagQuery(tmp, { q: 'probe', k: 3 });
    expect('telemetryId' in eventsOf(collector, 'rag.query')[0]).toBe(false);
  });

  it('rag.query.stale_filtered carries the telemetryId option when supplied', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: [...matchesFor(['doc.a']), { slug: 'gone', path: 'gone.md', text: 'g', score: 0.1 }] });
    await runRagQuery(tmp, { q: 'probe', k: 3, telemetryId: 'tid-stale' });
    expect(eventsOf(collector, 'rag.query.stale_filtered')[0].telemetryId).toBe('tid-stale');
  });

  it('rag.query.stale_filtered omits telemetryId when the option is absent', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: [...matchesFor(['doc.a']), { slug: 'gone', path: 'gone.md', text: 'g', score: 0.1 }] });
    await runRagQuery(tmp, { q: 'probe', k: 3 });
    const [stale] = eventsOf(collector, 'rag.query.stale_filtered');
    expect(stale).toBeDefined();
    expect('telemetryId' in stale).toBe(false);
  });

  it('existing rag.query fields are unchanged when telemetryId is supplied', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: matchesFor(SLUGS) });
    await runRagQuery(tmp, { q: 'probe', k: 3, telemetryId: 'tid-fields' });
    const data = eventsOf(collector, 'rag.query')[0];
    expect(data).toMatchObject({ query: 'probe', resultsReturned: 3, indexSize: null });
    expect(typeof data.durationMs).toBe('number');
    expect(Array.isArray(data.ranked)).toBe(true);
    expect('k' in data && 'intent' in data).toBe(true);
  });
});

describe('rks-agent-tools research run telemetry coverage', () => {
  it('a served rag_query emits rag.query with the launcher telemetryId, equal to the tool_call telemetryId', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: matchesFor(SLUGS) });
    const { collector } = await serve(['--telemetry-id', 'tid-run', '--model', 'model-run'],
      (c) => c.callTool({ name: 'rag_query', arguments: { q: 'join key probe' } }));
    const rq = eventsOf(collector, 'rag.query');
    expect(rq).toHaveLength(1);
    expect(rq[0].telemetryId).toBe('tid-run');
    expect(toolCall(collector, 'rag_query').telemetryId).toBe(rq[0].telemetryId);
  });

  it('both the primary and the broadened cascade query emit rag.query with the launcher telemetryId', async () => {
    queryMock
      .mockResolvedValueOnce({ ok: true, matches: matchesFor(['doc.a']) })
      .mockResolvedValueOnce({ ok: true, matches: matchesFor(SLUGS) });
    const { collector } = await serve(['--telemetry-id', 'tid-cascade'],
      (c) => c.callTool({ name: 'rag_query', arguments: { q: 'alpha bravo charlie delta echo' } }));
    expect(queryMock).toHaveBeenCalledTimes(2);
    const rq = eventsOf(collector, 'rag.query');
    expect(rq.map((e) => e.query)).toEqual(['alpha bravo charlie delta echo', 'alpha bravo charlie']);
    expect(rq.map((e) => e.telemetryId)).toEqual(['tid-cascade', 'tid-cascade']);
  });

  it('a served rag_query without --telemetry-id emits rag.query with no telemetryId key', async () => {
    queryMock.mockResolvedValue({ ok: true, matches: matchesFor(SLUGS) });
    const { collector } = await serve([], (c) => c.callTool({ name: 'rag_query', arguments: { q: 'no id probe' } }));
    const rq = eventsOf(collector, 'rag.query');
    expect(rq).toHaveLength(1);
    expect('telemetryId' in rq[0]).toBe(false);
  });

  it('a served read_file of a long file logs offset, limit, totalLines and truncatedWindow equal to the returned result', async () => {
    const { collector, res } = await serve(['--telemetry-id', 'tid-read'],
      (c) => c.callTool({ name: 'read_file', arguments: { path: 'long.md' } }));
    const returned = JSON.parse(res.content[0].text);
    expect(returned.totalLines).toBeGreaterThan(returned.offset + returned.limit);
    expect(toolCall(collector, 'read_file')).toMatchObject({
      path: 'long.md', offset: returned.offset, limit: returned.limit, totalLines: returned.totalLines, truncatedWindow: true,
    });
  });
});
