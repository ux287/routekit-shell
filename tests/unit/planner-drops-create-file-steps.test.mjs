import { describe, it, expect } from 'vitest';
import { shouldEarlyExitToSteps } from '../../packages/mcp-rks/src/server/planner.mjs';

// backlog.fix.planner-drops-create-file-steps
// The planner's deterministic early-exit emits ONLY search_replace steps. Taking it while
// op:create targets are uncovered silently DROPS the creates (the calculator failure:
// package.json edit + 3 op:create targets → plan shipped only the 2 package.json edits).
// The gate must refuse the bypass whenever uncovered op:create targets exist.

describe('shouldEarlyExitToSteps — op:create-aware early-exit gate', () => {
  it('bypasses the LLM for a pure-edit story (all op:edit covered, zero creates)', () => {
    expect(shouldEarlyExitToSteps(true, 2, 0)).toBe(true);
  });

  it('does NOT bypass when op:create targets are uncovered (the drop case)', () => {
    // 1 edit step covered, but 3 op:create targets uncovered → must fall through to LLM planning
    expect(shouldEarlyExitToSteps(true, 1, 3)).toBe(false);
  });

  it('does NOT bypass when not every op:edit target has @@SEARCH blocks', () => {
    expect(shouldEarlyExitToSteps(false, 1, 0)).toBe(false);
  });

  it('does NOT bypass when there are zero early-exit steps', () => {
    expect(shouldEarlyExitToSteps(true, 0, 0)).toBe(false);
  });

  it('calculator shape (1 edit covered, 3 uncovered creates) is NOT an early-exit', () => {
    expect(shouldEarlyExitToSteps(true, 1, 3)).toBe(false);
  });
});
