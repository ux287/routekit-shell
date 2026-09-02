/**
 * block-git-during-off-rail: DISCARD-vs-SHIP intent routing.
 *
 * The completion hook used to route EVERY git-write gesture to rks_guardrails_on (which always
 * ships). That made it impossible to bail out of a bad off-rail build — a `git reset` to discard
 * got hijacked into a ship. This suite pins the split:
 *   - DISCARD gestures (reset / restore / stash / clean / `checkout -- <path>`) → rks_guardrails_abort
 *   - SHIP gestures    (add / commit / push / merge / …)                        → rks_guardrails_on
 *
 * Runs the CANONICAL hook (packages/hooks/system/…) directly, so it verifies routing logic
 * regardless of whether the deployed copy is currently in .routekit/hooks/ or .routekit/hooks.bak/.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../helpers/tmp.mjs';

const CANONICAL_HOOK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/hooks/system/block-git-during-off-rail.mjs'
);

/** Run the canonical hook against a command in an off-rail (hooks.bak present) temp project. */
function runOffRail(command, projectDir) {
  fs.mkdirSync(path.join(projectDir, '.routekit', 'hooks.bak'), { recursive: true });
  const result = spawnSync('node', [CANONICAL_HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    timeout: 15000,
  });
  let output = null;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    output = null;
  }
  const context = output?.hookSpecificOutput?.additionalContext || '';
  return {
    exitCode: result.status,
    decision: output?.hookSpecificOutput?.permissionDecision,
    context,
    // The GOVERNOR ROUTING block emits a line `  agent: <name>` — the authoritative primary route.
    routedAgent: (context.match(/^\s*agent:\s*(\S+)/m) || [])[1] || null,
  };
}

describe('block-git-during-off-rail — discard-vs-ship routing', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTempDir('block-git-routing');
  });

  describe('DISCARD gestures → rks_guardrails_abort', () => {
    it.each([
      ['git reset --hard HEAD', 'reset'],
      ['git restore .', 'restore'],
      ['git stash push -m wip', 'stash'],
      ['git clean -fd', 'clean'],
      ['git checkout -- .', 'destructive checkout'],
    ])('routes %j (%s) to abort', (command) => {
      const r = runOffRail(command, projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.decision).toBe('deny');
      expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_abort');
    });
  });

  describe('SHIP gestures → rks_guardrails_on', () => {
    it.each([
      ['git add .', 'add'],
      ['git commit -m "ship it"', 'commit'],
      ['git push origin staging', 'push'],
      ['git merge feature', 'merge'],
    ])('routes %j (%s) to guardrails_on', (command) => {
      const r = runOffRail(command, projectDir);
      expect(r.exitCode).toBe(0);
      expect(r.decision).toBe('deny');
      expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_on');
    });
  });

  it('a mixed reset+commit gesture is treated as a DISCARD (abort wins)', () => {
    // If both a discard and a ship verb appear, intent is to bail out — route to abort.
    const r = runOffRail('git reset --hard && git commit -m x', projectDir);
    expect(r.routedAgent).toBe('mcp__rks__rks_guardrails_abort');
  });

  it('both completion tools are cross-referenced so the operator can pick the other', () => {
    const discard = runOffRail('git reset --hard HEAD', projectDir);
    expect(discard.context).toContain('rks_guardrails_on'); // "if you meant to ship, use on"
    const ship = runOffRail('git commit -m x', projectDir);
    expect(ship.context).toContain('rks_guardrails_abort'); // "if you meant to discard, use abort"
  });

  it('read-only git is still allowed (no redirect)', () => {
    const r = runOffRail('git status', projectDir);
    expect(r.exitCode).toBe(0);
    expect(r.decision).toBeUndefined();
  });
});
