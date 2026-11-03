import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { checkStateAllowed, getNextState, getStates, transitionOnResult } from '../../packages/mcp-rks/src/shared/governor-state.mjs';
const { runRefineTool } = await import('../../packages/mcp-rks/src/server/refine.mjs');

const storyStates = getStates('story');

describe('refine child decomp human gate — governor-state.mjs', () => {
  it('STORY_STATES contains decompose-gated state', () => {
    expect(storyStates['decompose-gated']).toBeDefined();
  });

  it('decompose-gated allows rks_refine_apply', () => {
    expect(storyStates['decompose-gated'].allowed.has('rks_refine_apply')).toBe(true);
  });

  it('decompose-gated allows rks_plan', () => {
    expect(storyStates['decompose-gated'].allowed.has('rks_plan')).toBe(true);
  });

  it('decompose-gated blocks any tool other than rks_refine_apply and rks_plan', () => {
    for (const tool of ['rks_refine', 'rks_exec', 'rks_plan_review', 'dendron_create_note', 'rks_agent_research']) {
      const result = checkStateAllowed('story', 'decompose-gated', tool);
      expect(result.allowed, `${tool} should be blocked in decompose-gated`).toBe(false);
    }
  });

  it('refining resultTransitions contains refine.decompose_suggested → decompose-gated', () => {
    expect(storyStates.refining.resultTransitions?.['refine.decompose_suggested']).toBe('decompose-gated');
  });

  it('decompose-gated transitions to planning on rks_plan', () => {
    expect(getNextState('story', 'decompose-gated', 'rks_plan')).toBe('planning');
  });

  it('decompose-gated transitions to decomposing on refine_apply.decomposed result', () => {
    expect(transitionOnResult('story', 'decompose-gated', 'refine_apply.decomposed')).toBe('decomposing');
  });

  it('refining → decompose-gated via refine.decompose_suggested result transition', () => {
    expect(transitionOnResult('story', 'refining', 'refine.decompose_suggested')).toBe('decompose-gated');
  });
});

describe('refine child decomp human gate — refine.mjs signal computation', () => {

  function makeStory({ parent, targetFiles }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-refine-gate-'));
    const slug = parent ? 'child-story' : 'parent-story';
    const fm = [
      '---',
      `id: "backlog.feat.${slug}"`,
      `title: "Test story"`,
      `desc: "test"`,
      `phase: "ready"`,
      parent ? `parent: "backlog.feat.parent"` : null,
      'targetFiles:',
      ...targetFiles.map(f => `  - path: "${f.path}"\n    op: "${f.op}"\n    desc: "test"`),
      '---',
      '',
      '## Problem',
      'test',
      '',
      '## Solution',
      'test',
      '',
      '## Acceptance Criteria',
      '- [ ] thing one',
      '- [ ] thing two',
      '- [ ] thing three',
    ].filter(l => l !== null).join('\n');
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes', `backlog.feat.${slug}.md`), fm);
    // Write a minimal package.json so projectRoot resolution works
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '0.0.1' }));
    return { dir, problemId: `backlog.feat.${slug}` };
  }

  it('child story with 6+ targetFiles: decomposeSuggested is true, decomposeReasons is empty', async () => {
    const targetFiles = Array.from({ length: 6 }, (_, i) => ({ path: `src/file${i}.mjs`, op: 'edit' }));
    // Also need a second signal — add editCount > 5 (already covered by 6 files)
    // and hasCreateAndEdit. Let's add a create target to get 2 signals.
    targetFiles[0] = { path: 'src/new-file.mjs', op: 'create' };
    const { dir, problemId } = makeStory({ parent: true, targetFiles });
    try {
      const result = await runRefineTool({ projectRoot: dir, problemId, projectId: 'test' });
      expect(result.analysis.decomposeSuggested).toBe(true);
      expect(result.analysis.decomposeReasons).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('child story with only 2 targetFiles: no decomposeSuggested (below signal threshold)', async () => {
    const targetFiles = [{ path: 'src/a.mjs', op: 'edit' }, { path: 'src/b.mjs', op: 'edit' }];
    const { dir, problemId } = makeStory({ parent: true, targetFiles });
    try {
      const result = await runRefineTool({ projectRoot: dir, problemId, projectId: 'test' });
      expect(result.analysis.decomposeSuggested).toBeUndefined();
      expect(result.analysis.decomposeReasons).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-child story with same 6+ targetFiles: decomposeReasons is set, no decomposeSuggested', async () => {
    const targetFiles = [
      { path: 'src/new-file.mjs', op: 'create' },
      ...Array.from({ length: 5 }, (_, i) => ({ path: `src/file${i}.mjs`, op: 'edit' })),
    ];
    const { dir, problemId } = makeStory({ parent: false, targetFiles });
    try {
      const result = await runRefineTool({ projectRoot: dir, problemId, projectId: 'test' });
      expect(result.analysis.decomposeSuggested).toBeUndefined();
      expect(result.analysis.decomposeReasons.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
