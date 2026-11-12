import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const ragQueryMock = vi.fn();

vi.mock('@routekit/rag/tools', () => ({
  runRagQuery: (...args) => ragQueryMock(...args),
}));

vi.mock('@routekit/rag/query-intent', () => ({
  inferQueryIntent: () => 'code',
}));

vi.mock('../../../packages/mcp-rks/src/agents/config.mjs', () => ({
  loadAgentConfig: () => ({
    model: 'claude-haiku-4-5-20251001',
    fallbackModel: 'claude-sonnet-4-6',
    maxTurns: 12,
    timeoutMs: 60000,
    prompt: null,
  }),
}));

vi.mock('../../../packages/mcp-rks/src/dendron.mjs', () => ({
  resolveNotesDir: () => '/tmp/notes',
  writeNoteRaw: () => {},
  frontmatterDefaults: () => ({}),
  editNote: () => {},
  updateField: () => {},
}));

vi.mock('../../../packages/mcp-rks/src/agents/cross-delegate.mjs', () => ({
  createCrossDelegationTool: () => ({
    tool: {
      name: 'read_git',
      description: 'Read-only git',
      inputSchema: z.object({ tool: z.string() }),
      execute: async () => ({ ok: true }),
    },
  }),
}));

vi.mock('../../../packages/mcp-rks/src/server/git-tools.mjs', () => ({
  runGitShow: () => ({}),
  runGitBlame: () => ({}),
  runGitDescribe: () => ({}),
  runGitBranchList: () => ({}),
  runGitRemoteList: () => ({}),
}));

vi.mock('../../../packages/mcp-rks/src/utils/git.mjs', () => ({
  runGit: () => '',
}));

vi.mock('@routekit/telemetry', () => ({
  ensureTelemetryStorage: () => ({ emit: () => {}, flush: async () => {} }),
}));

import {
  createResearchAgent,
  ResearchOutputSchema,
  shouldEmitResearchFailureEvent,
} from '../../../packages/mcp-rks/src/agents/research.mjs';
import { finalizeResult } from '../../../packages/mcp-rks/src/agents/runner.mjs';

function getRagQueryTool(agent) {
  return agent.tools.find(t => t.name === 'rag_query');
}

describe('research agent — fallback cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns primary results when >= 2 matches found', async () => {
    ragQueryMock.mockResolvedValue({
      matches: [{ file: 'a.mjs', score: 0.9 }, { file: 'b.mjs', score: 0.8 }],
    });
    const agent = createResearchAgent({ projectId: 'test', query: 'how does auth work', projectRoot: '/tmp' });
    const tool = getRagQueryTool(agent);
    const result = await tool.execute({ q: 'how does auth work' });
    expect(result.matches).toHaveLength(2);
    expect(result._cascade).toBeUndefined();
    expect(ragQueryMock).toHaveBeenCalledTimes(1);
  });

  it('retries with broadened query when primary returns < 2 matches', async () => {
    ragQueryMock
      .mockResolvedValueOnce({ matches: [] })
      .mockResolvedValueOnce({ matches: [{ file: 'auth.mjs', score: 0.7 }, { file: 'session.mjs', score: 0.6 }] });

    const agent = createResearchAgent({ projectId: 'test', query: 'how does authorization middleware work', projectRoot: '/tmp' });
    const tool = getRagQueryTool(agent);
    const result = await tool.execute({ q: 'how does authorization middleware work' });

    expect(ragQueryMock).toHaveBeenCalledTimes(2);
    expect(result.matches).toHaveLength(2);
    expect(result._cascade).toBe('broadened');
  });

  it('returns original thin result when broadened query is no better', async () => {
    ragQueryMock
      .mockResolvedValueOnce({ matches: [{ file: 'a.mjs', score: 0.5 }] })
      .mockResolvedValueOnce({ matches: [] });

    const agent = createResearchAgent({ projectId: 'test', query: 'something specific query', projectRoot: '/tmp' });
    const tool = getRagQueryTool(agent);
    const result = await tool.execute({ q: 'something specific query' });

    expect(result._cascade).toBe('thin_results');
    expect(result.matches).toHaveLength(1);
  });

  it('marks no_results cascade when both primary and broad return empty', async () => {
    ragQueryMock.mockResolvedValue({ matches: [] });

    const agent = createResearchAgent({ projectId: 'test', query: 'completely unknown thing here', projectRoot: '/tmp' });
    const tool = getRagQueryTool(agent);
    const result = await tool.execute({ q: 'completely unknown thing here' });

    expect(result._cascade).toBe('no_results');
  });

  it('does not retry when query has no words longer than 3 chars', async () => {
    ragQueryMock.mockResolvedValue({ matches: [] });

    const agent = createResearchAgent({ projectId: 'test', query: 'how do I do it', projectRoot: '/tmp' });
    const tool = getRagQueryTool(agent);
    await tool.execute({ q: 'how do I do it' });

    expect(ragQueryMock).toHaveBeenCalledTimes(1);
  });
});

