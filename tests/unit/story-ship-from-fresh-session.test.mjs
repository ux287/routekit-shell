// backlog.fix.story-ship-unreachable-from-fresh-session
// A NEW story-flow session for a story whose note reads phase executed starts at chain state
// executed, so rks_story_ship is reachable without the session that ran rks_exec.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  setProjectRoot,
  resetToken,
  assertToolAllowed,
  checkAllowedTool,
  getSession,
  createSession,
  advanceState,
  advanceStateOnResult,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import { classifyChainRefusal } from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import { handleGovernorInit } from '../../packages/mcp-rks/src/tools/governor-init.mjs';

const PID = 'backlog.fix.fresh-ship-fixture';
let root;

function writeNote(body) {
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', `${PID}.md`), body);
}
function withPhase(phase) {
  writeNote(`---\nid: "${PID}"\nphase: "${phase}"\n---\n\n## Problem\n`);
}
function init(extra = {}) {
  return handleGovernorInit({ projectId: 'p', problemId: PID, ...extra });
}
function freshToken() {
  const res = init();
  expect(res.ok).toBe(true);
  expect(res.mode).toBe('new');
  return res;
}
function expectRefused(token, tool) {
  const r = assertToolAllowed(token, tool);
  expect(r?.ok, tool).toBe(false);
  expect(r?.error, tool).toBe('chain_violation');
  // The wire gate (server.mjs calls checkAllowedTool, state only) must refuse too; assertToolAllowed
  // alone refuses rks_story_ship in every story session through STORY_FLOW_TOOLS, so it is vacuous.
  const w = checkAllowedTool(token, tool);
  expect(w?.ok, tool).toBe(false);
  expect(w?.error, tool).toBe('chain_violation');
}

beforeEach(() => {
  resetToken();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-ship-'));
  setProjectRoot(root);
});
afterEach(() => {
  resetToken();
  setProjectRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a fresh story session for an executed story is seeded and can ship', () => {
  it('starts at executed and admits rks_story_ship with no live exec session', () => {
    withPhase('executed');
    const res = freshToken();
    expect(res.state).toBe('executed');
    expect(getSession(res.token).state).toBe('executed');
    // The wire gate: server.mjs dispatches every token-bearing call through checkAllowedTool.
    // assertToolAllowed is not on the wire and its STORY_FLOW_TOOLS allowlist omits rks_story_ship.
    expect(checkAllowedTool(res.token, 'rks_story_ship')).toBeNull();
  });

  it('reports the observed phase it relied on (evidence-bound)', () => {
    withPhase('executed');
    const res = freshToken();
    expect(res.seededFrom).toEqual({ phase: 'executed', chainState: 'executed' });
  });

  it('does not open a write path', () => {
    withPhase('executed');
    const { token } = freshToken();
    for (const tool of [
      'rks_exec', 'rks_plan', 'rks_plan_review', 'rks_refine', 'rks_refine_apply',
      'dendron_create_note', 'dendron_edit_note', 'dendron_update_field',
    ]) {
      expectRefused(token, tool);
    }
  });
});

describe('every other phase is refused exactly as today', () => {
  for (const phase of ['ready', 'arch-approved', 'planned', 'executing']) {
    it(`starts at init and refuses rks_story_ship at phase ${phase}`, () => {
      withPhase(phase);
      const res = freshToken();
      expect(res.state).toBe('init');
      expect(res.seededFrom).toBeUndefined();
      expectRefused(res.token, 'rks_story_ship');
    });
  }
});

describe('fails closed when the phase cannot be observed', () => {
  it('missing note: starts at init and refuses rks_story_ship', () => {
    const res = freshToken();
    expect(res.state).toBe('init');
    expect(res.seededFrom).toBeUndefined();
    expectRefused(res.token, 'rks_story_ship');
  });
  it('unparseable frontmatter: starts at init and refuses rks_story_ship', () => {
    writeNote('---\nphase: "unclosed\nid: [oops\n---\nbody\n');
    const res = freshToken();
    expect(res.state).toBe('init');
    expect(res.seededFrom).toBeUndefined();
    expectRefused(res.token, 'rks_story_ship');
  });
});

