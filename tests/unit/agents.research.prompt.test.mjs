import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const promptPath = resolve(process.cwd(), '.rks/prompts/agent-research.md');
const content = readFileSync(promptPath, 'utf8');

describe('agent-research.md — prompt repair', () => {
  it('declares all 6 tools', () => {
    expect(content).toContain('rag_query');
    expect(content).toContain('read_file');
    expect(content).toContain('read_git');
    expect(content).toContain('dendron_create_note');
    expect(content).toContain('dendron_edit_note');
    expect(content).toContain('dendron_update_field');
  });

  it('hard limit for rag_query is max 2 (not max 1)', () => {
    expect(content).toContain('Maximum 2 rag_query');
    expect(content).not.toContain('Maximum 1 rag_query');
  });

  it('hard limit for read_file is max 3 (not max 2)', () => {
    expect(content).toContain('Maximum 3 read_file');
    expect(content).not.toContain('Maximum 2 read_file');
  });

  it('declares read_git with hard limit max 3', () => {
    expect(content).toContain('Maximum 3 read_git');
  });

  it('contains WHEN TO USE read_git workflow guidance', () => {
    expect(content).toContain('WHEN TO USE read_git');
  });

  it('contains NOTE AUTHORITY HIERARCHY section', () => {
    expect(content.toUpperCase()).toContain('NOTE AUTHORITY HIERARCHY');
  });

  it('names backlog.z_implemented.* as authoritative ground truth', () => {
    expect(content).toContain('backlog.z_implemented.*');
    expect(content.toLowerCase()).toContain('authoritative');
  });

  it('describes research.* notes as point-in-time snapshots', () => {
    expect(content).toContain('research.*');
    expect(content.toLowerCase()).toContain('point-in-time');
  });

  it('states z_implemented wins on conflicts', () => {
    expect(content).toMatch(/z_implemented.*wins|z_implemented.*takes precedence|z_implemented.*overrides/);
  });

  it('contains HARD LIMITS section', () => {
    expect(content).toContain('HARD LIMITS:');
  });

  it('contains GUIDELINES section', () => {
    expect(content).toContain('GUIDELINES:');
    expect(content).toContain('Start with rag_query to discover relevant files');
  });

  it('contains CITATION FORMAT section with [filename:lineNumber] marker', () => {
    expect(content).toContain('CITATION FORMAT');
    expect(content).toContain('[filename:lineNumber]');
  });
});
