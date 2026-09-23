/**
 * Tests for create_file suppression on op:edit targets.
 *
 * Verifies:
 * 1. checkOpMatch returns ALL violations (not just first)
 * 2. planProblem filters create_file steps for op:edit targets (no op_mismatch abort)
 * 3. op:create targets are unaffected
 * 4. The LLM prompt contains the explicit rule
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkOpMatch } from '../../packages/mcp-rks/src/server/plan-quality.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const LLM_PLANNER = path.join(ROOT, 'packages/mcp-rks/src/llm/planner.mjs');
const PLANNER_MJS = path.join(ROOT, 'packages/mcp-rks/src/server/planner.mjs');

// ─── checkOpMatch — returns all violations ────────────────────────────────────

describe('checkOpMatch — returns all violations', () => {
  const editTargets = [
    { path: 'src/foo.mjs', op: 'edit' },
    { path: 'src/bar.mjs', op: 'edit' },
    { path: 'src/new.mjs', op: 'create' },
  ];

  it('returns empty array when no violations', () => {
    const steps = [
      { action: 'search_replace', path: 'src/foo.mjs', edits: [] },
    ];
    expect(checkOpMatch(steps, editTargets)).toEqual([]);
  });

  it('returns empty array for non-array inputs', () => {
    expect(checkOpMatch(null, editTargets)).toEqual([]);
    expect(checkOpMatch([], null)).toEqual([]);
  });

  it('returns one violation when one create_file targets op:edit file', () => {
    const steps = [
      { action: 'create_file', path: 'src/foo.mjs', content: 'x' },
      { action: 'search_replace', path: 'src/bar.mjs', edits: [] },
    ];
    const result = checkOpMatch(steps, editTargets);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('op_mismatch');
    expect(result[0].step.path).toBe('src/foo.mjs');
  });

  it('returns ALL violations when multiple create_file steps target op:edit files', () => {
    const steps = [
      { action: 'create_file', path: 'src/foo.mjs', content: 'x' },
      { action: 'create_file', path: 'src/bar.mjs', content: 'y' },
      { action: 'search_replace', path: 'src/foo.mjs', edits: [] },
    ];
    const result = checkOpMatch(steps, editTargets);
    expect(result.length).toBe(2);
    const paths = result.map(v => v.step.path);
    expect(paths).toContain('src/foo.mjs');
    expect(paths).toContain('src/bar.mjs');
  });

  it('does NOT flag create_file for op:create targets', () => {
    const steps = [
      { action: 'create_file', path: 'src/new.mjs', content: 'x' },
    ];
    const result = checkOpMatch(steps, editTargets);
    expect(result.length).toBe(0);
  });

  it('does NOT flag search_replace steps', () => {
    const steps = [
      { action: 'search_replace', path: 'src/foo.mjs', edits: [] },
      { action: 'search_replace', path: 'src/bar.mjs', edits: [] },
    ];
    expect(checkOpMatch(steps, editTargets)).toEqual([]);
  });
});

// ─── planner.mjs source — filters instead of aborts ──────────────────────────

describe('planner.mjs — source: filters create_file on op:edit, does not abort', () => {
  let src;

  it('does not return op_mismatch — filters instead', () => {
    src = fs.readFileSync(PLANNER_MJS, 'utf8');
    // The old abort pattern should be gone
    expect(src).not.toContain("return { ok: false, error: 'op_mismatch'");
  });

  it('filters steps array when violations are found', () => {
    src = src || fs.readFileSync(PLANNER_MJS, 'utf8');
    expect(src).toContain('runRes.plan.steps = runRes.plan.steps.filter');
  });

  it('logs a warning with filtered path(s)', () => {
    src = src || fs.readFileSync(PLANNER_MJS, 'utf8');
    expect(src).toContain('filtering');
    expect(src).toContain('create_file step');
  });

  it('filter happens before validateSearchPatternsFromPlanner (plan is clean before further validation)', () => {
    src = src || fs.readFileSync(PLANNER_MJS, 'utf8');
    const filterIdx = src.indexOf('runRes.plan.steps = runRes.plan.steps.filter');
    const validateIdx = src.indexOf('validateSearchPatternsFromPlanner(');
    expect(filterIdx).toBeGreaterThan(0);
    expect(validateIdx).toBeGreaterThan(0);
    expect(filterIdx).toBeLessThan(validateIdx);
  });
});

// ─── LLM prompt — explicit op:edit rule ──────────────────────────────────────

describe('llm/planner.mjs — prompt contains op:edit create_file prohibition', () => {
  let src;

  beforeAll(() => {
    src = fs.readFileSync(LLM_PLANNER, 'utf8');
  });

  it('prompt contains explicit prohibition on create_file for op:edit targets', () => {
    expect(src).toContain('op="edit"');
    expect(src).toContain('NEVER emit');
  });

  it('prohibition mentions infinite retry loop consequence', () => {
    expect(src).toContain('infinite retry loop');
  });
});
