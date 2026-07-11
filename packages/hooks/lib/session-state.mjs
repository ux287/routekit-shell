import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { normalizePath as normalizePathShared, getProjectRoot } from "./path-utils.mjs";

const PROJECT_DIR = getProjectRoot();
const SESSION_DIR = path.join(PROJECT_DIR, '.rks', 'session');
const STATE_PATH = path.join(SESSION_DIR, 'state.json');
const LOCK_PATH = path.join(SESSION_DIR, '.lock');
const STALE_LOCK_MS = 5000;

// TTL backstop for the session write-ledger: a path the session wrote grants a
// provenance-free read for this long. The primary boundary is clearSessionState()
// (embed on commit); this bound just stops a stale write from granting reads
// indefinitely. Timestamp-compare, mirroring GIT_CACHE_TTL_MS (NOT the disabled
// generic isExpired). Exported for read-classification.mjs and the ledger tests.
export const WRITE_LEDGER_TTL_MS = 10 * 60 * 1000; // 10 minutes

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function now() {
  return Date.now();
}

function readRawState() {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) return null;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function acquireLock() {
  ensureDir();
  try {
    // Try to create lock exclusively
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeSync(fd, String(now()));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    // If lock exists, consider stale check
    try {
      const s = fs.statSync(LOCK_PATH);
      const age = Date.now() - s.mtimeMs;
      if (age > STALE_LOCK_MS) {
        // stale - remove
        try { fs.unlinkSync(LOCK_PATH); } catch {}
        // try again
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeSync(fd, String(now()));
        fs.closeSync(fd);
        return true;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
}

/**
 * Valid phases for the progressive provenance cone.
 * Enforcement scales with formality:
 *   discovery → RA-preferred, reads tracked (session default)
 *   planning  → scoped to plan targetFiles
 *   execution → full enforcement, all reads need provenance
 */
const PHASES = ['discovery', 'planning', 'execution'];

function defaultState() {
  return {
    ragSourcedPaths: [],
    userSpecifiedPaths: [],
    writtenPaths: [], // session write-ledger: { path, timestamp } — read what you just wrote
    planContext: null,
    readHistory: [],
    turnCount: 0,
    phase: 'discovery',
    gitProvenanceCache: null, // { paths: string[], timestamp: number }
    updatedAt: new Date().toISOString(),
  };
}

export function loadSessionState() {
  // Acquire lock not strictly required for reads but we will try to be conservative
  const raw = readRawState();
  const state = raw || defaultState();
  // Run expiry on load
  try {
    expireEntries(state);
  } catch (e) {}
  return state;
}

export function saveSessionState(state) {
  ensureDir();
  // Write atomically by taking lock and writing file
  const locked = acquireLock();
  if (!locked) {
    // best-effort: try once more, otherwise throw
    if (!acquireLock()) throw new Error('Unable to acquire session lock');
  }
  try {
    state.updatedAt = new Date().toISOString();
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
  } finally {
    releaseLock();
  }
}

// Re-export from path-utils — pass projectRoot for consistent absolute→relative normalization
export function normalizePath(p) {
  return normalizePathShared(p, getProjectRoot());
}

function expireEntries(state) {
  // TTL-based expiry removed - provenance now persists until explicit clearSessionState()
  // which is called on embed events (commit hook). This provides natural session boundaries.
  // Only keep readHistory bounded to prevent unbounded growth.
  state.readHistory = (state.readHistory || []).slice(-200);
}

export function addRagSourcedPath(p, query) {
  try {
    const state = loadSessionState();
    const pathNorm = normalizePath(p);
    const existing = (state.ragSourcedPaths || []).find(r => r.path === pathNorm);
    if (existing) {
      existing.query = query || existing.query;
      existing.timestamp = now();
    } else {
      state.ragSourcedPaths.push({ path: pathNorm, query: query || null, timestamp: now() });
    }
    saveSessionState(state);
  } catch (e) {
    // best-effort
  }
}

export function addUserSpecifiedPath(p, messageSnippet) {
  try {
    const state = loadSessionState();
    const pathNorm = normalizePath(p);
    const existing = (state.userSpecifiedPaths || []).find(r => r.path === pathNorm);
    if (existing) {
      existing.messageSnippet = messageSnippet || existing.messageSnippet;
      existing.timestamp = now();
    } else {
      state.userSpecifiedPaths.push({ path: pathNorm, messageSnippet: messageSnippet || null, timestamp: now() });
    }
    saveSessionState(state);
  } catch (e) {}
}

/**
 * Record a path the current session just wrote (Edit/Write). Populates the
 * write-ledger so read-provenance lets the session read back its own output.
 * Mirrors addRagSourcedPath: normalize, dedupe by path, refresh timestamp.
 * The ledger is the ONLY provenance source populated by writes; it is the
 * write-tier PostToolUse hook (track-write-ledger.mjs) that calls this.
 */
export function recordWrittenPath(p) {
  try {
    const state = loadSessionState();
    const pathNorm = normalizePath(p);
    if (!Array.isArray(state.writtenPaths)) state.writtenPaths = [];
    const existing = state.writtenPaths.find(r => r.path === pathNorm);
    if (existing) {
      existing.timestamp = now();
    } else {
      state.writtenPaths.push({ path: pathNorm, timestamp: now() });
    }
    saveSessionState(state);
  } catch (e) {
    // best-effort
  }
}

export function setPlanContext(planId, targetFiles) {
  try {
    const state = loadSessionState();
    state.planContext = {
      planId: planId || null,
      targetFiles: (targetFiles || []).map(normalizePath),
      activeStep: null,
    };
    saveSessionState(state);
  } catch (e) {}
}

export function clearPlanContext() {
  try {
    const state = loadSessionState();
    state.planContext = null;
    saveSessionState(state);
  } catch (e) {}
}

export function recordRead(p, provenance = 'unknown') {
  try {
    const state = loadSessionState();
    const pathNorm = normalizePath(p);
    state.readHistory = state.readHistory || [];
    state.readHistory.push({ path: pathNorm, timestamp: now(), provenance });
    // keep bounded
    state.readHistory = state.readHistory.slice(-500);
    saveSessionState(state);
  } catch (e) {}
}

export function hasValidProvenance(p) {
  const pathNorm = normalizePath(p);
  try {
    const state = loadSessionState();
    // Check RAG-sourced
    const rag = (state.ragSourcedPaths || []).find(r => r.path === pathNorm);
    if (rag) return { valid: true, source: 'rag', detail: rag.query || null };
    // Check user-specified
    const user = (state.userSpecifiedPaths || []).find(u => u.path === pathNorm);
    if (user) return { valid: true, source: 'user', detail: user.messageSnippet || null };
    // Check plan targets
    if (state.planContext && Array.isArray(state.planContext.targetFiles) && state.planContext.targetFiles.includes(pathNorm)) {
      return { valid: true, source: 'plan', detail: state.planContext.planId || null };
    }
    // Check git-based provenance (files changed on current branch)
    if (hasGitProvenance(pathNorm)) {
      return { valid: true, source: 'git', detail: 'changed on current branch' };
    }
    // Check session write-ledger — a session may read a file it JUST wrote.
    // Mirrors step-8.5 in read-classification.mjs. Session-scoped (this session's
    // state.json), TTL-bounded via WRITE_LEDGER_TTL_MS, and wiped by
    // clearSessionState() on embed — so it does NOT weaken the default block for
    // any non-ledgered path. This is the gate redirect-read-to-agent.mjs actually
    // fires, so the ledger must live here (not only in classifyReadIntent).
    const written = (state.writtenPaths || []).find(w => w.path === pathNorm);
    if (written && written.timestamp && (now() - written.timestamp) < WRITE_LEDGER_TTL_MS) {
      return { valid: true, source: 'session_write', detail: 'read-what-you-wrote' };
    }
  } catch (e) {}
  return { valid: false, source: null, detail: null };
}

export function advanceTurn() {
  try {
    const state = loadSessionState();
    state.turnCount = (state.turnCount || 0) + 1;
    expireEntries(state);
    saveSessionState(state);
  } catch (e) {}
}

/**
 * Get the exploration score: count of "unknown" provenance reads in a
 * sliding time window. This is compared against the `threshold` count
 * in read-policy.yaml (default 3). Returns a count, not a ratio.
 */
export function getExplorationScore() {
  try {
    const state = loadSessionState();
    const reads = state.readHistory || [];
    if (reads.length === 0) return 0;
    const windowMs = 60_000; // 60-second sliding window
    const cutoff = Date.now() - windowMs;
    const recent = reads.filter(r => (r.timestamp || 0) > cutoff);
    return recent.filter(r => !r.provenance || r.provenance === 'unknown').length;
  } catch (e) {
    return 0;
  }
}

/**
 * Get recent reads from history for context reporting
 * @param {number} count - Number of recent reads to return (default 5)
 * @returns {Array<{path: string, reason: string, timestamp: number}>}
 */
export function getRecentReads(count = 5) {
  try {
    const state = loadSessionState();
    const reads = state.readHistory || [];
    return reads.slice(-count).map(r => ({
      path: r.path,
      reason: r.provenance || 'unknown',
      timestamp: r.timestamp
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Clear session state - called on embed events to reset provenance.
 * This provides natural session boundaries: provenance persists until
 * the next embed event (typically on commit), not arbitrary TTL turns.
 */
export function clearSessionState() {
  try {
    const state = defaultState();
    saveSessionState(state);
    return { ok: true, cleared: ['ragSourcedPaths', 'userSpecifiedPaths', 'writtenPaths', 'readHistory', 'turnCount', 'planContext', 'phase'] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Phase tracking (progressive provenance cone) ---

/**
 * Get the current enforcement phase.
 * @returns {string} One of: discovery, planning, execution
 */
export function getPhase() {
  try {
    const state = loadSessionState();
    const phase = state.phase || 'discovery';
    return PHASES.includes(phase) ? phase : 'discovery';
  } catch {
    return 'discovery';
  }
}

/**
 * Set the enforcement phase explicitly.
 * @param {string} phase - One of: discovery, planning, execution
 * @returns {{ ok: boolean, phase: string, error?: string }}
 */
export function setPhase(phase) {
  if (!PHASES.includes(phase)) {
    return { ok: false, phase: 'unknown', error: `Invalid phase: ${phase}. Must be one of: ${PHASES.join(', ')}` };
  }
  try {
    const state = loadSessionState();
    state.phase = phase;
    saveSessionState(state);
    return { ok: true, phase };
  } catch (e) {
    return { ok: false, phase, error: e.message };
  }
}

/**
 * Advance to the next phase in the cone. No-op if already at execution.
 * discovery → planning → execution
 * @returns {{ ok: boolean, from: string, to: string }}
 */
export function advancePhase() {
  try {
    const state = loadSessionState();
    const current = state.phase || 'discovery';
    const idx = PHASES.indexOf(current);
    if (idx < 0 || idx >= PHASES.length - 1) {
      return { ok: true, from: current, to: current };
    }
    const next = PHASES[idx + 1];
    state.phase = next;
    saveSessionState(state);
    return { ok: true, from: current, to: next };
  } catch (e) {
    return { ok: false, from: 'unknown', to: 'unknown', error: e.message };
  }
}

// --- Git-based provenance ---

const GIT_CACHE_TTL_MS = 30_000; // cache git diff results for 30 seconds

/**
 * Get the list of files changed on the current branch relative to main.
 * Uses a 30-second cache to avoid repeated git calls.
 * @returns {string[]} Array of relative file paths changed on this branch
 */
function getGitChangedFiles() {
  try {
    const state = loadSessionState();
    const cache = state.gitProvenanceCache;
    if (cache && cache.timestamp && (now() - cache.timestamp) < GIT_CACHE_TTL_MS) {
      return cache.paths || [];
    }

    // Get files changed on current branch vs main
    const output = execSync('git diff --name-only main...HEAD 2>/dev/null || true', {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout: 5000,
    });

    const paths = output.trim().split('\n').filter(Boolean);

    // Cache the result
    state.gitProvenanceCache = { paths, timestamp: now() };
    saveSessionState(state);

    return paths;
  } catch {
    return [];
  }
}

/**
 * Check if a file has git-based provenance (changed on current branch).
 * Files you're actively working on have natural provenance.
 * @param {string} p - Path to check
 * @returns {boolean}
 */
export function hasGitProvenance(p) {
  const pathNorm = normalizePath(p);
  const changed = getGitChangedFiles();
  return changed.some(f => normalizePath(f) === pathNorm);
}
