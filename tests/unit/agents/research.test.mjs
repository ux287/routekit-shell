import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const ragQueryMock = vi.fn();

vi.mock('../../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagQuery: (...args) => ragQueryMock(...args),
}));

vi.mock('../../../packages/mcp-rks/src/rag/query-intent.mjs', () => ({
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

vi.mock('../../../packages/mcp-rks/src/server/telemetry/index.mjs', () => ({
  ensureTelemetryStorage: () => ({ emit: () => {}, flush: async () => {} }),
}));

import { createResearchAgent, ResearchOutputSchema } from '../../../packages/mcp-rks/src/agents/research.mjs';

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
    for (const cat of ['no_results', 'timeout', 'escalated', 'partial_answer']) {
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
  });

  it('a 1-element array whose element is a source (no answer/ok key) is treated as sources, not unwrapped', () => {
    const out = ResearchOutputSchema.parse([{ file: 'only.mjs', snippet: 'y' }]);
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].file).toBe('only.mjs');
    expect(out.answer).toBe(''); // coerced default answer
  });

  it('coerces a bare EMPTY array to a valid advisory:true output (transform still applies)', () => {
    const out = ResearchOutputSchema.parse([]);
    expect(out.ok).toBe(true);
    expect(out.sources).toEqual([]);
    expect(out.advisory).toBe(true); // empty sources → advisory via the object transform
  });

  it('unwraps the full result object when the model wraps it in a 1-element array', () => {
    const out = ResearchOutputSchema.parse([
      { ok: true, answer: 'wrapped answer', sources: [{ file: 'c.mjs' }], confidence: 0.9 },
    ]);
    expect(out.answer).toBe('wrapped answer');
    expect(out.sources).toHaveLength(1);
    expect(out.advisory).toBeUndefined(); // has sources → not advisory
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
});
