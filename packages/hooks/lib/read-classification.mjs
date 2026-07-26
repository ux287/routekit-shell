import { loadSessionState, getExplorationScore, WRITE_LEDGER_TTL_MS } from './session-state.mjs';
import { normalizePath as normalizePathShared, getProjectRoot } from './path-utils.mjs';

/**
 * Classify whether a Read operation is legitimate or exploration
 *
 * @param {Object} context - Read context
 * @param {string} context.targetPath - Path being read
 * @param {string} context.toolName - Tool requesting read (Read, Glob, Grep)
 * @param {Object} context.toolInput - Full tool input object
 * @param {Object} context.config - Read policy config
 * @returns {ClassificationResult}
 */
export function classifyReadIntent(context) {
  const { targetPath, toolName, toolInput, config = {} } = context || {};
  const state = loadSessionState();
  const normalizedPath = normalizePathLocal(targetPath || '');

  // helper constructors
  function allow(reason, confidence, extra = {}) {
    return {
      allowed: true,
      reason,
      confidence: typeof confidence === 'number' ? confidence : 0.5,
      suggestion: null,
      metadata: Object.assign({ provenanceSource: null, explorationScore: 0, matchedRule: null }, extra.metadata || {}, extra),
    };
  }

  function block(reason, confidence, suggestion = null, extra = {}) {
    return {
      allowed: false,
      reason,
      confidence: typeof confidence === 'number' ? confidence : 0.5,
      suggestion,
      metadata: Object.assign({ provenanceSource: null, explorationScore: 0, matchedRule: null }, extra.metadata || {}, extra),
    };
  }

  // 1. Runtime config paths - always allow
  const runtimePaths = (config.runtime_paths || []).slice();
  if (isRuntimeConfigPath(targetPath || '', runtimePaths)) {
    return allow('runtime_config', 1.0, { metadata: { matchedRule: 'runtime_paths' } });
  }

  // 2. Check RAG provenance - BEFORE strict_rag_paths so provenance is honored
  try {
    const ragProvenance = (state.ragSourcedPaths || []).find(p => pathMatches(normalizedPath, normalizePathLocal(p.path || '')));
    if (ragProvenance && !isExpired(ragProvenance, state)) {
      return allow('rag_sourced', 0.95, { metadata: { provenanceSource: 'rag', matchedRule: 'ragSourcedPaths', query: ragProvenance.query || null } });
    }
  } catch (e) { }

  // 3. Check user provenance
  try {
    const userProvenance = (state.userSpecifiedPaths || []).find(p => pathMatches(normalizedPath, normalizePathLocal(p.path || '')));
    if (userProvenance && !isExpired(userProvenance, state)) {
      return allow('user_specified', 0.9, { metadata: { provenanceSource: 'user', matchedRule: 'userSpecifiedPaths' } });
    }
  } catch (e) { }

  // 4. Check plan context
  try {
    if (state.planContext && Array.isArray(state.planContext.targetFiles)) {
      const planTargets = (state.planContext.targetFiles || []).map(t => normalizePathLocal(t));
      if (planTargets.includes(normalizedPath)) {
        return allow('plan_step', 0.95, { metadata: { provenanceSource: 'plan', matchedRule: 'planContext' } });
      }
    }
  } catch (e) { }

  // 5. Strict RAG paths - block only if NO provenance exists
  const strictRag = (config.strict_rag_paths || []).slice();
  if (strictRag.length > 0 && matchesStrictRagPaths(normalizedPath, strictRag)) {
    return block('exploration', 1.0, 'Use rks_rag_query for notes/docs', { metadata: { matchedRule: 'strict_rag_paths' } });
  }

  // 6. Project source file detection — targeted reads of code files are legitimate
  if (toolName === 'Read' && isProjectSourceFile(normalizedPath)) {
    return allow('project_source', 0.75, { metadata: { matchedRule: 'projectSource' } });
  }

  // 7. Pattern search detection
  if (toolName === 'Glob' || toolName === 'Grep') {
    return block('pattern_search', 0.9, 'Use rks_rag_query for code search', { metadata: { matchedRule: 'patternSearchTool' } });
  }

  // 8. Exploration pattern detection (count-based: blocks after N unknown reads in time window)
  const explorationScore = (typeof getExplorationScore === 'function') ? getExplorationScore() : 0;
  const threshold = (config.exploration_detection && typeof config.exploration_detection.threshold === 'number') ? config.exploration_detection.threshold : 3;
  if (explorationScore > threshold) {
    return block('exploration', 0.8, 'Multiple reads without RAG context - use orchestrator_query', { metadata: { explorationScore, matchedRule: 'explorationScore' } });
  }

  // 8.5 Session write-ledger — a session may always read a file it JUST wrote.
  // Placed immediately before the default block: it does NOT weaken the default
  // for any non-ledgered path, and stays behind the strict_rag (5) / Glob-Grep (7)
  // / exploration (8) blocks above. TTL-bounded via WRITE_LEDGER_TTL_MS, session-
  // scoped (this session's state.json), and wiped by clearSessionState() on embed.
  try {
    const written = (state.writtenPaths || []).find(p => pathMatches(normalizedPath, normalizePathLocal(p.path || '')));
    if (written && written.timestamp && (Date.now() - written.timestamp) < WRITE_LEDGER_TTL_MS) {
      return allow('session_write', 0.9, { metadata: { provenanceSource: 'session_write', matchedRule: 'writtenPaths' } });
    }
  } catch (e) { }

  // 9. Default based on mode
  if (config.mode === 'block') {
    return block('unknown', 0.5, 'Path has no provenance - query RAG first', { metadata: { explorationScore, matchedRule: 'default:mode=block' } });
  }

  return allow('unknown', 0.5, { metadata: { explorationScore, matchedRule: 'default:warn' } });
}

