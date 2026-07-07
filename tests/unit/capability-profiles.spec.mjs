import { describe, it, expect } from 'vitest';
import {
  AGENT_ROLES,
  CAPABILITY_PROFILES,
  getProfile,
  isSourceAllowed,
  getMaxFidelity,
  isOperationAllowed
} from '../../packages/mcp-rks/src/rag/capability-profiles.mjs';
import {
  createCapabilityToken,
  validateToken,
  tokenAllowsSource,
  getTokenFidelity
} from '../../packages/mcp-rks/src/rag/capability-token.mjs';
import { FIDELITY_LEVELS } from '../../packages/mcp-rks/src/rag/fidelity-filter.mjs';
import { SOURCE_CLASSES } from '../../packages/mcp-rks/src/rag/source-classifier.mjs';

describe('AGENT_ROLES', () => {
  it('exports all expected roles', () => {
    expect(AGENT_ROLES.SCOUT).toBe('scout');
    expect(AGENT_ROLES.PLANNER).toBe('planner');
    expect(AGENT_ROLES.EXECUTOR).toBe('executor');
    expect(AGENT_ROLES.AUDITOR).toBe('auditor');
  });
});

describe('capability-profiles', () => {
  describe('Scout profile', () => {
    it('only allows L0 fidelity', () => {
      expect(getMaxFidelity(AGENT_ROLES.SCOUT)).toBe(FIDELITY_LEVELS.L0_METADATA);
    });

    it('only allows public and project sources', () => {
      expect(isSourceAllowed(AGENT_ROLES.SCOUT, SOURCE_CLASSES.PUBLIC)).toBe(true);
      expect(isSourceAllowed(AGENT_ROLES.SCOUT, SOURCE_CLASSES.PROJECT)).toBe(true);
      expect(isSourceAllowed(AGENT_ROLES.SCOUT, SOURCE_CLASSES.SENSITIVE)).toBe(false);
      expect(isSourceAllowed(AGENT_ROLES.SCOUT, SOURCE_CLASSES.CLIENT)).toBe(false);
    });

    it('cannot escalate', () => {
      expect(isOperationAllowed(AGENT_ROLES.SCOUT, 'escalate')).toBe(false);
    });

    it('can only retrieve', () => {
      expect(isOperationAllowed(AGENT_ROLES.SCOUT, 'retrieve')).toBe(true);
      expect(isOperationAllowed(AGENT_ROLES.SCOUT, 'investigate')).toBe(false);
    });

    it('has zero snippet cap', () => {
      const profile = getProfile(AGENT_ROLES.SCOUT);
      expect(profile.snippetCap).toBe(0);
    });
  });

  describe('Planner profile', () => {
    it('allows up to L2 fidelity', () => {
      expect(getMaxFidelity(AGENT_ROLES.PLANNER)).toBe(FIDELITY_LEVELS.L2_REDACTED);
    });

    it('allows client sources', () => {
      expect(isSourceAllowed(AGENT_ROLES.PLANNER, SOURCE_CLASSES.CLIENT)).toBe(true);
    });

    it('does not allow sensitive sources', () => {
      expect(isSourceAllowed(AGENT_ROLES.PLANNER, SOURCE_CLASSES.SENSITIVE)).toBe(false);
    });

    it('can escalate', () => {
      expect(isOperationAllowed(AGENT_ROLES.PLANNER, 'escalate')).toBe(true);
    });

    it('has 500 char snippet cap', () => {
      const profile = getProfile(AGENT_ROLES.PLANNER);
      expect(profile.snippetCap).toBe(500);
    });
  });

  describe('Executor profile', () => {
    it('allows up to L1 fidelity', () => {
      expect(getMaxFidelity(AGENT_ROLES.EXECUTOR)).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
    });

    it('cannot escalate', () => {
      expect(isOperationAllowed(AGENT_ROLES.EXECUTOR, 'escalate')).toBe(false);
    });

    it('prefers tool outputs', () => {
      const profile = getProfile(AGENT_ROLES.EXECUTOR);
      expect(profile.preferToolOutputs).toBe(true);
    });

    it('has 200 char snippet cap', () => {
      const profile = getProfile(AGENT_ROLES.EXECUTOR);
      expect(profile.snippetCap).toBe(200);
    });
  });

  describe('Auditor profile', () => {
    it('allows L3 full fidelity', () => {
      expect(getMaxFidelity(AGENT_ROLES.AUDITOR)).toBe(FIDELITY_LEVELS.L3_FULL);
    });

    it('can access all source classes', () => {
      Object.values(SOURCE_CLASSES).forEach(cls => {
        expect(isSourceAllowed(AGENT_ROLES.AUDITOR, cls)).toBe(true);
      });
    });

    it('can escalate and investigate', () => {
      expect(isOperationAllowed(AGENT_ROLES.AUDITOR, 'escalate')).toBe(true);
      expect(isOperationAllowed(AGENT_ROLES.AUDITOR, 'investigate')).toBe(true);
    });

    it('has no snippet cap', () => {
      const profile = getProfile(AGENT_ROLES.AUDITOR);
      expect(profile.snippetCap).toBeNull();
    });

    it('has highest result limit', () => {
      const profile = getProfile(AGENT_ROLES.AUDITOR);
      expect(profile.maxResultsPerQuery).toBe(50);
    });
  });

  describe('getProfile', () => {
    it('returns correct profile for valid role', () => {
      const profile = getProfile(AGENT_ROLES.PLANNER);
      expect(profile.name).toBe('Planner');
    });

    it('defaults to executor for unknown role', () => {
      const profile = getProfile('unknown-role');
      expect(profile.name).toBe('Executor');
    });
  });
});

