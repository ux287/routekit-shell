/**
 * Tests for plan-ready.mjs no_search_pattern_for_modify check.
 * Uses runPlanReadyTool with a real temp git repo and story note.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tmp.mjs';

// Mock the RAG tools chain so the static import of plan-ready.mjs does not
// transitively load @xenova/transformers + onnxruntime-node. See
// research.2026.05.13.slow-test-hook-inventory.md.
vi.mock('../../packages/mcp-rks/src/rag/tools.mjs', () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

import { runPlanReadyTool } from '../../packages/mcp-rks/src/server/plan-ready.mjs';

const TARGET_FILE = 'src/app.mjs';

function initRepo(dir) {
  spawnSync('git', ['init', '-b', 'staging'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, TARGET_FILE), 'export function foo() {\n  return 1;\n}\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

function makeStory(dir, problemId, searchBlock) {
  const content = `---
id: "${problemId}"
title: "Test story"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${TARGET_FILE}"
    op: "edit"
---

## Problem

Something.

${searchBlock}
`;
  fs.writeFileSync(path.join(dir, 'notes', `${problemId}.md`), content);
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRepo() {
  const dir = makeTempDir('plan-quality');
  dirs.push(dir);
  initRepo(dir);
  return dir;
}

describe('no_search_pattern_for_modify', () => {
  it('passes when @@SEARCH block is present with no surrounding heading context', async () => {
    const dir = makeRepo();
    const id = 'backlog.fix.test';
    // @@SEARCH block with search text that exists in the file
    makeStory(dir, id, `@@SEARCH\nexport function foo() {\n@@REPLACE\nexport function foo() { // updated\n@@END`);

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    expect(searchIssues).toHaveLength(0);
  });

  it('fails when no @@SEARCH marker and no other search pattern is present', async () => {
    const dir = makeRepo();
    const id = 'backlog.fix.test2';
    makeStory(dir, id, '## Implementation Notes\n\nEdit the foo function to return 2.');

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    expect(searchIssues.length).toBeGreaterThan(0);
  });

  it('passes when legacy SEARCH:/``` block is present (backward compat)', async () => {
    const dir = makeRepo();
    const id = 'backlog.fix.test3';
    makeStory(dir, id, 'SEARCH:\n```javascript\nexport function foo() {\n```\nREPLACE:\n```javascript\nexport function foo() { // v2\n```');

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    expect(searchIssues).toHaveLength(0);
  });

  it('passes when injected code snippet (### Target: <file>) is present — snippet bypass', async () => {
    const dir = makeRepo();
    const id = 'backlog.fix.test4';
    // rks_refine_apply injects snippets in this format — no @@SEARCH block present
    makeStory(dir, id, `### Target: ${TARGET_FILE}\n\nCurrent source (use for search_replace patterns):\n\n\`\`\`javascript\nexport function foo() {\n  return 1;\n}\n\`\`\``);

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    expect(searchIssues).toHaveLength(0);
  });

  it('still fires for a file that has neither @@SEARCH nor ### Target: snippet', async () => {
    const dir = makeRepo();
    const id = 'backlog.fix.test5';
    // Snippet present for a DIFFERENT file — should not bypass check for TARGET_FILE
    makeStory(dir, id, `### Target: src/other.mjs\n\nCurrent source (use for search_replace patterns):\n\n\`\`\`javascript\n// other\n\`\`\``);

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    expect(searchIssues.length).toBeGreaterThan(0);
    expect(searchIssues[0].file).toBe(TARGET_FILE);
  });

  it('per-file bypass is independent — fires for files missing snippet, not for files with snippet', async () => {
    const SECOND_FILE = 'src/other.mjs';
    const dir = makeRepo();
    // Write a second existing file
    fs.writeFileSync(path.join(dir, SECOND_FILE), '// other\n');

    const id = 'backlog.fix.test6';
    // Two-target story: TARGET_FILE has a snippet, SECOND_FILE does not
    const content = `---
id: "${id}"
title: "Test story"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${TARGET_FILE}"
    op: "edit"
  - path: "${SECOND_FILE}"
    op: "edit"
---

## Problem

Something.

### Target: ${TARGET_FILE}

Current source (use for search_replace patterns):

\`\`\`javascript
export function foo() {
  return 1;
}
\`\`\`
`;
    fs.writeFileSync(path.join(dir, 'notes', `${id}.md`), content);

    const result = await runPlanReadyTool({ projectId: 'test', problemId: id, projectRoot: dir });
    const searchIssues = result.issues.filter(i => i.check === 'no_search_pattern_for_modify');
    // TARGET_FILE has snippet → no issue; SECOND_FILE has neither → issue
    expect(searchIssues).toHaveLength(1);
    expect(searchIssues[0].file).toBe(SECOND_FILE);
  });
});
