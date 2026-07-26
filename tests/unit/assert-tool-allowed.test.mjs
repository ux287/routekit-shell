import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setProjectRoot,
  generateToken,
  createSession,
  getSession,
  endSession,
  resetToken,
  assertToolAllowed,
  COMMON_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  OPS_FLOW_TOOLS,
  UNPROTECTED_TOOLS,
  isProtectedTool,
  checkAllowedTool,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import { getTelemetryCollector } from '../../packages/mcp-rks/src/server/telemetry/index.mjs';

describe('assertToolAllowed', () => {
  beforeEach(() => {
    resetToken();
  });

  afterEach(() => {
    resetToken();
  });

  // ─── Test 1: COMMON_TOOLS bypass without token ───────────────────
  describe('COMMON_TOOLS bypass', () => {
    it('returns null for COMMON_TOOLS even without a token', () => {
      const commonTool = Array.from(COMMON_TOOLS)[0]; // Pick first common tool
      const result = assertToolAllowed(null, commonTool);
      expect(result).toBeNull();
    });

    it('returns null for COMMON_TOOLS even with invalid token', () => {
      const commonTool = Array.from(COMMON_TOOLS)[0];
      const result = assertToolAllowed('invalid-token', commonTool);
      expect(result).toBeNull();
    });

    it('returns null for COMMON_TOOLS with valid token', () => {
      const commonTool = Array.from(COMMON_TOOLS)[0];
      const { token } = createSession({ projectId: 'proj-1' });
      const result = assertToolAllowed(token, commonTool);
      expect(result).toBeNull();
    });
  });

  // ─── Test 2: Missing/invalid token on protected tools ────────────
  describe('Token validation for protected tools', () => {
    it('returns error for protected tool without token', () => {
      const protectedTool = 'rks_refine';
      const result = assertToolAllowed(null, protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
      expect(result.tool).toBe(protectedTool);
    });

    it('returns error for protected tool with empty string token', () => {
      const protectedTool = 'rks_refine';
      const result = assertToolAllowed('', protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
    });

    it('returns error for protected tool with non-existent token', () => {
      const protectedTool = 'rks_refine';
      const result = assertToolAllowed('nonexistent-token', protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
    });
  });

  // ─── Test 3: Flow-type allowlist enforcement ─────────────────────
  describe('Flow-type allowlist enforcement', () => {
    it('allows STORY_FLOW_TOOLS in story flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const storyTool = 'rks_refine'; // Known to be in STORY_FLOW_TOOLS
      const result = assertToolAllowed(token, storyTool);
      expect(result).toBeNull();
    });

    it('returns error for STORY_FLOW_TOOLS in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' }); // No problemId → open flow
      const storyTool = 'rks_plan'; // Known to be story-only
      const result = assertToolAllowed(token, storyTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
      expect(result.flowType).toBe('open');
      expect(result.tool).toBe(storyTool);
    });

    it('allows OPEN_FLOW_TOOLS in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' }); // No problemId → open flow
      const openTool = 'rks_agent_research'; // Known to be in OPEN_FLOW_TOOLS
      const result = assertToolAllowed(token, openTool);
      expect(result).toBeNull();
    });

    it('allows OPEN_FLOW_TOOLS in story flow (subset)', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const openTool = 'rks_agent_research'; // Also in STORY_FLOW_TOOLS
      const result = assertToolAllowed(token, openTool);
      expect(result).toBeNull();
    });
  });

  // ─── Test 4: State machine permission checks ─────────────────────
  describe('State machine permission checks', () => {
    it('allows tool valid for current state in story flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      // In 'init' state, rks_refine should be allowed
      const result = assertToolAllowed(token, 'rks_refine');
      expect(result).toBeNull();
    });

    it('rejects tool not valid for current state', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      // In 'init' state, rks_exec should not be allowed (wrong state)
      const result = assertToolAllowed(token, 'rks_exec');
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
      expect(result.state).toBe('init');
    });
  });

  // ─── Test 5: sessionType population and accessibility ────────────
  describe('sessionType population', () => {
    it('populates sessionType as "story" when problemId is provided', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      expect(session).not.toBeNull();
      expect(session.sessionType).toBe('story');
      expect(session.flowType).toBe('story');
    });

    it('populates sessionType as "open" when problemId is not provided', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const session = getSession(token);
      expect(session).not.toBeNull();
      expect(session.sessionType).toBe('open');
      expect(session.flowType).toBe('open');
    });

    it('sessionType matches flowType for story flow', () => {
      const { token, flowType } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      expect(session.sessionType).toBe(flowType);
      expect(session.sessionType).toBe('story');
    });

    it('sessionType matches flowType for open flow', () => {
      const { token, flowType } = createSession({ projectId: 'proj-1' });
      const session = getSession(token);
      expect(session.sessionType).toBe(flowType);
      expect(session.sessionType).toBe('open');
    });
  });

  // ─── Test 6: Error response structure ──────────────────────────────
  describe('Error response structure', () => {
    it('includes tool name in unauthorized error', () => {
      const result = assertToolAllowed(null, 'rks_refine');
      expect(result.tool).toBe('rks_refine');
    });

    it('includes flowType and state in chain_violation error', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const result = assertToolAllowed(token, 'rks_exec'); // Not allowed in init state
      expect(result.flowType).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.flowType).toBe('story');
      expect(result.state).toBe('init');
    });

    it('includes descriptive message in error', () => {
      const result = assertToolAllowed(null, 'rks_refine');
      expect(result.message).toBeDefined();
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  // ─── Test 7: Integration scenarios ────────────────────────────────
  describe('Integration scenarios', () => {
    it('allows dendron tools in story flow (refining state)', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      // Advance to refining state where dendron tools are allowed
      assertToolAllowed(token, 'rks_refine');
      const session = getSession(token);
      // Manually set state to refining since assertToolAllowed doesn't advance state
      session.state = 'refining';
      const dendronTools = ['dendron_create_note', 'dendron_edit_note', 'dendron_read_note'];
      for (const tool of dendronTools) {
        const result = assertToolAllowed(token, tool);
        expect(result).toBeNull();
      }
    });

    it('allows dendron tools in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const dendronTools = ['dendron_create_note', 'dendron_edit_note', 'dendron_read_note'];
      for (const tool of dendronTools) {
        const result = assertToolAllowed(token, tool);
        expect(result).toBeNull();
      }
    });

    it('completely rejects unknown tool in any flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const unknownTool = 'rks_unknown_tool_xyz';
      const result = assertToolAllowed(token, unknownTool);
      expect(result).not.toBeNull();
      expect(result.error).toBe('chain_violation');
    });
  });

  // ─── Test 8: restrict-ship — rks_ship blocked for Build Governors ──
  describe('restrict-ship', () => {
    it('rks_ship is not in COMMON_TOOLS', () => {
      expect(COMMON_TOOLS.has('rks_ship')).toBe(false);
    });

    it('rks_ship is not in STORY_FLOW_TOOLS', () => {
      expect(STORY_FLOW_TOOLS.has('rks_ship')).toBe(false);
    });

    it('rks_ship is in UNPROTECTED_TOOLS (Ship Governor one-shot)', () => {
      expect(UNPROTECTED_TOOLS.has('rks_ship')).toBe(true);
    });

    it('Build Governor (story flow) is blocked from calling rks_ship', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const result = assertToolAllowed(token, 'rks_ship');
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
      expect(result.flowType).toBe('story');
    });

    it('Open flow is also blocked from calling rks_ship', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const result = assertToolAllowed(token, 'rks_ship');
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
    });
  });

  // ─── Test 9: Dendron namespace guards ──────────────────────────────
  describe('Dendron namespace guards', () => {
    it('story flow rejects dendron_create_note for research.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_create_note', { filename: 'research.topic.foo' });
      expect(result).not.toBeNull();
      expect(result.error).toBe('namespace_violation');
      expect(result.message).toContain('research');
      expect(result.message).toContain('backlog');
    });

    it('story flow allows dendron_update_field for backlog.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_update_field', { filename: 'backlog.feat.my-story', field: 'phase', value: 'planned' });
      expect(result).toBeNull();
    });

    it('open flow allows all namespaces', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const namespaces = ['backlog.feat.test', 'research.topic', 'how-to.guide', 'notes.random', 'design.arch'];
      for (const filename of namespaces) {
        const result = assertToolAllowed(token, 'dendron_create_note', { filename });
        expect(result).toBeNull();
      }
    });

    it('story flow rejects how-to.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_edit_note', { filename: 'how-to.some-guide' });
      expect(result).not.toBeNull();
      expect(result.error).toBe('namespace_violation');
    });

    it('namespace check skipped when no args provided', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_create_note');
      expect(result).toBeNull();
    });
  });

  // ─── Test 10: Proto-story guard ────────────────────────────────────
  describe('Proto-story guard', () => {
    it('story flow blocked from setting phase to ready', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_update_field', {
        filename: 'backlog.feat.my-story',
        field: 'phase',
        value: 'ready',
      });
      expect(result).not.toBeNull();
      expect(result.error).toBe('proto_story_guard');
      expect(result.message).toContain('PO');
    });

    it('open flow (PO) can set phase to ready', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const session = getSession(token);
      session.state = 'writing'; // dendron_update_field requires writing state
      const result = assertToolAllowed(token, 'dendron_update_field', {
        filename: 'backlog.feat.my-story',
        field: 'phase',
        value: 'ready',
      });
      expect(result).toBeNull();
    });

    it('story flow can set phase to planned (not restricted)', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_update_field', {
        filename: 'backlog.feat.my-story',
        field: 'phase',
        value: 'planned',
      });
      expect(result).toBeNull();
    });

    it('story flow can set phase to executed (not restricted)', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = assertToolAllowed(token, 'dendron_update_field', {
        filename: 'backlog.feat.my-story',
        field: 'phase',
        value: 'executed',
      });
      expect(result).toBeNull();
    });
  });

  // ─── Test 11: chain-gate reachability — exhaustive_search + recovery ──
  describe('chain-gate reachability (Tier-1 allowlists)', () => {
    it('rks_exhaustive_search (read-only) is in STORY, OPEN, and OPS flow allowlists', () => {
      expect(STORY_FLOW_TOOLS.has('rks_exhaustive_search')).toBe(true);
      expect(OPEN_FLOW_TOOLS.has('rks_exhaustive_search')).toBe(true);
      expect(OPS_FLOW_TOOLS.has('rks_exhaustive_search')).toBe(true);
    });

    it('rks_agent_recovery (mutating) is in OPEN + OPS allowlists but NOT STORY', () => {
      expect(OPEN_FLOW_TOOLS.has('rks_agent_recovery')).toBe(true);
      expect(OPS_FLOW_TOOLS.has('rks_agent_recovery')).toBe(true);
      expect(STORY_FLOW_TOOLS.has('rks_agent_recovery')).toBe(false);
    });

    it('open-flow init permits rks_exhaustive_search — no chain_violation', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      expect(assertToolAllowed(token, 'rks_exhaustive_search')).toBeNull();
    });

    it('open-flow init permits rks_agent_recovery — the sanctioned recovery entry', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      expect(assertToolAllowed(token, 'rks_agent_recovery')).toBeNull();
    });
  });

  // ─── Test 12: onboarding/setup tools ungated (backlog.feat.ungate-onboarding-setup-tools) ──
  // rks_onboarder + rks_templates_list were in a DEAD ZONE: rejected on direct call (auth gate)
  // AND chain_violation in every flow (chain gate has only a COMMON_TOOLS bypass). Fix adds them
  // to BOTH UNPROTECTED_TOOLS and COMMON_TOOLS so /rks-onboard + template discovery actually work.
  describe('onboarding/setup tools reachable', () => {
    const setupTools = ['rks_onboarder', 'rks_templates_list'];

    it('are in UNPROTECTED_TOOLS (auth-gate exempt)', () => {
      for (const t of setupTools) expect(UNPROTECTED_TOOLS.has(t)).toBe(true);
    });

    it('are in COMMON_TOOLS (chain-gate bypass, allowed in any flow/state)', () => {
      for (const t of setupTools) expect(COMMON_TOOLS.has(t)).toBe(true);
    });

    it('callable directly with NO token — no unauthorized (the dead-zone fix)', () => {
      for (const t of setupTools) expect(assertToolAllowed(null, t)).toBeNull();
    });

    it('callable inside an active session in any flow init state — no chain_violation', () => {
      const open = createSession({ projectId: 'proj-1' });
      for (const t of setupTools) expect(assertToolAllowed(open.token, t)).toBeNull();
      resetToken();
      const story = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      for (const t of setupTools) expect(assertToolAllowed(story.token, t)).toBeNull();
    });

    it('does NOT weaken auth — workflow tools stay protected + gated', () => {
      for (const t of ['rks_plan', 'rks_exec', 'rks_refine']) {
        expect(UNPROTECTED_TOOLS.has(t)).toBe(false);
        expect(COMMON_TOOLS.has(t)).toBe(false);
        expect(assertToolAllowed(null, t)?.error).toBe('unauthorized');
      }
    });

    it('rks_project_init stays PROTECTED (deferred — needs attached-project context)', () => {
      expect(UNPROTECTED_TOOLS.has('rks_project_init')).toBe(false);
      expect(COMMON_TOOLS.has('rks_project_init')).toBe(false);
    });
  });
});