// -- Helpers --
function isExpired(entry, state) {
  // TTL-based expiry disabled - provenance now persists until clearSessionState()
  // is called (on embed events). This provides natural session boundaries.
  // Entry is only "expired" if it doesn't exist.
  if (!entry) return true;
  return false;
}

/**
 * Check if a path is a project source file (has a recognized code/config extension).
 * These are legitimate targeted reads, distinct from exploration (which uses Glob/Grep).
 * Exploration abuse is caught by step 8 (count-based detection).
 */
function isProjectSourceFile(filePath) {
  const sourceExtensions = [
    '.mjs', '.js', '.ts', '.tsx', '.jsx', '.cjs',
    '.py', '.go', '.rs', '.rb', '.java', '.c', '.h', '.cpp', '.hpp',
    '.css', '.scss', '.less',
    '.json', '.yaml', '.yml', '.toml',
    '.sh', '.bash', '.zsh',
  ];
  return sourceExtensions.some(ext => filePath.endsWith(ext));
}

// Use shared normalizePath from path-utils.mjs
// Alias for backwards compatibility with internal calls
function normalizePathLocal(p) {
  return normalizePathShared(p, getProjectRoot());
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathMatches(inputPath, pattern, projectRoot = null) {
  if (!pattern) return false;

  // Keep original raw path for absolute-path detection
  let original = inputPath || '';

  // Determine effective project root: explicit param > env CLAUDE_PROJECT_DIR > process.cwd()
  const root = projectRoot || ((process && process.env && process.env.CLAUDE_PROJECT_DIR) ? process.env.CLAUDE_PROJECT_DIR : (process && process.cwd ? process.cwd() : null));

  let pathToTest = original;
  try {
    if (root && pathToTest) {
      // Normalize both for comparison (strip leading slashes)
      const normalizedRoot = normalizePathLocal(root);
      const normalizedInput = normalizePathLocal(pathToTest);
      if (normalizedInput.startsWith(normalizedRoot)) {
        pathToTest = normalizedInput.slice(normalizedRoot.length);
        if (pathToTest.startsWith('/')) pathToTest = pathToTest.slice(1);
      } else {
        pathToTest = normalizedInput;
      }
    }
  } catch (e) { }

  pathToTest = normalizePathLocal(pathToTest || '');
  pattern = String(pattern || '');
  if (pattern.includes('*')) {
    // simple glob -> regex
    const regex = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
    return regex.test(pathToTest);
  }
  return normalizePathLocal(pattern) === pathToTest;
}

function isRuntimeConfigPath(path, runtimePaths) {
  if (!Array.isArray(runtimePaths) || runtimePaths.length === 0) return false;
  return runtimePaths.some(p => pathMatches(path, p, getProjectRoot()));
}

function matchesStrictRagPaths(path, strictPatterns) {
  if (!Array.isArray(strictPatterns) || strictPatterns.length === 0) return false;
  return strictPatterns.some(p => pathMatches(path, p, getProjectRoot()));
}
