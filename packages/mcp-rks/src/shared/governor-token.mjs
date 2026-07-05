import crypto from "crypto";
import fs from "fs";
import path from "path";
import { checkStateAllowed, getNextState, transitionOnResult, isTerminal, QA_FLOW_TOOLS, SHIP_FLOW_TOOLS } from "./governor-state.mjs";
import { getTelemetryCollector } from "../server/telemetry/index.mjs";

// Best-effort telemetry for chain-state rejections (backlog.feat.chain-violation-telemetry-server-slice).
// NEVER throws into the caller — a telemetry failure must not block or alter the chain_violation
// return value. Local (non-exported) on purpose. Fires only on the REJECTION path (zero overhead
// on allowed calls). The canonical collector envelope is used (no hand-rolled shape).
function emitChainViolation(session, { blockedTool, flowType, state, violationKind, message, expectedTools } = {}) {
  try {
    getTelemetryCollector().emit("chain.violation", session?.projectId || null, {
      blockedTool,
      flowType: flowType ?? session?.flowType ?? null,
      state: state ?? session?.state ?? null,
      expectedTools: Array.isArray(expectedTools) ? expectedTools : [],
      violationKind,
      problemId: session?.problemId ?? null,
      sessionId: session?.token ?? null,
      message: message ?? null,
    });
  } catch {
    /* best-effort: telemetry must never block the chain */
  }
}

/**
 * Governor session token store with disk persistence.
 *
 * Sessions live in-memory (governorSessions Map) for fast access,
 * with a file-backed persistence layer (.rks/governor-session.json)
 * that survives MCP server process restarts.
 *
 * Lifecycle:
 *   1. Governor calls rks_governor_init → createSession() → persisted to disk
 *   2. Subsequent MCP calls include the token for validation
 *   3. If the server restarts, validateToken() rehydrates from disk
 *   4. endSession() or resetToken() cleans up both memory and disk
 *
 * Phase 1 (state machine): supports multiple concurrent sessions via Map.
 * Each session tracks flowType and allowed tools.
 * Phase 2 (state tracking): sessions track current state and enforce sequencing.
 */

// ── Session TTL ──────────────────────────────────────────────────────
/** Session TTL in milliseconds (30 minutes) */
const MAX_AGE_MS = 30 * 60 * 1000;
/** Warn when session age exceeds this fraction of MAX_AGE_MS */
const WARN_THRESHOLD = 0.8;

// ── Session persistence ──────────────────────────────────────────────

/** @type {string|null} Resolved project root for persistence path */
let _projectRoot = null;

// ── Stash cleanup registry ───────────────────────────────────────────
// Maps token → async cleanup function to call on session end.
// Allows callers (e.g. server.mjs) to register a stash pop that fires automatically
// when the session reaches a terminal state.
const _pendingStashCleanup = new Map();

/**
 * Set the project root for session persistence.
 * Must be called before createSession if persistence is desired.
 * @param {string} root - Absolute path to the project root
 */
export function setProjectRoot(root) {
  _projectRoot = root;
}

/**
 * Get the persistence file path.
 * @returns {string|null}
 */
function getSessionFilePath() {
  if (!_projectRoot) return null;
  return path.join(_projectRoot, ".rks", "governor-session.json");
}

/**
 * Persist the current session to disk.
 * Best-effort — failures are silently ignored.
 * @param {GovernorSession} session
 */
function persistSession(session) {
  const filePath = getSessionFilePath();
  if (!filePath) return;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
  } catch { /* best-effort */ }
}

/**
 * Load a persisted session from disk into memory.
 * Returns the session if found and valid, null otherwise.
 * @returns {GovernorSession|null}
 */