// backlog.fix.telemetry-export-unprotected-classification — regression witness.
// rks_telemetry_export shipped (v0.20.32) registered but UNINVOCABLE: it was PROTECTED
// (absent from UNPROTECTED_TOOLS) yet whitelisted in no governor flow-state, so both the
// token gate and the chain gate rejected it (unauthorized without a token; chain_violation
// with one). The /telemetry-export skill calls it directly (no governor), exactly like
// /telemetry calls query/report — so it MUST be unprotected. The server skips the auth +
// chain gates precisely when isProtectedTool(tool) === false.
describe('rks_telemetry_export — unprotected classification (callable like query/report)', () => {
  it('is in UNPROTECTED_TOOLS and isProtectedTool() returns false', () => {
    expect(UNPROTECTED_TOOLS.has('rks_telemetry_export')).toBe(true);
    expect(isProtectedTool('rks_telemetry_export')).toBe(false);
  });

  it('shares the unprotected classification of the sibling telemetry reads', () => {
    for (const t of ['rks_telemetry_query', 'rks_telemetry_report', 'rks_telemetry_export']) {
      expect(isProtectedTool(t)).toBe(false);
    }
  });
});

// backlog.feat.chain-violation-telemetry-server-slice — server-side chain.violation emit.
// getTelemetryCollector is globally mocked (tests/setup.mjs); its emit is a stable vi.fn.
describe('chain.violation telemetry emit (best-effort, canonical, non-blocking)', () => {
  let emitSpy;
  beforeEach(() => {
    resetToken();
    // Spy on whatever collector getTelemetryCollector() returns (global mock or real
    // singleton). governor-token.mjs imports the same getTelemetryCollector and thus the same
    // instance, so this spy captures its emit calls. No-op impl avoids real side effects.
    emitSpy = vi.spyOn(getTelemetryCollector(), 'emit').mockImplementation(() => {});
  });
  afterEach(() => {
    emitSpy.mockRestore();
  });

  it('assertToolAllowed flow-allowlist miss emits chain.violation AND still returns the rejection', () => {
    const { token } = createSession({ projectId: 'proj-1' }); // open flow
    const result = assertToolAllowed(token, 'rks_exec'); // not in the open-flow allowlist
    expect(result.error).toBe('chain_violation');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call).toBeDefined();
    expect(call[2].blockedTool).toBe('rks_exec');
    expect(call[2].flowType).toBe('open');
    expect(Array.isArray(call[2].expectedTools)).toBe(true);
    expect(call[2].violationKind).toBe('flow_allowlist');
  });

  it('assertToolAllowed rejection payload carries flow/state/message', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' }); // story flow, init
    const result = assertToolAllowed(token, 'rks_exec');
    expect(result.error).toBe('chain_violation');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call).toBeDefined();
    expect(call[2].state).toBeDefined();
    expect(['state_machine', 'flow_allowlist']).toContain(call[2].violationKind);
    expect(typeof call[2].message === 'string' || call[2].message === null).toBe(true);
  });

  it('checkAllowedTool state rejection emits chain.violation with violationKind state_machine', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
    const result = checkAllowedTool(token, 'rks_exec'); // in story flow but not the init state
    expect(result?.error).toBe('chain_violation');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call).toBeDefined();
    expect(call[2].violationKind).toBe('state_machine');
    expect(call[2].blockedTool).toBe('rks_exec');
  });

  it('canonical shape: emit called as (type, projectId, payload)', () => {
    const { token } = createSession({ projectId: 'proj-XYZ' });
    assertToolAllowed(token, 'rks_exec');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call[0]).toBe('chain.violation');
    expect(call[1]).toBe('proj-XYZ'); // projectId in the 2nd positional arg
    expect(typeof call[2]).toBe('object');
  });

  it('NON-BLOCKING: a throwing collector.emit neither throws nor alters the chain_violation return', () => {
    const { token } = createSession({ projectId: 'proj-1' });
    emitSpy.mockImplementationOnce(() => {
      throw new Error('telemetry boom');
    });
    let result;
    expect(() => {
      result = assertToolAllowed(token, 'rks_exec');
    }).not.toThrow();
    expect(result.error).toBe('chain_violation');
    expect(result.tool).toBe('rks_exec');
  });

  it('allowed calls do NOT emit chain.violation (rejection-path only)', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
    assertToolAllowed(token, 'rks_refine'); // allowed in story/init
    expect(emitSpy.mock.calls.find((c) => c[0] === 'chain.violation')).toBeUndefined();
  });
});

