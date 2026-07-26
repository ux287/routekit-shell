/**
 * Source classification for provenance control.
 * Classifies content into access tiers for graduated retrieval.
 */

export const SOURCE_CLASSES = {
  PUBLIC: 'public',
  PROJECT: 'project',
  CLIENT: 'client',
  SENSITIVE: 'sensitive',
  LEGAL: 'legal'
};

// Path patterns that indicate source class
const PATH_PATTERNS = [
  { pattern: /^clients?[\/.]/, class: SOURCE_CLASSES.CLIENT },
  { pattern: /^vendor[\/.]|^third.?party[\/.]/, class: SOURCE_CLASSES.PUBLIC },
  { pattern: /secrets?[\/.]|credentials?[\/.]|\.env/, class: SOURCE_CLASSES.SENSITIVE },
  { pattern: /legal[\/.]|contracts?[\/.]|compliance[\/.]/, class: SOURCE_CLASSES.LEGAL },
  { pattern: /incident[\/.]|postmortem[\/.]|security[\/.]/, class: SOURCE_CLASSES.SENSITIVE },
];

// Content markers that indicate sensitive content
const SENSITIVE_MARKERS = [
  /\bSECRET\b/i,
  /\bPRIVATE\b/i,
  /\bCONFIDENTIAL\b/i,
  /\bAPI[_-]?KEY\b/i,
  /\bpassword\s*[:=]/i,
];

/**
 * Classify a source based on path, frontmatter, and content.
 * @param {Object} options
 * @param {string} options.path - Relative file path
 * @param {Object} options.frontmatter - Parsed frontmatter (may have source_class)
 * @param {string} options.content - Text content (for marker detection)
 * @param {string} options.domain - Domain type (notes, code, docs)
 * @returns {string} Source class
 */
export function classifySource({ path, frontmatter, content, domain } = {}) {
  // 1. Explicit frontmatter override takes precedence
  if (frontmatter?.source_class && Object.values(SOURCE_CLASSES).includes(frontmatter.source_class)) {
    return frontmatter.source_class;
  }

  // 2. Path pattern matching
  const normalizedPath = (path || '').toLowerCase();
  for (const { pattern, class: cls } of PATH_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return cls;
    }
  }

  // 3. Content marker detection (only check first 2000 chars for performance)
  const contentSample = (content || '').slice(0, 2000);
  for (const marker of SENSITIVE_MARKERS) {
    if (marker.test(contentSample)) {
      return SOURCE_CLASSES.SENSITIVE;
    }
  }

  // 4. Default based on domain
  return SOURCE_CLASSES.PROJECT;
}

/**
 * Content type taxonomy for query-time re-ranking.
 * Classifies chunks by their role in the project so queries can boost
 * current-implementation sources over historical planning docs.
 */
export const CONTENT_TYPES = {
  SKILL: 'skill',
  LLM_CONTEXT: 'llm-context',
  IMPLEMENTED: 'implemented',
  BACKLOG: 'backlog',
  CODE: 'code',
  NOTE: 'note',
};

const LLM_CONTEXT_FILES = new Set(['CLAUDE.md', 'MEMORY.md', 'agents.md']);

/**
 * Classify a file path into a content type for RAG re-ranking.
 * Classification is precedence-ordered — first match wins.
 * @param {string} path - Relative file path
 * @param {string|null} noteType - Dendron note_type (e.g. 'backlog', 'feat')
 * @returns {string} One of CONTENT_TYPES values
 */
export function classifyContentType(path, noteType) {
  const p = (path || '').replace(/\\/g, '/');
  const basename = p.split('/').pop() || '';

  // 1. Skills — live skill definitions
  if (p.startsWith('.claude/skills/')) return CONTENT_TYPES.SKILL;

  // 2. LLM context — runtime prompts and instructions
  if (p.startsWith('.rks/prompts/')) return CONTENT_TYPES.LLM_CONTEXT;
  if (p.startsWith('.claude/') && LLM_CONTEXT_FILES.has(basename)) return CONTENT_TYPES.LLM_CONTEXT;
  if (basename === 'CLAUDE.md') return CONTENT_TYPES.LLM_CONTEXT;

  // 3. Implemented stories — shipped work, historical record.
  // Actual convention: z_implemented is a namespace extension under backlog,
  // so shipped notes live under the backlog.z_implemented.* prefix. Both
  // full-path and basename forms are matched. This rule precedes the
  // BACKLOG check below so shipped stories are not swept into the planning
  // bucket at query-time re-ranking.
  if (/(?:^|\/)notes\/backlog\.z_implemented\./.test(p) || /^backlog\.z_implemented\./.test(basename)) return CONTENT_TYPES.IMPLEMENTED;

  // 4. Backlog — unimplemented planning docs (also catch via note_type)
  if (/(?:^|\/)notes\/backlog\./.test(p) || /^backlog\./.test(basename)) return CONTENT_TYPES.BACKLOG;
  if (noteType === 'backlog') return CONTENT_TYPES.BACKLOG;

  // 5. Code — any non-markdown source file not already classified above
  if (!/\.md$/i.test(p)) return CONTENT_TYPES.CODE;

  // 6. Note — everything else (scratch, research, how-to, etc.)
  return CONTENT_TYPES.NOTE;
}

export default { SOURCE_CLASSES, classifySource, CONTENT_TYPES, classifyContentType };
