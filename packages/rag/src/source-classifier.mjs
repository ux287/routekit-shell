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
  // Sensitive/legal path rules match a WHOLE directory segment (start of path or `/` before, `/`
  // after), a final segment whose name before its first `.` is exactly secret(s)/credential(s)
  // (`config/secrets.json`, `credentials.yaml`), and `.env` only as an actual filename (`.env` /
  // `.env.*`). They never match inside a Dendron dot-name such as `backlog.security.x`,
  // `backlog.feat.env-example` or `backlog.feat.rotate-secrets` (D6 of
  // backlog.fix.source-class-never-projected-fidelity-defaults-permissive).
  { pattern: /(?:^|\/)(?:secrets?|credentials?)(?:\/|\.[^\/]*$)|(?:^|\/)\.env(?:\.[^\/]*)?$/, class: SOURCE_CLASSES.SENSITIVE },
  { pattern: /(?:^|\/)(?:legal|contracts?|compliance)\//, class: SOURCE_CLASSES.LEGAL },
  { pattern: /(?:^|\/)(?:incident|postmortem|security)\//, class: SOURCE_CLASSES.SENSITIVE },
];

// Content markers that indicate sensitive content. They match credential- and PII-SHAPED values,
// not prose that merely discusses secrecy (D2 of
// backlog.fix.source-class-never-projected-fidelity-defaults-permissive). A document that is
// sensitive by policy rather than by content must declare source_class in frontmatter or live under
// a sensitive path (PATH_PATTERNS above).
const SENSITIVE_MARKERS = [
  // Credential assignment carrying a real-looking value (16+ chars), not a bare mention of the name.
  /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-\/+=]{16,}/i,
  // Password assignment carrying a value (4+ non-space chars); tightened from bare `password:`.
  /\bpassword\s*[:=]\s*['"]?[^\s'"]{4,}/i,
  // PEM private key block header.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  // Well-known token shapes: AWS access key id, GitHub token, Slack token, Anthropic/OpenAI key.
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}/,
  // Bearer credential with a token-length value.
  /\bBearer\s+[A-Za-z0-9\-._~+\/]{20,}=*/,
  // PII: US Social Security Number shape.
  /\b\d{3}-\d{2}-\d{4}\b/,
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
