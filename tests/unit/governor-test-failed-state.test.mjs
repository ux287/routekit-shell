import { describe, it, expect } from 'vitest';
import {
  checkStateAllowed,
  getNextState,
  transitionOnResult,
  isTerminal,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';

describe('test-failed state', () => {
  // ── Transition into test-failed ──────────────────────────────────

  it('exec.failed transitions from executing to test-failed', () => {
    const next = transitionOnResult('story', 'executing', 'exec.failed');
    expect(next).toBe('test-failed');
  });

  // ── Allowed tools ────────────────────────────────────────────────

  it('allows rks_refine', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_refine');
    expect(result.allowed).toBe(true);
  });

  it('allows rks_refine_apply', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_refine_apply');
    expect(result.allowed).toBe(true);
  });

  it('allows rks_agent_research', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_agent_research');
    expect(result.allowed).toBe(true);
  });

  it('allows rks_agent_external_research', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_agent_external_research');
    expect(result.allowed).toBe(true);
  });

  it('allows rks_agent_git', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_agent_git');
    expect(result.allowed).toBe(true);
  });

  it('allows rks_project_get', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_project_get');
    expect(result.allowed).toBe(true);
  });

  // ── Blocked tools ────────────────────────────────────────────────

  it('blocks rks_exec (must refine first)', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_exec');
    expect(result.allowed).toBe(false);
  });

  it('blocks rks_plan (must refine first)', () => {
    const result = checkStateAllowed('story', 'test-failed', 'rks_plan');
    expect(result.allowed).toBe(false);
  });

  // ── Transitions out of test-failed ───────────────────────────────

  it('rks_refine transitions to refining', () => {
    const next = getNextState('story', 'test-failed', 'rks_refine');
    expect(next).toBe('refining');
  });

  it('rks_refine_apply transitions to refining', () => {
    const next = getNextState('story', 'test-failed', 'rks_refine_apply');
    expect(next).toBe('refining');
  });

  it('rks_agent_research transitions to refining', () => {
    const next = getNextState('story', 'test-failed', 'rks_agent_research');
    expect(next).toBe('refining');
  });

  // ── Non-terminal ─────────────────────────────────────────────────

  it('is not a terminal state', () => {
    expect(isTerminal('story', 'test-failed')).toBe(false);
  });

  // ── Regression: other states unchanged ───────────────────────────

  it('planned state still transitions to executing on rks_exec', () => {
    const next = getNextState('story', 'planned', 'rks_exec');
    expect(next).toBe('executing');
  });

  it('exec.ok still transitions to executed', () => {
    const next = transitionOnResult('story', 'executing', 'exec.ok');
    expect(next).toBe('executed');
  });

  it('plan.failed still transitions to refining', () => {
    const next = transitionOnResult('story', 'planning', 'plan.failed');
    expect(next).toBe('refining');
  });
});