describe('the seed is limited to a new, non-reset story-flow session', () => {
  it('open flow (no problemId) is not seeded even when an executed note exists', () => {
    withPhase('executed');
    const res = handleGovernorInit({ projectId: 'p' });
    expect(res.flowType).toBe('open');
    expect(res.state).toBe('init');
    expect(res.seededFrom).toBeUndefined();
    expectRefused(res.token, 'rks_story_ship');
  });

  it('explicit flowType qa with a problemId on an executed note is not seeded', () => {
    withPhase('executed');
    const res = init({ flowType: 'qa' });
    expect(res.ok).toBe(true);
    expect(res.flowType).toBe('qa');
    expect(res.state).toBe('init');
    expect(res.seededFrom).toBeUndefined();
  });

  it('reset: true on an executed note starts at init and admits rks_refine', () => {
    withPhase('executed');
    const res = init({ reset: true });
    expect(res.ok).toBe(true);
    expect(res.state).toBe('init');
    expect(res.seededFrom).toBeUndefined();
    expect(assertToolAllowed(res.token, 'rks_refine')).toBeNull();
  });

  it('reset: true over a live seeded session mints a new token at init', () => {
    withPhase('executed');
    const a = freshToken();
    expect(a.state).toBe('executed');
    const b = init({ reset: true });
    expect(b.mode).toBe('reset');
    expect(b.token).not.toBe(a.token);
    expect(b.state).toBe('init');
    expect(b.seededFrom).toBeUndefined();
    expect(assertToolAllowed(b.token, 'rks_refine')).toBeNull();
  });

  it('a live session is resumed at its current state, not re-seeded', () => {
    withPhase('ready');
    const a = freshToken();
    expect(a.state).toBe('init');
    withPhase('executed');
    const b = init();
    expect(b.mode).toBe('resumed');
    expect(b.token).toBe(a.token);
    expect(b.state).toBe('init');
    expect(b.seededFrom).toBeUndefined();
  });

  it('a live seeded session re-entered without reset resumes at executed', () => {
    withPhase('executed');
    const a = freshToken();
    const b = init();
    expect(b.mode).toBe('resumed');
    expect(b.token).toBe(a.token);
    expect(b.state).toBe('executed');
  });
});

describe('stale_reset starts at init (no seed)', () => {
  it('a planned session whose note now reads executed is ended and the NEW session starts at init', () => {
    withPhase('executing');
    const a = freshToken();
    expect(a.state).toBe('init');
    getSession(a.token).state = 'refining';
    expect(advanceState(a.token, 'rks_plan').newState).toBe('planning');
    expect(advanceStateOnResult(a.token, 'plan.ok').newState).toBe('planned');
    withPhase('executed');
    const b = init();
    expect(b.ok).toBe(true);
    expect(b.mode).toBe('stale_reset');
    expect(b.reason).toBe('chain_phase_mismatch');
    expect(b.token).not.toBe(a.token);
    expect(b.state).toBe('init');
    expect(b.seededFrom).toBeUndefined();
    expect(b.message).not.toContain('started at chain state');
    expectRefused(b.token, 'rks_story_ship');
  });
});

describe('createSession initialState', () => {
  it('is honoured only when it names a state of the flow', () => {
    expect(createSession({ projectId: 'p', problemId: PID, initialState: 'executed' }).session.state).toBe('executed');
    expect(createSession({ projectId: 'p', problemId: PID, initialState: 'no-such-state' }).session.state).toBe('init');
    expect(createSession({ projectId: 'p', problemId: PID }).session.state).toBe('init');
  });
});

describe('state-only refusal recovery names rks_exec_abort only when the state admits it', () => {
  it('story init (does not admit rks_exec_abort): no rks_exec_abort in recovery', () => {
    const res = classifyChainRefusal({ flowType: 'story', chainState: 'init', tool: 'rks_story_ship' });
    expect(res.blockedBy).toBe('state');
    expect(res.recovery.join(' ')).not.toContain('rks_exec_abort');
  });
  it('story executing (admits rks_exec_abort): recovery still names rks_exec_abort', () => {
    const res = classifyChainRefusal({ flowType: 'story', chainState: 'executing', tool: 'rks_plan' });
    expect(res.blockedBy).toBe('state');
    expect(res.recovery.join(' ')).toContain('rks_exec_abort');
  });
});