function loadPersistedSession() {
  const filePath = getSessionFilePath();
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data?.token || !data?.projectId) return null;
    // Refuse to rehydrate terminal sessions — they completed their purpose
    if (data.state && data.flowType && isTerminal(data.flowType, data.state)) {
      removePersistedSession();
      return null;
    }
    // Refuse to rehydrate sessions stuck in executing — treat as crashed
    if (data.state === 'executing') {
      removePersistedSession();
      return null;
    }
    // Reject sessions older than 30 minutes
    const MAX_AGE_MS = 30 * 60 * 1000;
    if (Date.now() - (data.lastActivity || data.createdAt || 0) > MAX_AGE_MS) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Remove the persisted session file.
 */
function removePersistedSession() {
  const filePath = getSessionFilePath();
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* best-effort */ }
}

// ── Governor Sessions Map ───────────────────────────────────────────

/**
 * @typedef {Object} GovernorSession
 * @property {string} token - The session token
 * @property {string} projectId - Project this session is bound to
 * @property {'story'|'open'|'qa'|'ship'} flowType - Flow type (explicit or inferred)
 * @property {'story'|'open'|'qa'|'ship'} sessionType - Session type (same as flowType, exposed for convenience)
 * @property {string|null} problemId - Backlog story ID (null for open flow)
 * @property {string} state - Current state in the state machine
 * @property {number} createdAt - Timestamp of session creation
 * @property {number} lastActivity - Timestamp of last tool call
 */

/** @type {Map<string, GovernorSession>} */
const governorSessions = new Map();

// ── Flow-type allowlists ────────────────────────────────────────────

/**
 * Tools allowed in story-based flow (refine → plan → exec → ship).
 */
export const STORY_FLOW_TOOLS = new Set([
  'rks_refine',
  'rks_refine_apply',
  'rks_agent_research',
  'rks_agent_external_research',
  'rks_exhaustive_search',
  'rks_agent_git',
  'rks_agent_visual',
  'rks_plan',
  'rks_plan_review',
  'rks_plan_ready',
  'rks_exec',
  'rks_exec_abort',
  // rks_ship removed — restricted to Ship Governor (unprotected one-shot, no token)
  'rks_preflight',
  'rks_analyze',
  'rks_agent_dendron',
  // Dendron tools needed for decompose path
  'dendron_create_note',
  'dendron_edit_note',
  'dendron_read_note',
  'dendron_update_field',
]);

/**
 * Tools allowed in open/notes flow (research → create/edit notes).
 */
export const OPEN_FLOW_TOOLS = new Set([
  'rks_agent_research',
  'rks_agent_external_research',
  'rks_exhaustive_search',
  'rks_agent_recovery',
  'rks_agent_git',
  'rks_agent_visual',
  'rks_agent_dendron',
  'dendron_create_note',
  'dendron_edit_note',
  'dendron_read_note',
  'dendron_update_field',
  'rks_preflight',
]);

/**
 * Tools allowed in ops flow (runtime command execution — no plan/exec cycle).
 * For operational tasks like checking balances, scanning signals, running scripts.
 */
export const OPS_FLOW_TOOLS = new Set([
  'rks_agent_run',
  'rks_agent_git',
  'rks_agent_research',
  'rks_agent_external_research',
  'rks_exhaustive_search',
  'rks_agent_recovery',
  'rks_project_get',
  'rks_preflight',
  'rks_telemetry_query',
  'rks_telemetry_report',
  'rks_rag_query',
  'rks_release',
  'rks_tag',
  'dendron_read_note',
]);

/**
 * Tools always allowed regardless of flow type.
 */
export const COMMON_TOOLS = new Set([
  'rks_governor_init',
  'rks_project_get',
  'rks_guardrails_on',
  'rks_guardrails_off',
  'rks_guardrails_status',
  'rks_agent_visual',
  // Onboarding/setup utilities — callable in any flow (mirror UNPROTECTED_TOOLS so an active
  // session can reach them; without this the chain gate returns chain_violation).
  'rks_onboarder',
  'rks_templates_list',
  // rks_ship removed — Build Governors must not call ship directly
]);

// ── Legacy singleton (kept for backward compat during transition) ───

