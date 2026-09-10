import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';


vi.mock('../../packages/mcp-rks/src/utils/git.mjs', () => ({
  commitFiles: vi.fn(async () => {}),
}));

const { runRefineApplyTool } = await import('../../packages/mcp-rks/src/server/refine.mjs');

const FRONTMATTER = `---
id: "backlog.test.story"
title: "Test Story"
status: "not-implemented"
phase: "draft"
targetFiles:
  - path: "hooks/useDisplayActions.ts"
    op: "create"
---`;

function makeStory(body) {
  return FRONTMATTER + '\n\n' + body;
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-refine-apply-test-'));
  const notesDir = path.join(tmpDir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(
    path.join(notesDir, 'backlog.test.story.md'),
    makeStory('## Problem\n\nSome problem description.\n\n## Code Changes\n\nSome changes.\n')
  );
});

describe('runRefineApplyTool — create_file_directive handler', () => {
  it('single suggestion injects directive and returns ok:true with applied entry', async () => {
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    expect(result.ok).toBe(true);
    const applied = result.applied.find(a => a.type === 'create_file_directive');
    expect(applied).toBeDefined();
    expect(applied.result).toMatch(/injected CREATE FILE directive/);
    const noteContent = fs.readFileSync(path.join(tmpDir, 'notes', 'backlog.test.story.md'), 'utf8');
    expect(noteContent).toContain('// CREATE FILE: hooks/useDisplayActions.ts');
  });

  it('multiple suggestions inject all paths under a single ## Files to Create section', async () => {
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [
        { type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' },
        { type: 'create_file_directive', file: 'hooks/useActionNumbering.ts' },
      ],
    });
    expect(result.ok).toBe(true);
    const noteContent = fs.readFileSync(path.join(tmpDir, 'notes', 'backlog.test.story.md'), 'utf8');
    expect(noteContent).toContain('// CREATE FILE: hooks/useDisplayActions.ts');
    expect(noteContent).toContain('// CREATE FILE: hooks/useActionNumbering.ts');
    const sectionCount = (noteContent.match(/## Files to Create/g) || []).length;
    expect(sectionCount).toBe(1);
  });

  it('appends inside existing ## Files to Create section without creating a duplicate', async () => {
    const notePath = path.join(tmpDir, 'notes', 'backlog.test.story.md');
    fs.writeFileSync(notePath, makeStory('## Files to Create\n\n// CREATE FILE: existing/file.ts\n\n## Code Changes\n\nSome changes.\n'));
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    expect(result.ok).toBe(true);
    const noteContent = fs.readFileSync(notePath, 'utf8');
    expect(noteContent).toContain('// CREATE FILE: hooks/useDisplayActions.ts');
    expect(noteContent).toContain('// CREATE FILE: existing/file.ts');
    const sectionCount = (noteContent.match(/## Files to Create/g) || []).length;
    expect(sectionCount).toBe(1);
  });

  it('inserts ## Files to Create before ## Code Changes when section absent', async () => {
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    expect(result.ok).toBe(true);
    const noteContent = fs.readFileSync(path.join(tmpDir, 'notes', 'backlog.test.story.md'), 'utf8');
    const filesIdx = noteContent.indexOf('## Files to Create');
    const changesIdx = noteContent.indexOf('## Code Changes');
    expect(filesIdx).toBeGreaterThan(-1);
    expect(changesIdx).toBeGreaterThan(-1);
    expect(filesIdx).toBeLessThan(changesIdx);
  });

  it('appends ## Files to Create at end of body when neither section exists', async () => {
    const notePath = path.join(tmpDir, 'notes', 'backlog.test.story.md');
    fs.writeFileSync(notePath, makeStory('## Problem\n\nSome problem description.\n'));
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    expect(result.ok).toBe(true);
    const noteContent = fs.readFileSync(notePath, 'utf8');
    expect(noteContent).toContain('## Files to Create');
    expect(noteContent).toContain('// CREATE FILE: hooks/useDisplayActions.ts');
    expect(noteContent.indexOf('## Code Changes')).toBe(-1);
  });

  it('is idempotent — skips injection if directive already exists in body', async () => {
    const notePath = path.join(tmpDir, 'notes', 'backlog.test.story.md');
    fs.writeFileSync(notePath, makeStory('## Files to Create\n\n// CREATE FILE: hooks/useDisplayActions.ts\n\n## Code Changes\n\nSome changes.\n'));
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    // backlog.fix.build-governor-self-heal: a refinement that changes NOTHING no longer reports
    // success. It used to return ok:true AND `requiredNext: rks_plan` — telling the Build Governor
    // "success, now go re-plan" an unchanged story, which is the infinite loop this story kills.
    expect(result.ok).toBe(false);
    expect(result.status).toBe('refine_noop');
    expect(result.requiredNext).toBeUndefined();
    const applied = result.applied.find(a => a.type === 'create_file_directive');
    expect(applied.result).toMatch(/directive already present/);
    const noteContent = fs.readFileSync(notePath, 'utf8');
    const directiveCount = (noteContent.match(/\/\/ CREATE FILE: hooks\/useDisplayActions\.ts/g) || []).length;
    expect(directiveCount).toBe(1);
  });

  it('applied entry describes injected path', async () => {
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [{ type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' }],
    });
    expect(result.ok).toBe(true);
    const applied = result.applied.find(a => a.type === 'create_file_directive');
    expect(applied.result).toContain('hooks/useDisplayActions.ts');
  });

  it('other suggestion types are unaffected when create_file_directive present', async () => {
    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: 'backlog.test.story',
      refinements: [
        { type: 'create_file_directive', file: 'hooks/useDisplayActions.ts' },
        { type: 'clarify_ac', criteria: ['new acceptance criterion'] },
      ],
    });
    expect(result.ok).toBe(true);
    const noteContent = fs.readFileSync(path.join(tmpDir, 'notes', 'backlog.test.story.md'), 'utf8');
    expect(noteContent).toContain('// CREATE FILE: hooks/useDisplayActions.ts');
    expect(noteContent).toContain('new acceptance criterion');
  });
});
