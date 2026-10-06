/**
 * Run-scoped capability tokens.
 * Issued at run start, encodes access constraints for the run.
 */

import { randomUUID } from 'crypto';
import { getProfile, AGENT_ROLES } from './capability-profiles.mjs';

/**
 * Create a capability token for a run.
 * @param {Object} options
 * @param {string} options.runId - Run identifier
 * @param {string} options.role - Agent role (scout, planner, executor, auditor)
 * @param {string} options.projectId - Project identifier
 * @param {Object} options.overrides - Optional per-class fidelity overrides
 * @returns {Object} Capability token
 */
export function createCapabilityToken({ runId, role, projectId, overrides = {} }) {
  const profile = getProfile(role);
  const tokenId = randomUUID();

  return {
    tokenId,
    runId,
    projectId,
    role,
    profile: profile.name,
    issuedAt: new Date().toISOString(),

    // Access constraints
    allowedSourceClasses: profile.allowedSourceClasses,
    maxFidelity: profile.maxFidelity,
    allowedOperations: profile.allowedOperations,
    maxResultsPerQuery: profile.maxResultsPerQuery,
    snippetCap: profile.snippetCap,
    canEscalate: profile.canEscalate,
    canEmbed: profile.canEmbed,

    // Overrides (from escalation approvals, etc.)
    fidelityOverrides: overrides
  };
}

/**
 * Validate a capability token.
 * @param {Object} token - Capability token
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateToken(token) {
  const errors = [];

  if (!token?.tokenId) errors.push('Missing tokenId');
  if (!token?.runId) errors.push('Missing runId');
  if (!token?.role) errors.push('Missing role');
  if (!Object.values(AGENT_ROLES).includes(token?.role)) {
    errors.push(`Invalid role: ${token?.role}`);
  }
  if (!token?.issuedAt) errors.push('Missing issuedAt');

  // Check token age (tokens expire after 24 hours)
  if (token?.issuedAt) {
    const age = Date.now() - new Date(token.issuedAt).getTime();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (age > maxAge) {
      errors.push('Token expired');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if token allows access to a source class.
 * @param {Object} token - Capability token
 * @param {string} sourceClass - Source classification
 * @returns {boolean}
 */
export function tokenAllowsSource(token, sourceClass) {
  return token?.allowedSourceClasses?.includes(sourceClass) ?? false;
}

/**
 * Get effective fidelity from token for a source class.
 * @param {Object} token - Capability token
 * @param {string} sourceClass - Source classification
 * @returns {number} Effective fidelity level
 */
export function getTokenFidelity(token, sourceClass) {
  // Check for override
  if (token?.fidelityOverrides?.[sourceClass] !== undefined) {
    return Math.min(token.fidelityOverrides[sourceClass], token.maxFidelity);
  }
  return token?.maxFidelity ?? 2; // Default to L2
}

export default {
  createCapabilityToken,
  validateToken,
  tokenAllowsSource,
  getTokenFidelity
};
