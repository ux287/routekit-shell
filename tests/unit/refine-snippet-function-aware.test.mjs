import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runRefineApplyTool } from '../../packages/mcp-rks/src/server/refine.mjs';

const TEST_PROJECT_DIR = path.join(process.cwd(), '.tmp-test-refine-snippet-fn');
const NOTES_DIR = path.join(TEST_PROJECT_DIR, 'notes');
const TARGET_DIR = path.join(TEST_PROJECT_DIR, 'packages/mcp-rks/src/server');
const TARGET_FILE = 'packages/mcp-rks/src/server/target.mjs';
const TARGET_FILE_FULL = path.join(TEST_PROJECT_DIR, TARGET_FILE);
const STORY_ID = 'backlog.fix.snippet-test';

// Build a file with more than 120 lines so truncation logic triggers
function buildLargeFile(targetFunctionName = 'runTargetTool') {
  const lines = [
    `import fs from 'fs';`,
    `import path from 'path';`,
    '',
  ];
  // Pad to push the file past 120 lines (threshold) and the target function past line 80
  for (let i = 0; i < 105; i++) {
    lines.push(`// padding line ${i}`);
  }
  // Use plain function declaration to avoid ambiguous multi-pattern matches in findFunctionSlice
  lines.push(
    `function ${targetFunctionName}(projectRoot) {`,
    `  const result = 'found it';`,
    `  return { ok: true, result };`,
    `}`,
    '',
  );
  // pad to 130+ total
  for (let i = 0; i < 20; i++) {
    lines.push(`// trailing line ${i}`);
  }
  return lines.join('\n');
}

function makeStory({ desc = '', withSnippet = false } = {}) {
  const targetFilesYaml = desc
    ? `targetFiles:\n  - path: "${TARGET_FILE}"\n    op: "edit"\n    desc: "${desc}"\n`
    : `targetFiles:\n  - path: "${TARGET_FILE}"\n    op: "edit"\n`;
  const snippetSection = withSnippet
    ? `\n\n### Target: ${TARGET_FILE}\n\nCurrent source (use for search_replace patterns):\n\n\`\`\`javascript\n// already here\n\`\`\`\n`
    : '';
  return `---\nid: "${STORY_ID}"\ntitle: "Test"\ndesc: "test"\nstatus: "not-implemented"\nphase: "ready"\n${targetFilesYaml}---\n\n## Problem\n\nSome problem.${snippetSection}`;
}

beforeEach(() => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
});

describe('add_code_snippet — function-aware extraction', () => {
  it('uses function slice when large file and targetFiles desc names a backtick-quoted function', async () => {
    const fileContent = buildLargeFile('runTargetTool');
    fs.writeFileSync(TARGET_FILE_FULL, fileContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory({ desc: 'edit `runTargetTool` handler' }));

    const result = await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    expect(result.ok).toBe(true);
    const applied = result.applied?.[0];
    expect(applied.result).toContain('function-aware slice for runTargetTool');

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    expect(updated).toContain('// Slice: function runTargetTool');
    expect(updated).toContain('return { ok: true, result }');
  });

  it('includes line-range comment in injected snippet', async () => {
    const fileContent = buildLargeFile('runTargetTool');
    fs.writeFileSync(TARGET_FILE_FULL, fileContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory({ desc: 'edit `runTargetTool` handler' }));

    await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    // Comment should contain "lines X–Y of N"
    expect(updated).toMatch(/\/\/ Slice: function runTargetTool \(lines \d+–\d+ of \d+\)/);
  });

  it('falls back to head+tail when no function name in desc', async () => {
    const fileContent = buildLargeFile('runTargetTool');
    fs.writeFileSync(TARGET_FILE_FULL, fileContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory({ desc: 'edit this file to add support' }));

    await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    expect(updated).toContain('lines omitted');
    expect(updated).not.toContain('// Slice: function');
  });

  it('falls back to head+tail when targetFiles has no desc', async () => {
    const fileContent = buildLargeFile('runTargetTool');
    fs.writeFileSync(TARGET_FILE_FULL, fileContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory());

    await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    expect(updated).toContain('lines omitted');
    expect(updated).not.toContain('// Slice: function');
  });

  it('falls back to head+tail when function named in desc is not found in file', async () => {
    const fileContent = buildLargeFile('runTargetTool');
    fs.writeFileSync(TARGET_FILE_FULL, fileContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory({ desc: 'edit `ghostFunction` handler' }));

    await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    expect(updated).toContain('lines omitted');
    expect(updated).not.toContain('// Slice: function');
  });

  it('injects full file content unchanged when file is under 120 lines', async () => {
    const shortContent = `export function smallFn() {\n  return 1;\n}\n`;
    fs.writeFileSync(TARGET_FILE_FULL, shortContent);
    fs.writeFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), makeStory({ desc: 'edit `smallFn`' }));

    await runRefineApplyTool({
      projectRoot: TEST_PROJECT_DIR,
      problemId: STORY_ID,
      refinements: [{ type: 'add_code_snippet', data: { file: TARGET_FILE } }],
    });

    const updated = fs.readFileSync(path.join(NOTES_DIR, STORY_ID + '.md'), 'utf8');
    expect(updated).toContain('export function smallFn()');
    expect(updated).not.toContain('lines omitted');
    expect(updated).not.toContain('// Slice: function');
  });
});
