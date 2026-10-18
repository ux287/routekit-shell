import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runRefineTool, runRefineApplyTool } from '../../packages/mcp-rks/src/server/refine.mjs';

const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-refine-search-pattern');
const NOTES_DIR = path.join(TEST_PROJECT_DIR, 'notes');

const STORY_ID = 'backlog.fix.example';
const STORY_FILE = path.join(NOTES_DIR, STORY_ID + '.md');
const TARGET_FILE = 'packages/mcp-rks/src/server/example.mjs';
const TARGET_FILE_FULL = path.join(TEST_PROJECT_DIR, TARGET_FILE);

const SNIPPET_CODE = `export async function runSomeTool({ projectRoot }) {
  return { ok: true };
}

export function helperFn() {
  return 42;
}
`;

function makeStoryWithSnippet(extraFrontmatter = '') {
  return `---
id: "${STORY_ID}"
title: "Example Fix"
desc: "A fix story"
status: "not-implemented"
phase: "ready"
testRequirements:
  - "Verify runSomeTool returns ok"
targetFiles:
  - path: "${TARGET_FILE}"
    op: "edit"
    desc: "Edit example"
${extraFrontmatter}---
## Problem

Some problem.

## Acceptance Criteria

- [ ] Something works

### Target: ${TARGET_FILE}

Current source (use for search_replace patterns):

\`\`\`javascript
${SNIPPET_CODE}\`\`\`
`;
}

function makeStoryWithoutSnippet() {
  return `---
id: "${STORY_ID}"
title: "Example Fix"
desc: "A fix story"
status: "not-implemented"
phase: "ready"
testRequirements:
  - "Verify runSomeTool returns ok"
targetFiles:
  - path: "${TARGET_FILE}"
    op: "edit"
    desc: "Edit example"
---
## Problem

Some problem.

## Acceptance Criteria

- [ ] Something works
`;
}

describe('refine: add_search_pattern suggestion', () => {
  beforeEach(() => {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(TARGET_FILE_FULL), { recursive: true });
    fs.writeFileSync(TARGET_FILE_FULL, SNIPPET_CODE, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  });

  it('returns add_search_pattern suggestion when trigger=plan_failed, context=no_search_pattern_for_modify, and ### Target: section exists', async () => {
    fs.writeFileSync(STORY_FILE, makeStoryWithSnippet(), 'utf8');

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      trigger: 'plan_failed',
      context: 'plan failed: no_search_pattern_for_modify for packages/mcp-rks/src/server/example.mjs',
    });

    expect(result.ok).toBe(true);
    const suggestion = result.suggestions.find(s => s.type === 'add_search_pattern');
    expect(suggestion).toBeDefined();
    expect(suggestion.priority).toBe('high');
    expect(suggestion.file).toBe(TARGET_FILE);
    expect(suggestion.reason).toContain(TARGET_FILE);
    expect(suggestion.reason).toContain('no SEARCH anchor');
  });

  it('does NOT fire when ### Target: sections are absent (snippets not yet injected)', async () => {
    fs.writeFileSync(STORY_FILE, makeStoryWithoutSnippet(), 'utf8');

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      trigger: 'plan_failed',
      context: 'plan failed: no_search_pattern_for_modify',
    });

    expect(result.ok).toBe(true);
    const suggestion = result.suggestions.find(s => s.type === 'add_search_pattern');
    expect(suggestion).toBeUndefined();
    // add_code_snippet should be suggested instead (snippet not yet injected)
    const snippetSuggestion = result.suggestions.find(s => s.type === 'add_code_snippet');
    expect(snippetSuggestion).toBeDefined();
  });

  it('does NOT fire when context does not contain no_search_pattern_for_modify', async () => {
    fs.writeFileSync(STORY_FILE, makeStoryWithSnippet(), 'utf8');

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      trigger: 'plan_failed',
      context: 'plan failed: some other reason',
    });

    expect(result.ok).toBe(true);
    const suggestion = result.suggestions.find(s => s.type === 'add_search_pattern');
    expect(suggestion).toBeUndefined();
  });

  it('does NOT fire when trigger is not plan_failed', async () => {
    fs.writeFileSync(STORY_FILE, makeStoryWithSnippet(), 'utf8');

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      trigger: 'exec_failed',
      context: 'no_search_pattern_for_modify',
    });

    expect(result.ok).toBe(true);
    const suggestion = result.suggestions.find(s => s.type === 'add_search_pattern');
    expect(suggestion).toBeUndefined();
  });

  it('apply handler extracts anchor patterns and injects SEARCH blocks inline', async () => {
    fs.writeFileSync(STORY_FILE, makeStoryWithSnippet(), 'utf8');

    const result = await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_search_pattern', file: TARGET_FILE }],
    });

    expect(result.ok).toBe(true);
    const appliedEntry = result.applied.find(a => a.type === 'add_search_pattern');
    expect(appliedEntry).toBeDefined();
    expect(appliedEntry.anchors).toBeDefined();
    expect(appliedEntry.anchors.length).toBeGreaterThanOrEqual(1);
    expect(appliedEntry.anchors.length).toBeLessThanOrEqual(4);

    const updated = fs.readFileSync(STORY_FILE, 'utf8');
    expect(updated).toContain('@@SEARCH');
    expect(updated).toContain('@@REPLACE');
    expect(updated).toContain('@@END');
    // Should contain at least one of the function signatures from SNIPPET_CODE
    expect(updated).toMatch(/export async function runSomeTool|export function helperFn/);
  });

  it('apply handler returns manual:true when no extractable anchors in snippet', async () => {
    const stubSnippet = `// placeholder\n// no functions here\n`;
    const storyWithStub = `---
id: "${STORY_ID}"
title: "Example Fix"
desc: "A fix"
status: "not-implemented"
phase: "ready"
testRequirements:
  - "Verify something"
targetFiles:
  - path: "${TARGET_FILE}"
    op: "edit"
    desc: "Edit"
---
## Acceptance Criteria

- [ ] Something works

### Target: ${TARGET_FILE}

Current source (use for search_replace patterns):

\`\`\`javascript
${stubSnippet}\`\`\`
`;
    fs.writeFileSync(STORY_FILE, storyWithStub, 'utf8');
    // Remove target file so disk fallback also finds no anchors → manual:true path
    fs.rmSync(TARGET_FILE_FULL, { force: true });

    const result = await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_search_pattern', file: TARGET_FILE }],
    });

    expect(result.ok).toBe(true);
    const appliedEntry = result.applied.find(a => a.type === 'add_search_pattern');
    expect(appliedEntry).toBeDefined();
    expect(appliedEntry.manual).toBe(true);
    expect(appliedEntry.hint).toBeDefined();
  });

  it('add_code_snippet suggestion behavior is unchanged (no regression)', async () => {
    // Story without any ### Target: sections — should get add_code_snippet suggestions
    fs.writeFileSync(STORY_FILE, makeStoryWithoutSnippet(), 'utf8');

    const result = await runRefineTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
    });

    expect(result.ok).toBe(true);
    const snippetSuggestion = result.suggestions.find(s => s.type === 'add_code_snippet');
    expect(snippetSuggestion).toBeDefined();
    expect(snippetSuggestion.priority).toBe('high');
    expect(snippetSuggestion.file).toBe(TARGET_FILE);
  });
});
