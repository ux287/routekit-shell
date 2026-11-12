import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('@routekit/rag/tools');

import { runRagEmbed } from '@routekit/rag/tools';
import { createDendronAgent } from '../../packages/mcp-rks/src/agents/dendron.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-dendron-test-'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rks', 'prompts'), { recursive: true });
  return dir;
}

function getTool(agent, name) {
  return agent.tools.find(t => t.name === name);
}

describe('dendron_create embed trigger', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls runRagEmbed with the new note file path after write succeeds', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'create foo', projectRoot: dir });
    const tool = getTool(agent, 'dendron_create');
    const result = await tool.execute({ filename: 'foo' });
    expect(result.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledOnce();
    expect(runRagEmbed).toHaveBeenCalledWith(dir, {
      files: [expect.stringContaining('notes/foo.md')],
    });
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValueOnce(new Error('embed failed'));
    const agent = createDendronAgent({ projectId: 'test', request: 'create bar', projectRoot: dir });
    const tool = getTool(agent, 'dendron_create');
    const result = await tool.execute({ filename: 'bar' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe('embed failed');
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed returns ok:false', async () => {
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'lock held' });
    const agent = createDendronAgent({ projectId: 'test', request: 'create baz', projectRoot: dir });
    const tool = getTool(agent, 'dendron_create');
    const result = await tool.execute({ filename: 'baz' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBeTruthy();
  });

  it('does not call runRagEmbed when note already exists', async () => {
    const notePath = path.join(dir, 'notes', 'existing.md');
    fs.writeFileSync(notePath, '---\nid: "existing"\n---\n');
    const agent = createDendronAgent({ projectId: 'test', request: 'create existing', projectRoot: dir });
    const tool = getTool(agent, 'dendron_create');
    const result = await tool.execute({ filename: 'existing' });
    expect(result.error).toBeTruthy();
    expect(runRagEmbed).not.toHaveBeenCalled();
  });
});

describe('dendron_edit embed trigger', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
    fs.writeFileSync(
      path.join(dir, 'notes', 'foo.md'),
      '---\nid: "foo"\ntitle: "Foo"\ncreated: 1000000\nupdated: 1000000\n---\n\nOriginal content.'
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls runRagEmbed with the edited note file path after edit succeeds', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'edit foo', projectRoot: dir });
    const tool = getTool(agent, 'dendron_edit');
    const result = await tool.execute({ filename: 'foo', content: 'Updated content.' });
    expect(result.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledOnce();
    expect(runRagEmbed).toHaveBeenCalledWith(dir, {
      files: [expect.stringContaining('notes/foo.md')],
    });
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValueOnce(new Error('embed failed'));
    const agent = createDendronAgent({ projectId: 'test', request: 'edit foo', projectRoot: dir });
    const tool = getTool(agent, 'dendron_edit');
    const result = await tool.execute({ filename: 'foo', content: 'Updated content.' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe('embed failed');
  });

  it('does not call runRagEmbed when edit fails (note not found)', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'edit missing', projectRoot: dir });
    const tool = getTool(agent, 'dendron_edit');
    const result = await tool.execute({ filename: 'missing', content: 'content' });
    expect(result.ok).toBe(false);
    expect(runRagEmbed).not.toHaveBeenCalled();
  });
});

// ── backlog.fix.dendron-array-field-write-destroys-unread-entries ────────────
//
// This door is FAIL-CLOSED by decision, and the decision is witnessed rather than
// assumed. It forwards the library result verbatim, and its zod schema accepts only
// filename, field and value — so there is no argument a caller can pass that would let a
// shrinking write through. That is deliberate: this agent is driven by a natural-language
// request, and the tokenless route upstream stringifies its payload, so nothing
// structured would survive to carry an acknowledgement anyway.

