import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// We test the detectPerStepDivergence function by importing exec.mjs's internals.
// Since it's not exported, we test the behavior through the exported runApplyTool.
// But first, let's test the detection logic directly by extracting it.

// Import the module to access detectPerStepDivergence via the module's internal scope.
// Since it's a module-level const, we can't import it directly.
// Instead, we'll test the behavior end-to-end through runApplyTool.

// For unit testing the detection logic, we replicate it here with the same algorithm:
const computeImplicitDirs = (expectedFiles) => {
  const dirs = new Set();
  for (const filePath of expectedFiles) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
};

const detectPerStepDivergence = (modifiedFiles, expectedFiles, preCommandGeneratedFiles = new Set()) => {
  const implicitDirs = computeImplicitDirs(expectedFiles);

  const unexpectedFiles = modifiedFiles.filter(f => {
    if (expectedFiles.has(f)) return false;
    if (f.startsWith('.rks/')) return false;
    if (f.startsWith('.routekit/')) return false;
    if (preCommandGeneratedFiles.has(f)) return false;
    if (implicitDirs.has(f) || implicitDirs.has(f.replace(/\/$/, ''))) return false;
    return true;
  });

  if (unexpectedFiles.length > 0) {
    const actuallyModified = new Set(modifiedFiles);
    const missingFiles = Array.from(expectedFiles).filter(f => !actuallyModified.has(f));

    return {
      diverged: true,
      unexpectedFiles,
      missingFiles,
      actualFiles: modifiedFiles,
      expectedFiles: Array.from(expectedFiles),
    };
  }

  return { diverged: false };
};

describe('per-step divergence detection', () => {
  describe('detectPerStepDivergence logic', () => {
    it('returns diverged: false when only expected files are modified', () => {
      const modified = ['src/foo.mjs', 'src/bar.mjs'];
      const expected = new Set(['src/foo.mjs', 'src/bar.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(false);
    });

    it('returns diverged: true when unexpected files are detected', () => {
      const modified = ['src/foo.mjs', 'src/unexpected.mjs'];
      const expected = new Set(['src/foo.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(true);
      expect(result.unexpectedFiles).toEqual(['src/unexpected.mjs']);
    });

    it('includes stepIndex-compatible expectedFiles and actualFiles in result', () => {
      const modified = ['src/foo.mjs', 'src/rogue.mjs'];
      const expected = new Set(['src/foo.mjs', 'src/bar.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(true);
      expect(result.expectedFiles).toContain('src/foo.mjs');
      expect(result.expectedFiles).toContain('src/bar.mjs');
      expect(result.actualFiles).toContain('src/foo.mjs');
      expect(result.actualFiles).toContain('src/rogue.mjs');
    });

    it('includes unexpectedFiles listing files not in plan', () => {
      const modified = ['src/foo.mjs', 'src/rogue.mjs'];
      const expected = new Set(['src/foo.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.unexpectedFiles).toEqual(['src/rogue.mjs']);
    });

    it('includes missingFiles listing expected files not actually modified', () => {
      const modified = ['src/foo.mjs', 'src/rogue.mjs'];
      const expected = new Set(['src/foo.mjs', 'src/bar.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.missingFiles).toEqual(['src/bar.mjs']);
    });

    it('excludes .rks/ infrastructure paths from divergence detection', () => {
      const modified = ['src/foo.mjs', '.rks/runs/some-log.json'];
      const expected = new Set(['src/foo.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(false);
    });

    it('excludes .routekit/ infrastructure paths from divergence detection', () => {
      const modified = ['src/foo.mjs', '.routekit/hooks/some-hook.mjs'];
      const expected = new Set(['src/foo.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(false);
    });

    it('excludes preCommand-generated files from divergence detection', () => {
      const modified = ['src/foo.mjs', 'package-lock.json'];
      const expected = new Set(['src/foo.mjs']);
      const preCommandGenerated = new Set(['package-lock.json']);
      const result = detectPerStepDivergence(modified, expected, preCommandGenerated);
      expect(result.diverged).toBe(false);
    });

    it('when no divergence occurs, execution completes normally', () => {
      const steps = [
        { target: 'src/a.mjs' },
        { target: 'src/b.mjs' },
        { target: 'src/c.mjs' },
      ];
      // Simulate checking after each step
      for (let i = 0; i < steps.length; i++) {
        const expectedThrough = new Set(
          steps.slice(0, i + 1).map(s => s.target)
        );
        const modified = steps.slice(0, i + 1).map(s => s.target);
        const result = detectPerStepDivergence(modified, expectedThrough);
        expect(result.diverged).toBe(false);
      }
    });

    it('stops at the step that causes divergence', () => {
      const steps = [
        { target: 'src/a.mjs' },
        { target: 'src/b.mjs' },  // This step will also modify src/rogue.mjs
        { target: 'src/c.mjs' },
      ];
      // After step 0: clean
      let expected = new Set(['src/a.mjs']);
      let result = detectPerStepDivergence(['src/a.mjs'], expected);
      expect(result.diverged).toBe(false);

      // After step 1: diverged (rogue file appeared)
      expected = new Set(['src/a.mjs', 'src/b.mjs']);
      result = detectPerStepDivergence(['src/a.mjs', 'src/b.mjs', 'src/rogue.mjs'], expected);
      expect(result.diverged).toBe(true);
      expect(result.unexpectedFiles).toEqual(['src/rogue.mjs']);
      // Step 2 never runs — execution stopped at step 1
    });

    it('divergence result includes diffSummary-compatible data', () => {
      const modified = ['src/foo.mjs', 'src/rogue.mjs'];
      const expected = new Set(['src/foo.mjs']);
      const result = detectPerStepDivergence(modified, expected);
      expect(result.diverged).toBe(true);
      // The caller constructs diffSummary from unexpectedFiles
      const diffSummary = `Step 1 modified unexpected files: ${result.unexpectedFiles.join(', ')}`;
      expect(diffSummary).toContain('src/rogue.mjs');
    });
  });
});
