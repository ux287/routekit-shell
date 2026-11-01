/**
 * backlog.fix.governor-state-allowlist-gaps
 *
 * rks_git_state and rks_publish_profiles are registered, read-only MCP tools that no
 * open/story/qa/ops state admitted, so the runtime chain gate (checkAllowedTool ->
 * checkStateAllowed) refused them with chain_violation from every Governor session
 * outside the ship flow. This spec pins:
 *   - both tools admitted in EVERY state of EVERY flow, at both the pure layer
 *     (checkStateAllowed) and the runtime layer (checkAllowedTool on a real session);
 *   - neither tool ever moves the chain (no transition);
 *   - NEGATIVE CONTROLS: gating is not disabled — tools absent from a state's allowed set
 *     (including the mutating sibling rks_publish) are still refused with chain_violation.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/governor-state-allowlist-gaps.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkStateAllowed,
  getNextState,
  getStates,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import {
  createSession,
  checkAllowedTool,
  endSession,
  setProjectRoot,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const FLOWS = ['story', 'open', 'qa', 'ship', 'ops'];
const READ_ONLY_TOOLS = ['rks_git_state', 'rks_publish_profiles'];
// Mutating tools used as negative controls. Each is refused wherever its state's
// allowed set does not already carry it — the fix must not open these.
const MUTATING_PROBES = ['rks_publish', 'rks_git_commit', 'rks_git_push', 'rks_git_merge', 'rks_exec', 'rks_ship'];

let tmpRoot;
beforeAll(() => {
  // Sessions persist to disk — keep them out of the repository.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-gaps-'));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function newSession(flowType) {
  const args = { projectId: 'allowlist-gaps-test', flowType };
  if (flowType === 'story') args.problemId = 'backlog.fix.allowlist-gaps-probe';
  return createSession(args).token;
}

describe('pure layer: checkStateAllowed admits both read-only tools everywhere', () => {
  for (const flow of FLOWS) {
    it(`${flow}: every state admits rks_git_state and rks_publish_profiles`, () => {
      const states = Object.keys(getStates(flow));
      expect(states.length).toBeGreaterThan(0);
      for (const state of states) {
        for (const tool of READ_ONLY_TOOLS) {
          expect(checkStateAllowed(flow, state, tool).allowed, `${tool} in ${flow}/${state}`).toBe(true);
        }
      }
    });
  }

  it('neither tool moves the chain in any state of any flow', () => {
    for (const flow of FLOWS) {
      for (const state of Object.keys(getStates(flow))) {
        for (const tool of READ_ONLY_TOOLS) {
          expect(getNextState(flow, state, tool), `${tool} from ${flow}/${state}`).toBe(state);
        }
      }
    }
  });
});

describe('runtime layer: checkAllowedTool on a real session', () => {
  for (const flow of FLOWS) {
    it(`${flow} init: both tools return null (admitted), not chain_violation`, () => {
      const token = newSession(flow);
      try {
        for (const tool of READ_ONLY_TOOLS) {
          expect(checkAllowedTool(token, tool), `${tool} in ${flow}/init`).toBeNull();
        }
      } finally {
        endSession(token);
      }
    });
  }

  it('open-flow init admits rks_git_state (the external stdio field report)', () => {
    const token = newSession('open');
    try {
      expect(checkAllowedTool(token, 'rks_git_state')).toBeNull();
    } finally {
      endSession(token);
    }
  });
});

describe('NEGATIVE CONTROL: gating is not disabled', () => {
  it('a tool absent from a state\'s allowed set is still refused (pure layer)', () => {
    let refusals = 0;
    for (const flow of FLOWS) {
      const states = getStates(flow);
      for (const [name, def] of Object.entries(states)) {
        for (const tool of MUTATING_PROBES) {
          if (def.allowed.has(tool)) continue;
          expect(checkStateAllowed(flow, name, tool).allowed, `${tool} must stay refused in ${flow}/${name}`).toBe(false);
          refusals++;
        }
      }
    }
    // The loop must actually exercise refusals, or it proves nothing.
    expect(refusals).toBeGreaterThan(0);
  });

  it('rks_publish (the tool that actually publishes) is refused in every state of every flow', () => {
    for (const flow of FLOWS) {
      for (const state of Object.keys(getStates(flow))) {
        expect(checkStateAllowed(flow, state, 'rks_publish').allowed, `rks_publish in ${flow}/${state}`).toBe(false);
      }
    }
  });

  it('runtime: rks_exec from open init returns chain_violation', () => {
    const token = newSession('open');
    try {
      const res = checkAllowedTool(token, 'rks_exec');
      expect(res).not.toBeNull();
      expect(res.error).toBe('chain_violation');
    } finally {
      endSession(token);
    }
  });

  it('runtime: rks_publish from qa init returns chain_violation', () => {
    const token = newSession('qa');
    try {
      const res = checkAllowedTool(token, 'rks_publish');
      expect(res).not.toBeNull();
      expect(res.error).toBe('chain_violation');
    } finally {
      endSession(token);
    }
  });
});

describe('ship flow: governor-ship.md step 0.5 is unaffected', () => {
  it('ship init still lists rks_git_state in its own allowed set and self-loops on it', () => {
    const ship = getStates('ship');
    expect(ship.init.allowed.has('rks_git_state')).toBe(true);
    expect(getNextState('ship', 'init', 'rks_git_state')).toBe('init');
  });
});
