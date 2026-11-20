/**
 * backlog.fix.research-agent-budget-observed-not-asserted — research agent tool budgets are counted
 * in code and program-stamped onto the output as observed, not asserted by the model.
 *
 * Unit tier. runRagQuery is replaced with a vi.fn, so no RAG index is touched. Fixture files live in
 * per-test temp dirs, removed after the file. This file starts no subprocess.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ragQueryMock = vi.fn(async () => ({ ok: true, matches: [{ file: 'a.md', text: 'hit' }] }));
vi.mock('@routekit/rag', async (importOriginal) => ({ ...(await importOriginal()), runRagQuery: (...args) => ragQueryMock(...args) }));

const { createResearchAgent } = await import('../../../packages/mcp-rks/src/agents/research.mjs');

const restart = (index, kind = 'primary') => ({ index, kind, resumed: false });
const resume = (index) => ({ index, kind: 'escalation', resumed: true });
const tool = (agent, name) => agent.tools.find((t) => t.name === name);

const roots = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function freshAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-budget-'));
  roots.push(root);
  for (const f of ['a.md', 'b.md', 'c.md', 'd.md']) fs.writeFileSync(path.join(root, f), `content of ${f}\n`);
  const agent = createResearchAgent({ projectId: 'test', query: 'q', projectRoot: root });
  agent.attemptState.beginAttempt(restart(0));
  return { agent, root };
}

// `ok` is required by ResearchOutputObject, so the model output carries it.
const MODEL_OUT = { ok: true, answer: 'a', sources: [], confidence: 0.5 };

describe('research tool budgets', () => {
  beforeEach(() => ragQueryMock.mockClear());

  it('a 3rd rag_query call in one attempt is refused with ok:false and does not call runRagQuery', async () => {
    const { agent } = freshAgent();
    await tool(agent, 'rag_query').execute({ q: 'one' });
    await tool(agent, 'rag_query').execute({ q: 'two' });
    const calls = ragQueryMock.mock.calls.length;
    expect(calls).toBe(2); // positive control: admitted calls do reach runRagQuery
    const third = await tool(agent, 'rag_query').execute({ q: 'three' });
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/rag_query budget exhausted \(2\/2\)/);
    expect(ragQueryMock.mock.calls.length).toBe(calls);
  });

  it('a 4th read_file call in one attempt is refused with ok:false and does not read the file', async () => {
    const { agent } = freshAgent();
    for (const p of ['a.md', 'b.md', 'c.md']) await tool(agent, 'read_file').execute({ path: p });
    const fourth = await tool(agent, 'read_file').execute({ path: 'd.md' });
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toMatch(/read_file budget exhausted \(3\/3\)/);
    expect(JSON.stringify(fourth)).not.toContain('content of d.md');
  });

  it('a rag_query call that triggers the broad-words retry consumes one rag_query slot', async () => {
    ragQueryMock.mockResolvedValueOnce({ ok: true, matches: [] });
    const { agent } = freshAgent();
    await tool(agent, 'rag_query').execute({ q: 'how does authorization middleware work' });
    // Positive control: the broad-words retry actually fired (two runRagQuery invocations).
    expect(ragQueryMock.mock.calls.length).toBe(2);
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.rag_query.used).toBe(1);
  });

  it('a refused call does not increment its counter', async () => {
    const { agent } = freshAgent();
    for (const q of ['1', '2', '3', '4']) await tool(agent, 'rag_query').execute({ q });
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.rag_query).toMatchObject({ used: 2, max: 2 });
  });

  it('rag_query, read_file and read_git counters are independent', async () => {
    const { agent } = freshAgent();
    for (const q of ['1', '2', '3']) await tool(agent, 'rag_query').execute({ q });
    const read = await tool(agent, 'read_file').execute({ path: 'a.md' });
    expect(read.ok).not.toBe(false);
    expect(read.content).toContain('content of a.md');
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.rag_query.used).toBe(2);
    expect(parsed.budget.read_file.used).toBe(1);
    expect(parsed.budget.read_git.used).toBe(0);
  });

  it('a budget-refused rag_query records no retrieval outcome', async () => {
    const { agent } = freshAgent();
    for (const q of ['1', '2']) await tool(agent, 'rag_query').execute({ q });
    const recordSpy = vi.spyOn(agent._retrieval, 'record');
    const third = await tool(agent, 'rag_query').execute({ q: '3' });
    expect(third.ok).toBe(false);
    expect(third.budgetExhausted).toBe('rag_query');
    expect(recordSpy).not.toHaveBeenCalled();
    recordSpy.mockRestore();
  });

  it('counters reset on a restart attempt and carry on a max-turns resume', async () => {
    const { agent } = freshAgent();
    for (const p of ['a.md', 'b.md', 'c.md']) await tool(agent, 'read_file').execute({ path: p });
    agent.attemptState.beginAttempt(resume(1));
    expect((await tool(agent, 'read_file').execute({ path: 'd.md' })).ok).toBe(false);
    agent.attemptState.beginAttempt(restart(2, 'same_model_retry'));
    expect((await tool(agent, 'read_file').execute({ path: 'd.md' })).ok).not.toBe(false);
  });
});

describe('budget record hardening (in-process)', () => {
  beforeEach(() => ragQueryMock.mockClear());

  const NAMED_STATE = () => ({
    rag_query: { used: 1, max: 2, queries: ['alpha'] },
    read_file: {
      used: 1,
      max: 3,
      paths: [{ path: 'notes/named.md', offset: 0, limit: 200, named: true }, { path: 'a.md', offset: 0, limit: 200 }],
    },
    read_git: { used: 0, max: 3 },
    exhaustive_search: { used: 0, max: 6, calls: [] },
  });
  // An agent with one admitted rag_query, so "unchanged" is a non-zero baseline.
  async function primedAgent() {
    const { agent } = freshAgent();
    await tool(agent, 'rag_query').execute({ q: 'baseline' });
    return { agent, before: agent._budget.snapshot() };
  }

  it('a read_file of an existing directory returns an error result, consumes one slot and its paths entry carries error true', async () => {
    const { agent, root } = freshAgent();
    fs.mkdirSync(path.join(root, 'subdir'));
    expect(fs.existsSync(path.join(root, 'subdir'))).toBe(true); // positive control: the path exists
    const res = await tool(agent, 'read_file').execute({ path: 'subdir' });
    expect(typeof res.error).toBe('string');
    expect(res.content).toBeUndefined();
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.read_file.used).toBe(1);
    expect(parsed.budget.read_file.paths).toEqual([{ path: 'subdir', offset: 0, limit: 200, error: true }]);
  });

  it('a rag_query whose retrieval throws consumes one slot, lists its query and records no retrieval outcome', async () => {
    const { agent } = freshAgent();
    ragQueryMock.mockRejectedValueOnce(new Error('index unavailable'));
    const recordSpy = vi.spyOn(agent._retrieval, 'record');
    await expect(tool(agent, 'rag_query').execute({ q: 'boom' })).rejects.toThrow('index unavailable');
    expect(ragQueryMock).toHaveBeenCalledTimes(1);
    expect(recordSpy).not.toHaveBeenCalled();
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.rag_query.used).toBe(1);
    expect(parsed.budget.rag_query.queries).toEqual(['boom']);
    recordSpy.mockRestore();
  });

  it('replay rejects a state whose rag_query used differs from its queries length', async () => {
    const { agent, before } = await primedAgent();
    const state = NAMED_STATE();
    state.rag_query = { used: 2, max: 2, queries: ['alpha'] };
    expect(agent._budget.replay(state)).toBe(false);
    expect(agent._budget.snapshot()).toEqual(before);
  });

  it('replay rejects a state whose read_file used differs from its non-named paths count', async () => {
    const { agent, before } = await primedAgent();
    const state = NAMED_STATE();
    // Two entries listed, one named: a used of 2 counts the named entry.
    state.read_file.used = 2;
    expect(agent._budget.replay(state)).toBe(false);
    expect(agent._budget.snapshot()).toEqual(before);
  });

  it('replay rejects a state with a used count above its max', async () => {
    const { agent, before } = await primedAgent();
    const over = [
      (s) => { s.rag_query = { used: 3, max: 2, queries: ['a', 'b', 'c'] }; },
      (s) => {
        s.read_file = { used: 4, max: 3, paths: ['a', 'b', 'c', 'd'].map((p) => ({ path: `${p}.md`, offset: 0, limit: 200 })) };
      },
      (s) => { s.read_git = { used: 4, max: 3 }; },
    ];
    for (const mutate of over) {
      const state = NAMED_STATE();
      mutate(state);
      expect(agent._budget.replay(state)).toBe(false);
      expect(agent._budget.snapshot()).toEqual(before);
    }
  });

  it('replay accepts a consistent state with an uncounted named entry and reports observed true', () => {
    const { agent } = freshAgent();
    agent._budget.markUnobserved();
    expect(agent.outputSchema.parse(MODEL_OUT).budget.observed).toBe(false); // control
    const state = NAMED_STATE();
    expect(agent._budget.replay(state)).toBe(true);
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.observed).toBe(true);
    expect(parsed.budget.rag_query).toEqual(state.rag_query);
    expect(parsed.budget.read_file).toEqual(state.read_file);
    expect(parsed.budget.read_git).toEqual(state.read_git);
    expect(parsed.budget.exhaustive_search).toEqual(state.exhaustive_search);
  });

  it('the createToolBudget doc comment documents path, offset, limit, named and error', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/mcp-rks/src/agents/research.mjs'), 'utf8');
    const fnAt = src.indexOf('function createToolBudget(');
    expect(fnAt).toBeGreaterThan(-1);
    const commentStart = src.lastIndexOf('/**', fnAt);
    const comment = src.slice(commentStart, fnAt);
    // Immediately above: the comment closes on the line before the function.
    expect(comment.trimEnd().endsWith('*/')).toBe(true);
    expect(comment.slice(comment.indexOf('*/') + 2).trim()).toBe('');
    for (const field of ['path', 'offset', 'limit', 'named', 'error']) {
      expect(comment).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
});