/** @type {string | null} */
let _activeToken = null;

/** @type {string | null} */
let _sessionId = null;

// ── Story 1: Core token CRUD ────────────────────────────────────────

/**
 * Generate a cryptographically random session token.
 * Optionally binds the token to a session ID for scoping.
 * @param {string} [sessionId] - Optional session identifier to bind to this token
 * @returns {string} A UUID v4 token
 */
export function generateToken(sessionId) {
  if (sessionId) {
    _sessionId = sessionId;
  }
  return crypto.randomUUID();
}

/**
 * Store the active session token in memory.
 * @param {string} token
 */
export function setToken(token) {
  _activeToken = token;
}

/**
 * Retrieve the current session token.
 * @returns {string | null} The active token, or null if not initialized
 */
export function getToken() {
  return _activeToken;
}

/**
 * Validate a provided token against the stored session token.
 * Also checks the governorSessions Map.
 * @param {string} provided - The token to validate
 * @returns {boolean} True if the provided token matches a valid session
 */
export function validateToken(provided) {
  if (!provided) return false;
  // Check sessions Map first (Phase 1 path)
  if (governorSessions.has(provided)) return true;
  // Legacy singleton fallback
  if (_activeToken && _activeToken === provided) return true;
  // Disk rehydration: if token not in memory, try loading from persisted session.
  // This handles MCP server process restarts during a Governor chain.
  const persisted = loadPersistedSession();
  if (persisted && persisted.token === provided) {
    // Rehydrate into memory
    governorSessions.set(persisted.token, persisted);
    _activeToken = persisted.token;
    _sessionId = persisted.projectId;
    return true;
  }
  return false;
}

// ── Story 2: Token scope & reset ────────────────────────────────────

/**
 * Clear both the active token and session binding.
 * Also clears all governor sessions.
 * Used when a Governor session ends or needs to be recycled.
 */
export function resetToken() {
  _activeToken = null;
  _sessionId = null;
  governorSessions.clear();
  removePersistedSession();
}

// ── Phase 1: Session management ─────────────────────────────────────

/**
 * Create a new governor session with flowType inference or explicit override.
 *
 * flowType resolution (in priority order):
 *   1. Explicit flowType param → use as-is
 *   2. problemId provided → 'story'
 *   3. Neither → 'open'
 *
 * @param {{ projectId: string, problemId?: string, flowType?: 'story'|'open'|'qa'|'ship' }} opts
 * @returns {{ token: string, flowType: string, session: GovernorSession }}
 */
export function createSession({ projectId, problemId, flowType: explicitFlowType }) {
  const token = crypto.randomUUID();
  const flowType = explicitFlowType || (problemId ? 'story' : 'open');
  const now = Date.now();

  /** @type {GovernorSession} */
  const session = {
    token,
    projectId,
    flowType,
    sessionType: flowType,
    problemId: problemId || null,
    state: 'init',
    guardrailsDisabled: false,
    createdAt: now,
    lastActivity: now,
    toolCallCounts: {},
  };

  governorSessions.set(token, session);
  // Also set legacy singleton for backward compat
  _activeToken = token;
  _sessionId = projectId;
  // Persist to disk for server restart recovery
  persistSession(session);

  // Emit governor.init lifecycle event (best-effort)
  try {
    const collector = getTelemetryCollector();
    collector.emit("governor.init", projectId, { projectId, flowType, sessionId: token });
  } catch (e) { /* telemetry is best-effort */ }

  return { token, flowType, session };
}

/**
 * Retrieve a governor session by token.
 * @param {string} token
 * @returns {GovernorSession|null}
 */
export function getSession(token) {
  return governorSessions.get(token) || null;
}

/**
 * End a specific governor session.
 * @param {string} token
 */
