/**
 * backlog.fix.research-agent-named-path-read — the research agent detects a path or note slug named
 * in the question, reads it on a reserved slot outside the discovery read_file budget, and
 * program-stamps namedPaths from the detection and the observed read record.
 *
 * Unit tier. runRagQuery is mocked; every project root is a temp dir removed after the file.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ragQueryMock = vi.fn(async () => ({ ok: true, matches: [{ file: 'a.md', text: 'hit' }] }));
vi.mock('@routekit/rag', async (importOriginal) => ({ ...(await importOriginal()), runRagQuery: (...args) => ragQueryMock(...args) }));

const { createResearchAgent } = await import('../../../packages/mcp-rks/src/agents/research.mjs');

const restart = (index) => ({ index, kind: 'primary', resumed: false });
const tool = (agent, name) => agent.tools.find((t) => t.name === name);
// `ok` is required by ResearchOutputObject, so the model output carries it.
const MODEL_OUT = { ok: true, answer: 'a', sources: [], confidence: 0.5 };

const created = [];
afterAll(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function fixtureRoot(root = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-named-'))) {
  created.push(root);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'notes'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'notes', 'backlog.foo.bar.md'), '# foo bar note\n');
  for (const f of ['a.md', 'b.md', 'c.md', 'd.md']) fs.writeFileSync(path.join(root, f), `content of ${f}\n`);
  for (const f of ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs']) fs.writeFileSync(path.join(root, 'src', f), `// ${f}\n`);
  fs.writeFileSync(path.join(root, 'sub', '.env.local'), 'SECRET_TOKEN=supersecretvalue123\n');
  return root;
}

function agentFor(query, root = fixtureRoot()) {
  const agent = createResearchAgent({ projectId: 'test', query, projectRoot: root });
  agent.attemptState.beginAttempt(restart(0));
  return { agent, root };
}

const named = (parsed, p) => (parsed.namedPaths || []).find((e) => e.path === p);

describe('named-path detection', () => {
  beforeEach(() => ragQueryMock.mockClear());

  it('a named existing note slug is listed in namedPaths with exists true and in the userMessage', () => {
    const { agent } = agentFor('what does backlog.foo.bar say about scope?');
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(named(parsed, 'notes/backlog.foo.bar.md')).toMatchObject({ exists: true });
    expect(agent.userMessage).toContain('Named paths (exist on disk)');
    expect(agent.userMessage).toMatch(/Named paths \(exist on disk\)[^\n]*notes\/backlog\.foo\.bar\.md/);
  });

  it('a named path that does not exist yields exists false, read false and is not listed in the userMessage', () => {
    const { agent } = agentFor('explain src/missing-file.mjs');
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(named(parsed, 'src/missing-file.mjs')).toMatchObject({ exists: false, read: false });
    expect(agent.userMessage).not.toMatch(/Named paths \(exist on disk\)[^\n]*src\/missing-file\.mjs/);
  });

  it('a token resolving outside projectRoot is never a named path', async () => {
    // parent/proj is the root; parent/proj-evil shares its string prefix; parent/x.md is ../x.md.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-named-parent-'));
    created.push(parent);
    const root = fixtureRoot(path.join(parent, 'proj'));
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'x.md'), 'outside\n');
    fs.writeFileSync(path.join(parent, 'x.md'), 'parent\n');
    const siblingRel = `../${path.basename(sibling)}/x.md`;
    const { agent } = agentFor(`compare ../x.md with ${siblingRel} and src/one.mjs`, root);
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    // Positive control: the in-root path in the same query is detected.
    expect(named(parsed, 'src/one.mjs')).toMatchObject({ exists: true });
    for (const e of parsed.namedPaths || []) expect(e.path.startsWith('..')).toBe(false);
    expect(JSON.stringify(parsed.namedPaths || [])).not.toContain('-evil');
    expect(agent._namedPaths).toEqual(['src/one.mjs']);
    // No reserved allowance: an outside read is a discovery read and is refused by containment.
    const res = await tool(agent, 'read_file').execute({ path: siblingRel });
    expect(JSON.stringify(res)).toContain('Path traversal blocked');
    const after = agent.outputSchema.parse(MODEL_OUT).budget.read_file;
    expect(after.used).toBe(1);
    expect(after.paths.some((p) => p.named === true)).toBe(false);
  });

  it('the named set is capped at three entries', () => {
    const { agent } = agentFor('compare src/one.mjs src/two.mjs src/three.mjs src/four.mjs');
    const parsed = agent.outputSchema.parse(MODEL_OUT);
    expect(parsed.namedPaths).toHaveLength(3);
    expect(parsed.namedPaths.every((e) => e.exists === true)).toBe(true);
  });
});

describe('reserved allowance', () => {
  it('a read of a named path is listed in budget.read_file.paths with named true and does not decrement the discovery read_file budget', async () => {
    const { agent } = agentFor('what does backlog.foo.bar say?');
    const before = agent.outputSchema.parse(MODEL_OUT).budget.read_file.used;
    const res = await tool(agent, 'read_file').execute({ path: 'notes/backlog.foo.bar.md' });
    expect(res.ok).not.toBe(false);
    expect(JSON.stringify(res)).toContain('foo bar note');
    const after = agent.outputSchema.parse(MODEL_OUT);
    expect(after.budget.read_file.used).toBe(before);
    expect(after.budget.read_file.paths).toContainEqual(expect.objectContaining({ path: 'notes/backlog.foo.bar.md', named: true }));
    // Control: a non-named read does count, and its entry carries no named key.
    await tool(agent, 'read_file').execute({ path: 'a.md' });
    const third = agent.outputSchema.parse(MODEL_OUT).budget.read_file;
    expect(third.used).toBe(before + 1);
    expect(third.paths).toContainEqual({ path: 'a.md', offset: 0, limit: 200 });
  });

  it('after three discovery reads a named read executes and a fourth non-named read is refused', async () => {
    const { agent } = agentFor('what does backlog.foo.bar say?');
    for (const p of ['a.md', 'b.md', 'c.md']) await tool(agent, 'read_file').execute({ path: p });
    const namedRead = await tool(agent, 'read_file').execute({ path: 'notes/backlog.foo.bar.md' });
    expect(namedRead.ok).not.toBe(false);
    expect(JSON.stringify(namedRead)).toContain('foo bar note');
    const fourth = await tool(agent, 'read_file').execute({ path: 'd.md' });
    expect(fourth.ok).toBe(false);
    expect(fourth.error).toMatch(/read_file budget exhausted \(3\/3\)/);
  });

  it('a named dotenv read is redacted to variable names only', async () => {
    const { agent } = agentFor('what is configured in sub/.env.local?');
    expect(agent._namedPaths).toEqual(['sub/.env.local']);
    const res = await tool(agent, 'read_file').execute({ path: 'sub/.env.local' });
    const text = JSON.stringify(res);
    expect(text).toContain('REDACTED dotenv file');
    expect(text).toContain('SECRET_TOKEN');
    expect(text).not.toContain('supersecretvalue123');
    expect(agent.outputSchema.parse(MODEL_OUT).budget.read_file.paths)
      .toContainEqual(expect.objectContaining({ path: 'sub/.env.local', named: true }));
  });
});

describe('program-stamped namedPaths', () => {
  it('read is true only when read_file executed and a model-supplied namedPaths is overwritten', async () => {
    const { agent } = agentFor('compare backlog.foo.bar with src/one.mjs');
    await tool(agent, 'read_file').execute({ path: 'notes/backlog.foo.bar.md' });
    const parsed = agent.outputSchema.parse({ ...MODEL_OUT, namedPaths: [{ path: 'src/one.mjs', exists: true, read: true }, { path: 'fake.md', exists: true, read: true }] });
    expect(named(parsed, 'notes/backlog.foo.bar.md')).toMatchObject({ exists: true, read: true });
    expect(named(parsed, 'src/one.mjs')).toMatchObject({ exists: true, read: false });
    expect(named(parsed, 'fake.md')).toBeUndefined();
  });
});

describe('verbatim short-circuit', () => {
  it('a verbatim query fires shortCircuit and skips named-path detection, and a named-path query leaves shortCircuit undefined', async () => {
    const { agent: verbatimAgent } = agentFor('read notes/backlog.foo.bar.md verbatim');
    expect(typeof verbatimAgent.shortCircuit).toBe('function');
    expect(verbatimAgent._namedPaths).toEqual([]);
    expect(await verbatimAgent.shortCircuit()).toMatchObject({ ok: true, answer: '# foo bar note\n' });
    const { agent } = agentFor('what does backlog.foo.bar say?');
    expect(agent._namedPaths).toEqual(['notes/backlog.foo.bar.md']);
    expect(agent.shortCircuit).toBeUndefined();
  });
});
