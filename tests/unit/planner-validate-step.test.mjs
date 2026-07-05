/**
 * Source-code assertions for planner validateStep() fail-fast refactor
 * and VALID_STEP_TYPES shared contract between planner and exec.
 * (backlog.bug.planner-note-step-in-exec)
 *
 * Originating telemetry: mcp.tool.failed on rks_exec
 * IDs: ecdd9b09, a533142e, b630c943, ca63ae8f, 51b7c034, cf634ff0, 276b5b71
 * Source: design.telemetry-research.2026.04.20.concourse-failure-patterns
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const plannerSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/planner.mjs'),
  'utf8'
);

const execSrc = fs.readFileSync(
  path.resolve('packages/mcp-rks/src/server/exec.mjs'),
  'utf8'
);

describe('VALID_STEP_TYPES — shared contract', () => {
  it('VALID_STEP_TYPES is exported from planner.mjs', () => {
    expect(plannerSrc).toContain('export const VALID_STEP_TYPES');
  });

  it('VALID_STEP_TYPES includes the five executable step types', () => {
    expect(plannerSrc).toContain("'search_replace'");
    expect(plannerSrc).toContain("'create_file'");
    expect(plannerSrc).toContain("'edit_file'");
    expect(plannerSrc).toContain("'delete_file'");
    expect(plannerSrc).toContain("'run_command'");
  });

  it('exec.mjs imports VALID_STEP_TYPES from planner.mjs', () => {
    expect(execSrc).toContain('VALID_STEP_TYPES');
    expect(execSrc).toContain('./planner.mjs');
  });

  it('exec.mjs note-step rejection uses VALID_STEP_TYPES instead of hardcoded string', () => {
    expect(execSrc).toContain('VALID_STEP_TYPES.includes(step.action)');
    // Must not still use the old hardcoded check
    expect(execSrc).not.toContain('step.action === "note"');
  });
});

describe('validateStep() — fail-fast: returns _invalid instead of note', () => {
  it('invalid run_command returns _invalid not action:note', () => {
    expect(plannerSrc).toContain('_invalidReason: "empty command"');
    // The invalid return must NOT set action: "note"
    const runCmdBlock = plannerSrc.match(/if \(step\.action === "run_command"\)[\s\S]*?return step;\s*\}/)?.[0] ?? '';
    expect(runCmdBlock).not.toContain('action: "note"');
    expect(runCmdBlock).toContain('_invalid: true');
  });

  it('search_replace with missing path returns _invalid', () => {
    // Structural validation failures use _invalid: true
    expect(plannerSrc).toContain('_invalid: true, _invalidReason: "missing or invalid path"');
  });

  it('search_replace with missing edits array returns _invalid', () => {
    expect(plannerSrc).toContain('_invalid: true, _invalidReason: "missing edits array"');
  });

  it('unrecognized action type returns _invalid', () => {
    expect(plannerSrc).toContain('_invalid: true, _invalidReason: "unrecognized action type"');
  });

  it('missing content returns _invalid', () => {
    expect(plannerSrc).toContain('_invalid: true, _invalidReason: "missing content"');
  });

  it('diff-style content returns _invalid', () => {
    expect(plannerSrc).toContain('_invalid: true, _invalidReason: "diff-style content rejected"');
  });
});

describe('plan emission — collects and guards on invalid steps', () => {
  it('_invalid steps are filtered out of combined steps', () => {
    expect(plannerSrc).toContain('validated?._invalid');
    expect(plannerSrc).toContain('return null;');
  });

  it('_invalid steps push to rejectionReasons before filtering', () => {
    const filterBlock = plannerSrc.match(/if \(validated\?._invalid\)[\s\S]*?return null;/)?.[0] ?? '';
    expect(filterBlock).toContain('rejectionReasons.push');
    expect(filterBlock).toContain('_invalidReason');
  });

  it('planner returns refinement_required after retries exhausted with note steps', () => {
    // Both the exhausted-retries guard and the refinement_required status must coexist
    expect(plannerSrc).toContain('retryCount >= MAX_NOTE_ONLY_RETRIES');
    expect(plannerSrc).toContain('status: "refinement_required"');
    // The exhausted reason var must be defined before the return
    expect(plannerSrc).toContain("reason: exhaustedReason");
  });

  it('refinement_required return includes noteSteps and rejectionReasons for diagnostics', () => {
    expect(plannerSrc).toContain('noteSteps: combinedSteps.filter');
    expect(plannerSrc).toContain('rejectionReasons,');
  });
});

describe('exec.mjs — safety net still in place', () => {
  it('exec still rejects non-executable steps via VALID_STEP_TYPES check', () => {
    expect(execSrc).toContain('VALID_STEP_TYPES.includes(step.action)');
    expect(execSrc).toContain('McpError');
  });
});
