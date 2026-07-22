/**
 * Unit tests for the decompose child guard and targetFiles split logic.
 *
 * Bug 1 fix: stories with `parent` in frontmatter do NOT decompose on editCount > 1 alone.
 * Bug 2 fix: decomposing a multi-file story splits targetFiles across children, not copies.
 */

import { describe, it, expect } from 'vitest';

// ─── Bug 1: editCount > 1 decompose reason skipped for child stories ──────────

/**
 * Mirrors the decomposeReasons logic in runRefineTool (refine.mjs ~line 197).
 * Extracted here to test the guard in isolation.
 */
function buildDecomposeReasons({ acceptanceCriteriaCount, bodyLength, targetFileCount, editCount, hasCreateAndEdit, isChild }) {
  const decomposeReasons = [];
  if (acceptanceCriteriaCount > 4) decomposeReasons.push(`${acceptanceCriteriaCount} acceptance criteria`);
  if (bodyLength > 2500) decomposeReasons.push(`${Math.round(bodyLength / 1000)}KB of content`);
  if (targetFileCount > 5) decomposeReasons.push(`${targetFileCount} target files`);
  if (!isChild && editCount > 1) decomposeReasons.push(`${editCount} separate files being edited (multiple independent concerns)`);
  if (hasCreateAndEdit) decomposeReasons.push(`bundled create+edit targets (implementation mixed with wiring)`);
  return decomposeReasons;
}

