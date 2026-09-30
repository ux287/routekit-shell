import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkStateAllowed, getNextState, getStates } from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import {
  createSession,
  advanceState,
  assertToolAllowed,
  endSession,
  setProjectRoot,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const states = getStates('open');

// Sessions persist to disk; point them at a temp root so this suite never writes
// into the repository.
let tmpRoot;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'po-chain-'));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Drive a real open-flow session to `researching` (one research call from init). */
function openSessionAt(state) {
  const { token } = createSession({ projectId: 'po-chain-test', flowType: 'open' });
  advanceState(token, 'rks_agent_research'); // init -> researching
  if (state === 'concern-separating') {
    advanceState(token, 'rks_agent_research'); // researching -> concern-separating
  }
  return token;
}

describe('PO Governor open-flow chain — structural state machine', () => {
  // backlog.fix.open-flow-research-note-creation: this test previously asserted
  // `states.researching.allowed.has('dendron_create_note') === false`. Under the
  // ARCH-binding namespace-discriminator mechanism the STATE check must now permit
  // the tool so the namespace layer can adjudicate, so the mechanical assertion
  // necessarily inverts. It is replaced by the BEHAVIOURAL invariant it was
  // protecting — the PO gate itself — which is what actually matters and which
  // survives either mechanism.
  it('PO gate preserved: a backlog.* dendron_create_note is REJECTED from researching', () => {
    const token = openSessionAt('researching');
    try {
      const res = assertToolAllowed(token, 'dendron_create_note', {
        filename: 'backlog.feat.some-story',
      });
      expect(res).not.toBeNull();
      expect(res.ok).toBe(false);
      // The PO must still traverse concern-separating -> test-file-scanning -> writing.
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('PO gate preserved: a backlog.* dendron_create_note is REJECTED from concern-separating', () => {
    const token = openSessionAt('concern-separating');
    try {
      const res = assertToolAllowed(token, 'dendron_create_note', {
        filename: 'backlog.feat.some-story',
      });
      expect(res).not.toBeNull();
      expect(res.ok).toBe(false);
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('research chain unblocked: a research.* create is ALLOWED from researching', () => {
    const token = openSessionAt('researching');
    try {
      const res = assertToolAllowed(token, 'dendron_create_note', {
        filename: 'research.2026.07.31.qa-probe',
      });
      expect(res).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it('writing state allows dendron_create_note', () => {
    expect(states.writing.allowed.has('dendron_create_note')).toBe(true);
  });

  it('concern-separating state exists and allows rks_agent_research', () => {
    expect(states['concern-separating']).toBeDefined();
    expect(states['concern-separating'].allowed.has('rks_agent_research')).toBe(true);
  });

  it('concern-separating transitions to test-file-scanning on rks_agent_research', () => {
    expect(states['concern-separating'].transitions['rks_agent_research']).toBe('test-file-scanning');
  });

  it('test-file-scanning state exists and allows rks_agent_research', () => {
    expect(states['test-file-scanning']).toBeDefined();
    expect(states['test-file-scanning'].allowed.has('rks_agent_research')).toBe(true);
  });

  it('test-file-scanning transitions to writing on rks_agent_research', () => {
    expect(states['test-file-scanning'].transitions['rks_agent_research']).toBe('writing');
  });

  // Also inverted by the same ARCH-binding mechanism, and replaced by the behavioural
  // equivalent: the block now comes from the namespace layer rather than the state
  // machine, but a PO Governor is still refused a story create from `researching`.
  // The two `PO gate preserved` tests above are the named record that this gate exists.
  it('the state check now permits the tool so the namespace layer can adjudicate', () => {
    const result = checkStateAllowed('open', 'researching', 'dendron_create_note');
    expect(result.allowed).toBe(true);

    // ...and the gate is still enforced, one layer up.
    const token = openSessionAt('researching');
    try {
      const blocked = assertToolAllowed(token, 'dendron_create_note', {
        filename: 'backlog.feat.some-story',
      });
      expect(blocked?.ok).toBe(false);
    } finally {
      endSession(token);
    }
  });

  it('full traversal init → researching → concern-separating → test-file-scanning → writing allows dendron_create_note', () => {
    let state = 'init';
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('researching');
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('concern-separating');
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('test-file-scanning');
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('writing');
    expect(checkStateAllowed('open', state, 'dendron_create_note').allowed).toBe(true);
  });

  it('rks_agent_external_research self-loops in concern-separating (does not advance)', () => {
    expect(getNextState('open', 'concern-separating', 'rks_agent_external_research')).toBe('concern-separating');
  });

  it('rks_agent_external_research self-loops in test-file-scanning (does not advance)', () => {
    expect(getNextState('open', 'test-file-scanning', 'rks_agent_external_research')).toBe('test-file-scanning');
  });
});
