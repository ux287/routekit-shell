/**
 * validateStep() fail-fast contract + the VALID_STEP_TYPES contract shared between planner and exec.
 * (backlog.bug.planner-note-step-in-exec)
 *
 * Originating telemetry: mcp.tool.failed on rks_exec
 * IDs: ecdd9b09, a533142e, b630c943, ca63ae8f, 51b7c034, cf634ff0, 276b5b71
 * Source: design.telemetry-research.2026.04.20.concourse-failure-patterns
 *
 * backlog.fix.planner-note-step-false-rejection — REWRITTEN.
 * This file used to `fs.readFileSync` planner.mjs and regex-slice it, asserting things like
 * `expect(plannerSrc).toContain('noteSteps: combinedSteps.filter')`. That is a source-text mirror:
 * it asserts nothing about behavior, it breaks on any refactor, and — worst — it stayed GREEN for
 * two releases while the code it "witnessed" was throwing away valid plans. It could not have
 * caught the bug it was standing next to.
 *
 * Every assertion below now drives the real exported functions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateStep, classifySteps, VALID_STEP_TYPES } from '../../packages/mcp-rks/src/server/planner.mjs';

let projectRoot;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rks-validate-step-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
});

afterAll(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('VALID_STEP_TYPES — shared contract with exec', () => {
  it('contains exactly the five executable step types', () => {
    expect([...VALID_STEP_TYPES].sort()).toEqual(
      ['create_file', 'delete_file', 'edit_file', 'run_command', 'search_replace'].sort(),
    );
  });

  it('does NOT contain "note" — a note is not executable, which is why exec rejects one', () => {
    expect(VALID_STEP_TYPES).not.toContain('note');
  });

  it('exec.mjs imports the contract from planner.mjs rather than redeclaring it', async () => {
    // A cross-module import edge is the one thing a behavioral test cannot observe from outside,
    // so this stays structural — but it is a narrow import check, not a mirror of any rule.
    const execSrc = fs.readFileSync(path.resolve('packages/mcp-rks/src/server/exec.mjs'), 'utf8');
    expect(execSrc).toContain('VALID_STEP_TYPES');
    expect(execSrc).toContain('./planner.mjs');
  });
});

describe('validateStep() — fail-fast: rejects with _invalid rather than disguising as a note', () => {
  it('run_command with an empty command is rejected (not turned into a note)', () => {
    const out = validateStep({ title: 'x', action: 'run_command', command: '   ' }, null, projectRoot);
    expect(out._invalid).toBe(true);
    expect(out._invalidReason).toMatch(/empty command/i);
    expect(out.action).not.toBe('note');
  });

  it('a VALID run_command survives — including with path:null, which is correct for a shell command', () => {
    // The regression that mattered: a command legitimately has no file path. Any gate that reads a
    // null path as "outside the editable targets" destroys the step — and one destroyed step used
    // to discard the entire plan.
    const out = validateStep(
      { title: 'Run tests', action: 'run_command', path: null, content: null, command: 'npm run test' },
      { allowFiles: ['src/a.js'], allowPatterns: [] },
      projectRoot,
    );
    expect(out.action).toBe('run_command');
    expect(out._invalid).toBeFalsy();
  });

  it('search_replace with a missing path is rejected', () => {
    const out = validateStep({ title: 'x', action: 'search_replace', edits: [{ search: 'a', replace: 'b' }] }, null, projectRoot);
    expect(out._invalid).toBe(true);
    expect(out._invalidReason).toMatch(/missing or invalid path/i);
  });

  it('search_replace with no edits array is rejected', () => {
    const out = validateStep({ title: 'x', action: 'search_replace', path: 'src/a.js' }, null, projectRoot);
    expect(out._invalid).toBe(true);
    expect(out._invalidReason).toMatch(/missing edits/i);
  });

  it('an unrecognized action is rejected', () => {
    const out = validateStep({ title: 'x', action: 'teleport_file', path: 'src/a.js' }, null, projectRoot);
    expect(out._invalid).toBe(true);
    expect(out._invalidReason).toMatch(/unrecognized action/i);
  });

  it('a path traversal attempt is rejected', () => {
    const out = validateStep(
      { title: 'x', action: 'search_replace', path: '../../etc/passwd', edits: [{ search: 'a', replace: 'b' }] },
      null,
      projectRoot,
    );
    expect(out._invalid).toBe(true);
  });
});

describe('classifySteps() — invalid steps are dropped, recorded, and always nameable', () => {
  it('drops _invalid steps from the plan and records WHY', () => {
    const r = classifySteps({
      rawSteps: [
        { title: 'good', action: 'create_file', path: 'src/new.js', content: 'export const x = 1;' },
        { title: 'bad', action: 'run_command', command: '' },
      ],
      allowedTargets: null,
      projectRoot,
    });

    expect(r.steps.map((s) => s.title)).toEqual(['good']);
    expect(r.hasExecutableSteps).toBe(true);
    expect(r.rejectionReasons).toHaveLength(1);
    expect(r.rejectionReasons[0].reason).toMatch(/empty command/i);
  });

  it('every rejection carries a non-empty label — the empty-string bug', () => {
    // The failure that made this whole class of bug undebuggable: a rejected step rendered as "",
    // so the planner told the LLM "these steps became notes:" and listed nothing.
    const r = classifySteps({
      rawSteps: [{ action: 'run_command', command: '' }], // no title, no path
      allowedTargets: null,
      projectRoot,
    });
    expect(r.rejectionReasons).toHaveLength(1);
    expect(r.rejectionReasons[0].label).toBeTruthy();
    expect(r.rejectionReasons[0].label).not.toBe('');
  });

  it('separates notes from executables — exec may only ever see the executables', () => {
    const r = classifySteps({
      rawSteps: [
        { title: 'code', action: 'create_file', path: 'src/new.js', content: 'export const x = 1;' },
        { title: 'commentary', action: 'note', description: 'a follow-up thought' },
      ],
      allowedTargets: null,
      projectRoot,
    });
    expect(r.executable).toHaveLength(1);
    expect(r.noteSteps).toHaveLength(1);
    expect(r.executable.every((s) => VALID_STEP_TYPES.includes(s.action))).toBe(true);
  });
});
