import { describe, it, expect } from 'vitest';
import {
  checkStateAllowed,
  getNextState,
  transitionOnResult,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';

describe('governor-state: diverged state', () => {
  const flow = 'story';

  // --- resultTransitions from executing ---

  it('executing → exec.diverged transitions to diverged', () => {
    const next = transitionOnResult(flow, 'executing', 'exec.diverged');
    expect(next).toBe('diverged');
  });

  it('executing → exec.ok still transitions to executed (non-regression)', () => {
    const next = transitionOnResult(flow, 'executing', 'exec.ok');
    expect(next).toBe('executed');
  });

  it('executing → exec.failed still transitions to test-failed (non-regression)', () => {
    const next = transitionOnResult(flow, 'executing', 'exec.failed');
    expect(next).toBe('test-failed');
  });

  // --- diverged state: allowed tools ---

  it('diverged state allows rks_refine', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_refine');
    expect(result.allowed).toBe(true);
  });

  it('diverged state allows rks_refine_apply', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_refine_apply');
    expect(result.allowed).toBe(true);
  });

  it('diverged state allows rks_agent_research', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_agent_research');
    expect(result.allowed).toBe(true);
  });

  it('diverged state allows rks_agent_external_research', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_agent_external_research');
    expect(result.allowed).toBe(true);
  });

  it('diverged state allows rks_agent_git', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_agent_git');
    expect(result.allowed).toBe(true);
  });

  it('diverged state allows rks_project_get', () => {
    const result = checkStateAllowed(flow, 'diverged', 'rks_project_get');
    expect(result.allowed).toBe(true);
  });

  // --- diverged state: transitions ---

  it('diverged → rks_refine transitions to refining', () => {
    const next = getNextState(flow, 'diverged', 'rks_refine');
    expect(next).toBe('refining');
  });

  it('diverged → rks_refine_apply transitions to refining', () => {
    const next = getNextState(flow, 'diverged', 'rks_refine_apply');
    expect(next).toBe('refining');
  });

  // --- diverged state matches test-failed shape ---

  it('diverged state has same allowed tools as test-failed', () => {
    // Both states should allow the same refine tools
    const divergedTools = ['rks_refine', 'rks_refine_apply', 'rks_agent_research', 'rks_agent_external_research', 'rks_agent_git', 'rks_project_get'];
    for (const tool of divergedTools) {
      const divergedResult = checkStateAllowed(flow, 'diverged', tool);
      const testFailedResult = checkStateAllowed(flow, 'test-failed', tool);
      expect(divergedResult.allowed, `diverged: ${tool}`).toBe(true);
      expect(testFailedResult.allowed, `test-failed: ${tool}`).toBe(true);
    }
  });

  it('diverged state has same transitions as test-failed', () => {
    const tools = ['rks_refine', 'rks_refine_apply', 'rks_agent_research', 'rks_agent_external_research'];
    for (const tool of tools) {
      const divergedNext = getNextState(flow, 'diverged', tool);
      const testFailedNext = getNextState(flow, 'test-failed', tool);
      expect(divergedNext, `diverged → ${tool}`).toBe(testFailedNext);
    }
  });
});