export function endSession(token) {
  const session = governorSessions.get(token);
  if (session?.guardrailsDisabled) {
    const restored = restoreGuardrails();
    if (restored) {
      console.error('[governor-token] Auto-restored guardrails on session end');
    }
  }
  // Auto-pop any pending stash registered for this session
  if (_pendingStashCleanup.has(token)) {
    const cleanupFn = _pendingStashCleanup.get(token);
    _pendingStashCleanup.delete(token);
    if (session?.pendingStash) {
      console.error('[governor-token] Auto-popping pending stash on session end');
      Promise.resolve(cleanupFn()).catch(e => {
        console.error('[governor-token] Stash auto-pop failed:', e.message);
      });
    }
  }
  // Emit tool_summary before removing session data
  try {
    if (session) {
      const collector = getTelemetryCollector();
      collector.emit("governor.tool_summary", session.projectId, {
        sessionId: token,
        projectId: session.projectId,
        flowType: session.flowType,
        toolCallCounts: session.toolCallCounts || {},
        durationMs: Date.now() - (session.createdAt || Date.now()),
      });
    }
  } catch (e) { /* telemetry is best-effort */ }

  governorSessions.delete(token);
  if (_activeToken === token) {
    _activeToken = null;
    _sessionId = null;
  }
  removePersistedSession();
}

/**
 * Mark guardrails as disabled for a session.
 * @param {string} token
 * @param {boolean} [disabled=true]
 */
export function setGuardrailsDisabled(token, disabled = true) {
  const session = governorSessions.get(token);
  if (session) {
    session.guardrailsDisabled = disabled;
  }
}

/**
 * Restore guardrails by moving hooks.bak back to hooks.
 * @returns {boolean} true if restored, false if no-op
 */
export function restoreGuardrails() {
  if (!_projectRoot) return false;
  const hooksDir = path.join(_projectRoot, '.routekit', 'hooks');
  const bakDir = path.join(_projectRoot, '.routekit', 'hooks.bak');
  if (!fs.existsSync(bakDir)) return false;
  try {
    if (fs.existsSync(hooksDir)) {
      fs.rmSync(hooksDir, { recursive: true });
    }
    fs.renameSync(bakDir, hooksDir);
    return true;
  } catch (e) {
    console.warn(`[governor-token] Failed to restore guardrails: ${e.message}`);
    return false;
  }
}

/**
 * Detect orphaned guardrails (hooks.bak exists but no active session).
 * Call at server startup.
 * @returns {boolean} true if restored, false if no-op
 */
export function detectOrphanedGuardrails() {
  if (!_projectRoot) return false;
  const bakDir = path.join(_projectRoot, '.routekit', 'hooks.bak');
  if (!fs.existsSync(bakDir)) return false;
  // If any active session exists, don't restore
  if (governorSessions.size > 0) return false;
  const restored = restoreGuardrails();
  if (restored) {
    console.error('[governor-token] Restored orphaned guardrails (no active session)');
  }
  return restored;
}

/**
 * Touch a session's lastActivity timestamp.
 * @param {string} token
 */
export function touchSession(token) {
  const session = governorSessions.get(token);
  if (session) {
    session.lastActivity = Date.now();
  }
}

/**
 * Check if a tool is allowed for the given governor session.
 * Uses per-state allowlists from the state machine (Phase 2).
 * Returns null if allowed, or a structured error object if blocked.
 *
 * @param {string} token - Governor session token
 * @param {string} toolName - The tool being called
 * @returns {{ ok: false, error: string, tool: string, message: string, state: string, flowType: string } | null}
 */