describe('capability-token', () => {
  describe('createCapabilityToken', () => {
    it('creates valid token with profile constraints', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.PLANNER,
        projectId: 'my-project'
      });

      expect(token.tokenId).toBeDefined();
      expect(token.runId).toBe('run-123');
      expect(token.role).toBe(AGENT_ROLES.PLANNER);
      expect(token.projectId).toBe('my-project');
      expect(token.maxFidelity).toBe(FIDELITY_LEVELS.L2_REDACTED);
      expect(token.canEscalate).toBe(true);
      expect(token.issuedAt).toBeDefined();
    });

    it('includes allowed source classes from profile', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.SCOUT,
        projectId: 'proj'
      });

      expect(token.allowedSourceClasses).toContain(SOURCE_CLASSES.PUBLIC);
      expect(token.allowedSourceClasses).toContain(SOURCE_CLASSES.PROJECT);
      expect(token.allowedSourceClasses).not.toContain(SOURCE_CLASSES.SENSITIVE);
    });

    it('includes overrides when provided', () => {
      const overrides = { project: FIDELITY_LEVELS.L3_FULL };
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj',
        overrides
      });

      expect(token.fidelityOverrides).toEqual(overrides);
    });
  });

  describe('validateToken', () => {
    it('validates well-formed token', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj'
      });

      const { valid, errors } = validateToken(token);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });

    it('rejects token without tokenId', () => {
      const token = { runId: 'r', role: AGENT_ROLES.EXECUTOR, issuedAt: new Date().toISOString() };
      const { valid, errors } = validateToken(token);
      expect(valid).toBe(false);
      expect(errors).toContain('Missing tokenId');
    });

    it('rejects token without runId', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj'
      });
      delete token.runId;

      const { valid, errors } = validateToken(token);
      expect(valid).toBe(false);
      expect(errors).toContain('Missing runId');
    });

    it('rejects token with invalid role', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj'
      });
      token.role = 'invalid-role';

      const { valid, errors } = validateToken(token);
      expect(valid).toBe(false);
      expect(errors.some(e => e.includes('Invalid role'))).toBe(true);
    });

    it('rejects expired token', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj'
      });
      // Backdate token by 25 hours
      token.issuedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      const { valid, errors } = validateToken(token);
      expect(valid).toBe(false);
      expect(errors).toContain('Token expired');
    });

    it('accepts token within 24 hour window', () => {
      const token = createCapabilityToken({
        runId: 'run-123',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'proj'
      });
      // Backdate token by 23 hours (still valid)
      token.issuedAt = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();

      const { valid, errors } = validateToken(token);
      expect(valid).toBe(true);
      expect(errors).toHaveLength(0);
    });
  });

  describe('tokenAllowsSource', () => {
    it('respects profile source restrictions', () => {
      const scoutToken = createCapabilityToken({
        runId: 'r1',
        role: AGENT_ROLES.SCOUT,
        projectId: 'p'
      });

      expect(tokenAllowsSource(scoutToken, SOURCE_CLASSES.PUBLIC)).toBe(true);
      expect(tokenAllowsSource(scoutToken, SOURCE_CLASSES.PROJECT)).toBe(true);
      expect(tokenAllowsSource(scoutToken, SOURCE_CLASSES.SENSITIVE)).toBe(false);
      expect(tokenAllowsSource(scoutToken, SOURCE_CLASSES.LEGAL)).toBe(false);
    });

    it('auditor token allows all sources', () => {
      const auditorToken = createCapabilityToken({
        runId: 'r1',
        role: AGENT_ROLES.AUDITOR,
        projectId: 'p'
      });

      Object.values(SOURCE_CLASSES).forEach(cls => {
        expect(tokenAllowsSource(auditorToken, cls)).toBe(true);
      });
    });

    it('returns false for null/undefined token', () => {
      expect(tokenAllowsSource(null, SOURCE_CLASSES.PUBLIC)).toBe(false);
      expect(tokenAllowsSource(undefined, SOURCE_CLASSES.PUBLIC)).toBe(false);
    });
  });

  describe('getTokenFidelity', () => {
    it('returns token maxFidelity by default', () => {
      const token = createCapabilityToken({
        runId: 'r1',
        role: AGENT_ROLES.PLANNER,
        projectId: 'p'
      });

      expect(getTokenFidelity(token, SOURCE_CLASSES.PROJECT)).toBe(FIDELITY_LEVELS.L2_REDACTED);
    });

    it('respects fidelity overrides', () => {
      const token = createCapabilityToken({
        runId: 'r1',
        role: AGENT_ROLES.EXECUTOR,
        projectId: 'p',
        overrides: { project: FIDELITY_LEVELS.L3_FULL }
      });

      // Override says L3, but token maxFidelity is L1 (executor), so should be L1
      expect(getTokenFidelity(token, SOURCE_CLASSES.PROJECT)).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
    });

    it('returns override when lower than maxFidelity', () => {
      const token = createCapabilityToken({
        runId: 'r1',
        role: AGENT_ROLES.AUDITOR, // L3 max
        projectId: 'p',
        overrides: { project: FIDELITY_LEVELS.L1_ABSTRACTED }
      });

      expect(getTokenFidelity(token, SOURCE_CLASSES.PROJECT)).toBe(FIDELITY_LEVELS.L1_ABSTRACTED);
    });

    it('defaults to L2 for null/undefined token', () => {
      expect(getTokenFidelity(null, SOURCE_CLASSES.PROJECT)).toBe(2);
      expect(getTokenFidelity(undefined, SOURCE_CLASSES.PROJECT)).toBe(2);
    });
  });
});

describe('CAPABILITY_PROFILES', () => {
  it('exports profiles for all roles', () => {
    expect(CAPABILITY_PROFILES[AGENT_ROLES.SCOUT]).toBeDefined();
    expect(CAPABILITY_PROFILES[AGENT_ROLES.PLANNER]).toBeDefined();
    expect(CAPABILITY_PROFILES[AGENT_ROLES.EXECUTOR]).toBeDefined();
    expect(CAPABILITY_PROFILES[AGENT_ROLES.AUDITOR]).toBeDefined();
  });

  it('all profiles have required fields', () => {
    Object.values(CAPABILITY_PROFILES).forEach(profile => {
      expect(profile.name).toBeDefined();
      expect(profile.description).toBeDefined();
      expect(profile.allowedSourceClasses).toBeDefined();
      expect(Array.isArray(profile.allowedSourceClasses)).toBe(true);
      expect(typeof profile.maxFidelity).toBe('number');
      expect(Array.isArray(profile.allowedOperations)).toBe(true);
      expect(typeof profile.maxResultsPerQuery).toBe('number');
      expect(typeof profile.canEscalate).toBe('boolean');
      expect(typeof profile.canEmbed).toBe('boolean');
    });
  });
});