describe('program-stamped budget', () => {
  beforeEach(() => ragQueryMock.mockClear());

  it('outputSchema.parse stamps budget used/max/exhausted and overwrites a model-supplied budget', async () => {
    const { agent } = freshAgent();
    for (const q of ['1', '2']) await tool(agent, 'rag_query').execute({ q });
    const parsed = agent.outputSchema.parse({ ...MODEL_OUT, budget: { rag_query: { used: 0, max: 99 }, exhausted: [] } });
    expect(parsed.budget.rag_query).toMatchObject({ used: 2, max: 2 });
    expect(parsed.budget.read_file).toMatchObject({ used: 0, max: 3 });
    expect(parsed.budget.read_git).toMatchObject({ used: 0, max: 3 });
    expect(parsed.budget.exhausted).toEqual(['rag_query']);
  });

  it('budget lists exactly the executed read_file paths and rag_query queries', async () => {
    const { agent } = freshAgent();
    for (const q of ['alpha', 'beta', 'gamma']) await tool(agent, 'rag_query').execute({ q });
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) await tool(agent, 'read_file').execute({ path: p });
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.budget.rag_query.queries).toEqual(['alpha', 'beta']);
    expect(parsed.budget.read_file.paths.map((r) => (typeof r === 'string' ? r : r.path))).toEqual(['a.md', 'b.md', 'c.md']);
    expect(parsed.budget.read_file.paths[0]).toEqual({ path: 'a.md', offset: 0, limit: 200 });
  });

  it('agent.research.complete carries per-tool used/max and the exhausted list', async () => {
    const { finalizeResult } = await import('../../../packages/mcp-rks/src/agents/runner.mjs');
    const { agent } = freshAgent();
    for (const q of ['1', '2']) await tool(agent, 'rag_query').execute({ q });
    const emits = [];
    finalizeResult({ name: 'research', rawText: JSON.stringify(MODEL_OUT), outputSchema: agent.outputSchema, telemetryId: 't', emitTelemetry: (type, data) => emits.push({ type, data }), startTime: Date.now(), turns: 1, tokens: {} });
    const complete = emits.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.data.budget.observed).toBe(true);
    expect(complete.data.budget.rag_query).toMatchObject({ used: 2, max: 2 });
    expect(complete.data.budget.read_file).toMatchObject({ used: 0, max: 3 });
    expect(complete.data.budget.read_git).toMatchObject({ used: 0, max: 3 });
    expect(complete.data.budget.exhausted).toEqual(['rag_query']);
  });

  it('an unobserved budget reaches agent.research.complete with observed false', async () => {
    const { finalizeResult } = await import('../../../packages/mcp-rks/src/agents/runner.mjs');
    // Stands in for the claude-cli parse when the budget state file is missing: the stamped budget is unobserved.
    const unobservedSchema = { parse: (v) => ({ ...v, budget: { observed: false, exhausted: [] } }) };
    const emits = [];
    finalizeResult({ name: 'research', rawText: JSON.stringify(MODEL_OUT), outputSchema: unobservedSchema, telemetryId: 't', emitTelemetry: (type, data) => emits.push({ type, data }), startTime: Date.now(), turns: 1, tokens: {} });
    const complete = emits.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.data.budget).toEqual({ observed: false, exhausted: [] });
  });

  it('an observed budget carries observed true and ResearchOutputObject declares no budget key', () => {
    const { agent } = freshAgent();
    expect(agent.outputSchema.parse(MODEL_OUT).budget.observed).toBe(true);
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/mcp-rks/src/agents/research.mjs'), 'utf8');
    const start = src.indexOf('const ResearchOutputObject = z.object({');
    const end = src.indexOf('export const ResearchOutputSchema');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('budget');
  });

  it('research.mjs no longer carries the stale comment naming non-existent RAG/file-read counters', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/mcp-rks/src/agents/research.mjs'), 'utf8');
    expect(src).not.toContain('separate budget from RAG/file-read counters');
    // Positive control: the read_git counter the comment sits above is still present.
    expect(src).toContain("attemptState.scoped('read_git'");
  });
});
