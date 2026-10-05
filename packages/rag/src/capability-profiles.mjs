/**
 * Capability profiles for agent hierarchy.
 * Each profile defines what the agent can access and how.
 */

import { FIDELITY_LEVELS } from './fidelity-filter.mjs';
import { SOURCE_CLASSES } from './source-classifier.mjs';

export const AGENT_ROLES = {
  SCOUT: 'scout',
  PLANNER: 'planner',
  EXECUTOR: 'executor',
  AUDITOR: 'auditor'
};

/**
 * Capability profile definitions.
 * Each profile specifies access constraints.
 */
export const CAPABILITY_PROFILES = {
  [AGENT_ROLES.SCOUT]: {
    name: 'Scout/Detector',
    description: 'Find candidate sources without consuming content',
    allowedSourceClasses: [SOURCE_CLASSES.PUBLIC, SOURCE_CLASSES.PROJECT],
    maxFidelity: FIDELITY_LEVELS.L0_METADATA,
    allowedOperations: ['retrieve'],
    maxResultsPerQuery: 20,
    snippetCap: 0, // No snippets
    canEscalate: false,
    canEmbed: false
  },

  [AGENT_ROLES.PLANNER]: {
    name: 'Planner',
    description: 'Compile intent into plans while staying grounded',
    allowedSourceClasses: [SOURCE_CLASSES.PUBLIC, SOURCE_CLASSES.PROJECT, SOURCE_CLASSES.CLIENT],
    maxFidelity: FIDELITY_LEVELS.L2_REDACTED,
    allowedOperations: ['retrieve', 'escalate'],
    maxResultsPerQuery: 12,
    snippetCap: 500, // Capped preview length
    canEscalate: true,
    canEmbed: false
  },

  [AGENT_ROLES.EXECUTOR]: {
    name: 'Executor',
    description: 'Apply changes within strict scope',
    allowedSourceClasses: [SOURCE_CLASSES.PUBLIC, SOURCE_CLASSES.PROJECT],
    maxFidelity: FIDELITY_LEVELS.L1_ABSTRACTED,
    allowedOperations: ['retrieve'],
    maxResultsPerQuery: 6,
    snippetCap: 200,
    canEscalate: false,
    canEmbed: false,
    // Executor should prefer tool outputs over broad reading
    preferToolOutputs: true
  },

  [AGENT_ROLES.AUDITOR]: {
    name: 'Auditor/Safety',
    description: 'Verify compliance and investigate violations',
    allowedSourceClasses: Object.values(SOURCE_CLASSES), // All classes
    maxFidelity: FIDELITY_LEVELS.L3_FULL,
    allowedOperations: ['retrieve', 'escalate', 'investigate'],
    maxResultsPerQuery: 50,
    snippetCap: null, // No cap
    canEscalate: true,
    canEmbed: false
  }
};

/**
 * Get capability profile for a role.
 * @param {string} role - Agent role
 * @returns {Object} Capability profile
 */
export function getProfile(role) {
  return CAPABILITY_PROFILES[role] || CAPABILITY_PROFILES[AGENT_ROLES.EXECUTOR];
}

/**
 * Check if a source class is allowed for a role.
 * @param {string} role - Agent role
 * @param {string} sourceClass - Source classification
 * @returns {boolean}
 */
export function isSourceAllowed(role, sourceClass) {
  const profile = getProfile(role);
  return profile.allowedSourceClasses.includes(sourceClass);
}

/**
 * Get maximum fidelity for a role.
 * @param {string} role - Agent role
 * @returns {number} Max fidelity level
 */
export function getMaxFidelity(role) {
  const profile = getProfile(role);
  return profile.maxFidelity;
}

/**
 * Check if an operation is allowed for a role.
 * @param {string} role - Agent role
 * @param {string} operation - Operation name
 * @returns {boolean}
 */
export function isOperationAllowed(role, operation) {
  const profile = getProfile(role);
  return profile.allowedOperations.includes(operation);
}

export default {
  AGENT_ROLES,
  CAPABILITY_PROFILES,
  getProfile,
  isSourceAllowed,
  getMaxFidelity,
  isOperationAllowed
};