describe('dendron_update_field — the agent door forwards an array-shrink refusal', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
    fs.writeFileSync(
      path.join(dir, 'notes', 'story.md'),
      '---\nid: "story"\ntitle: "S"\ncreated: 1\nupdated: 2\ntestFiles:\n  - a\n  - b\n  - c\n---\n\nbody\n'
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the library ok false rather than reporting a success', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'shrink', projectRoot: dir });
    const result = await getTool(agent, 'dendron_update_field').execute({
      filename: 'story', field: 'testFiles', value: ['a'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('array_entries_removed');
    expect(result.removed).toEqual(['b', 'c']);
  });

  it('leaves the note unchanged on a refusal', async () => {
    const notePath = path.join(dir, 'notes', 'story.md');
    const before = fs.readFileSync(notePath, 'utf8');
    const agent = createDendronAgent({ projectId: 'test', request: 'shrink', projectRoot: dir });
    await getTool(agent, 'dendron_update_field').execute({
      filename: 'story', field: 'testFiles', value: [],
    });
    expect(fs.readFileSync(notePath, 'utf8')).toBe(before);
  });

  it('CANNOT acknowledge — no accepted argument lets the shrink proceed', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'shrink', projectRoot: dir });
    const tool = getTool(agent, 'dendron_update_field');
    // The tool's own schema is the guarantee: only these three keys are accepted, so an
    // acknowledgement has nowhere to travel. Asserted on the schema, not on a hopeful call.
    expect(Object.keys(tool.inputSchema.shape).sort()).toEqual(['field', 'filename', 'value']);

    const result = await tool.execute({
      filename: 'story', field: 'testFiles', value: ['a'], acknowledgeRemoval: true,
    });
    expect(result.ok).toBe(false);
  });

  it('still forwards a growing write as a success', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'grow', projectRoot: dir });
    const result = await getTool(agent, 'dendron_update_field').execute({
      filename: 'story', field: 'testFiles', value: ['a', 'b', 'c', 'd'],
    });
    expect(result.ok).toBe(true);
    expect(result.afterCount).toBe(4);
  });
});

// ── backlog.fix.dendron-note-write-surfaces-stale-embed-code ─────────────────
//
// runRagEmbed reports embedCodeStale (true / false / null) with a warning on an ok result
// (backlog.fix.rag-embed-server-stale-module-unreported). Every dendron write path that
// embeds after writing must surface a stale-but-ok embed, and an unobserved ok embed that
// carries a warning, as ragEmbedWarning — without changing the ok false and throw branches.