// backlog.fix.fetch-raw-uninvocable-research-gov — regression witness.
// rks_fetch_raw shipped (v0.20.33) registered + PROTECTED (network egress) but UNINVOCABLE:
// it was in NO governor flow allowlist, so every reachable state chain_violated it (concourse
// found it dead at open/init, open/researching, ops/init, story/init). The fix is OPEN-FLOW
// PARITY with rks_agent_external_research (its research-toolbox sibling): OPEN_FLOW_TOOLS +
// all five open-flow states where external_research is allowed — NOT story/ops flows.
describe('rks_fetch_raw — open-flow parity with external_research (research-gov toolbox)', () => {
  it('STAYS PROTECTED (network egress must keep the token + chain gates)', () => {
    expect(isProtectedTool('rks_fetch_raw')).toBe(true);
    expect(UNPROTECTED_TOOLS.has('rks_fetch_raw')).toBe(false);
    expect(COMMON_TOOLS.has('rks_fetch_raw')).toBe(false);
  });

  it('is in OPEN_FLOW_TOOLS ONLY — story/ops flows intentionally excluded', () => {
    // NOTE: external_research is broader (story + ops too); fetch_raw is deliberately
    // open-flow-only per the human decision. Parity is at the STATE layer WITHIN open flow
    // (see governor-state.test.mjs), NOT the flow layer.
    expect(OPEN_FLOW_TOOLS.has('rks_fetch_raw')).toBe(true);
    expect(STORY_FLOW_TOOLS.has('rks_fetch_raw')).toBe(false);
    expect(OPS_FLOW_TOOLS.has('rks_fetch_raw')).toBe(false);
  });

  it('open-flow init: reachable with a valid token — no unauthorized, no chain_violation', () => {
    const { token } = createSession({ projectId: 'proj-1' }); // open flow, init state
    expect(assertToolAllowed(token, 'rks_fetch_raw')).toBeNull();
  });

  it('still gated: NO token → unauthorized (protection intact)', () => {
    expect(assertToolAllowed(null, 'rks_fetch_raw')?.error).toBe('unauthorized');
  });

  it('story flow rejects it (out of scope by design) — chain_violation, not silent allow', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
    expect(assertToolAllowed(token, 'rks_fetch_raw')?.error).toBe('chain_violation');
  });
});
