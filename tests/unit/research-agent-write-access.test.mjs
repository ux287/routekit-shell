/**
 * Tests for research agent write access.
 *
 * Verifies:
 * 1. createResearchAgent() tool list includes dendron_create_note and dendron_edit_note
 * 2. dendron_create_note rejects backlog.* filenames with an error (inline guard)
 * 3. dendron_edit_note rejects backlog.* filenames with an error (inline guard)
 * 4. dendron_create_note with design.* filename succeeds (non-backlog allowed)
 * 5. governor-research.md exists and documents allowed namespaces and backlog.* restriction
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { makeTempDir, writeFile, ensureDir } from '../helpers/tmp.mjs';
import { createResearchAgent } from '../../packages/mcp-rks/src/agents/research.mjs';

function setupProject(projectRoot) {
  ensureDir(path.join(projectRoot, 'notes'));
  ensureDir(path.join(projectRoot, '.rks'));
  writeFile(path.join(projectRoot, '.rks', 'project.json'), JSON.stringify({
    projectId: 'test-project',
    branches: { working: 'staging', integration: 'staging', production: 'main' },
  }));
}

describe('createResearchAgent — tool registration', () => {
  it('includes dendron_create_note in tool list', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: '/tmp' });
    const toolNames = agent.tools.map(t => t.name);
    expect(toolNames).toContain('dendron_create_note');
  });

  it('includes dendron_edit_note in tool list', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: '/tmp' });
    const toolNames = agent.tools.map(t => t.name);
    expect(toolNames).toContain('dendron_edit_note');
  });
});

describe('createResearchAgent — backlog.* guard (inline)', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('research_write_test');
    setupProject(projectRoot);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('dendron_create_note rejects backlog.* filename', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_create_note');
    const result = await tool.execute({ filename: 'backlog.feat.my-story', title: 'Test' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/backlog\.\*/i);
  });

  it('dendron_edit_note rejects backlog.* filename', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_edit_note');
    const result = await tool.execute({ filename: 'backlog.feat.my-story', body: '# Updated' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/backlog\.\*/i);
  });

  it('dendron_create_note rejects z_archive.* filename', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_create_note');
    const result = await tool.execute({ filename: 'z_archive.old-note', title: 'Archived' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/z_archive\.\*/i);
  });

  it('dendron_edit_note rejects z_archive.* filename', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_edit_note');
    const result = await tool.execute({ filename: 'z_archive.old-note', body: '# Updated' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/z_archive\.\*/i);
  });

  it('dendron_create_note with design.* filename succeeds', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_create_note');
    const result = await tool.execute({
      filename: 'design.arch.my-topic',
      title: 'My Topic',
      desc: 'A design note',
      body: '## Overview\n\nSome content.',
    });
    expect(result.ok).toBe(true);
    expect(result.filename).toBe('design.arch.my-topic');
    const notePath = path.join(projectRoot, 'notes', 'design.arch.my-topic.md');
    expect(fs.existsSync(notePath)).toBe(true);
  });

  it('dendron_create_note with notes.* filename succeeds', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_create_note');
    const result = await tool.execute({
      filename: 'notes.my-general-note',
      title: 'General Note',
      body: '## Notes\n\nSome content.',
    });
    expect(result.ok).toBe(true);
    expect(result.filename).toBe('notes.my-general-note');
    const notePath = path.join(projectRoot, 'notes', 'notes.my-general-note.md');
    expect(fs.existsSync(notePath)).toBe(true);
  });
});

describe('governor-research.md prompt', () => {
  it('exists and documents backlog.* and z_archive.* restrictions', () => {
    const promptPath = path.resolve(
      new URL('../../.rks/prompts/governor-research.md', import.meta.url).pathname
    );
    expect(fs.existsSync(promptPath)).toBe(true);
    const content = fs.readFileSync(promptPath, 'utf8');
    expect(content).toMatch(/backlog\.\*/);
    expect(content).toMatch(/z_archive\.\*/);
  });
});

// ---------------------------------------------------------------------------
// dendron_update_field
// ---------------------------------------------------------------------------
describe('createResearchAgent — dendron_update_field registration', () => {
  it('includes dendron_update_field in tool list', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: '/tmp' });
    const toolNames = agent.tools.map(t => t.name);
    expect(toolNames).toContain('dendron_update_field');
  });

  it('inputSchema covers filename, field, value', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: '/tmp' });
    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    expect(tool.inputSchema.shape.filename).toBeDefined();
    expect(tool.inputSchema.shape.field).toBeDefined();
    expect(tool.inputSchema.shape.value).toBeDefined();
  });

  it('no other dendron write tools were added (scope is narrowly dendron_update_field)', () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot: '/tmp' });
    const toolNames = agent.tools.map(t => t.name);
    expect(toolNames).not.toContain('dendron_delete_note');
    expect(toolNames).not.toContain('dendron_mark_implemented');
  });
});

describe('createResearchAgent — dendron_update_field namespace guard', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('research_update_field_test');
    setupProject(projectRoot);
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  it('rejects backlog.* filename — guard fires before field validation', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    const result = await tool.execute({ filename: 'backlog.feat.my-story', field: 'phase', value: 'ready' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/backlog\.\*/i);
    expect(result.ok).toBeUndefined();
  });

  it('rejects z_archive.* filename', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    const result = await tool.execute({ filename: 'z_archive.old-note', field: 'title', value: 'New' });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/z_archive\.\*/i);
  });

  it('guard fires even when field/value are absent', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    const result = await tool.execute({ filename: 'backlog.feat.test' });
    expect(result.error).toBeDefined();
  });

  it('passes notes.* through to updateField', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    // Create the note first
    const createTool = agent.tools.find(t => t.name === 'dendron_create_note');
    await createTool.execute({ filename: 'notes.test-update', title: 'Test', body: 'content' });

    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    const result = await tool.execute({ filename: 'notes.test-update', field: 'title', value: 'Updated Title' });
    expect(result.ok).toBe(true);
    expect(result.field).toBe('title');
  });

  it('passes design.* through to updateField', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const createTool = agent.tools.find(t => t.name === 'dendron_create_note');
    await createTool.execute({ filename: 'design.my-design', title: 'Design', body: 'content' });

    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    const result = await tool.execute({ filename: 'design.my-design', field: 'desc', value: 'Updated desc' });
    expect(result.ok).toBe(true);
  });

  it('errors from updateField are caught and returned as { error }', async () => {
    const agent = createResearchAgent({ projectId: 'test', query: 'test', projectRoot });
    const tool = agent.tools.find(t => t.name === 'dendron_update_field');
    // nonexistent note should return error, not throw
    const result = await tool.execute({ filename: 'notes.nonexistent', field: 'title', value: 'x' });
    expect(result.error).toBeDefined();
    expect(result.ok).toBeUndefined();
  });
});
