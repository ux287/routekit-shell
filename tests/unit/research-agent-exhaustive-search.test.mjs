/**
 * backlog.feat.research-agent-exhaustive-search-tool — the research agent's exhaustive_search tool,
 * its dotenv guard, its own budget counter and call ledger, and the program-stamped
 * deterministicNegativeObserved flag (in-process and across the claude-cli budget transport).
 *
 * Unit tier. Entirely in-process: no subprocess is spawned by this file, no network, no LLM call.
 * runRagQuery is replaced via vi.mock of @routekit/rag (importOriginal keeps runExhaustiveSearch real).
 * Fixtures live in per-test temp dirs, removed after each test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ragSpy = vi.fn(async () => ({ ok: true, matches: [] }));
vi.mock('@routekit/rag', async (importOriginal) => ({ ...(await importOriginal()), runRagQuery: (...a) => ragSpy(...a) }));

const { createResearchAgent, ResearchOutputSchema } = await import('../../packages/mcp-rks/src/agents/research.mjs');
const { zodToJsonSchema } = await import('../../packages/mcp-rks/src/agents/zod-to-json-schema.mjs');

const FLAG = 'deterministicNegativeObserved';
const MODEL_OUT = { ok: true, answer: 'a', sources: [{ file: 'sample.mjs' }], confidence: 0.9 };
const RESULT_KEYS = ['ok', 'pattern', 'path', 'anchor', 'exhaustive', 'countOnly', 'fileCount', 'matchCount', 'truncated', 'skipped', 'warnings', 'results', 'files'];
const restart = (index) => ({ index, kind: 'same_model_retry', resumed: false });
const resume = (index) => ({ index, kind: 'escalation', resumed: true });

let tmpDir;
beforeEach(() => {
  ragSpy.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-research-exhaustive-'));
  fs.writeFileSync(path.join(tmpDir, 'sample.mjs'), 'export const marker = "POSITIVE_CONTROL";\n');
  fs.mkdirSync(path.join(tmpDir, 'sub'));
  fs.writeFileSync(path.join(tmpDir, 'sub', 'other.mjs'), 'export const other = "OTHER_CONTROL";\n');
  fs.writeFileSync(path.join(tmpDir, '.env'), 'QA_CANARY_SECRET=sk-live-QA-CANARY-VALUE\n');
  fs.writeFileSync(path.join(tmpDir, '.env.example'), 'EXAMPLE_KEY=sk-example-placeholder\n');
  fs.writeFileSync(path.join(tmpDir, '.env.sample'), 'SAMPLE_KEY=sk-example-sample\n');
  fs.writeFileSync(path.join(tmpDir, '.env.template'), 'TEMPLATE_KEY=sk-example-template\n');
  fs.mkdirSync(path.join(tmpDir, 'dist'));
  fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'POSITIVE_CONTROL\n');
});
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const freshAgent = () => createResearchAgent({ projectId: 'test', query: 'q', scope: 'all', projectRoot: tmpDir });
const tool = (agent, name) => agent.tools.find((t) => t.name === name);
const search = (agent, input) => tool(agent, 'exhaustive_search').execute(input);
async function exhaust(agent) { let last; for (let i = 0; i < 25; i++) last = await search(agent, { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' }); return last; }
async function recordPair(agent, zeroPath = 'sample.mjs', controlPath = 'sample.mjs', controlPattern = 'POSITIVE_CONTROL') {
  const zero = await search(agent, { pattern: 'NO_SUCH_TOKEN_QA', path: zeroPath });
  const control = await search(agent, { pattern: controlPattern, path: controlPath });
  return { zero, control };
}

describe('exhaustive_search registration', () => {
  it('is present on the agent, found by name', () => {
    expect(freshAgent().tools.some((t) => t.name === 'exhaustive_search')).toBe(true);
  });
  it('does not displace the six pre-existing tools', () => {
    const names = freshAgent().tools.map((t) => t.name);
    for (const n of ['rag_query', 'read_file', 'read_git', 'dendron_create_note', 'dendron_edit_note', 'dendron_update_field']) expect(names).toContain(n);
  });
  it('declares pattern and path required and countOnly and maxResults optional', () => {
    const s = zodToJsonSchema(tool(freshAgent(), 'exhaustive_search').inputSchema);
    expect(s.required).toEqual(expect.arrayContaining(['pattern', 'path']));
    expect(s.required ?? []).not.toContain('countOnly');
    expect(s.required ?? []).not.toContain('maxResults');
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['pattern', 'path', 'countOnly', 'maxResults']));
  });
});

describe('exhaustive_search refusals', () => {
  it('refuses a call with no path', async () => {
    const r = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL' });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });
  it('refuses a call with no pattern', async () => {
    const r = await search(freshAgent(), { path: '.' });
    expect(r.ok).toBe(false);
    expect(r.error.length).toBeGreaterThan(0);
  });
  it('refuses a path that escapes the project root', async () => {
    expect((await search(freshAgent(), { pattern: 'x', path: '../..' })).ok).toBe(false);
  });
  it('refuses a nonexistent scope distinguishably from a zero result', async () => {
    const r = await search(freshAgent(), { pattern: 'x', path: 'no-such-dir' });
    expect(r.ok).toBe(false);
    expect(r.matchCount).toBeUndefined();
  });
  it('a refused call does not consume budget', async () => {
    const agent = freshAgent();
    for (let i = 0; i < 25; i++) await search(agent, { pattern: 'POSITIVE_CONTROL' });
    expect((await search(agent, { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' })).ok).not.toBe(false);
  });
});

describe('exhaustive_search retrieved text', () => {
  it('carries the disclosure fields including warnings and per-hit coordinates', async () => {
    const r = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' });
    for (const k of ['anchor', 'exhaustive', 'fileCount', 'matchCount', 'truncated', 'skipped', 'warnings']) expect(r).toHaveProperty(k);
    for (const k of ['file', 'line', 'text']) expect(r.results[0]).toHaveProperty(k);
  });
  it('result text is byte-identical to the source line', async () => {
    const r = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' });
    const src = fs.readFileSync(path.join(tmpDir, 'sample.mjs'), 'utf8').split('\n')[r.results[0].line - 1];
    expect(r.results[0].text).toBe(src);
    expect(r.results[0].redacted).toBeUndefined();
  });
  it('is deterministic across two identical calls', async () => {
    const a = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: '.' });
    const b = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: '.' });
    expect(b.results).toEqual(a.results);
    expect(b.matchCount).toBe(a.matchCount);
    expect(b.fileCount).toBe(a.fileCount);
  });
});

describe('exhaustive_search pruning disclosure', () => {
  it('a pruned directory yields exhaustive false with an ignored_dir skip and an unpruned scope yields exhaustive true', async () => {
    const pruned = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: '.' });
    expect(pruned.exhaustive).toBe(false);
    expect(pruned.skipped.some((s) => s.path.includes('dist') && s.reason === 'ignored_dir')).toBe(true);
    const clean = await search(freshAgent(), { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' });
    expect(clean.exhaustive).toBe(true);
    expect(clean.skipped).toEqual([]);
  });
});

describe('exhaustive_search dotenv guard', () => {
  it('withholds the secret value from a .env hit while disclosing the name', async () => {
    const r = await search(freshAgent(), { pattern: 'sk-', path: '.' });
    expect(JSON.stringify(r)).not.toContain('sk-live-QA-CANARY-VALUE');
    const envHit = r.results.find((h) => path.basename(h.file) === '.env');
    expect(envHit.text).toContain('QA_CANARY_SECRET');
  });
  it('returns .env.example, .env.sample and .env.template hits verbatim', async () => {
    const r = await search(freshAgent(), { pattern: 'sk-example', path: '.' });
    const texts = r.results.map((h) => h.text).join('\n');
    for (const v of ['sk-example-placeholder', 'sk-example-sample', 'sk-example-template']) expect(texts).toContain(v);
  });
  it('a hit only inside a protected dotenv file still reports file and line', async () => {
    const r = await search(freshAgent(), { pattern: 'sk-live', path: '.' });
    expect(r.results).toHaveLength(1);
    expect(path.basename(r.results[0].file)).toBe('.env');
    expect(r.results[0].line).toBe(1);
    expect(r.results[0].text).not.toContain('sk-live-QA-CANARY-VALUE');
  });
  it('marks a redacted .env hit redacted true and leaves a .env.example hit unmarked', async () => {
    const r = await search(freshAgent(), { pattern: 'sk-', path: '.' });
    const envHit = r.results.find((h) => path.basename(h.file) === '.env');
    const exampleHit = r.results.find((h) => path.basename(h.file) === '.env.example');
    expect(envHit.redacted).toBe(true);
    expect(exampleHit).toBeDefined();
    expect(exampleHit.redacted).toBeUndefined();
    expect(exampleHit.text).toBe('EXAMPLE_KEY=sk-example-placeholder');
  });
});

describe('exhaustive_search budget', () => {
  it('exhaustion returns an error naming the budget, never throws and never calls runRagQuery', async () => {
    const last = await exhaust(freshAgent());
    expect(last.ok).toBe(false);
    expect(last.error).toMatch(/budget/i);
    expect(last.budgetExhausted).toBe('exhaustive_search');
    expect(ragSpy).not.toHaveBeenCalled();
  });
  it('its counter is independent of read_git in both directions', async () => {
    const a = freshAgent();
    await exhaust(a);
    const afterExhaust = a.outputSchema.parse({ ...MODEL_OUT }).budget;
    expect(afterExhaust.exhausted).toContain('exhaustive_search');
    expect(afterExhaust.rag_query.used).toBe(0);
    expect(afterExhaust.read_file.used).toBe(0);
    const git = await tool(a, 'read_git').execute({ tool: 'git_state' });
    expect(JSON.stringify(git)).not.toMatch(/budget exhausted/i);
    const b = freshAgent();
    for (let i = 0; i < 3; i++) await tool(b, 'read_git').execute({ tool: 'git_state' });
    expect(JSON.stringify(await tool(b, 'read_git').execute({ tool: 'git_state' }))).toMatch(/budget exhausted/i);
    expect((await search(b, { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' })).ok).not.toBe(false);
  });
  it('the counter resets on a restart attempt and carries on a resume', async () => {
    const agent = freshAgent();
    await exhaust(agent);
    agent.attemptState.beginAttempt(resume(1));
    expect((await search(agent, { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' })).ok).toBe(false);
    agent.attemptState.beginAttempt(restart(2));
    expect((await search(agent, { pattern: 'POSITIVE_CONTROL', path: 'sample.mjs' })).ok).not.toBe(false);
  });
});

describe('observation flag schema', () => {
  it('ResearchOutputSchema parses the flag absent, true and false and rejects a non-boolean', () => {
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT })).not.toThrow();
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT, [FLAG]: true })).not.toThrow();
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT, [FLAG]: false })).not.toThrow();
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT, [FLAG]: 'yes' })).toThrow();
  });
  it('advisory and truncated still parse and a payload carrying neither still parses', () => {
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT, advisory: true, truncated: true })).not.toThrow();
    expect(() => ResearchOutputSchema.parse({ ...MODEL_OUT })).not.toThrow();
  });
  it('the flag is named and described as an observation, not a verified claim', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'packages/mcp-rks/src/agents/research.mjs'), 'utf8');
    const decl = src.split('\n').find((l) => l.includes(`${FLAG}: z.boolean()`));
    expect(decl).toBeDefined();
    expect(decl.toLowerCase()).toContain('a deterministic negative was obtained');
    expect(decl).not.toMatch(/verified/i);
  });
});

describe('program-stamped deterministicNegativeObserved', () => {
  it('the ledger is per instance and never returned by the tool', async () => {
    const a = freshAgent();
    const { zero, control } = await recordPair(a);
    for (const r of [zero, control]) for (const k of Object.keys(r)) expect(RESULT_KEYS).toContain(k);
    const b = freshAgent();
    expect(b.outputSchema.parse({ ...MODEL_OUT, [FLAG]: true })[FLAG]).not.toBe(true);
  });
  it('a model-asserted true is downgraded when no qualifying pair was observed', () => {
    expect(freshAgent().outputSchema.parse({ ...MODEL_OUT, [FLAG]: true })[FLAG]).not.toBe(true);
  });
  it('is true after a same-path zero at exhaustive true plus a different-pattern hit', async () => {
    const agent = freshAgent();
    const { zero, control } = await recordPair(agent);
    expect(zero.matchCount).toBe(0);
    expect(zero.exhaustive).toBe(true);
    expect(control.matchCount).toBeGreaterThan(0);
    expect(agent.outputSchema.parse({ ...MODEL_OUT, [FLAG]: false })[FLAG]).toBe(true);
  });
  it('a zero at exhaustive false does not qualify', async () => {
    const agent = freshAgent();
    const { zero } = await recordPair(agent, '.', '.');
    expect(zero.exhaustive).toBe(false);
    expect(agent.outputSchema.parse({ ...MODEL_OUT, [FLAG]: true })[FLAG]).not.toBe(true);
  });
  it('a positive control on a different path does not qualify', async () => {
    const agent = freshAgent();
    await recordPair(agent, 'sample.mjs', 'sub/other.mjs', 'OTHER_CONTROL');
    expect(agent.outputSchema.parse({ ...MODEL_OUT, [FLAG]: true })[FLAG]).not.toBe(true);
  });
  it('parsing the same payload twice yields the same flag', async () => {
    const agent = freshAgent();
    await recordPair(agent);
    const first = agent.outputSchema.parse({ ...MODEL_OUT })[FLAG];
    const second = agent.outputSchema.parse({ ...MODEL_OUT })[FLAG];
    expect(second).toBe(first);
  });
  it('the ledger resets on a restart attempt and carries on a resume', async () => {
    const a = freshAgent();
    await recordPair(a);
    a.attemptState.beginAttempt(resume(1));
    expect(a.outputSchema.parse({ ...MODEL_OUT })[FLAG]).toBe(true);
    a.attemptState.beginAttempt(restart(2));
    expect(a.outputSchema.parse({ ...MODEL_OUT })[FLAG]).not.toBe(true);
  });
});

// PO amendment 2026-11-19: the tool is served on the claude-cli backend, where the tools run in the
// rks-agent-tools child and the parent replays _budget.snapshot(). These tests exercise that transport
// in-process between two agent instances. Titles mapped in requirementCoverage by the QA re-run of 2026-11-19.
describe('claude-cli transport of the ledger', () => {
  it('the budget snapshot carries the exhaustive_search counter and ledger', async () => {
    const child = freshAgent();
    await recordPair(child);
    const snap = child._budget.snapshot();
    expect(snap.exhaustive_search.used).toBe(2);
    expect(snap.exhaustive_search.calls.map((c) => c.pattern)).toEqual(['NO_SUCH_TOKEN_QA', 'POSITIVE_CONTROL']);
    expect(snap.exhaustive_search.calls[0]).toMatchObject({ path: 'sample.mjs', matchCount: 0, exhaustive: true });
  });
  it('a parent that replays a child snapshot holding a qualifying pair stamps the flag true', async () => {
    const child = freshAgent();
    await recordPair(child);
    const parent = freshAgent();
    expect(parent.outputSchema.parse({ ...MODEL_OUT })[FLAG]).not.toBe(true); // control: nothing replayed yet
    expect(parent._budget.replay(JSON.parse(JSON.stringify(child._budget.snapshot())))).toBe(true);
    expect(parent.outputSchema.parse({ ...MODEL_OUT, [FLAG]: false })[FLAG]).toBe(true);
  });
  it('replay rejects a missing exhaustive_search key, a used that differs from its ledger length, a used above max and a malformed entry, and loads nothing', async () => {
    const child = freshAgent();
    await recordPair(child);
    const good = child._budget.snapshot();
    const parent = freshAgent();
    const before = parent._budget.snapshot();
    const { exhaustive_search: _dropped, ...missing } = good;
    expect(parent._budget.replay(missing)).toBe(false);
    expect(parent._budget.replay({ ...good, exhaustive_search: { ...good.exhaustive_search, used: 1 } })).toBe(false);
    const seven = Array.from({ length: 7 }, () => ({ ...good.exhaustive_search.calls[1] }));
    expect(parent._budget.replay({ ...good, exhaustive_search: { ...good.exhaustive_search, used: 7, calls: seven } })).toBe(false);
    expect(parent._budget.replay({ ...good, exhaustive_search: { ...good.exhaustive_search, calls: [good.exhaustive_search.calls[0], { path: 'sample.mjs' }] } })).toBe(false);
    expect(parent._budget.snapshot()).toEqual(before);
    expect(parent._budget.replay(good)).toBe(true); // control: the unmodified snapshot is accepted
  });
  it('an unobserved budget never stamps the flag true', async () => {
    const agent = freshAgent();
    await recordPair(agent);
    expect(agent.outputSchema.parse({ ...MODEL_OUT })[FLAG]).toBe(true); // control: the pair qualifies
    agent._budget.markUnobserved();
    expect(agent.outputSchema.parse({ ...MODEL_OUT, [FLAG]: true })[FLAG]).not.toBe(true);
  });
});

describe('fallback system prompt', () => {
  it('names exhaustive_search as its own tool and states the absence rule', () => {
    const prompt = freshAgent().prompt;
    expect(prompt).toMatch(/(^|[^_a-z])exhaustive_search/);
    expect(prompt.toLowerCase()).toContain('positive control');
  });
});
