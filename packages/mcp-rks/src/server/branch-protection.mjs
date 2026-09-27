/**
 * Branch protection utilities for MCP git tools.
 * Prevents accidental operations on protected branches.
 *
 * Protection is TOPOLOGY-AWARE:
 * - Two-branch (staging + main): protects main only
 * - Three-branch (dev + staging + main): protects staging AND main
 *
 * Only designated tools can touch protected branches:
 * - rks_promote: can merge to integration (staging)
 * - rks_release: can merge to production (main)
 */

import fs from "fs";
import path from "path";
import { getBranchConfig } from "./project.mjs";

/**
 * Load project.json from .rks/project.json
 * @param {string} projectRoot - Project root directory
 * @returns {object} Project JSON contents or empty object
 */
function loadProjectJson(projectRoot) {
  try {
    const projectJsonPath = path.join(projectRoot, ".rks", "project.json");
    if (fs.existsSync(projectJsonPath)) {
      return JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
    }
  } catch (e) {
    // Ignore errors, return empty object for defaults
  }
  return {};
}

/**
 * Get protected branches based on workflow topology.
 * @param {string} projectRoot - Project root directory
 * @returns {string[]} Array of protected branch names
 */
export function getProtectedBranches(projectRoot) {
  const projectJson = loadProjectJson(projectRoot);
  const branchConfig = getBranchConfig(null, projectJson);

  const protectedBranches = [];

  // Production branch is always protected
  if (branchConfig.production) {
    protectedBranches.push(branchConfig.production);
  }
  // Also protect common aliases
  protectedBranches.push("main", "master", "production");

  // Three-branch topology: integration (staging) is also protected
  // Detected when working !== integration
  if (branchConfig.working !== branchConfig.integration) {
    if (branchConfig.integration) {
      protectedBranches.push(branchConfig.integration);
    }
    protectedBranches.push("staging");
  }

  // Deduplicate
  return [...new Set(protectedBranches)];
}

/**
 * Check if a branch is the integration branch (for promote exemption).
 * @param {string} projectRoot - Project root directory
 * @param {string} branch - Branch name to check
 * @returns {boolean}
 */
export function isIntegrationBranch(projectRoot, branch) {
  const projectJson = loadProjectJson(projectRoot);
  const branchConfig = getBranchConfig(null, projectJson);
  return (
    branch === branchConfig.integration ||
    branch === "staging"
  );
}

/**
 * Check if a branch is the production branch (for release exemption).
 * @param {string} projectRoot - Project root directory
 * @param {string} branch - Branch name to check
 * @returns {boolean}
 */
export function isProductionBranch(projectRoot, branch) {
  const projectJson = loadProjectJson(projectRoot);
  const branchConfig = getBranchConfig(null, projectJson);
  return (
    branch === branchConfig.production ||
    branch === "main" ||
    branch === "master" ||
    branch === "production"
  );
}

/**
 * Throws if the given branch is protected.
 * Call this BEFORE any git checkout, commit, or merge to a branch.
 *
 * @param {string} projectRoot - Project root for config lookup
 * @param {string} branch - Branch name to check
 * @param {string} operation - Description of the operation (for error message)
 * @param {object} options - Optional config
 * @param {boolean} options.allowPromote - If true, allow integration branch (for rks_promote)
 * @param {boolean} options.allowRelease - If true, allow production branch (for rks_release)
 */
export function assertNotProtectedBranch(
  projectRoot,
  branch,
  operation,
  options = {}
) {
  // Check exemptions first
  if (options.allowRelease && isProductionBranch(projectRoot, branch)) {
    return; // rks_release is exempt for production
  }
  if (options.allowPromote && isIntegrationBranch(projectRoot, branch)) {
    return; // rks_promote is exempt for integration
  }

  const protectedBranches = getProtectedBranches(projectRoot);

  if (protectedBranches.includes(branch)) {
    const hint = isIntegrationBranch(projectRoot, branch)
      ? "Use rks_promote to merge to integration branch."
      : "Use rks_release for production deployments.";

    throw new Error(
      `🛑 BLOCKED: Cannot ${operation} on protected branch '${branch}'. ${hint}`
    );
  }
}

/**
 * Throws if currently on a protected branch.
 * Call this before commits on the current branch.
 *
 * @param {string} projectRoot - Project root for config lookup
 * @param {string} currentBranch - Current branch name
 * @param {string} operation - Description of the operation (for error message)
 */
export function assertNotOnProtectedBranch(projectRoot, currentBranch, operation) {
  const protectedBranches = getProtectedBranches(projectRoot);

  if (protectedBranches.includes(currentBranch)) {
    throw new Error(
      `🛑 BLOCKED: Cannot ${operation} while on protected branch '${currentBranch}'. ` +
        `Switch to a feature branch first.`
    );
  }
}
