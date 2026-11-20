// backlog.fix.plan-ready-heading-only-edit-target-false-ready — TR1-TR9, TR13, TR14, TR15.
//
// A `###` heading that merely NAMES an existing op:edit target used to suppress
// no_search_pattern_for_modify on its own, so plan_ready reported ready for a target the
// planner could not bind a step to (coverage_gap). The suppression now requires a BINDABLE
// edit — extractExplicitEdits (the planner's own extractor) yielding >=1 edit attributed to
// the target — while hasSearchPattern stays an independent clearing term and the out-of-band
// marker path is unchanged.
//
// Fixtures live under os.tmpdir() only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the static import chain off @xenova/transformers + onnxruntime-node (same mock as
// tests/integration/plan-quality.test.mjs).
vi.mock('@routekit/rag/tools', () => ({
  runRagEmbed: vi.fn().mockResolvedValue({ ok: true, addedEmbeddings: 0, removedCount: 0 }),
  getLastEmbedTime: vi.fn().mockResolvedValue(0),
  ensureRagIndex: vi.fn().mockResolvedValue({ ok: true }),
}));

import { runPlanReadyTool, extractSearchPatterns } from '../../packages/mcp-rks/src/server/plan-ready.mjs';
import { extractExplicitEdits } from '../../packages/mcp-rks/src/llm/reviewer.mjs';
import { runRefineTool, runRefineApplyTool } from '../../packages/mcp-rks/src/server/refine.mjs';

const STORY_ID = 'backlog.fix.heading-only-edit-target';
const TARGET = 'src/app.mjs';
const TARGET_CONTENT = `export function foo() {
  return 1;
}

export function bar() {
  return 'bar-value';
}
`;
const OTHER = 'src/other.mjs';
const OTHER_CONTENT = 'export const other = 1;\n';

// refine.mjs add_code_snippet section shape: Target-label heading, the "Current source"
// preamble line, one plain code fence of the target's content, no @@SEARCH.
const REFINE_SNIPPET_SECTION = `### Target: ${TARGET}

Current source (use for search_replace patterns):

\`\`\`javascript
${TARGET_CONTENT}\`\`\`
`;

const IDENTITY_BLOCK = `### ${TARGET}

@@SEARCH
export function foo() {
@@REPLACE
export function foo() {
@@END
`;