export function checkAllowedTool(token, toolName) {
  // Common tools always allowed
  if (COMMON_TOOLS.has(toolName)) return null;

  const session = governorSessions.get(token);
  if (!session) {
    // Token validated but session not in Map — reject.
    // Self-bootstrapping agents (rks_agent_research) create a real session before calling tools.
    return {
      ok: false,
      error: 'unauthorized',
      tool: toolName,
      message: `No active Governor session for token. Call rks_governor_init first.`,
    };
  }

  // Touch activity timestamp
  session.lastActivity = Date.now();

  // Phase 2: per-state check from state machine
  const stateCheck = checkStateAllowed(session.flowType, session.state, toolName);
  if (stateCheck.allowed) {
    session.toolCallCounts = session.toolCallCounts || {};
    session.toolCallCounts[toolName] = (session.toolCallCounts[toolName] || 0) + 1;
    return null;
  }

  // Tool not allowed in current state — chain violation
  emitChainViolation(session, {
    blockedTool: toolName,
    flowType: session.flowType,
    state: session.state,
    violationKind: "state_machine",
    message: stateCheck.error || undefined,
  });
  return {
    ok: false,
    error: "chain_violation",
    tool: toolName,
    flowType: session.flowType,
    state: session.state,
    message: stateCheck.error ||
      `Blocked: '${toolName}' is not allowed in state '${session.state}' (${session.flowType} flow). ` +
      `Focus on the chain. If something failed, return { status: 'failed' } with the error.`,
  };
}

/**
 * Advance the session state after a tool call.
 * Should be called BEFORE the tool executes (on tool entry).
 *
 * @param {string} token - Governor session token
 * @param {string} toolName - The tool that was called
 * @returns {{ previousState: string, newState: string, transitioned: boolean } | null}
 */
export function advanceState(token, toolName) {
  const session = governorSessions.get(token);
  if (!session) return null;

  const previousState = session.state;
  const newState = getNextState(session.flowType, previousState, toolName);

  if (newState !== previousState) {
    session.state = newState;
    if (isTerminal(session.flowType, newState)) {
      endSession(token);
    } else {
      persistSession(session);
    }
    return { previousState, newState, transitioned: true };
  }

  return { previousState, newState: previousState, transitioned: false };
}

/**
 * Advance the session state based on a tool's result.
 * Should be called AFTER the tool completes (on tool exit).
 *
 * @param {string} token - Governor session token
 * @param {string} resultKey - e.g., 'plan.ok', 'plan.failed', 'exec.ok'
 * @returns {{ previousState: string, newState: string, transitioned: boolean } | null}
 */
export function advanceStateOnResult(token, resultKey) {
  const session = governorSessions.get(token);
  if (!session) return null;

  const previousState = session.state;
  const newState = transitionOnResult(session.flowType, previousState, resultKey);

  if (newState !== previousState) {
    session.state = newState;
    if (isTerminal(session.flowType, newState)) {
      endSession(token);
    } else {
      persistSession(session);
    }
    return { previousState, newState, transitioned: true };
  }

  return { previousState, newState: previousState, transitioned: false };
}

/**
 * Check if the session is in a terminal state.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isSessionTerminal(token) {
  const session = governorSessions.get(token);
  if (!session) return false;
  return isTerminal(session.flowType, session.state);
}

/**
 * Record that a stash save was performed for this session and register
 * a cleanup function to auto-pop it when the session ends.
 *
 * @param {string} token - Governor session token
 * @param {() => Promise<void>} cleanupFn - Async function that pops the stash
 */
export function setPendingStash(token, cleanupFn) {
  const session = governorSessions.get(token);
  if (!session) return;
  session.pendingStash = true;
  _pendingStashCleanup.set(token, cleanupFn);
}

/**
 * Clear the pending stash for this session (called after a successful pop or drop).
 *
 * @param {string} token - Governor session token
 */
export function clearPendingStash(token) {
  const session = governorSessions.get(token);
  if (session) {
    session.pendingStash = false;
  }
  _pendingStashCleanup.delete(token);
}

// ── Phase 3: Decompose and child tracking ───────────────────────────

/**
 * @typedef {Object} ChildStory
 * @property {string} childId - The child story's problemId
 * @property {'pending'|'refining'|'planning'|'executing'|'complete'|'failed'} childState
 * @property {number} startedAt - When this child started processing
 * @property {number} completedAt - When this child finished (0 if not done)
 */