describe('refine decompose child guard — Bug 1', () => {
  it('child story with editCount > 1 does NOT get editCount decompose reason', () => {
    const reasons = buildDecomposeReasons({
      acceptanceCriteriaCount: 2,
      bodyLength: 500,
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      isChild: true, // has parent field
    });
    expect(reasons).toHaveLength(0);
    expect(reasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('parent story with editCount > 1 DOES get editCount decompose reason (existing behavior preserved)', () => {
    const reasons = buildDecomposeReasons({
      acceptanceCriteriaCount: 2,
      bodyLength: 500,
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      isChild: false,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('2 separate files being edited');
  });

  it('child story with acceptanceCriteriaCount > 4 DOES decompose (strong signal not suppressed)', () => {
    const reasons = buildDecomposeReasons({
      acceptanceCriteriaCount: 6,
      bodyLength: 500,
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      isChild: true,
    });
    expect(reasons.some(r => r.includes('acceptance criteria'))).toBe(true);
    expect(reasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('child story with bodyLength > 2500 DOES decompose (strong signal not suppressed)', () => {
    const reasons = buildDecomposeReasons({
      acceptanceCriteriaCount: 2,
      bodyLength: 3000,
      targetFileCount: 2,
      editCount: 2,
      hasCreateAndEdit: false,
      isChild: true,
    });
    expect(reasons.some(r => r.includes('KB of content'))).toBe(true);
    expect(reasons.some(r => r.includes('separate files being edited'))).toBe(false);
  });

  it('child story with targetFileCount > 5 DOES decompose (strong signal not suppressed)', () => {
    const reasons = buildDecomposeReasons({
      acceptanceCriteriaCount: 2,
      bodyLength: 500,
      targetFileCount: 6,
      editCount: 2,
      hasCreateAndEdit: false,
      isChild: true,
    });
    expect(reasons.some(r => r.includes('target files'))).toBe(true);
  });
});

// ─── Bug 1b: isHighByConcern must also respect parent guard ──────────────────

/**
 * Mirrors the isHighByConcern logic in runRefineTool (refine.mjs ~line 226).
 * Bug 1 fix was incomplete: decomposeReasons excluded editCount > 1 for child
 * stories, but isHighByConcern (which drives estimatedComplexity = "high" and
 * the decompose suggestion) still checked editCount > 1 without a parent guard.
 */
function computeIsHighByConcern({ editCount, hasCreateAndEdit, hasLargeFileEdit, hasCreateExistsOnDisk, isChild }) {
  return (!isChild && editCount > 1) || hasCreateAndEdit ||
    hasLargeFileEdit || hasCreateExistsOnDisk;
}

describe('refine isHighByConcern child guard — Bug 1b', () => {
  it('child story with editCount > 1 is NOT high by concern', () => {
    expect(computeIsHighByConcern({
      editCount: 2, hasCreateAndEdit: false, hasLargeFileEdit: false, hasCreateExistsOnDisk: false, isChild: true,
    })).toBe(false);
  });

  it('parent story with editCount > 1 IS high by concern', () => {
    expect(computeIsHighByConcern({
      editCount: 2, hasCreateAndEdit: false, hasLargeFileEdit: false, hasCreateExistsOnDisk: false, isChild: false,
    })).toBe(true);
  });

  it('child story with hasCreateAndEdit is still high by concern (that trigger is not parent-guarded)', () => {
    expect(computeIsHighByConcern({
      editCount: 1, hasCreateAndEdit: true, hasLargeFileEdit: false, hasCreateExistsOnDisk: false, isChild: true,
    })).toBe(true);
  });

  it('child story with large file edit is still high by concern', () => {
    expect(computeIsHighByConcern({
      editCount: 2, hasCreateAndEdit: false, hasLargeFileEdit: true, hasCreateExistsOnDisk: false, isChild: true,
    })).toBe(true);
  });
});

// ─── Bug 2: targetFiles split across children ─────────────────────────────────

/**
 * Mirrors the targetFiles split logic in the decompose loop (refine.mjs ~line 1318).
 * Extracted here to test splitting in isolation.
 */
function assignTargetFilesToChild({ resolvedParentFiles, numChildren, childIndex }) {
  if (numChildren === 1) {
    return resolvedParentFiles;
  }

  const isTestPattern = f => /\.test\.|\.spec\.|\/tests\/|\/test\//.test(f.path);
  const implFiles = resolvedParentFiles.filter(f => !isTestPattern(f));
  const testFiles = resolvedParentFiles.filter(f => isTestPattern(f));

  if (implFiles.length > 0 && testFiles.length > 0) {
    // Mixed: impl to earlier children (round-robin), test to last child
    if (childIndex === numChildren - 1) {
      return testFiles;
    } else {
      const implChildCount = numChildren - 1;
      const assigned = implFiles.filter((_, idx) => idx % implChildCount === childIndex);
      return assigned.length > 0 ? assigned : implFiles.slice(childIndex, childIndex + 1);
    }
  } else {
    // All same type: round-robin
    const assigned = resolvedParentFiles.filter((_, idx) => idx % numChildren === childIndex);
    return assigned.length > 0 ? assigned : resolvedParentFiles.slice(childIndex, childIndex + 1);
  }
}

describe('refine targetFiles split — Bug 2', () => {
  it('2-file story produces children with distinct subsets, not the full list', () => {
    const parentFiles = [
      { path: 'src/Modal.tsx', op: 'edit' },
      { path: 'tests/unit/Modal.test.tsx', op: 'edit' },
    ];
    const child0 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 0 });
    const child1 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 1 });

    // Each child should get a subset, not both files
    expect(child0).toHaveLength(1);
    expect(child1).toHaveLength(1);
    // Together they cover all files
    const allPaths = [...child0, ...child1].map(f => f.path);
    expect(allPaths).toContain('src/Modal.tsx');
    expect(allPaths).toContain('tests/unit/Modal.test.tsx');
  });

  it('impl/test split: impl file goes to earlier child, test file goes to last child', () => {
    const parentFiles = [
      { path: 'src/server/exec.mjs', op: 'edit' },
      { path: 'tests/unit/exec.test.mjs', op: 'create' },
    ];
    const child0 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 0 });
    const child1 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 1 });

    expect(child0.map(f => f.path)).toContain('src/server/exec.mjs');
    expect(child1.map(f => f.path)).toContain('tests/unit/exec.test.mjs');
  });

  it('impl/test split: .spec. pattern goes to last child', () => {
    const parentFiles = [
      { path: 'src/utils/parser.mjs', op: 'edit' },
      { path: 'src/utils/parser.spec.mjs', op: 'edit' },
    ];
    const child1 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 1 });
    expect(child1.map(f => f.path)).toContain('src/utils/parser.spec.mjs');
  });

  it('round-robin: all impl files distributed across children when no test files', () => {
    const parentFiles = [
      { path: 'src/a.mjs', op: 'edit' },
      { path: 'src/b.mjs', op: 'edit' },
      { path: 'src/c.mjs', op: 'edit' },
    ];
    const child0 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 3, childIndex: 0 });
    const child1 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 3, childIndex: 1 });
    const child2 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 3, childIndex: 2 });

    // Each gets exactly one file, no overlaps
    expect(child0).toHaveLength(1);
    expect(child1).toHaveLength(1);
    expect(child2).toHaveLength(1);
    const allPaths = [...child0, ...child1, ...child2].map(f => f.path);
    expect(new Set(allPaths).size).toBe(3);
  });

  it('single-child decompose: child receives all parent files unchanged', () => {
    const parentFiles = [
      { path: 'src/Modal.tsx', op: 'edit' },
      { path: 'tests/unit/Modal.test.tsx', op: 'edit' },
    ];
    const child0 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 1, childIndex: 0 });
    expect(child0).toHaveLength(2);
    expect(child0).toEqual(parentFiles);
  });

  it('round-robin: all test files distributed across children when no impl files', () => {
    const parentFiles = [
      { path: 'tests/unit/a.test.mjs', op: 'edit' },
      { path: 'tests/unit/b.test.mjs', op: 'edit' },
    ];
    const child0 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 0 });
    const child1 = assignTargetFilesToChild({ resolvedParentFiles: parentFiles, numChildren: 2, childIndex: 1 });

    expect(child0).toHaveLength(1);
    expect(child1).toHaveLength(1);
    expect(child0[0].path).not.toBe(child1[0].path);
  });
});