describe('ResearchOutputSchema — failureCategory', () => {
  it('accepts valid failureCategory values', () => {
    for (const cat of ['no_results', 'thin_results', 'retrieval_failed', 'malformed_output', 'timeout', 'escalated', 'partial_answer']) {
      expect(() => ResearchOutputSchema.parse({
        ok: true,
        answer: 'partial',
        sources: [],
        confidence: 0.3,
        failureCategory: cat,
        advisory: true, // sourceless answer → must be flagged advisory (Finding 3)
      })).not.toThrow();
    }
  });

  it('failureCategory is optional — schema validates without it', () => {
    expect(() => ResearchOutputSchema.parse({
      ok: true,
      answer: 'complete answer',
      sources: [{ file: 'a.mjs' }],
      confidence: 0.95,
    })).not.toThrow();
  });

  it('rejects unknown failureCategory values', () => {
    expect(() => ResearchOutputSchema.parse({
      ok: true,
      answer: 'x',
      sources: [],
      confidence: 0.1,
      advisory: true, // isolate the failureCategory rejection (Finding 3 contract satisfied)
      failureCategory: 'unknown_category',
    })).toThrow();
  });
});

describe('ResearchOutputSchema — advisory/cited contract (Finding 3)', () => {
  it('normalizes a sourceless answer to advisory: true (never sourceless-as-cited)', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'a design opinion', sources: [], confidence: 0.7,
    });
    expect(out.advisory).toBe(true);
  });

  it('core invariant: a parsed output never has empty sources without advisory: true', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'x', sources: [], confidence: 0.5,
    });
    expect(out.sources.length === 0 && out.advisory === true).toBe(true);
  });

  it('preserves an explicit advisory: true on a sourceless answer', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'a design opinion', sources: [], confidence: 0.7, advisory: true,
    });
    expect(out.advisory).toBe(true);
  });

  it('does NOT force advisory on a cited answer (non-empty sources)', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'cited fact', sources: [{ file: 'a.mjs' }], confidence: 0.9,
    });
    expect(out.advisory).toBeUndefined();
  });

  it('still rejects confidence outside [0,1] regardless of advisory/sources', () => {
    expect(() => ResearchOutputSchema.parse({
      ok: true, answer: 'x', sources: [{ file: 'a.mjs' }], confidence: 1.5,
    })).toThrow();
  });
});