/**
 * Set the child queue for a decomposed story.
 * Called when refine_apply returns decomposed: true with children.
 *
 * @param {string} token
 * @param {Array<{ childId: string }>} children - Ordered list of child stories
 * @returns {{ ok: boolean, childCount: number } | null}
 */
export function setChildQueue(token, children) {
  const session = governorSessions.get(token);
  if (!session) return null;

  session.childQueue = children.map(c => ({
    childId: c.childId,
    childState: 'pending',
    startedAt: 0,
    completedAt: 0,
  }));
  session.activeChildIndex = 0;

  return { ok: true, childCount: session.childQueue.length };
}

/**
 * Get the currently active child story.
 *
 * @param {string} token
 * @returns {{ childId: string, childState: string, index: number, total: number } | null}
 */
export function getActiveChild(token) {
  const session = governorSessions.get(token);
  if (!session?.childQueue?.length) return null;

  const idx = session.activeChildIndex ?? 0;
  if (idx >= session.childQueue.length) return null;

  const child = session.childQueue[idx];
  return {
    childId: child.childId,
    childState: child.childState,
    index: idx,
    total: session.childQueue.length,
  };
}

/**
 * Update the active child's sub-state.
 * Called as each child progresses through refine → plan → exec.
 *
 * @param {string} token
 * @param {'refining'|'planning'|'executing'|'complete'|'failed'} childState
 * @returns {{ childId: string, childState: string } | null}
 */
export function updateChildState(token, childState) {
  const session = governorSessions.get(token);
  if (!session?.childQueue?.length) return null;

  const idx = session.activeChildIndex ?? 0;
  if (idx >= session.childQueue.length) return null;

  const child = session.childQueue[idx];
  child.childState = childState;

  if (childState === 'refining' && !child.startedAt) {
    child.startedAt = Date.now();
  }
  if (childState === 'complete' || childState === 'failed') {
    child.completedAt = Date.now();
  }

  return { childId: child.childId, childState };
}

/**
 * Advance to the next child story after the current one completes.
 * Returns null if no more children (all done).
 *
 * @param {string} token
 * @returns {{ childId: string, index: number, total: number, allComplete: boolean } | null}
 */
export function advanceToNextChild(token) {
  const session = governorSessions.get(token);
  if (!session?.childQueue?.length) return null;

  const nextIdx = (session.activeChildIndex ?? 0) + 1;

  if (nextIdx >= session.childQueue.length) {
    // All children processed
    return {
      childId: null,
      index: nextIdx,
      total: session.childQueue.length,
      allComplete: true,
    };
  }

  session.activeChildIndex = nextIdx;
  return {
    childId: session.childQueue[nextIdx].childId,
    index: nextIdx,
    total: session.childQueue.length,
    allComplete: false,
  };
}

/**
 * Get a summary of all children and their states.
 *
 * @param {string} token
 * @returns {Array<ChildStory> | null}
 */
export function getChildSummary(token) {
  const session = governorSessions.get(token);
  if (!session?.childQueue) return null;
  return [...session.childQueue];
}

// ── Story 3: Unauthorized response helpers ──────────────────────────

/**
 * Build a standardized unauthorized-access response object.
 * @param {string} toolName - The tool that was called without authorization
 * @returns {object} A structured error response directing the caller to launch a Governor
 */
export function unauthorizedResponse(toolName) {
  return {
    ok: false,
    error: "unauthorized",
    tool: toolName,
    message: "This tool requires Governor authorization. Do not call it directly — launch a Governor instead.",
    redirect: {
      action: "Launch a Governor via Task(subagent_type: 'general-purpose')",
      reason: "MCP tools require a valid Governor session token obtained via rks_governor_init"
    }
  };
}

/**
 * Gate a tool call behind token validation.
 * Returns null if the token is valid (caller should proceed),
 * or an unauthorizedResponse object if invalid (caller should return it).
 * @param {string} provided - The token provided by the caller
 * @param {string} toolName - The tool being invoked
 * @returns {object | null} null if authorized, error response object if not
 */
