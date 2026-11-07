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
