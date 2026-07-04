import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

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