export function requireToken(provided, toolName) {
  if (validateToken(provided)) {
    return null;
  }
  return unauthorizedResponse(toolName);
}

// ── Story 4: Tool protection allow-list ─────────────────────────────

/**
 * Tools that do NOT require a Governor session token.
 * Bootstrap, onboarding, and infrastructure tools that are safe to call
 * without a Governor session. Workflow tools (plan, exec, refine, ship)
 * are intentionally NOT here — they require a token so the state machine
 * can enforce sequencing.
 *
 * rks_ship is kept unprotected for the governor-ship one-shot flow
 * (commit+PR outside the plan/exec cycle).
 */
export const UNPROTECTED_TOOLS = new Set([
  'rks_governor_init',
  'rks_guardrails_on',
  'rks_guardrails_status',
  // rks_guardrails_off is now PROTECTED — blocked by state machine (not in any flow)
  'rks_project_get',
  'rks_preflight',
  'rks_telemetry_query',
  'rks_telemetry_report',
  'rks_telemetry_export', // read-only export/redact of telemetry; called directly by /telemetry-export (like query/report)
  // Infrastructure/onboarding tools — setup/utility, not workflow-gated
  `rks_init`,
  'rks_interview',
  'rks_onboarder',
  'rks_templates_list',
  'rks_story_create',
  'rks_rag_init',
  'rks_rag_embed',
  'rks_rag_query',
  'rks_rag_compact',
  // Recovery tools — must be callable to abort a stuck exec
  'rks_exec_abort',
  // Ship tools unprotected — deterministic workflow, no need for AI agent routing
  'rks_ship',
  'rks_story_ship',
]);

/**
 * Check whether a tool requires Governor token authorization.
 * @param {string} toolName - The tool name to check
 * @returns {boolean} True if the tool requires a token, false if it's unprotected
 */
export function isProtectedTool(toolName) {
  return !UNPROTECTED_TOOLS.has(toolName);
}

// ── Story 5: Tool authorization abstraction ─────────────────────────

/**
 * Dendron namespace enforcement map.
 * Maps flowType to allowed note namespaces for write operations.
 * 'open' flow (PO + Research) can write to all note namespaces.
 * 'story' flow (Build) can only write to backlog.* (for phase transitions).
 */
const NAMESPACE_ALLOWLIST = {
  open: null,  // null = all namespaces allowed
  story: new Set(['backlog']),
  qa: new Set(['qa', 'backlog']),
};

/** Dendron tools that perform write operations */
const DENDRON_WRITE_TOOLS = new Set([
  'dendron_create_note',
  'dendron_edit_note',
  'dendron_update_field',
]);

/**
 * Assert that a tool call is allowed under the current session.
 * Single entry point for all tool authorization logic.
 *
 * Returns null if the tool is allowed, or a structured error object if blocked.
 * Tools in COMMON_TOOLS bypass all checks and return null immediately.
 *
 * Checks performed (in order):
 * 1. COMMON_TOOLS bypass
 * 2. Token validation
 * 3. Flow-type allowlist
 * 4. State machine permission
 * 5. Dendron namespace enforcement (when args provided)
 * 6. Proto-story guard (phase:ready restricted to open flow)
 *
 * @param {string} token - Governor session token (or null/empty)
 * @param {string} toolName - The tool being invoked
 * @param {object} [args] - Tool arguments for context-aware checks
 * @returns {null | { ok: false, error: string, tool: string, flowType?: string, state?: string, message: string }}
 */
