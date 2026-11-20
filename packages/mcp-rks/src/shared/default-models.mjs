/**
 * Default Claude model IDs for rks (backlog.feat.default-models-haiku-sonnet-5-5).
 *
 * Single source for every hard-coded default model in packages/mcp-rks/src.
 * The next model upgrade is a change to this file only. Overrides still win:
 * env var > .rks/agents.yaml > these defaults (see agents/config.mjs).
 *
 * IDs verified against https://platform.claude.com/docs/en/about-claude/models/overview
 * (no dated snapshot suffix; the ID is also the alias).
 */

/** Cheap/fast tier: primary model for mechanical agents. */
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';

/** Higher-capability tier: fallback model, planner, reviewer, QA, visual. */
export const DEFAULT_SONNET_MODEL = 'claude-sonnet-5-5';
