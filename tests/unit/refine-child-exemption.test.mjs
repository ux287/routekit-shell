/**
 * Tests for child story exemption from decompose signals in runRefineTool.
 *
 * Child stories (parsedData.parent set) must never trigger decompose — they were
 * already scoped by PO + QA when the parent was decomposed. Grandchild decomposition
 * wastes a full QA + Build cycle and overrides a prior scope decision.
 *
 * Covers:
 * - Child with 6+ ACs does NOT trigger decompose
 * - Child with 6+ target files does NOT trigger decompose
 * - Child with hasCreateAndEdit=true does NOT trigger decompose
 * - isHighByConcern is false for child regardless of hasCreateAndEdit
 * - Child with exactly 1 signal: decomposeReasons is [], decomposeSuggested is not set (1-signal fix)
 * - Child with 2+ signals: decomposeSuggested is true, decomposeReasons is [] (regression)
 * - Non-child 2-signal: decomposeReasons non-empty, estimatedComplexity 'high' (regression)
 * - Non-child 1-signal: decomposeReasons non-empty, estimatedComplexity NOT 'high' (regression)
 * - Non-child stories are unaffected (regression)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { makeTempDir, writeFile, ensureDir } from '../helpers/tmp.mjs';
import { runRefineTool } from '../../packages/mcp-rks/src/server/refine.mjs';

function setupProject(projectRoot) {
  ensureDir(path.join(projectRoot, 'notes'));
  ensureDir(path.join(projectRoot, '.rks'));
  writeFile(path.join(projectRoot, '.rks', 'project.json'), JSON.stringify({
    projectId: 'test-project',
    branches: { working: 'staging', integration: 'staging', production: 'main' },
  }));
}

function makeChildStory(id, targetFilesYaml, acCount = 6) {
  const acs = Array.from({ length: acCount }, (_, i) => `- [ ] AC ${i + 1}`).join('\n');
  return `---
id: ${id}
title: Child Story
status: not-implemented
phase: ready
parent: backlog.feat.parent-story
testRequirements:
  - "Test the thing"
targetFiles:
${targetFilesYaml}
---

## Acceptance Criteria
${acs}
`;
}

function makeNonChildStory(id, targetFilesYaml, acCount = 6) {
  const acs = Array.from({ length: acCount }, (_, i) => `- [ ] AC ${i + 1}`).join('\n');
  return `---
id: ${id}
title: Non-Child Story
status: not-implemented
phase: ready
testRequirements:
  - "Test the thing"
targetFiles:
${targetFilesYaml}
---

## Acceptance Criteria
${acs}
`;
}

describe('refine child exemption — child stories do not decompose', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine_child_exemption_test');
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, 'src'));
  });

  it('child story with 6+ ACs does NOT trigger decompose', async () => {
    const story = makeChildStory(
      'test-child-many-acs',
      `  - path: src/a.mjs\n    op: edit`,
      7,
    );
    writeFile(path.join(projectRoot, 'notes', 'test-child-many-acs.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-many-acs' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'decompose');
    expect(decompose).toBeUndefined();
  });

  it('child story with 6+ target files does NOT trigger decompose', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f']
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join('\n');
    const story = makeChildStory('test-child-many-files', files, 3);
    writeFile(path.join(projectRoot, 'notes', 'test-child-many-files.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-many-files' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'decompose');
    expect(decompose).toBeUndefined();
  });

  it('child story with hasCreateAndEdit=true and editCount=2 does NOT trigger decompose', async () => {
    for (const f of ['existing.mjs']) {
      writeFile(path.join(projectRoot, 'src', f), '// existing\n');
    }
    const files = `  - path: src/new.mjs\n    op: create\n  - path: src/existing.mjs\n    op: edit`;
    const story = makeChildStory('test-child-create-edit', files, 3);
    writeFile(path.join(projectRoot, 'notes', 'test-child-create-edit.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-create-edit' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'decompose');
    expect(decompose).toBeUndefined();
  });

  it('child story with large file edit does NOT trigger decompose', async () => {
    const bigContent = Array(300).fill('// line').join('\n') + '\n';
    writeFile(path.join(projectRoot, 'src', 'big.mjs'), bigContent);
    const files = `  - path: src/big.mjs\n    op: edit`;
    const story = makeChildStory('test-child-large-file', files, 3);
    writeFile(path.join(projectRoot, 'notes', 'test-child-large-file.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-large-file' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'decompose');
    expect(decompose).toBeUndefined();
  });
});

describe('refine child exemption — non-child stories are unaffected (regression)', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine_child_exemption_regression_test');
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, 'src'));
  });

  it('non-child story with 6+ target files DOES trigger decompose', async () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f']
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join('\n');
    const story = makeNonChildStory('test-non-child-many-files', files, 3);
    writeFile(path.join(projectRoot, 'notes', 'test-non-child-many-files.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-non-child-many-files' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'plan_staging');
    expect(decompose).toBeDefined();
    expect(result.suggestions.find(s => s.type === 'decompose')).toBeUndefined();
  });

  it('non-child story with hasCreateAndEdit=true and editCount > 3 DOES trigger decompose', async () => {
    for (const f of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']) {
      writeFile(path.join(projectRoot, 'src', f), '// existing\n');
    }
    const files = [
      `  - path: src/new.mjs\n    op: create`,
      `  - path: src/a.mjs\n    op: edit`,
      `  - path: src/b.mjs\n    op: edit`,
      `  - path: src/c.mjs\n    op: edit`,
      `  - path: src/d.mjs\n    op: edit`,
    ].join('\n');
    const story = makeNonChildStory('test-non-child-create-edit', files, 3);
    writeFile(path.join(projectRoot, 'notes', 'test-non-child-create-edit.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-non-child-create-edit' });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === 'plan_staging');
    expect(decompose).toBeDefined();
    expect(result.suggestions.find(s => s.type === 'decompose')).toBeUndefined();
  });
});

describe('refine child 1-signal fix — child with exactly 1 signal is fully exempt', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine_child_1signal_test');
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, 'src'));
  });

  it('child with 1 signal: decomposeReasons is [] and decomposeSuggested is not set', async () => {
    // Trigger exactly 1 signal: large file edit (>=300 lines).
    // Use a single op:edit target to avoid triggering the editCount or targetFileCount thresholds.
    const bigContent = Array(300).fill('// line').join('\n') + '\n';
    writeFile(path.join(projectRoot, 'src', 'big.mjs'), bigContent);
    const files = `  - path: src/big.mjs\n    op: edit`;
    const story = makeChildStory('test-child-1signal', files, 2);
    writeFile(path.join(projectRoot, 'notes', 'test-child-1signal.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-1signal' });
    expect(result.ok).toBe(true);
    // decomposeReasons must be empty — child is exempt regardless of signal count
    expect(result.analysis.decomposeReasons).toEqual([]);
    // decomposeSuggested must NOT be set for 1 signal (only fires at 2+)
    expect(result.analysis.decomposeSuggested).toBeUndefined();
  });

  it('child with 2+ signals: decomposeSuggested is true and decomposeReasons is [] (regression)', async () => {
    // Trigger 2 signals: 6+ target files AND large file edit
    const bigContent = Array(300).fill('// line').join('\n') + '\n';
    writeFile(path.join(projectRoot, 'src', 'big.mjs'), bigContent);
    const files = ['big', 'b', 'c', 'd', 'e', 'f']
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join('\n');
    const story = makeChildStory('test-child-2signals', files, 2);
    writeFile(path.join(projectRoot, 'notes', 'test-child-2signals.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-child-2signals' });
    expect(result.ok).toBe(true);
    // decomposeReasons must still be empty for child
    expect(result.analysis.decomposeReasons).toEqual([]);
    // decomposeSuggested fires at 2+ signals for child stories
    expect(result.analysis.decomposeSuggested).toBe(true);
    // decomposeSuggestedReasons must be non-empty
    expect(Array.isArray(result.analysis.decomposeSuggestedReasons)).toBe(true);
    expect(result.analysis.decomposeSuggestedReasons.length).toBeGreaterThan(0);
  });
});

describe('refine non-child signal regression — non-child decompose/complexity behavior', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir('refine_nonchild_signal_test');
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, 'src'));
  });

  it('non-child with 2+ signals: decomposeReasons is non-empty and estimatedComplexity is high', async () => {
    // Trigger 2 signals: 6+ target files AND large file edit
    const bigContent = Array(300).fill('// line').join('\n') + '\n';
    writeFile(path.join(projectRoot, 'src', 'big.mjs'), bigContent);
    const files = ['big', 'b', 'c', 'd', 'e', 'f']
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join('\n');
    const story = makeNonChildStory('test-nonchild-2signals', files, 2);
    writeFile(path.join(projectRoot, 'notes', 'test-nonchild-2signals.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-nonchild-2signals' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.analysis.decomposeReasons)).toBe(true);
    expect(result.analysis.decomposeReasons.length).toBeGreaterThan(0);
    expect(result.analysis.estimatedComplexity).toBe('high');
  });

  it('non-child with 1 signal: decomposeReasons is non-empty and estimatedComplexity is NOT high', async () => {
    // Trigger exactly 1 signal: large file edit (>=300 lines).
    // Single op:edit target avoids triggering editCount or targetFileCount thresholds.
    const bigContent = Array(300).fill('// line').join('\n') + '\n';
    writeFile(path.join(projectRoot, 'src', 'big.mjs'), bigContent);
    const files = `  - path: src/big.mjs\n    op: edit`;
    const story = makeNonChildStory('test-nonchild-1signal', files, 2);
    writeFile(path.join(projectRoot, 'notes', 'test-nonchild-1signal.md'), story);
    const result = await runRefineTool({ projectRoot, problemId: 'test-nonchild-1signal' });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.analysis.decomposeReasons)).toBe(true);
    expect(result.analysis.decomposeReasons.length).toBeGreaterThan(0);
    expect(result.analysis.estimatedComplexity).not.toBe('high');
  });
});
