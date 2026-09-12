import path from 'node:path';
import { loadSessionState, getExplorationScore, WRITE_LEDGER_TTL_MS } from './session-state.mjs';
import { normalizePath as normalizePathShared, getProjectRoot } from './path-utils.mjs';

/**
 * Leaf directories the harness writes THIS session's own output into.
 * `tasks` holds background-task output, `tool-results` holds overflowed tool
 * results, `scratchpad` is the harness-designated temp location.
 */
const HARNESS_SESSION_LEAVES = new Set(['tasks', 'scratchpad', 'tool-results']);

/**
 * Is this path output the CURRENT session produced?
 *
 * An agent handed a path to its own overflowed tool result could not read it:
 * the harness persists the output and returns only the path, and the read gates
 * then deny it. This is the narrow allowance for that, keyed to session identity
 * so it cannot become a general read escape hatch.
 *
 * Two properties do the security work, and both are deliberate:
 *
 *  - SEGMENT EQUALITY, never substring. `<session-id>-evil` defeats includes(),
 *    and a sibling directory defeats startsWith(). We split into path segments
 *    and require one to equal the session id exactly.
 *  - NORMALIZE FIRST, then test. A `..` inside an otherwise-valid session prefix
 *    is the obvious bypass; resolving before matching collapses it, so the
 *    traversal is gone before any comparison happens.
 *
 * Fails closed on a missing or blank sessionId — without identity there is no
 * allowance to grant.
 *
 * No Bash allowance — deliberate, and this is the record of that decision.
 * The obvious convenience would be letting `head`/`tail`/`wc` at these paths
 * through redirect-bash-to-governor.mjs. We are not doing that. That hook
 * matches a WHOLE-COMMAND grammar (anchored prefix plus outright rejection of
 * shell metacharacters); it has no argument-scoped allowance mechanism, so
 * carving one out means building new machinery in a WRITE-tier hook to serve a
 * READ need. Read with offset/limit already slices large files, and no case was
 * found that it cannot serve. Revisit only if one turns up.
 */
export function isHarnessSessionOutputPath(targetPath, sessionId) {
  if (typeof targetPath !== 'string' || typeof sessionId !== 'string') return false;
  if (!targetPath || !sessionId.trim()) return false;

  const resolved = path.resolve(targetPath);
  const segments = resolved.split(path.sep).filter(Boolean);

  const idx = segments.indexOf(sessionId);
  if (idx === -1) return false;

  return HARNESS_SESSION_LEAVES.has(segments[idx + 1]);
}

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
  const { targetPath, toolName, toolInput, config = {}, sessionId } = context || {};
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
  //
  // The harness-session-output carve-out has to live HERE as well as at 8.6,
  // not only after 8.5: this rule blocks Glob/Grep before execution ever
  // reaches 8.5, so a rule added later is unreachable for those two tools. One
  // predicate, referenced twice — see isHarnessSessionOutputPath above.
  if ((toolName === 'Glob' || toolName === 'Grep') && !isHarnessSessionOutputPath(targetPath, sessionId)) {
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

  // 8.6 Harness session output — a session may read output it just produced.
  // Same slot and same spirit as 8.5: placed immediately before the default
  // block, so it weakens nothing above it, and scoped to THIS session's id so it
  // grants nothing beyond the agent's own output.
  if (isHarnessSessionOutputPath(targetPath, sessionId)) {
    return allow('session_output', 0.9, { metadata: { provenanceSource: 'session_output', matchedRule: 'harnessSessionOutput' } });
  }

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
