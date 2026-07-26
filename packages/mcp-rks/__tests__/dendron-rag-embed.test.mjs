import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../src/rag/tools.mjs');

import { runRagEmbed } from '../src/rag/tools.mjs';
import { createDendronAgent } from '../src/agents/dendron.mjs';

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-dendron-rag-test-'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rks', 'prompts'), { recursive: true });
  return dir;
}

function makeNote(dir, filename, extra = '') {
  fs.writeFileSync(
    path.join(dir, 'notes', `${filename}.md`),
    `---\nid: "${filename}"\ntitle: "Test"\ncreated: 1000000\nupdated: 1000000\nphase: "draft"\n---\n\nContent.${extra}`
  );
}

function getTool(agent, name) {
  return agent.tools.find(t => t.name === name);
}

describe('dendron_update_field embed trigger', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
    makeNote(dir, 'backlog.feat.foo');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls runRagEmbed with the note path after updateField succeeds', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'update field', projectRoot: dir });
    const tool = getTool(agent, 'dendron_update_field');
    const result = await tool.execute({ filename: 'backlog.feat.foo', field: 'phase', value: 'ready' });
    expect(result.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledOnce();
    expect(runRagEmbed).toHaveBeenCalledWith(dir, {
      files: [expect.stringContaining('notes/backlog.feat.foo.md')],
    });
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed returns ok:false', async () => {
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'lock held' });
    const agent = createDendronAgent({ projectId: 'test', request: 'update field', projectRoot: dir });
    const tool = getTool(agent, 'dendron_update_field');
    const result = await tool.execute({ filename: 'backlog.feat.foo', field: 'phase', value: 'ready' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBeTruthy();
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValueOnce(new Error('embed crashed'));
    const agent = createDendronAgent({ projectId: 'test', request: 'update field', projectRoot: dir });
    const tool = getTool(agent, 'dendron_update_field');
    const result = await tool.execute({ filename: 'backlog.feat.foo', field: 'phase', value: 'ready' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe('embed crashed');
  });
});

describe('dendron_fix_frontmatter embed trigger', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
    makeNote(dir, 'backlog.feat.bar');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls runRagEmbed with the note path after writeNoteRaw succeeds', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'fix frontmatter', projectRoot: dir });
    const tool = getTool(agent, 'dendron_fix_frontmatter');
    const result = await tool.execute({ filename: 'backlog.feat.bar' });
    expect(result.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledOnce();
    expect(runRagEmbed).toHaveBeenCalledWith(dir, {
      files: [expect.stringContaining('notes/backlog.feat.bar.md')],
    });
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed returns ok:false', async () => {
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'lock' });
    const agent = createDendronAgent({ projectId: 'test', request: 'fix frontmatter', projectRoot: dir });
    const tool = getTool(agent, 'dendron_fix_frontmatter');
    const result = await tool.execute({ filename: 'backlog.feat.bar' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBeTruthy();
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValueOnce(new Error('embed crashed'));
    const agent = createDendronAgent({ projectId: 'test', request: 'fix frontmatter', projectRoot: dir });
    const tool = getTool(agent, 'dendron_fix_frontmatter');
    const result = await tool.execute({ filename: 'backlog.feat.bar' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe('embed crashed');
  });

  it('does not call runRagEmbed when note does not exist', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'fix frontmatter', projectRoot: dir });
    const tool = getTool(agent, 'dendron_fix_frontmatter');
    const result = await tool.execute({ filename: 'missing' });
    expect(result.ok).toBe(false);
    expect(runRagEmbed).not.toHaveBeenCalled();
  });
});

describe('dendron_mark_implemented embed trigger', () => {
  let dir;

  beforeEach(() => {
    vi.resetAllMocks();
    runRagEmbed.mockResolvedValue({ ok: true, indexed: 1 });
    dir = makeTempProject();
    fs.mkdirSync(path.join(dir, 'notes', 'z_implemented'), { recursive: true });
    makeNote(dir, 'backlog.feat.baz');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('calls runRagEmbed with the z_implemented destination path after rename', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'mark implemented', projectRoot: dir });
    const tool = getTool(agent, 'dendron_mark_implemented');
    const result = await tool.execute({ filename: 'backlog.feat.baz' });
    expect(result.ok).toBe(true);
    expect(runRagEmbed).toHaveBeenCalledOnce();
    const [, opts] = runRagEmbed.mock.calls[0];
    expect(opts.files[0]).toContain('z_implemented');
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed returns ok:false', async () => {
    runRagEmbed.mockResolvedValueOnce({ ok: false, error: 'lock' });
    const agent = createDendronAgent({ projectId: 'test', request: 'mark implemented', projectRoot: dir });
    const tool = getTool(agent, 'dendron_mark_implemented');
    const result = await tool.execute({ filename: 'backlog.feat.baz' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBeTruthy();
  });

  it('returns ok: true with ragEmbedWarning when runRagEmbed throws', async () => {
    runRagEmbed.mockRejectedValueOnce(new Error('embed crashed'));
    const agent = createDendronAgent({ projectId: 'test', request: 'mark implemented', projectRoot: dir });
    const tool = getTool(agent, 'dendron_mark_implemented');
    const result = await tool.execute({ filename: 'backlog.feat.baz' });
    expect(result.ok).toBe(true);
    expect(result.ragEmbedWarning).toBe('embed crashed');
  });

  it('returns ok: false when markImplemented throws (note not found)', async () => {
    const agent = createDendronAgent({ projectId: 'test', request: 'mark implemented', projectRoot: dir });
    const tool = getTool(agent, 'dendron_mark_implemented');
    const result = await tool.execute({ filename: 'backlog.feat.missing' });
    expect(result.ok).toBe(false);
    expect(runRagEmbed).not.toHaveBeenCalled();
  });
});
