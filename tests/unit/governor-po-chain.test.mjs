import { describe, it, expect } from 'vitest';
import { checkStateAllowed, getNextState, getStates } from '../../packages/mcp-rks/src/shared/governor-state.mjs';

const states = getStates('open');

describe('PO Governor open-flow chain — structural state machine', () => {
  it('researching state does NOT allow dendron_create_note', () => {
    expect(states.researching.allowed.has('dendron_create_note')).toBe(false);
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

  it('calling dendron_create_note in researching state is blocked (chain_violation)', () => {
    const result = checkStateAllowed('open', 'researching', 'dendron_create_note');
    expect(result.allowed).toBe(false);
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
