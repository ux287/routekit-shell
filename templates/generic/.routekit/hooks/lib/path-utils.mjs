/**
 * @module path-utils
 * Shared path normalization utilities for the provenance system.
 * 
 * Provides single source of truth for path handling and comparison across provenance storage.
 * 
 * Exports:
 * - {@link normalizePath} - Normalize a path for storage and comparison
 * - {@link getProjectRoot} - Get the effective project root from environment
 * - {@link pathsMatch} - Check if two paths match after normalization
 * - {@link debugPathMatch} - Debug helper for path matching issues
 */

/**
 * Shared path normalization utilities.
 * Single source of truth for path handling across provenance system.
 */

/**
 * Normalize a path for provenance storage and comparison.
 * - Strips leading/trailing slashes for consistent comparison
 * - Handles absolute paths by stripping project root prefix
 *
 * @param {string} p - Path to normalize
 * @param {string} projectRoot - Optional project root to strip
 * @returns {string} Normalized path
 */
export function normalizePath(p, projectRoot = null) {
  if (!p) return '';

  let normalized = String(p);

  // Strip project root prefix if provided
  if (projectRoot) {
    const root = projectRoot.replace(/\/+$/, '');
    if (normalized.startsWith(root)) {
      normalized = normalized.slice(root.length);
    }
  }

  // Strip leading and trailing slashes
  normalized = normalized.replace(/^\/+/, '').replace(/\/+$/, '');

  return normalized;
}

/**
 * Get the effective project root from environment.
 * @returns {string} Project root path
 */
export function getProjectRoot() {
  return process.env.ROUTEKIT_PROJECT_ROOT
      || process.env.CLAUDE_PROJECT_DIR
      || process.cwd();
}

/**
 * Check if two paths match after normalization.
 * @param {string} a - First path
 * @param {string} b - Second path
 * @param {string} projectRoot - Optional project root
 * @returns {boolean}
 */
export function pathsMatch(a, b, projectRoot = null) {
  return normalizePath(a, projectRoot) === normalizePath(b, projectRoot);
}

/**
 * Debug helper for path matching issues.
 */
export function debugPathMatch(stored, requested, projectRoot = null) {
  const storedNorm = normalizePath(stored, projectRoot);
  const requestedNorm = normalizePath(requested, projectRoot);
  return {
    stored,
    storedNorm,
    requested,
    requestedNorm,
    match: storedNorm === requestedNorm
  };
}
