import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setProjectRoot,
  generateToken,
  createSession,
  getSession,
  endSession,
  resetToken,
  COMMON_TOOLS,
  STORY_FLOW_TOOLS,
  OPEN_FLOW_TOOLS,
  OPS_FLOW_TOOLS,
  UNPROTECTED_TOOLS,
  isProtectedTool,
  checkAllowedTool,
  requireToken,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import { getTelemetryCollector } from '@routekit/telemetry';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// backlog.feat.assert-tool-allowed-wire-or-delete: this suite formerly exercised the uncalled
// second admission function; every case now runs through checkAllowedTool, the live gate.
describe('checkAllowedTool admission', () => {
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
      const result = checkAllowedTool(null, commonTool);
      expect(result).toBeNull();
    });

    it('returns null for COMMON_TOOLS even with invalid token', () => {
      const commonTool = Array.from(COMMON_TOOLS)[0];
      const result = checkAllowedTool('invalid-token', commonTool);
      expect(result).toBeNull();
    });

    it('returns null for COMMON_TOOLS with valid token', () => {
      const commonTool = Array.from(COMMON_TOOLS)[0];
      const { token } = createSession({ projectId: 'proj-1' });
      const result = checkAllowedTool(token, commonTool);
      expect(result).toBeNull();
    });
  });

  // ─── Test 2: Missing/invalid token on protected tools ────────────
  describe('Token validation for protected tools', () => {
    it('returns error for protected tool without token', () => {
      const protectedTool = 'rks_refine';
      const result = checkAllowedTool(null, protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
      expect(result.tool).toBe(protectedTool);
    });

    it('returns error for protected tool with empty string token', () => {
      const protectedTool = 'rks_refine';
      const result = checkAllowedTool('', protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
    });

    it('returns error for protected tool with non-existent token', () => {
      const protectedTool = 'rks_refine';
      const result = checkAllowedTool('nonexistent-token', protectedTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('unauthorized');
    });
  });

  // ─── Test 3: Flow-level refusals (decided by the per-state tables) ─
  describe('Flow-level refusals via the state tables', () => {
    it('allows STORY_FLOW_TOOLS in story flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const storyTool = 'rks_refine'; // Known to be in STORY_FLOW_TOOLS
      const result = checkAllowedTool(token, storyTool);
      expect(result).toBeNull();
    });

    it('returns error for STORY_FLOW_TOOLS in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' }); // No problemId → open flow
      const storyTool = 'rks_plan'; // Known to be story-only
      const result = checkAllowedTool(token, storyTool);
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
      expect(result.flowType).toBe('open');
      expect(result.tool).toBe(storyTool);
    });

    it('allows OPEN_FLOW_TOOLS in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' }); // No problemId → open flow
      const openTool = 'rks_agent_research'; // Known to be in OPEN_FLOW_TOOLS
      const result = checkAllowedTool(token, openTool);
      expect(result).toBeNull();
    });

    it('allows OPEN_FLOW_TOOLS in story flow (subset)', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const openTool = 'rks_agent_research'; // Also in STORY_FLOW_TOOLS
      const result = checkAllowedTool(token, openTool);
      expect(result).toBeNull();
    });
  });

  // ─── Test 4: State machine permission checks ─────────────────────
  describe('State machine permission checks', () => {
    it('allows tool valid for current state in story flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      // In 'init' state, rks_refine should be allowed
      const result = checkAllowedTool(token, 'rks_refine');
      expect(result).toBeNull();
    });

    it('rejects tool not valid for current state', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      // In 'init' state, rks_exec should not be allowed (wrong state)
      const result = checkAllowedTool(token, 'rks_exec');
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
      const result = checkAllowedTool(null, 'rks_refine');
      expect(result.tool).toBe('rks_refine');
    });

    it('includes flowType and state in chain_violation error', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const result = checkAllowedTool(token, 'rks_exec'); // Not allowed in init state
      expect(result.flowType).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.flowType).toBe('story');
      expect(result.state).toBe('init');
    });

    it('includes descriptive message in error', () => {
      const result = checkAllowedTool(null, 'rks_refine');
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
      checkAllowedTool(token, 'rks_refine');
      const session = getSession(token);
      // Manually set state to refining since checkAllowedTool doesn't advance state
      session.state = 'refining';
      const dendronTools = ['dendron_create_note', 'dendron_edit_note', 'dendron_read_note'];
      for (const tool of dendronTools) {
        const result = checkAllowedTool(token, tool);
        expect(result).toBeNull();
      }
    });

    it('allows dendron tools in open flow', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const dendronTools = ['dendron_create_note', 'dendron_edit_note', 'dendron_read_note'];
      for (const tool of dendronTools) {
        const result = checkAllowedTool(token, tool);
        expect(result).toBeNull();
      }
    });

    it('completely rejects unknown tool in any flow', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const unknownTool = 'rks_unknown_tool_xyz';
      const result = checkAllowedTool(token, unknownTool);
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

    it('rks_ship is not in UNPROTECTED_TOOLS (a tokenless call is refused)', () => {
      expect(UNPROTECTED_TOOLS.has('rks_ship')).toBe(false);
    });

    it('Build Governor (story flow) is blocked from calling rks_ship', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const result = checkAllowedTool(token, 'rks_ship');
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
      expect(result.flowType).toBe('story');
    });

    it('Open flow is also blocked from calling rks_ship', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const result = checkAllowedTool(token, 'rks_ship');
      expect(result).not.toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('chain_violation');
    });

    // backlog.feat.restrict-ship-to-ship-governor — both ship tools are protected: a call with no
    // token, or a token that matches no session, is refused at the token gate; a tokened call is
    // decided by the session's state machine (checkAllowedTool).
    const SHIP_TOOLS = ['rks_ship', 'rks_story_ship'];

    for (const tool of SHIP_TOOLS) {
      it(`${tool} is not in UNPROTECTED_TOOLS and isProtectedTool returns true`, () => {
        expect(UNPROTECTED_TOOLS.has(tool)).toBe(false);
        expect(isProtectedTool(tool)).toBe(true);
      });

      it(`requireToken refuses ${tool} with a null, empty or unknown token`, () => {
        for (const provided of [null, '', crypto.randomUUID()]) {
          const rejection = requireToken(provided, tool);
          expect(rejection, `token ${JSON.stringify(provided)}`).not.toBeNull();
          expect(rejection.ok).toBe(false);
          expect(rejection.error).toBe('unauthorized');
          expect(rejection.tool).toBe(tool);
        }
      });

      it(`checkAllowedTool refuses ${tool} from an open-flow session`, () => {
        const { token } = createSession({ projectId: 'proj-1' });
        const result = checkAllowedTool(token, tool);
        expect(result).not.toBeNull();
        expect(result.ok).toBe(false);
        expect(result.error).toBe('chain_violation');
      });

      it(`checkAllowedTool refuses ${tool} from a qa-flow session`, () => {
        const { token } = createSession({ projectId: 'proj-1', flowType: 'qa' });
        const result = checkAllowedTool(token, tool);
        expect(result).not.toBeNull();
        expect(result.ok).toBe(false);
        expect(result.error).toBe('chain_violation');
      });

      it(`checkAllowedTool refuses ${tool} from a story-flow session in state init`, () => {
        const { token, session } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
        expect(session.state).toBe('init');
        const result = checkAllowedTool(token, tool);
        expect(result).not.toBeNull();
        expect(result.ok).toBe(false);
        expect(result.error).toBe('chain_violation');
      });

      it(`checkAllowedTool admits ${tool} from a story-flow session in state executed`, () => {
        const { token, session } = createSession({ projectId: 'proj-1', problemId: 'story-1', initialState: 'executed' });
        expect(session.state).toBe('executed');
        expect(checkAllowedTool(token, tool)).toBeNull();
      });
    }

    it('the mcp-contract UNPROTECTED_TOOLS mirror lists neither ship tool', () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/__tests__/mcp-contract.spec.mjs'), 'utf8');
      const open = 'const UNPROTECTED_TOOLS = new Set([';
      const start = src.indexOf(open);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = src.indexOf(']);', start + open.length);
      expect(end).toBeGreaterThan(start);
      const literal = src.slice(start + open.length, end);
      expect(literal).not.toMatch(/["']rks_ship["']/);
      expect(literal).not.toMatch(/["']rks_story_ship["']/);
    });

    it('the MCP surface golden advertises _governorToken on both ship tools and drops the tokenless advice', () => {
      const golden = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/integration/fixtures/mcp-surface.golden.json'), 'utf8'));
      const tools = Array.isArray(golden.tools) ? golden.tools : [];
      for (const tool of SHIP_TOOLS) {
        const entry = tools.find((t) => t && t.name === tool);
        expect(entry, `golden entry for ${tool}`).toBeTruthy();
        expect(entry.inputSchema?.properties?._governorToken, `${tool} _governorToken`).toBeTruthy();
      }
      const ship = tools.find((t) => t && t.name === 'rks_ship');
      expect(ship.description).not.toContain('Use after guardrails-off work');
    });

    it('governor-token.mjs and server.mjs carry no stale unprotected-ship comments or tokenless advice', () => {
      const tokenSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/shared/governor-token.mjs'), 'utf8');
      for (const phrase of ['unprotected one-shot', 'kept unprotected for the governor-ship one-shot', 'Ship tools unprotected']) {
        expect(tokenSrc, phrase).not.toContain(phrase);
      }
      const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'packages/mcp-rks/src/server.mjs'), 'utf8');
      for (const phrase of ['rks_ship is unprotected', 'rks_story_ship is unprotected', 'Use after guardrails-off work or any time you have uncommitted changes to ship']) {
        expect(serverSrc, phrase).not.toContain(phrase);
      }
    });
  });

  // ─── Test 9: Dendron namespace guards ──────────────────────────────
  describe('Dendron namespace guards', () => {
    it('story flow rejects dendron_create_note for research.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = checkAllowedTool(token, 'dendron_create_note', { filename: 'research.topic.foo' });
      expect(result).not.toBeNull();
      expect(result.error).toBe('namespace_violation');
      expect(result.message).toContain('research');
      expect(result.message).toContain('backlog');
    });

    it('story flow allows dendron_update_field for backlog.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = checkAllowedTool(token, 'dendron_update_field', { filename: 'backlog.feat.my-story', field: 'phase', value: 'planned' });
      expect(result).toBeNull();
    });

    it('open flow allows all namespaces', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      const namespaces = ['research.topic', 'how-to.guide', 'notes.random', 'design.arch'];
      for (const filename of namespaces) {
        const result = checkAllowedTool(token, 'dendron_create_note', { filename });
        expect(result).toBeNull();
      }
      // backlog.feat.dendron-write-arg-checks-close-bypasses: a backlog.* create from init has not
      // traversed the PO research chain, so the open-flow backlog gate refuses it.
      const backlog = checkAllowedTool(token, 'dendron_create_note', { filename: 'backlog.feat.test' });
      expect(backlog).toMatchObject({ ok: false, error: 'namespace_violation' });
    });

    it('story flow rejects how-to.* namespace', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = checkAllowedTool(token, 'dendron_edit_note', { filename: 'how-to.some-guide' });
      expect(result).not.toBeNull();
      expect(result.error).toBe('namespace_violation');
    });

    it('namespace check skipped when no args provided', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = checkAllowedTool(token, 'dendron_create_note');
      expect(result).toBeNull();
    });
  });

  // ─── Test 10: Proto-story guard ────────────────────────────────────
  describe('Proto-story guard', () => {
    it('story flow blocked from setting phase to ready', () => {
      const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      const session = getSession(token);
      session.state = 'refining';
      const result = checkAllowedTool(token, 'dendron_update_field', {
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
      const result = checkAllowedTool(token, 'dendron_update_field', {
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
      const result = checkAllowedTool(token, 'dendron_update_field', {
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
      const result = checkAllowedTool(token, 'dendron_update_field', {
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

    it('rks_arch_verdict is in the OPEN flow allowlist — ARCH inits with no problemId', () => {
      // ARCH calls rks_governor_init WITHOUT a problemId, so it runs the open flow.
      // Without this entry the verdict call returns chain_violation and ARCH can
      // record a verdict by no path at all — dendron.mjs now refuses the direct write.
      expect(OPEN_FLOW_TOOLS.has('rks_arch_verdict')).toBe(true);
    });

    it('rks_agent_recovery (mutating) is in OPEN + OPS allowlists but NOT STORY', () => {
      expect(OPEN_FLOW_TOOLS.has('rks_agent_recovery')).toBe(true);
      expect(OPS_FLOW_TOOLS.has('rks_agent_recovery')).toBe(true);
      expect(STORY_FLOW_TOOLS.has('rks_agent_recovery')).toBe(false);
    });

    it('open-flow init permits rks_exhaustive_search — no chain_violation', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      expect(checkAllowedTool(token, 'rks_exhaustive_search')).toBeNull();
    });

    it('open-flow init permits rks_agent_recovery — the sanctioned recovery entry', () => {
      const { token } = createSession({ projectId: 'proj-1' });
      expect(checkAllowedTool(token, 'rks_agent_recovery')).toBeNull();
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
      for (const t of setupTools) expect(checkAllowedTool(null, t)).toBeNull();
    });

    it('callable inside an active session in any flow init state — no chain_violation', () => {
      const open = createSession({ projectId: 'proj-1' });
      for (const t of setupTools) expect(checkAllowedTool(open.token, t)).toBeNull();
      resetToken();
      const story = createSession({ projectId: 'proj-1', problemId: 'story-1' });
      for (const t of setupTools) expect(checkAllowedTool(story.token, t)).toBeNull();
    });

    it('does NOT weaken auth — workflow tools stay protected + gated', () => {
      for (const t of ['rks_plan', 'rks_exec', 'rks_refine']) {
        expect(UNPROTECTED_TOOLS.has(t)).toBe(false);
        expect(COMMON_TOOLS.has(t)).toBe(false);
        expect(checkAllowedTool(null, t)?.error).toBe('unauthorized');
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

  it('checkAllowedTool open-flow refusal emits chain.violation AND still returns the rejection', () => {
    const { token } = createSession({ projectId: 'proj-1' }); // open flow
    const result = checkAllowedTool(token, 'rks_exec'); // not admitted by any open-flow state
    expect(result.error).toBe('chain_violation');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call).toBeDefined();
    expect(call[2].blockedTool).toBe('rks_exec');
    expect(call[2].flowType).toBe('open');
    expect(Array.isArray(call[2].expectedTools)).toBe(true);
    expect(call[2].violationKind).toBe('state_machine');
  });

  it('checkAllowedTool rejection payload carries flow/state/message', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' }); // story flow, init
    const result = checkAllowedTool(token, 'rks_exec');
    expect(result.error).toBe('chain_violation');
    const call = emitSpy.mock.calls.find((c) => c[0] === 'chain.violation');
    expect(call).toBeDefined();
    expect(call[2].state).toBeDefined();
    expect(call[2].violationKind).toBe('state_machine');
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
    checkAllowedTool(token, 'rks_exec');
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
      result = checkAllowedTool(token, 'rks_exec');
    }).not.toThrow();
    expect(result.error).toBe('chain_violation');
    expect(result.tool).toBe('rks_exec');
  });

  it('allowed calls do NOT emit chain.violation (rejection-path only)', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
    checkAllowedTool(token, 'rks_refine'); // allowed in story/init
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
    expect(checkAllowedTool(token, 'rks_fetch_raw')).toBeNull();
  });

  it('still gated: NO token → unauthorized (protection intact)', () => {
    expect(checkAllowedTool(null, 'rks_fetch_raw')?.error).toBe('unauthorized');
  });

  it('story flow rejects it (out of scope by design) — chain_violation, not silent allow', () => {
    const { token } = createSession({ projectId: 'proj-1', problemId: 'story-1' });
    expect(checkAllowedTool(token, 'rks_fetch_raw')?.error).toBe('chain_violation');
  });
});

// ---------------------------------------------------------------------------
// backlog.fix.agent-stash-create-containment — rks_stash reachability
// ---------------------------------------------------------------------------
describe("rks_stash is admitted by the LIVE gate in every flow", () => {
  // Asserted against checkAllowedTool — the one admission function the server reaches. The
  // *_FLOW_TOOLS sets only choose redirect text, so testing those instead would pin a dead path.
  //
  // WHY THIS MATTERS BEYOND REACHABILITY: rks_stash is admitted via STATE_BYPASS_TOOLS, which
  // is consulted INSIDE checkStateAllowed — i.e. AFTER checkAllowedTool's session lookup. That
  // ordering is what makes a live session a structural precondition of admission, which is what
  // guarantees setPendingStash's governorSessions.get(token) hits and the auto-pop can be armed.
  // COMMON_TOOLS returns before that lookup and would make the guarantee silently optional.
  for (const flowType of ["story", "open", "ops", "qa", "ship"]) {
    it(`${flowType} flow: a live session may call rks_stash from its initial state`, () => {
      const { token } = createSession({ projectId: "p", flowType, problemId: "s-1" });
      try {
        expect(checkAllowedTool(token, "rks_stash"),
          `rks_stash refused in ${flowType} flow — the tracked path is unreachable there`).toBeNull();
      } finally {
        endSession(token);
      }
    });
  }

  it("POSITIVE CONTROL — a non-bypass tool is still refused in those same flows", () => {
    // Without this, the five assertions above would pass against a gate that allowed everything.
    const { token } = createSession({ projectId: "p", flowType: "ship", problemId: "s-2" });
    try {
      expect(checkAllowedTool(token, "rks_exhaustive_search")).not.toBeNull();
    } finally {
      endSession(token);
    }
  });

  it("SESSION-PRESENCE PIN — a token with no live session is still refused", () => {
    // The whole point of choosing STATE_BYPASS_TOOLS over COMMON_TOOLS. If this ever returns
    // null, admission has moved upstream of the session lookup and setPendingStash becomes a
    // silent no-op for exactly the callers that most need the auto-pop.
    expect(checkAllowedTool("no-such-token", "rks_stash"),
      "rks_stash was admitted without a live session — that is the COMMON_TOOLS shape").not.toBeNull();
  });

  it("rks_stash is NOT in COMMON_TOOLS — the mechanism, pinned", () => {
    expect(COMMON_TOOLS.has("rks_stash")).toBe(false);
  });

  it("rks_stash remains a PROTECTED tool — admission is not exemption from tokens", () => {
    expect(isProtectedTool("rks_stash")).toBe(true);
  });
});