describe('ResearchOutputSchema — bare-array coercion (backlog.fix.research-agent.bare-array-coercion)', () => {
  // A top-level array response previously failed z.object ("Expected object, received array")
  // and made the runner wastefully escalate haiku→sonnet. Coercion now makes it parse (ok:true),
  // so the runner's escalation gate (fires only on !ok) is never entered — no cost smell.
  it('coerces a bare sources-array to ok:true with sources carrying the array (no escalation)', () => {
    const out = ResearchOutputSchema.parse([{ file: 'a.mjs', snippet: 'x' }, { file: 'b.mjs' }]);
    expect(out.ok).toBe(true);
    expect(out.sources).toHaveLength(2);
    expect(out.sources[0].file).toBe('a.mjs');
    // backlog.fix.research-agent-output-contract (D7): legible, not laundered
    expect(out.failureCategory).toBe('malformed_output');
  });

  it('a 1-element array whose element is a source (no answer/ok key) is treated as sources, not unwrapped', () => {
    const out = ResearchOutputSchema.parse([{ file: 'only.mjs', snippet: 'y' }]);
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].file).toBe('only.mjs');
    expect(out.answer).toBe(''); // coerced default answer
    expect(out.failureCategory).toBe('malformed_output');
  });

  it('coerces a bare EMPTY array to a valid advisory:true output (transform still applies)', () => {
    const out = ResearchOutputSchema.parse([]);
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([]);
    expect(out.advisory).toBe(true); // empty sources → advisory via the object transform
    expect(out.failureCategory).toBe('malformed_output');
  });

  it('unwraps the full result object when the model wraps it in a 1-element array', () => {
    const out = ResearchOutputSchema.parse([
      { ok: true, answer: 'wrapped answer', sources: [{ file: 'c.mjs' }], confidence: 0.9 },
    ]);
    expect(out.answer).toBe('wrapped answer');
    expect(out.sources).toHaveLength(1);
    expect(out.advisory).toBeUndefined(); // has sources → not advisory
    expect(out.failureCategory).toBeUndefined(); // a recovered result, not malformed
    expect(out.confidence).toBe(0.9);
  });

  it('coercion is NARROW: a wrong-shape array (non-source elements) still throws + would escalate', () => {
    expect(() => ResearchOutputSchema.parse([1, 2, 3])).toThrow();
    expect(() => ResearchOutputSchema.parse(['just', 'strings'])).toThrow();
  });

  it('coercion is NARROW: a bare string or number still throws (only arrays are coerced)', () => {
    expect(() => ResearchOutputSchema.parse('not an object')).toThrow();
    expect(() => ResearchOutputSchema.parse(42)).toThrow();
  });

  it('a valid object response passes through the coercion unchanged (no regression)', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'cited', sources: [{ file: 'a.mjs' }], confidence: 0.8,
    });
    expect(out.answer).toBe('cited');
    expect(out.advisory).toBeUndefined();
    expect(out.failureCategory).toBeUndefined();
  });
});

