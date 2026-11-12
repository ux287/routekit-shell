/**
 * Tests for auto-phase.mjs ship transition and VALID_PHASES enum
 * (backlog.feat.fix-auto-phase-ship-transition)
 *
 * Root cause: PR #223 added "integrated" and "released" to VALID_PHASES but omitted
 * "implemented", causing dendron_update_field to throw "Invalid phase 'implemented'"
 * on every ship operation. The fix: add "implemented" to VALID_PHASES in dendron.mjs.
 *
 * auto-phase.mjs, state-machine.mjs, and all tooling correctly use "implemented" —
 * they did not need to change.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from '../helpers/tmp.mjs';
import { getExpectedTransition, advancePhase, resolveOperation } from '../../packages/mcp-rks/src/workflow/auto-phase.mjs';
import { OPERATION_TRANSITIONS, PHASE_MACHINE } from '../../packages/mcp-rks/src/workflow/phases.mjs';

function initGitRepo(dir) {
  spawnSync('git', ['init', '-b', 'staging'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('OPERATION_TRANSITIONS — ship', () => {
  // Story 1 (backlog.feat.phase-machine-foundation): OPERATION_TRANSITIONS.<op>.from
  // is now a string[] (multi-source support) instead of a single string.
  it('ship transition targets "integrated"', () => {
    const transition = getExpectedTransition('ship');
    expect(transition).not.toBeNull();
    expect(transition.to).toBe('integrated');
    expect(transition.from).toEqual(['executed']);
  });
});

describe('VALID_PHASES — R1.4 retires "implemented"', () => {
  it('R1.4: VALID_PHASES does NOT include "implemented" (retired after R8 backfill)', async () => {
    const { VALID_PHASES } = await import('../../packages/mcp-rks/src/dendron.mjs');
    expect(VALID_PHASES).not.toContain('implemented');
  });

  it('VALID_PHASES still includes "integrated" and "released" for the post-ship arc', async () => {
    const { VALID_PHASES } = await import('../../packages/mcp-rks/src/dendron.mjs');
    expect(VALID_PHASES).toContain('integrated');
    expect(VALID_PHASES).toContain('released');
  });

  it('VALID_PHASES includes "arch-approved"', async () => {
    const { VALID_PHASES } = await import('../../packages/mcp-rks/src/dendron.mjs');
    expect(VALID_PHASES).toContain('arch-approved');
  });
});

describe('advancePhase — ship operation', () => {
  it('transitions executed → integrated without throwing', async () => {
    const projectRoot = makeTempDir('auto-phase-ship');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = 'backlog.feat.test-story';
    const notePath = path.join(projectRoot, 'notes', `${problemId}.md`);
    fs.writeFileSync(notePath, [
      '---',
      `id: "${problemId}"`,
      'title: "Test Story"',
      'phase: "executed"',
      '---',
      '',
      '# Test Story',
    ].join('\n'));

    const result = await advancePhase(projectRoot, problemId, 'ship', 'test-project');
    expect(result.ok).toBe(true);
    expect(result.to).toBe('integrated');
    expect(result.from).toBe('executed');
  });

  it('does not throw "Invalid phase integrated" error', async () => {
    const projectRoot = makeTempDir('auto-phase-no-invalid');
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = 'backlog.feat.test-story-2';
    const notePath = path.join(projectRoot, 'notes', `${problemId}.md`);
    fs.writeFileSync(notePath, [
      '---',
      `id: "${problemId}"`,
      'title: "Test Story 2"',
      'phase: "executed"',
      '---',
      '',
      '# Test Story 2',
    ].join('\n'));

    const result = await advancePhase(projectRoot, problemId, 'ship', 'test-project');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('R1.3 — resolveOperation helper (R1.3e wired it into advancePhase; R1.3f shrank legacyAcceptedOperations to 3 entries)', () => {
  it('returns v2 op name unchanged when passed a v2 op (passthrough)', () => {
    expect(resolveOperation('exec_start')).toBe('exec_start');
    expect(resolveOperation('exec_end')).toBe('exec_end');
    expect(resolveOperation('commit')).toBe('commit');
    expect(resolveOperation('promote')).toBe('promote');
    expect(resolveOperation('guardrails_off')).toBe('guardrails_off');
    expect(resolveOperation('guardrails_on.commit')).toBe('guardrails_on.commit');
    expect(resolveOperation('guardrails_on.merge')).toBe('guardrails_on.merge');
  });

  it('returns v2 op name unchanged when passed a v1 op that is also a v2 op key (release, qa, arch)', () => {
    // These names exist in OPERATION_TRANSITIONS as v1 ops; resolveOperation
    // returns them unchanged because the v2 lookup succeeds.
    expect(resolveOperation('release')).toBe('release');
    expect(resolveOperation('qa')).toBe('qa');
    expect(resolveOperation('arch')).toBe('arch');
  });

  it('maps v1 legacy ops to v2 equivalents per PHASE_MACHINE.legacyAcceptedOperations', () => {
    // These v1 ops ALSO exist as OPERATION_TRANSITIONS keys (because R1.0-R1.2
    // kept v1 ops alongside v2). So resolveOperation returns them unchanged
    // from the v2 lookup path, NOT the legacy-map path. R1.4 retired cycle_complete
    // entirely — resolveOperation now returns null for it.
    expect(resolveOperation('plan')).toBe('plan');
    expect(resolveOperation('exec')).toBe('exec');
    expect(resolveOperation('ship')).toBe('ship');
    expect(resolveOperation('cycle_complete')).toBeNull();
  });

  it('returns null for an unknown operation name', () => {
    expect(resolveOperation('definitely-not-a-real-operation')).toBeNull();
    expect(resolveOperation('')).toBeNull();
  });

  it('is exported alongside advancePhase and getExpectedTransition', () => {
    expect(typeof resolveOperation).toBe('function');
  });
});
