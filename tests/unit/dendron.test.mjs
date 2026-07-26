import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../packages/mcp-rks/src/rag/tools.mjs');

import { runRagEmbed } from '../../packages/mcp-rks/src/rag/tools.mjs';
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