describe('ResearchOutputSchema — sources[] primitive sanitization (backlog.fix.research-agent-sources-primitive-sanitization)', () => {
  // Live repro (v0.21.0): an object-with-answer whose sources[] carried a bare line NUMBER
  // failed the whole run (`sources[0] expected object received number`), discarding a good
  // multi-turn answer. Sanitization DROPS bare primitives while preserving well-formed entries.
  it('drops a bare number from sources[] and preserves the well-formed {file,snippet} entry', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'real answer', sources: [42, { file: 'a.mjs', snippet: 'x' }], confidence: 0.8,
    });
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([{ file: 'a.mjs', snippet: 'x' }]);
    expect(out.advisory).toBeUndefined(); // still has a cited source → not forced advisory
  });

  it('drops MIXED primitives (number AND string) while well-formed entries survive', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'real answer', sources: [12, 'line 12', { file: 'b.mjs' }], confidence: 0.7,
    });
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([{ file: 'b.mjs' }]);
  });

  it('all-primitive sources on an object-with-answer → [] + advisory:true, answer preserved (no throw)', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'answer text', sources: [1, 'x', 2], confidence: 0.7,
    });
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([]);
    expect(out.advisory).toBe(true); // empty sources → advisory via the object transform
    expect(out.answer).toBe('answer text');
  });

  it('well-formed multi-entry sources pass through unchanged, order preserved', () => {
    const input = [{ file: 'a.mjs', snippet: 's1' }, { file: 'b.mjs' }, { file: 'c.mjs', snippet: 's3' }];
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'cited', sources: input, confidence: 0.9,
    });
    expect(out.sources).toEqual(input);
    expect(out.advisory).toBeUndefined(); // non-empty sources → NOT forced advisory
  });

  it('sanitization is narrow: an object still missing `answer` (beyond sources) STILL fails', () => {
    expect(() => ResearchOutputSchema.parse({
      ok: true, sources: [42, { file: 'a.mjs' }], confidence: 0.8,
    })).toThrow();
  });

  it('additive: direct .parse returns identical sanitized output and does not emit; the drop is only RECORDED on the consume-once hook (backlog.fix.research-agent-sources-sanitized-emit)', () => {
    const out = ResearchOutputSchema.parse({
      ok: true, answer: 'real answer', sources: [42, { file: 'a.mjs', snippet: 'x' }], confidence: 0.8,
    });
    // identical sanitized output to the pre-emit behavior (purely additive change)
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([{ file: 'a.mjs', snippet: 'x' }]);
    expect(out.advisory).toBeUndefined();
    // The emit lives ONLY at the finalizeResult call site — a direct parse has no emitter and
    // fires no telemetry; it merely records the drop for a same-frame, consume-once read.
    expect(typeof ResearchOutputSchema._consumeSanitizationMeta).toBe('function');
    expect(ResearchOutputSchema._consumeSanitizationMeta()).toEqual({ dropped: 1, kept: 1 });
    // consume-once: cleared after read
    expect(ResearchOutputSchema._consumeSanitizationMeta()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.research-agent-output-contract
// ─────────────────────────────────────────────────────────────────────────────

describe('D6 — the fallback prompt no longer asks for ungroundable line citations', () => {
  it('agent.prompt (RESEARCH_SYSTEM_PROMPT) carries no line-number instruction or example', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'q', projectRoot: '/tmp' });
    expect(agent.prompt).not.toContain('[filename:lineNumber]');
    expect(agent.prompt).not.toContain('file.mjs:187');
  });

  it('a parsed source carries no line / lineNumber field', () => {
    const out = ResearchOutputSchema.parse({ ok: true, answer: 'a', sources: [{ file: 'a.mjs', snippet: 'x' }], confidence: 0.8 });
    expect(out.sources[0].file).toBe('a.mjs');
    expect('line' in out.sources[0]).toBe(false);
    expect('lineNumber' in out.sources[0]).toBe(false);
  });
});

