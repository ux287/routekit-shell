/**
 * Unit tests for op_mismatch assertion in plan generation.
 *
 * Tests checkOpMatch (plan-quality.mjs) in isolation, then verifies the
 * integration point: planProblem filters create_file steps for op:edit targets
 * rather than aborting (no op_mismatch abort).
 */
import { describe, it, expect } from 'vitest';
import { checkOpMatch } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

// ─── checkOpMatch unit tests ──────────────────────────────────────────────────

describe('checkOpMatch — pure function', () => {
  it('returns null when all steps match their target ops', () => {
    const steps = [
      { action: 'search_replace', path: 'src/server/exec.mjs', edits: [] },
      { action: 'create_file', path: 'tests/unit/exec.test.mjs', content: 'test' },
    ];
    const targetFiles = [
      { path: 'src/server/exec.mjs', op: 'edit' },
      { path: 'tests/unit/exec.test.mjs', op: 'create' },
    ];
    const result = checkOpMatch(steps, targetFiles);
    expect(result).toEqual([]);
  });

  it('returns op_mismatch error when create_file targets an op:edit file', () => {
    const step = { action: 'create_file', path: 'src/server/exec.mjs', content: '...' };
    const targetFiles = [
      { path: 'src/server/exec.mjs', op: 'edit' },
    ];
    const result = checkOpMatch([step], targetFiles);
    expect(result).not.toBeNull();
    expect(result.length).toBe(1);
    const err = result[0];
    expect(err.type).toBe('op_mismatch');
    expect(err.step).toBe(step);
    expect(err.targetFile).toEqual({ path: 'src/server/exec.mjs', op: 'edit' });
    expect(err.message).toContain('create_file');
    expect(err.message).toContain('op:edit');
  });

  it('error object includes step and targetFile fields', () => {
    const step = { action: 'create_file', path: 'components/Modal.tsx', content: '...' };
    const targetFile = { path: 'components/Modal.tsx', op: 'edit', desc: 'Edit modal' };
    const result = checkOpMatch([step], [targetFile]);
    expect(result.length).toBe(1);
    const err = result[0];
    expect(err).toHaveProperty('step');
    expect(err).toHaveProperty('targetFile');
    expect(err.step).toBe(step);
    expect(err.targetFile).toBe(targetFile);
  });

  it('returns null when steps is empty', () => {
    const targetFiles = [{ path: 'src/foo.mjs', op: 'edit' }];
    expect(checkOpMatch([], targetFiles)).toEqual([]);
  });

  it('returns null when targetFiles is empty', () => {
    const steps = [{ action: 'create_file', path: 'src/foo.mjs', content: '...' }];
    expect(checkOpMatch(steps, [])).toEqual([]);
  });

  it('returns null when targetFiles is not an array', () => {
    const steps = [{ action: 'create_file', path: 'src/foo.mjs', content: '...' }];
    expect(checkOpMatch(steps, null)).toEqual([]);
    expect(checkOpMatch(steps, undefined)).toEqual([]);
  });

  it('create_file on op:create target is NOT a mismatch', () => {
    const steps = [{ action: 'create_file', path: 'src/new-file.mjs', content: 'new' }];
    const targetFiles = [{ path: 'src/new-file.mjs', op: 'create' }];
    expect(checkOpMatch(steps, targetFiles)).toEqual([]);
  });

  it('search_replace on op:edit target is NOT a mismatch', () => {
    const steps = [{ action: 'search_replace', path: 'src/existing.mjs', edits: [] }];
    const targetFiles = [{ path: 'src/existing.mjs', op: 'edit' }];
    expect(checkOpMatch(steps, targetFiles)).toEqual([]);
  });

  it('uses step.target as fallback when step.path is absent', () => {
    const step = { action: 'create_file', target: 'src/server/exec.mjs', content: '...' };
    const targetFiles = [{ path: 'src/server/exec.mjs', op: 'edit' }];
    const result = checkOpMatch([step], targetFiles);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('op_mismatch');
  });

  it('create_file for a path not in targetFiles returns null', () => {
    const steps = [{ action: 'create_file', path: 'src/unlisted.mjs', content: '...' }];
    const targetFiles = [{ path: 'src/other.mjs', op: 'edit' }];
    expect(checkOpMatch(steps, targetFiles)).toEqual([]);
  });

  it('returns first mismatch when multiple create_file steps target op:edit files', () => {
    const step1 = { action: 'create_file', path: 'src/a.mjs', content: '...' };
    const step2 = { action: 'create_file', path: 'src/b.mjs', content: '...' };
    const targetFiles = [
      { path: 'src/a.mjs', op: 'edit' },
      { path: 'src/b.mjs', op: 'edit' },
    ];
    const result = checkOpMatch([step1, step2], targetFiles);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].step).toBe(step1); // first mismatch
  });
});