describe('dendron write paths surface a stale-but-ok embed', () => {
  let dir;
  let uniq;

  const STALE_WARNING = 'embed ran stale code; restart the MCP server';

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    uniq = 0;
    dir = makeTempProject();
    const notes = path.join(dir, 'notes');
    fs.writeFileSync(
      path.join(notes, 'editme.md'),
      '---\nid: "editme"\ntitle: "Edit me"\ncreated: 1000000\nupdated: 1000000\n---\n\nOriginal content.'
    );
    fs.writeFileSync(
      path.join(notes, 'fieldme.md'),
      '---\nid: "fieldme"\ntitle: "Field me"\ncreated: 1000000\nupdated: 1000000\nphase: "draft"\n---\n\nbody\n'
    );
    fs.writeFileSync(
      path.join(notes, 'fixme.md'),
      '---\nid: "fixme"\n---\n\nbody\n'
    );
    fs.mkdirSync(path.join(notes, 'z_implemented'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedBacklogNote() {
    uniq += 1;
    const name = `backlog.test.story-${uniq}`;
    fs.writeFileSync(
      path.join(dir, 'notes', `${name}.md`),
      `---\nid: "${name}"\ntitle: "Story ${uniq}"\ncreated: 1000000\nupdated: 1000000\nstatus: "not-implemented"\n---\n\nbody\n`
    );
    return name;
  }

  // One runner per write path; each returns the tool result.
  const WRITE_PATHS = {
    dendron_create: async (agent) => {
      uniq += 1;
      return getTool(agent, 'dendron_create').execute({ filename: `fresh-${uniq}` });
    },
    dendron_edit: async (agent) =>
      getTool(agent, 'dendron_edit').execute({ filename: 'editme', content: 'Updated content.' }),
    dendron_update_field: async (agent) =>
      getTool(agent, 'dendron_update_field').execute({ filename: 'fieldme', field: 'phase', value: 'ready' }),
    dendron_fix_frontmatter: async (agent) =>
      getTool(agent, 'dendron_fix_frontmatter').execute({ filename: 'fixme' }),
    dendron_mark_implemented: async (agent) =>
      getTool(agent, 'dendron_mark_implemented').execute({ filename: seedBacklogNote(), commitId: 'abc1234' }),
  };

  async function runPath(name) {
    const agent = createDendronAgent({ projectId: 'test', request: name, projectRoot: dir });
    const result = await WRITE_PATHS[name](agent);
    expect(runRagEmbed, `${name} should call runRagEmbed`).toHaveBeenCalled();
    return result;
  }

  async function staleWithWarning(name) {
    runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: true, warning: STALE_WARNING });
    const result = await runPath(name);
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe(STALE_WARNING);
  }

  it('dendron_create sets ragEmbedWarning from the warning of an ok stale embed', async () => {
    await staleWithWarning('dendron_create');
  });

  it('dendron_edit sets ragEmbedWarning from the warning of an ok stale embed', async () => {
    await staleWithWarning('dendron_edit');
  });

  it('dendron_update_field sets ragEmbedWarning from the warning of an ok stale embed', async () => {
    await staleWithWarning('dendron_update_field');
  });

  it('dendron_fix_frontmatter sets ragEmbedWarning from the warning of an ok stale embed', async () => {
    await staleWithWarning('dendron_fix_frontmatter');
  });

  it('dendron_mark_implemented sets ragEmbedWarning from the warning of an ok stale embed', async () => {
    await staleWithWarning('dendron_mark_implemented');
  });

  it('falls back to a restart message on every write path when an ok stale embed carries no warning', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: true });
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(typeof result.ragEmbedWarning, name).toBe('string');
      expect(result.ragEmbedWarning.length, name).toBeGreaterThan(0);
      expect(result.ragEmbedWarning, name).toMatch(/restart/i);
    }
  });

  it('leaves ragEmbedWarning unset on every write path when embedCodeStale is false', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: false });
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(result.ragEmbedWarning, name).toBeUndefined();
    }
  });

  it('sets ragEmbedWarning from the warning on every write path when embedCodeStale is null and a warning is carried', async () => {
    const W = 'Could not determine whether the RAG embed ran current embed code: fingerprint unavailable';
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({
        ok: true, embedCodeStale: null, embedCodeStaleReason: 'fingerprint unavailable', warning: W,
      });
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(result.ragEmbedWarning, name).toBe(W);
    }
  });

  it('leaves ragEmbedWarning unset on every write path when embedCodeStale is null and no warning is carried', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({ ok: true, embedCodeStale: null });
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(result.ragEmbedWarning, name).toBeUndefined();
    }
  });

  it('leaves ragEmbedWarning unset on every write path when embedCodeStale is absent', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({ ok: true, indexed: 1 });
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(result.ragEmbedWarning, name).toBeUndefined();
    }
  });

  it('keeps ragEmbedWarning equal to embedResult.error on every write path when the embed returns ok false', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockResolvedValueOnce({
        ok: false, error: 'lock held', embedCodeStale: true, warning: STALE_WARNING,
      });
      const result = await runPath(name);
      expect(result.ragEmbedWarning, name).toBe('lock held');
    }
  });

  it('keeps ragEmbedWarning equal to the thrown message on every write path when runRagEmbed throws', async () => {
    for (const name of Object.keys(WRITE_PATHS)) {
      runRagEmbed.mockRejectedValueOnce(new Error('embed exploded'));
      const result = await runPath(name);
      expect(result.ok, name).toBe(true);
      expect(result.ragEmbedWarning, name).toBe('embed exploded');
    }
  });
});