describe('D7 — code-set failureCategory reaches the caller through the per-agent schema', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // The seam exercised: createResearchAgent(...).outputSchema.parse — the exact call
  // runner.finalizeResult makes after the model's final turn.
  const modelOut = { ok: true, answer: 'model answer', sources: [{ file: 'a.mjs', snippet: 'm' }], confidence: 0.6 };
  async function runWith(ragResults, output = modelOut, query = 'how does authorization middleware work') {
    ragQueryMock.mockReset();
    for (const r of ragResults) ragQueryMock.mockResolvedValueOnce(r);
    const agent = createResearchAgent({ projectId: 'test', query, projectRoot: '/tmp' });
    return { agent, tool: getRagQueryTool(agent) };
  }

  it('no_results: both queries empty → failureCategory no_results even though the model omitted it', async () => {
    const { agent, tool } = await runWith([{ ok: true, matches: [] }, { ok: true, matches: [] }]);
    await tool.execute({ q: 'how does authorization middleware work' });
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBe('no_results');
  });

  it('thin_results: exactly one match for both queries', async () => {
    const one = { ok: true, matches: [{ file: 'a.mjs' }] };
    const { agent, tool } = await runWith([one, one]);
    await tool.execute({ q: 'how does authorization middleware work' });
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBe('thin_results');
  });

  it('retrieval failure is retrieval_failed, not no_results', async () => {
    const failed = { ok: false, error: 'RAG store not found at /x', matches: [] };
    const { agent, tool } = await runWith([failed, failed]);
    await tool.execute({ q: 'how does authorization middleware work' });
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBe('retrieval_failed');
  });

  it('healthy retrieval: no code-set category; answer, confidence and source files equal the model output', async () => {
    const { agent, tool } = await runWith([{ ok: true, matches: [{ file: 'a.mjs' }, { file: 'b.mjs' }] }]);
    await tool.execute({ q: 'how does authorization middleware work' });
    const out = agent.outputSchema.parse(modelOut);
    expect(out.failureCategory).toBeUndefined();
    expect(out.answer).toBe(modelOut.answer);
    expect(out.confidence).toBe(modelOut.confidence);
    expect(out.sources.map((s) => s.file)).toEqual(modelOut.sources.map((s) => s.file));
  });

  it('best outcome across calls: an empty first call then a healthy second call → no category', async () => {
    const { agent, tool } = await runWith([
      { ok: true, matches: [] }, { ok: true, matches: [] },
      { ok: true, matches: [{ file: 'a.mjs' }, { file: 'b.mjs' }] },
    ]);
    await tool.execute({ q: 'how does authorization middleware work' });
    await tool.execute({ q: 'authorization middleware' });
    expect(agent.outputSchema.parse(modelOut).failureCategory).toBeUndefined();
  });

  it('precedence: a recorded no_results beats a volunteered partial_answer; healthy lets it through', async () => {
    const volunteered = { ...modelOut, failureCategory: 'partial_answer' };
    const a = await runWith([{ ok: true, matches: [] }, { ok: true, matches: [] }]);
    await a.tool.execute({ q: 'how does authorization middleware work' });
    expect(a.agent.outputSchema.parse(volunteered).failureCategory).toBe('no_results');

    const b = await runWith([{ ok: true, matches: [{ file: 'a.mjs' }, { file: 'b.mjs' }] }]);
    await b.tool.execute({ q: 'how does authorization middleware work' });
    expect(b.agent.outputSchema.parse(volunteered).failureCategory).toBe('partial_answer');
  });

  it('no state leakage: across instances, and across successive finalizes on one schema', async () => {
    const a = await runWith([{ ok: true, matches: [] }, { ok: true, matches: [] }]);
    await a.tool.execute({ q: 'how does authorization middleware work' });
    expect(a.agent.outputSchema.parse(modelOut).failureCategory).toBe('no_results');
    // Same schema, next finalize: the record was consumed.
    expect(a.agent.outputSchema.parse(modelOut).failureCategory).toBeUndefined();

    const b = await runWith([{ ok: true, matches: [{ file: 'a.mjs' }, { file: 'b.mjs' }] }]);
    await b.tool.execute({ q: 'how does authorization middleware work' });
    expect(b.agent.outputSchema.parse(modelOut).failureCategory).toBeUndefined();
  });

  it('the per-agent schema forwards _consumeSanitizationMeta: finalizeResult emits one sources_sanitized', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'q', projectRoot: '/tmp' });
    expect(typeof agent.outputSchema._consumeSanitizationMeta).toBe('function');
    const events = [];
    finalizeResult({
      name: 'research',
      rawText: JSON.stringify({ ok: true, answer: 'a', sources: [42, { file: 'a.mjs', snippet: 'x' }], confidence: 0.8 }),
      outputSchema: agent.outputSchema,
      telemetryId: 't',
      emitTelemetry: (event, data) => events.push({ event, data }),
      startTime: Date.now(),
      turns: 1,
      tokens: { in: 1, out: 1 },
    });
    const sanitized = events.filter((e) => e.event === 'sources_sanitized');
    expect(sanitized).toHaveLength(1);
    expect(sanitized[0].data).toEqual({ dropped: 1, kept: 1 });
  });

  it('failures-only telemetry predicate', () => {
    for (const c of ['retrieval_failed', 'malformed_output', 'timeout', 'escalated', 'partial_answer']) {
      expect(shouldEmitResearchFailureEvent(c), c).toBe(true);
    }
    for (const c of ['no_results', 'thin_results', undefined]) {
      expect(shouldEmitResearchFailureEvent(c), String(c)).toBe(false);
    }
  });
});
