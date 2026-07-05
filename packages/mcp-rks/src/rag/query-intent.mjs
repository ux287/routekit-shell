/**
 * Query intent inference and content-type boost multipliers for RAG re-ranking.
 * Shared between scripts/rag/query.mjs (CLI) and the research agent (MCP server).
 * Kept separate from query.mjs to avoid importing CLI-specific module-level init code.
 */

// Content-type boost multipliers per query intent.
// Applied after status boost: finalScore = baseScore × statusBoost × contentTypeBoost
export const CONTENT_TYPE_BOOST = {
  'current-state': { skill: 2.0, 'llm-context': 1.8, code: 1.5, implemented: 1.2, note: 1.0, backlog: 0.4 },
  'planning':      { backlog: 2.0, implemented: 1.5, note: 1.0, skill: 0.8, 'llm-context': 0.6, code: 0.5 },
  'neutral':       { skill: 1.0, 'llm-context': 1.0, implemented: 1.0, backlog: 1.0, code: 1.0, note: 1.0 },
};

/**
 * Infer query intent from a query string.
 * Lightweight heuristic — no LLM call required.
 * @param {string} queryString
 * @returns {'current-state'|'planning'|'neutral'}
 */
export function inferQueryIntent(queryString) {
  const q = (queryString || '').toLowerCase();
  const currentStatePatterns = [
    /how does\b/, /how do i\b/, /what does .+ do\b/, /show me\b/,
    /where is\b/, /what is the current\b/, /how is .+ implemented\b/,
    /what is .+ doing\b/,
  ];
  const planningPatterns = [
    /\bplan\b/, /\bdesign\b/, /\bbacklog\b/, /\bstory\b/, /\bstories\b/,
    /what should\b/, /how should we\b/, /\broadmap\b/, /\bfeature request\b/,
    /what('s| is) (planned|next|coming)\b/,
  ];
  if (currentStatePatterns.some(p => p.test(q))) return 'current-state';
  if (planningPatterns.some(p => p.test(q))) return 'planning';
  return 'neutral';
}

const IMPL_KEYWORDS = ['exist', 'implemented', 'registered', 'built', 'shipped'];

export function isImplementationQuery(queryString) {
  const q = (queryString || '').toLowerCase();
  return IMPL_KEYWORDS.some(kw => q.includes(kw));
}

export const NAMESPACE_BOOST = {
  z_implemented: 1.4,
  research: 0.85,
  canonical_source: 1.3,
  default: 1.0,
};

export function getNamespaceBoost(slug, isImplQuery) {
  if (!isImplQuery || !slug) return 1.0;
  if (slug.startsWith('backlog.z_implemented.')) return NAMESPACE_BOOST.z_implemented;
  if (slug.startsWith('research.')) return NAMESPACE_BOOST.research;
  return NAMESPACE_BOOST.default;
}

export function getCanonicalPathBoost(filePath) {
  if (!filePath) return 1.0;
  if (filePath.startsWith('packages/mcp-rks/src/')) return NAMESPACE_BOOST.canonical_source;
  return 1.0;
}