export function assertToolAllowed(token, toolName, args) {
  // Tools in COMMON_TOOLS are always allowed, even without a token
  if (COMMON_TOOLS.has(toolName)) {
    return null;
  }

  // For protected tools, validate token
  if (!token || typeof token !== 'string') {
    return {
      ok: false,
      error: 'unauthorized',
      tool: toolName,
      message: `Tool '${toolName}' requires a valid Governor session token.`,
    };
  }

  // Lookup session by token
  const session = governorSessions.get(token);
  if (!session) {
    return {
      ok: false,
      error: 'unauthorized',
      tool: toolName,
      message: `Invalid or expired Governor session token.`,
    };
  }

  // Check if tool is allowed in the session's flow type
  const flowAllowlist = session.flowType === 'qa' ? QA_FLOW_TOOLS
    : session.flowType === 'ship' ? SHIP_FLOW_TOOLS
    : session.flowType === 'ops' ? OPS_FLOW_TOOLS
    : session.flowType === 'story' ? STORY_FLOW_TOOLS : OPEN_FLOW_TOOLS;
  if (!flowAllowlist.has(toolName)) {
    emitChainViolation(session, {
      blockedTool: toolName,
      flowType: session.flowType,
      state: session.state,
      violationKind: "flow_allowlist",
      expectedTools: Array.from(flowAllowlist),
      message: `Tool '${toolName}' is not allowed in '${session.flowType}' flow.`,
    });
    return {
      ok: false,
      error: 'chain_violation',
      tool: toolName,
      flowType: session.flowType,
      state: session.state,
      message: `Tool '${toolName}' is not allowed in '${session.flowType}' flow.`,
    };
  }

  // Check state machine permission
  const stateCheck = checkStateAllowed(session.flowType, session.state, toolName);
  if (!stateCheck.allowed) {
    emitChainViolation(session, {
      blockedTool: toolName,
      flowType: session.flowType,
      state: session.state,
      violationKind: "state_machine",
      message: stateCheck.error || undefined,
    });
    return {
      ok: false,
      error: 'chain_violation',
      tool: toolName,
      flowType: session.flowType,
      state: session.state,
      message: stateCheck.error || `Tool '${toolName}' is not allowed in state '${session.state}' for '${session.flowType}' flow.`,
    };
  }

  // Dendron namespace enforcement
  if (args && DENDRON_WRITE_TOOLS.has(toolName)) {
    const filename = args.filename;
    if (filename) {
      const namespace = filename.split('.')[0];
      const allowed = NAMESPACE_ALLOWLIST[session.flowType];
      if (allowed && !allowed.has(namespace)) {
        return {
          ok: false,
          error: 'namespace_violation',
          tool: toolName,
          flowType: session.flowType,
          sessionType: session.sessionType,
          message: `Namespace '${namespace}' is not allowed for '${session.flowType}' flow. Allowed: ${[...allowed].join(', ')}.`,
        };
      }
    }

    // Proto-story guard: only open flow (PO) or QA flow can set phase to 'ready'
    if (toolName === 'dendron_update_field' && args.field === 'phase' && args.value === 'ready') {
      if (session.flowType !== 'open' && session.flowType !== 'qa') {
        return {
          ok: false,
          error: 'proto_story_guard',
          tool: toolName,
          flowType: session.flowType,
          sessionType: session.sessionType,
          message: `Only PO (open flow) or QA sessions can set phase to 'ready'. Current flow: '${session.flowType}'.`,
        };
      }
    }
  }

  // Increment tool call counter for this session
  if (session) {
    session.toolCallCounts = session.toolCallCounts || {};
    session.toolCallCounts[toolName] = (session.toolCallCounts[toolName] || 0) + 1;
  }

  // Session idle warning: attach _sessionWarning if age > 80% of TTL (non-blocking)
  if (session) {
    const age = Date.now() - (session.createdAt || Date.now());
    if (age > MAX_AGE_MS * WARN_THRESHOLD) {
      const msRemaining = Math.max(0, MAX_AGE_MS - age);
      const minsRemaining = Math.max(1, Math.ceil(msRemaining / 60000));
      session._sessionWarning = `Session expires in ${minsRemaining}m`;
    } else {
      session._sessionWarning = undefined;
    }
  }

  return null;
}
