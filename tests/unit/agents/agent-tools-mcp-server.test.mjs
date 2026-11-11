/**
 * backlog.feat.agent-tools-mcp-server — rks-agent-tools stdio MCP server (read-only, decision D3).
 *
 * Unit tier (vitest.config.unit.mjs collects tests/unit/**). Deterministic: fake tools, a recording
 * collector, a stepping clock and an in-memory MCP transport pair are injected. No child process is
 * started and no claude binary is invoked. The stdio transport module is replaced with a constructor
 * spy so the import-has-no-side-effects check can observe it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_TOOLS_SERVER_NAME,
  READ_ONLY_TOOLS,
  parseServerArgs,
  selectAgentTools,
  createToolHandlers,
  startAgentToolsServer,
} from '../../../packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs';
import { createResearchAgent, classifyRetrieval } from '../../../packages/mcp-rks/src/agents/research.mjs';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn() }));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER_REL = 'packages/mcp-rks/src/agents/agent-tools-mcp-server.mjs';
const EXPECTED_READ_ONLY = ['rag_query', 'read_file', 'read_git'];
const REQUIRED_FLAGS_RE = /--agent, --project and --root are required/;

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-mcp-'));
  fs.writeFileSync(path.join(tmp, 'marker.txt'), 'agent-tools-marker-line\n', 'utf8');
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function recordingCollector() {
  const events = [];
  return {
    events,
    emit: (event, projectId, data) => {
      events.push({ event, projectId, data });
    },
    flush: async () => {},
  };
}

function steppingClock(start = 1000, step = 250) {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

function fakeTool(name, impl) {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({ q: z.string().optional(), path: z.string().optional() }),
    execute: impl,
  };
}

function handlersFor(tools, outcomesFile, overrides = {}) {
  const collector = recordingCollector();
  const handlers = createToolHandlers({
    tools,
    agent: 'research',
    projectId: 'proj-t',
    telemetryId: 'tid-parent',
    model: 'model-x',
    backend: 'claude-cli',
    billing: 'subscription',
    collector,
    outcomesFile,
    now: steppingClock(),
    ...overrides,
  });
  return { handlers, collector };
}

function readOutcomeLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function realReadOnlyTools() {
  return selectAgentTools({ agent: 'research', projectId: 'proj-t', projectRoot: tmp });
}

describe('module import', () => {
  it('importing the module builds no stdio transport (no server started, stdin untouched)', () => {
    expect(StdioServerTransport).not.toHaveBeenCalled();
    expect(AGENT_TOOLS_SERVER_NAME).toBe('rks-agent-tools');
  });
});

describe('READ_ONLY_TOOLS and selectAgentTools (D3 read-only)', () => {
  it('READ_ONLY_TOOLS.research is exactly the three read-only tools and is frozen', () => {
    expect([...READ_ONLY_TOOLS.research]).toEqual(EXPECTED_READ_ONLY);
    expect(Object.isFrozen(READ_ONLY_TOOLS)).toBe(true);
    expect(Object.isFrozen(READ_ONLY_TOOLS.research)).toBe(true);
  });

  it('the real research agent still owns dendron write tools (positive control for the filter)', () => {
    const all = createResearchAgent({ projectId: 'proj-t', query: '', projectRoot: tmp }).tools.map((t) => t.name);
    expect(all).toEqual(expect.arrayContaining(['dendron_create_note', 'dendron_edit_note', 'dendron_update_field']));
  });

  it('selectAgentTools over the real research agent returns exactly rag_query, read_file, read_git and no dendron_ tool', () => {
    const names = realReadOnlyTools().map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_READ_ONLY);
    expect(names.some((n) => n.startsWith('dendron_'))).toBe(false);
  });

  it('selectAgentTools returns the SAME tool objects the factory built and passes projectId, empty query and projectRoot', () => {
    const rag = fakeTool('rag_query', async () => ({ ok: true, matches: [] }));
    const read = fakeTool('read_file', async () => ({ content: '' }));
    const git = fakeTool('read_git', async () => ({}));
    const write = fakeTool('dendron_create_note', async () => ({ ok: true }));
    const factory = vi.fn(() => ({ tools: [rag, write, read, git] }));
    const selected = selectAgentTools({
      agent: 'research',
      projectId: 'p-inj',
      projectRoot: '/root-inj',
      factories: { research: factory },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({ projectId: 'p-inj', query: '', projectRoot: '/root-inj' });
    expect(selected).toHaveLength(3);
    expect(selected[0]).toBe(rag);
    expect(selected[1]).toBe(read);
    expect(selected[2]).toBe(git);
  });

  it('selectAgentTools refuses an unsupported agent and names the supported agents', () => {
    expect(() => selectAgentTools({ agent: 'planner', projectId: 'p', projectRoot: tmp })).toThrow(/not supported/);
    expect(() => selectAgentTools({ agent: 'planner', projectId: 'p', projectRoot: tmp })).toThrow(/supported: research/);
  });
});

describe('parseServerArgs', () => {
  it('maps all eight flags and ignores an unknown flag with its value', () => {
    const parsed = parseServerArgs([
      '--agent', 'research',
      '--bogus', 'zzz',
      '--project', 'p1',
      '--root', '/abs/root',
      '--telemetry-id', 'tid-1',
      '--model', 'model-1',
      '--outcomes-file', '/abs/outcomes.jsonl',
      '--backend', 'backend-1',
      '--billing', 'billing-1',
    ]);
    expect(parsed).toEqual({
      agent: 'research',
      projectId: 'p1',
      projectRoot: '/abs/root',
      telemetryId: 'tid-1',
      model: 'model-1',
      outcomesFile: '/abs/outcomes.jsonl',
      backend: 'backend-1',
      billing: 'billing-1',
    });
  });

  it('produces no backend or billing key when those flags are absent', () => {
    const parsed = parseServerArgs(['--agent', 'research', '--project', 'p1', '--root', '/abs/root']);
    expect(parsed).toEqual({ agent: 'research', projectId: 'p1', projectRoot: '/abs/root' });
    expect('backend' in parsed).toBe(false);
    expect('billing' in parsed).toBe(false);
  });

  it('ignores a trailing flag that has no value', () => {
    expect(parseServerArgs(['--agent'])).toEqual({});
  });
});

describe('startAgentToolsServer required flags', () => {
  it.each([
    ['no flags', []],
    ['missing --agent', ['--project', 'p', '--root', '/abs/root']],
    ['missing --project', ['--agent', 'research', '--root', '/abs/root']],
    ['missing --root', ['--agent', 'research', '--project', 'p']],
  ])('%s rejects with an error naming the three required flags', async (_label, argv) => {
    await expect(startAgentToolsServer(argv, {})).rejects.toThrow(REQUIRED_FLAGS_RE);
    expect(StdioServerTransport).not.toHaveBeenCalled();
  });
});

describe('createToolHandlers.listTools', () => {
  it('advertises name, description and an object inputSchema for every real read-only tool', () => {
    const { handlers } = handlersFor(realReadOnlyTools());
    const { tools } = handlers.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_READ_ONLY);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema.type).toBe('object');
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.rag_query.inputSchema.properties).toHaveProperty('q');
    expect(byName.read_file.inputSchema.properties).toHaveProperty('path');
  });
});

describe('createToolHandlers.callTool result shapes', () => {
  it('a known tool returns one text block holding JSON.stringify(result) and no isError key', async () => {
    const payload = { content: 'hello', lines: 1 };
    const { handlers } = handlersFor([fakeTool('read_file', async () => payload)]);
    const res = await handlers.callTool('read_file', { path: 'a.txt' });
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
    expect('isError' in res).toBe(false);
  });

  it('a throwing tool returns isError true with { error: message } and emits ok:false with that error', async () => {
    const { handlers, collector } = handlersFor([
      fakeTool('read_file', async () => {
        throw new Error('boom');
      }),
    ]);
    const res = await handlers.callTool('read_file', { path: 'a.txt' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ error: 'boom' });
    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].data).toMatchObject({ tool: 'read_file', ok: false, error: 'boom' });
  });

  it('an unknown tool name returns isError true and emits ok:false error unknown_tool', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({}))]);
    const res = await handlers.callTool('nope', {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain('nope');
    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].event).toBe('agent.research.tool_call');
    expect(collector.events[0].data).toMatchObject({ tool: 'nope', ok: false, error: 'unknown_tool' });
  });

  it('dendron_create_note is not reachable through the real read-only tool set', async () => {
    const { handlers, collector } = handlersFor(realReadOnlyTools());
    const res = await handlers.callTool('dendron_create_note', { filename: 'notes.x', body: 'y' });
    expect(res.isError).toBe(true);
    expect(collector.events[0].data).toMatchObject({ tool: 'dendron_create_note', ok: false, error: 'unknown_tool' });
  });
});

describe('tool_call telemetry parity', () => {
  it('read_file emits exactly one tool_call with the runner fields plus path and the claude-cli tags', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ content: 'x' }))]);
    await handlers.callTool('read_file', { path: 'docs/a.md' });
    expect(collector.events).toHaveLength(1);
    const [ev] = collector.events;
    expect(ev.event).toBe('agent.research.tool_call');
    expect(ev.projectId).toBe('proj-t');
    expect(ev.data).toMatchObject({
      tool: 'read_file',
      ok: true,
      durationMs: 250,
      path: 'docs/a.md',
      telemetryId: 'tid-parent',
      model: 'model-x',
      backend: 'claude-cli',
      billing: 'subscription',
    });
  });

  it('rag_query emits query and hitCount', async () => {
    const { handlers, collector } = handlersFor([
      fakeTool('rag_query', async () => ({ ok: true, matches: [{ file: 'a' }, { file: 'b' }] })),
    ]);
    await handlers.callTool('rag_query', { q: 'needle' });
    expect(collector.events).toHaveLength(1);
    expect(collector.events[0].data).toMatchObject({
      tool: 'rag_query',
      ok: true,
      durationMs: 250,
      query: 'needle',
      hitCount: 2,
      telemetryId: 'tid-parent',
      model: 'model-x',
      backend: 'claude-cli',
      billing: 'subscription',
    });
  });

  it('read_git carries no path, query or hitCount', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_git', async () => ({ commits: [] }))]);
    await handlers.callTool('read_git', { tool: 'git_log' });
    expect(collector.events).toHaveLength(1);
    const { data } = collector.events[0];
    expect(data).toMatchObject({ tool: 'read_git', ok: true, backend: 'claude-cli', billing: 'subscription' });
    expect(data.path).toBeUndefined();
    expect(data.query).toBeUndefined();
    expect(data.hitCount).toBeUndefined();
  });

  it('backend and billing are copied from the launcher-supplied values, not hard-coded', async () => {
    const { handlers, collector } = handlersFor([fakeTool('read_file', async () => ({ content: 'x' }))], undefined, {
      backend: 'backend-from-flag',
      billing: 'billing-from-flag',
    });
    await handlers.callTool('read_file', { path: 'a.txt' });
    await handlers.callTool('nope', {});
    expect(collector.events).toHaveLength(2);
    for (const ev of collector.events) {
      expect(ev.data.backend).toBe('backend-from-flag');
      expect(ev.data.billing).toBe('billing-from-flag');
    }
  });

  it('omits backend and billing entirely when the launcher supplied neither', async () => {
    const { handlers, collector } = handlersFor(
      [fakeTool('read_file', async () => ({ content: 'x' })), fakeTool('rag_query', async () => ({ ok: true, matches: [] }))],
      undefined,
      { backend: undefined, billing: undefined },
    );
    await handlers.callTool('read_file', { path: 'a.txt' });
    await handlers.callTool('rag_query', { q: 'x' });
    await handlers.callTool('nope', {});
    expect(collector.events).toHaveLength(3);
    for (const ev of collector.events) {
      expect('backend' in ev.data).toBe(false);
      expect('billing' in ev.data).toBe(false);
      expect(ev.data).toMatchObject({ telemetryId: 'tid-parent', model: 'model-x' });
    }
  });

  it('the server module source contains no backend or billing literal', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, SERVER_REL), 'utf8');
    expect(src).toContain('--backend');
    // Any quote style: single, double or backtick.
    expect(src).not.toMatch(/['"`]claude-cli['"`]/);
    expect(src).not.toMatch(/['"`]subscription['"`]/);
  });
});

describe('retrieval outcomes file', () => {
  it.each([
    ['healthy', { ok: true, matches: [{}, {}, {}] }],
    ['thin_results', { ok: true, matches: [{}], _cascade: 'thin_results' }],
    ['no_results', { ok: true, matches: [], _cascade: 'no_results' }],
    ['retrieval_failed', { ok: false, error: 'index unavailable' }],
  ])('a rag_query returning a %s result appends one line with that outcome', async (expected, result) => {
    const outcomesFile = path.join(tmp, `outcomes-${expected}.jsonl`);
    const { handlers } = handlersFor([fakeTool('rag_query', async () => result)], outcomesFile);
    const res = await handlers.callTool('rag_query', { q: 'x' });
    expect(res.isError).toBeUndefined();
    expect(classifyRetrieval(result)).toBe(expected);
    expect(readOutcomeLines(outcomesFile)).toEqual([{ outcome: expected }]);
  });

  it('lines append in call order and other tools write no line', async () => {
    const outcomesFile = path.join(tmp, 'outcomes-order.jsonl');
    const results = [
      { ok: true, matches: [], _cascade: 'no_results' },
      { ok: true, matches: [{}, {}] },
    ];
    let i = 0;
    const { handlers } = handlersFor(
      [
        fakeTool('rag_query', async () => results[i++]),
        fakeTool('read_file', async () => ({ content: 'x' })),
        fakeTool('read_git', async () => ({ commits: [] })),
      ],
      outcomesFile,
    );
    await handlers.callTool('read_file', { path: 'a.txt' });
    await handlers.callTool('rag_query', { q: 'first' });
    await handlers.callTool('read_git', { tool: 'git_log' });
    await handlers.callTool('rag_query', { q: 'second' });
    expect(readOutcomeLines(outcomesFile)).toEqual([{ outcome: 'no_results' }, { outcome: 'healthy' }]);
  });

  it('a throwing rag_query writes no line', async () => {
    const outcomesFile = path.join(tmp, 'outcomes-throw.jsonl');
    const { handlers } = handlersFor(
      [
        fakeTool('rag_query', async () => {
          throw new Error('lance down');
        }),
      ],
      outcomesFile,
    );
    const res = await handlers.callTool('rag_query', { q: 'x' });
    expect(res.isError).toBe(true);
    expect(readOutcomeLines(outcomesFile)).toEqual([]);
  });

  it('a missing outcomesFile writes nothing, does not throw, and reports no write failure', async () => {
    const before = fs.readdirSync(tmp).sort();
    const { handlers, collector } = handlersFor([fakeTool('rag_query', async () => ({ ok: true, matches: [{}] }))], undefined);
    const res = await handlers.callTool('rag_query', { q: 'x' });
    expect(res.isError).toBeUndefined();
    expect(fs.readdirSync(tmp).sort()).toEqual(before);
    expect(collector.events).toHaveLength(1);
    expect('outcomeWriteFailed' in collector.events[0].data).toBe(false);
  });

  it('a successful append reports no write failure on the tool_call event', async () => {
    const outcomesFile = path.join(tmp, 'outcomes-ok-flag.jsonl');
    const { handlers, collector } = handlersFor([fakeTool('rag_query', async () => ({ ok: true, matches: [{}, {}] }))], outcomesFile);
    await handlers.callTool('rag_query', { q: 'x' });
    expect(readOutcomeLines(outcomesFile)).toEqual([{ outcome: 'healthy' }]);
    expect(collector.events).toHaveLength(1);
    expect('outcomeWriteFailed' in collector.events[0].data).toBe(false);
  });

  it('a failed append is volunteered as outcomeWriteFailed on that call and does not fail the call', async () => {
    const outcomesFile = path.join(tmp, 'no-such-dir', 'outcomes.jsonl');
    const result = { ok: true, matches: [{}, {}] };
    const { handlers, collector } = handlersFor([fakeTool('rag_query', async () => result)], outcomesFile);
    const res = await handlers.callTool('rag_query', { q: 'x' });
    expect(res.isError).toBeUndefined();
    expect(res).toEqual({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    expect(fs.existsSync(outcomesFile)).toBe(false);
    expect(collector.events).toHaveLength(1);
    const { data } = collector.events[0];
    expect(data).toMatchObject({ tool: 'rag_query', ok: true, outcomeWriteFailed: true });
    expect(typeof data.outcomeWriteError).toBe('string');
    expect(data.outcomeWriteError.length).toBeGreaterThan(0);
  });
});

describe('in-process MCP round trip (InMemoryTransport, no subprocess)', () => {
  it('serves exactly the read-only tools, refuses dendron_create_note, and serves read_file with telemetry tags', async () => {
    const collector = recordingCollector();
    const outcomesFile = path.join(tmp, 'outcomes-roundtrip.jsonl');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const { server } = await startAgentToolsServer(
      [
        '--agent', 'research',
        '--project', 'proj-rt',
        '--root', tmp,
        '--telemetry-id', 'tid-rt',
        '--model', 'model-rt',
        '--outcomes-file', outcomesFile,
        '--backend', 'backend-rt',
        '--billing', 'billing-rt',
      ],
      { transport: serverTransport, ensureTelemetryStorage: () => collector },
    );
    const client = new Client({ name: 'agent-tools-test', version: '0.0.0' });
    try {
      await client.connect(clientTransport);

      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_READ_ONLY);
      expect(names.some((n) => n.startsWith('dendron_'))).toBe(false);
      for (const t of listed.tools) expect(t.inputSchema.type).toBe('object');

      const write = await client.callTool({ name: 'dendron_create_note', arguments: { filename: 'notes.x', body: 'y' } });
      expect(write.isError).toBe(true);

      const read = await client.callTool({ name: 'read_file', arguments: { path: 'marker.txt' } });
      expect(read.isError).toBeFalsy();
      expect(JSON.parse(read.content[0].text).content).toContain('agent-tools-marker-line');

      const calls = collector.events.filter((e) => e.event === 'agent.research.tool_call');
      expect(calls.map((e) => e.data.tool)).toEqual(['dendron_create_note', 'read_file']);
      expect(calls.every((e) => e.projectId === 'proj-rt')).toBe(true);
      expect(calls[0].data).toMatchObject({ ok: false, error: 'unknown_tool' });
      expect(calls[1].data).toMatchObject({
        ok: true,
        path: 'marker.txt',
        telemetryId: 'tid-rt',
        model: 'model-rt',
        backend: 'backend-rt',
        billing: 'billing-rt',
      });
      expect(readOutcomeLines(outcomesFile)).toEqual([]);
      expect(StdioServerTransport).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('off by default (gated chain)', () => {
  // Tripwire, updated by backlog.feat.agent-backend-selection-research. The server may be referenced
  // by exactly one module, the claude-cli executor; the executor only by backend-dispatch.mjs; and
  // backend-dispatch.mjs only by runner.mjs, through a dynamic import behind the per-agent opt-in.
  // Any new path to the server reds here.
  const SRC_ROOT = path.join(REPO_ROOT, 'packages/mcp-rks/src');
  const EXECUTOR_REL = 'packages/mcp-rks/src/agents/executors/claude-cli.mjs';
  const DISPATCH_REL = 'packages/mcp-rks/src/agents/executors/backend-dispatch.mjs';
  const RUNNER_REL = 'packages/mcp-rks/src/agents/runner.mjs';

  function scanSrc(needle, selfRel) {
    const scanned = [];
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(full);
          continue;
        }
        if (!/\.(mjs|js|cjs|ts)$/.test(e.name)) continue;
        const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
        scanned.push(rel);
        if (rel === selfRel) continue;
        if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(rel);
      }
    };
    walk(SRC_ROOT);
    return { scanned, hits: hits.sort() };
  }

  it('only the claude-cli executor references agent-tools-mcp-server', () => {
    const { scanned, hits } = scanSrc('agent-tools-mcp-server', SERVER_REL);
    expect(scanned).toContain('packages/mcp-rks/src/agents/research.mjs');
    expect(hits).toEqual([EXECUTOR_REL]);
  });

  it('only backend-dispatch.mjs references the claude-cli executor module', () => {
    const { scanned, hits } = scanSrc('claude-cli.mjs', EXECUTOR_REL);
    expect(scanned).toContain(DISPATCH_REL);
    expect(hits).toEqual([DISPATCH_REL]);
  });

  it('only runner.mjs references backend-dispatch, and only through a dynamic import', () => {
    const { hits } = scanSrc('backend-dispatch', DISPATCH_REL);
    expect(hits).toEqual([RUNNER_REL]);
    const runnerSrc = fs.readFileSync(path.join(REPO_ROOT, RUNNER_REL), 'utf8');
    expect(runnerSrc).toContain("import('./executors/backend-dispatch.mjs')");
    expect(/^\s*import\s[^(\n]*backend-dispatch/m.test(runnerSrc)).toBe(false);
  });
});