const REAL_CHANGE_BLOCK = `### ${TARGET}

@@SEARCH
  return 1;
@@REPLACE
  return 2;
@@END
`;

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeProject(files = { [TARGET]: TARGET_CONTENT }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-plan-ready-heading-only-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function writeStory(dir, body, targets = [TARGET]) {
  const targetYaml = targets.map((t) => `  - path: "${t}"\n    op: "edit"\n    desc: "Edit ${t}"`).join('\n');
  const content = `---
id: "${STORY_ID}"
title: "Heading-only edit target"
desc: "test"
status: "not-implemented"
phase: "ready"
testRequirements:
  - "Verify the change works and fails gracefully on invalid input"
targetFiles:
${targetYaml}
---

## Problem

Something.

## Acceptance Criteria

- [ ] Something works

## Telemetry

None.

${body}`;
  fs.writeFileSync(path.join(dir, 'notes', `${STORY_ID}.md`), content);
}

async function planReady(dir) {
  return runPlanReadyTool({ projectId: 'test', problemId: STORY_ID, projectRoot: dir });
}

function noSearchIssues(result, file) {
  return result.issues.filter(
    (i) => i.check === 'no_search_pattern_for_modify' && (file === undefined || i.file === file)
  );
}

function editsFor(body, dir, file, targets = [TARGET]) {
  return extractExplicitEdits(body, dir, targets).filter((e) => e?.file === file);
}

function patternsPresentIn(body, content) {
  return extractSearchPatterns(body).filter((p) => content.includes(p));
}

describe('plan_ready: heading-only op:edit target is not ready', () => {
  it('TR1: bare path heading followed only by prose, zero @@SEARCH -> ready false, one issue on the target', async () => {
    const dir = makeProject();
    writeStory(dir, `### ${TARGET}\n\nChange foo so it returns 2.\n`);

    const result = await planReady(dir);
    expect(result.ready).toBe(false);
    const issues = noSearchIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(TARGET);
  });

  it('TR2: Target-label heading followed only by prose, zero @@SEARCH -> issue on the target', async () => {
    const dir = makeProject();
    writeStory(dir, `### Target: ${TARGET}\n\nChange foo so it returns 2.\n`);

    const result = await planReady(dir);
    expect(result.ready).toBe(false);
    const issues = noSearchIssues(result, TARGET);
    expect(issues).toHaveLength(1);
  });

  it('TR3: refine add_code_snippet shape (plain fence, no @@SEARCH) -> issue on the target', async () => {
    const dir = makeProject();
    writeStory(dir, REFINE_SNIPPET_SECTION);
    // No edit is bindable to the target from a plain fence of current source.
    expect(editsFor(REFINE_SNIPPET_SECTION, dir, TARGET)).toHaveLength(0);

    const result = await planReady(dir);
    expect(result.ready).toBe(false);
    expect(noSearchIssues(result, TARGET)).toHaveLength(1);
  });

  it('TR4a: TR3 + identity @@SEARCH block clears via hasSearchPattern (zero bindable edits)', async () => {
    const dir = makeProject();
    const body = `${REFINE_SNIPPET_SECTION}\n${IDENTITY_BLOCK}`;
    writeStory(dir, body);

    // Precondition: identity hunks are dropped by extractExplicitEdits, so the bindable
    // predicate is false — any clear is attributable to hasSearchPattern.
    expect(editsFor(body, dir, TARGET)).toHaveLength(0);
    expect(TARGET_CONTENT).toContain('export function foo() {');

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(0);
  });

  it('TR4b: TR3 + non-identity verbatim @@SEARCH block clears (>=1 bindable edit)', async () => {
    const dir = makeProject();
    const body = `${REFINE_SNIPPET_SECTION}\n${REAL_CHANGE_BLOCK}`;
    writeStory(dir, body);

    const edits = editsFor(body, dir, TARGET);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(TARGET_CONTENT.split('  return 1;').length - 1).toBe(1); // verbatim and unique

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(0);
  });

  it('TR5: TR1 + verbatim unique non-identity @@SEARCH block under the heading -> no issue', async () => {
    const dir = makeProject();
    writeStory(dir, `### ${TARGET}\n\nChange foo so it returns 2.\n\n@@SEARCH\n  return 1;\n@@REPLACE\n  return 2;\n@@END\n`);

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(0);
  });

  it('TR6: out-of-band marker for the target clears; a marker for a different path does not', async () => {
    const dirA = makeProject();
    writeStory(dirA, `Context was supplied out of band.\n\n<!-- rks:context-out-of-band: ${TARGET} -->\n`);
    expect(noSearchIssues(await planReady(dirA), TARGET)).toHaveLength(0);

    const dirB = makeProject();
    writeStory(dirB, `Context was supplied out of band.\n\n<!-- rks:context-out-of-band: src/elsewhere.mjs -->\n`);
    expect(noSearchIssues(await planReady(dirB), TARGET)).toHaveLength(1);
  });

  it('TR7: bindable is the planner extractor — a text-tagged fence under a SEARCH: label does not clear', async () => {
    const dir = makeProject();
    const body = `### ${TARGET}\n\nSEARCH:\n\`\`\`text\n  return 1;\n\`\`\`\n`;
    writeStory(dir, body);

    // Fixture sanity: the fenced line IS verbatim in the on-disk target.
    expect(TARGET_CONTENT).toContain('  return 1;');
    // Precondition (i): extractSearchPatterns yields nothing present in the target, so
    // hasSearchPattern is false and cannot mask the result.
    expect(patternsPresentIn(body, TARGET_CONTENT)).toHaveLength(0);
    // Precondition (ii): the planner's extractor binds no edit to the target.
    expect(editsFor(body, dir, TARGET)).toHaveLength(0);

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(1);
  });

  it('TR8: per-file independence — only the target without a bindable block raises', async () => {
    const dir = makeProject({ [TARGET]: TARGET_CONTENT, [OTHER]: OTHER_CONTENT });
    writeStory(dir, `${REAL_CHANGE_BLOCK}\n### ${OTHER}\n\nChange other to 2.\n`, [TARGET, OTHER]);

    const result = await planReady(dir);
    const issues = noSearchIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0].file).toBe(OTHER);
  });

  it('TR9: refine recovery converges — plan_failed -> add_search_pattern -> apply -> no issue', async () => {
    const dir = makeProject();
    writeStory(dir, REFINE_SNIPPET_SECTION);

    // (a)
    const before = await planReady(dir);
    expect(noSearchIssues(before, TARGET)).toHaveLength(1);

    // (b)
    const refine = await runRefineTool({
      projectRoot: dir,
      problemId: STORY_ID,
      trigger: 'plan_failed',
      context: `plan failed: no_search_pattern_for_modify for ${TARGET}`,
    });
    expect(refine.ok).toBe(true);
    const suggestion = refine.suggestions.find((s) => s.type === 'add_search_pattern' && s.file === TARGET);
    expect(suggestion).toBeDefined();

    // (c)
    const apply = await runRefineApplyTool({
      projectRoot: dir,
      problemId: STORY_ID,
      refinements: [{ type: 'add_search_pattern', file: TARGET }],
    });
    expect(apply.ok).toBe(true);
    const applied = apply.applied.find((a) => a.type === 'add_search_pattern');
    expect(applied).toBeDefined();
    expect(applied.anchors?.length).toBeGreaterThanOrEqual(1);
    expect(applied.manual).toBeFalsy();

    // (d)
    const after = await planReady(dir);
    expect(noSearchIssues(after, TARGET)).toHaveLength(0);
  });

  it('TR13: disk-export fallback shape (bare heading + identity block only) clears via hasSearchPattern', async () => {
    const dir = makeProject();
    writeStory(dir, IDENTITY_BLOCK);

    expect(editsFor(IDENTITY_BLOCK, dir, TARGET)).toHaveLength(0);

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(0);
  });

  it('TR14: anchorless target with a fenced Target section — apply is a manual stop and the issue still raises', async () => {
    const MD_TARGET = 'docs/guide.md';
    const MD_CONTENT = '# Guide\n\nSome plain prose here.\nAnother line of prose.\n';
    const dir = makeProject({ [MD_TARGET]: MD_CONTENT });
    writeStory(
      dir,
      `### Target: ${MD_TARGET}\n\nCurrent source (use for search_replace patterns):\n\n\`\`\`markdown\n${MD_CONTENT}\`\`\`\n`,
      [MD_TARGET]
    );

    const apply = await runRefineApplyTool({
      projectRoot: dir,
      problemId: STORY_ID,
      refinements: [{ type: 'add_search_pattern', file: MD_TARGET }],
    });
    const applied = apply.applied.find((a) => a.type === 'add_search_pattern');
    expect(applied).toBeDefined();
    expect(applied.manual).toBe(true);
    expect(applied.result.startsWith('no extractable anchors found')).toBe(true);

    const result = await planReady(dir);
    expect(noSearchIssues(result, MD_TARGET)).toHaveLength(1);
  });

  it('TR15: Target-label heading + non-identity conflict-marker block clears through the bindable predicate only', async () => {
    const dir = makeProject();
    // Path written exactly as in frontmatter targetFiles, no backticks: the conflict-marker
    // grammar takes the raw label text as the file.
    const body = `### Target: ${TARGET}\n\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE\n`;
    writeStory(dir, body);

    // Precondition (i): hasSearchPattern is false.
    expect(patternsPresentIn(body, TARGET_CONTENT)).toHaveLength(0);
    // Precondition (ii): >=1 bindable non-identity edit for the target.
    const edits = editsFor(body, dir, TARGET);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.some((e) => e.search !== e.replace)).toBe(true);

    const result = await planReady(dir);
    expect(noSearchIssues(result, TARGET)).toHaveLength(0);
  });
});
