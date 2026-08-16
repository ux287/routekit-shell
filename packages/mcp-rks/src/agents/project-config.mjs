/**
 * Project Config Loader for Agents
 *
 * Reads project.json to provide config-driven defaults.
 * Agents use this instead of accepting caller-supplied params
 * for governance-controlled values like PR target branch.
 *
 * @see backlog.agents.ship-agent-config-driven
 * @see backlog.agents.dispatcher-minimal-params
 */

import fs from 'fs';
import path from 'path';

/**
 * Load project configuration from project.json.
 *
 * Searches: .rks/project.json → routekit/project.json
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {{ id: string, baseBranch: string, [key: string]: any }}
 */
export function loadProjectConfig(projectRoot) {
  const candidates = [
    path.join(projectRoot, '.rks', 'project.json'),
    path.join(projectRoot, 'routekit', 'project.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        ...raw,
        // Enforce defaults for governance-controlled fields
        baseBranch: raw.baseBranch || 'staging',
      };
    }
  }

  // No project.json found — return safe defaults
  return { id: 'unknown', baseBranch: 'staging' };
}

/**
 * Resolve the PR target branch for shipping.
 *
 * Reads from project config. Hard rejects 'main' — production
 * releases go through rks_release, not Ship Agent PRs.
 *
 * @param {string} projectRoot
 * @returns {{ ok: boolean, branch?: string, error?: string }}
 */
export function resolveShipTarget(projectRoot) {
  const config = loadProjectConfig(projectRoot);
  const branch = config.baseBranch;

  if (branch === 'main' || branch === 'master') {
    return {
      ok: false,
      error: `Ship Agent cannot target '${branch}' (production branch). Use rks_release to promote to production.`,
    };
  }

  return { ok: true, branch };
}

/**
 * Derive a branch name from a story ID.
 *
 * @param {string} storyId - e.g., "backlog.agents.ship-agent-config-driven"
 * @returns {string} - e.g., "rks/agents-ship-agent-config-driven"
 */
export function deriveBranchName(storyId) {
  if (!storyId) return null;
  // Strip "backlog." prefix, slugify the rest
  const slug = storyId
    .replace(/^backlog\./, '')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase()
    .slice(0, 60);
  return `rks/${slug}`;
}

/**
 * Derive a PR title from a story note.
 *
 * Reads the story note to extract the title field.
 * Falls back to storyId if note not found.
 *
 * @param {string} projectRoot
 * @param {string} storyId
 * @returns {string}
 */
export function derivePrTitle(projectRoot, storyId) {
  if (!storyId) return null;

  const notesDir = path.join(projectRoot, 'notes');
  const candidates = [
    path.join(notesDir, `${storyId}.md`),
    path.join(notesDir, `${storyId.replace('backlog.', 'backlog.z_implemented.')}.md`),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      const titleMatch = content.match(/^title:\s*['"]?([^'"\n]+)['"]?$/m);
      if (titleMatch) {
        const storyTitle = titleMatch[1].trim();
        // Derive scope from story path: backlog.agents.foo → agents
        const scope = storyId.replace(/^backlog\./, '').split('.')[0] || 'core';
        return `feat(${scope}): ${storyTitle}`;
      }
    }
  }

  // Fallback: humanize the storyId
  const humanized = storyId.replace(/^backlog\./, '').replace(/\./g, ' ').replace(/-/g, ' ');
  return `feat: ${humanized}`;
}

/**
 * Derive a commit message from a story.
 *
 * @param {string} projectRoot
 * @param {string} storyId
 * @returns {string}
 */
export function deriveCommitMessage(projectRoot, storyId) {
  const prTitle = derivePrTitle(projectRoot, storyId);
  return prTitle || 'feat: ship changes';
}
