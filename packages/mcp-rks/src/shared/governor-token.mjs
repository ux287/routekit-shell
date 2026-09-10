import crypto from "crypto";
import fs from "fs";
import path from "path";
import { checkStateAllowed, getNextState, transitionOnResult, isTerminal, QA_FLOW_TOOLS, SHIP_FLOW_TOOLS, classifyChainRefusal } from "./governor-state.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";
// shared -> workflow. Verified acyclic: phases.mjs is a leaf with no imports of its own, and
// governor-token.mjs had no prior workflow/ edge.
import { phaseAllows } from "../workflow/phases.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";

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

/**
 * backlog.fix.refine-noop-escalation-false-positive: how many CONSECUTIVE `refine_apply.noop`
 * results escalate the run. 1 was the old behaviour and terminated healthy builds on a single
 * false positive; 2 means "it happened again after the Governor had a populated skipped-ledger
 * to act on", which is the evidence that the story genuinely cannot converge.
 */
const NOOP_ESCALATION_THRESHOLD = 2;

// ── Session persistence ──────────────────────────────────────────────

/** @type {string|null} Resolved project root for persistence path */
let _projectRoot = null;

// ── Stash cleanup registry ───────────────────────────────────────────
// Maps token → async cleanup function to call on session end.
// Allows callers (e.g. server.mjs) to register a stash pop that fires automatically
// when the session reaches a terminal state.
const _pendingStashCleanup = new Map();

// ── In-flight stash pops ─────────────────────────────────────────────
// Maps token → Promise<{ token, projectId, ok, error }> for a pop that endSession
// has FIRED but that has not settled yet.
//
// endSession is synchronous and has three call sites, none of which can await it
// (advanceStateOnResult alone has 18 callers in server.mjs, and endSession has 64
// references across 14 test files — making it async would convert every one of
// those into a new floating promise, relocating this defect rather than fixing
// it). So the promise is RETAINED here instead of dropped, and awaited once at the
// wire layer via flushPendingStashPops(). Without that, a process exiting straight
// after endSession loses the restore and the user's work stays stashed with
// nothing having reported a failure.
const _pendingStashPops = new Map();

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
  // rks_fetch_raw is a research-governor toolbox member: same open-flow paths as
  // external_research. Registered + PROTECTED (network egress → default-deny
  // allowlist), so it needs an explicit flow-allowlist entry to be reachable.
  // Open flow ONLY — story/ops flows intentionally excluded (see governor-state.mjs).
  'rks_fetch_raw',
  'rks_exhaustive_search',
  'rks_agent_recovery',
  'rks_agent_git',
  'rks_agent_visual',
  'rks_agent_dendron',
  'dendron_create_note',
  'dendron_edit_note',
  'dendron_read_note',
  'dendron_update_field',
  // backlog.feat.arch-verdict-monotone-ledger: ARCH inits with no problemId, so
  // it runs the OPEN flow. Without this entry the verdict call returns
  // chain_violation and ARCH can record a verdict by no path at all.
  'rks_arch_verdict',
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
  'rks_guardrails_abort',
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
    // backlog.fix.refine-noop-escalation-false-positive: consecutive-no-op streaks, keyed by
    // result key. Drives escalate-on-repeat in `advanceStateOnResult`; reset by any other result.
    consecutiveNoopCounts: {},
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
 * Record how a stash auto-pop settled.
 *
 * A PLAIN function, deliberately not exported: several suites bound a source
 * window with `src.indexOf("\nexport function", start + 1)` over this file, and a
 * new top-level `export function` would truncate one of those windows. See the
 * note above `resolveStoryPhase`.
 *
 * Emits the raw event name rather than an EventTypes constant, matching the
 * `governor.init` emit above — that event is likewise absent from the registry in
 * packages/telemetry/src/types.mjs, and nothing consumes EventTypes to gate or
 * classify an emit. Registry reconciliation is owned by
 * backlog.fix.unknown-telemetry-events.
 *
 * Best-effort: telemetry must never be able to fail a stash restore.
 */
function emitStashPopOutcome(projectId, payload) {
  try {
    getTelemetryCollector().emit("governor.stash_pop", projectId, payload);
  } catch { /* telemetry is best-effort */ }
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
      // CAPTURED HERE, while the session is still live. The pop settles AFTER the
      // session is dropped from the registry below, so a flush-time lookup by
      // token returns null; and the module-level `_projectRoot` is a singleton
      // reflecting the last setProjectRoot call, not necessarily this session's
      // project. session.projectId is the same value the summary emit below
      // already reads.
      //
      // NB: this comment deliberately avoids writing the registry-delete call or
      // the summary event name as literals — a source-text assertion in
      // tests/unit/session-tool-telemetry.test.mjs locates them by indexOf and
      // would match the prose instead of the code.
      const projectId = session.projectId ?? null;
      // RETAINED, not dropped. The outcome reflects how the pop SETTLED, never
      // merely that it was fired.
      const popPromise = Promise.resolve()
        .then(() => cleanupFn())
        .then(() => {
          emitStashPopOutcome(projectId, { token, ok: true });
          return { token, projectId, ok: true, error: null };
        })
        .catch((e) => {
          const error = e?.message ?? String(e);
          console.error('[governor-token] Stash auto-pop failed:', error);
          emitStashPopOutcome(projectId, { token, ok: false, error });
          return { token, projectId, ok: false, error };
        });
      _pendingStashPops.set(token, popPromise);
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
 * Await every stash auto-pop that endSession has fired but not yet settled.
 *
 * PLACEMENT IS CONSTRAINED, and the constraint is load-bearing. This declaration
 * sits immediately after `endSession` and before `setGuardrailsDisabled`. It MUST
 * NOT be moved between `checkAllowedTool` and `advanceState`: two suites that this
 * story does not edit — tests/unit/research-agent-self-bootstrap.test.mjs (:85,
 * :92, :104) and tests/unit/wire-classify-chain-refusal.test.mjs (:199) — bound a
 * window over exactly that span with `indexOf("\nexport function", start + 1)`,
 * and `export async function` is invisible to that delimiter. A declaration placed
 * inside the span would silently over-extend both windows: their assertions would
 * still pass, while no longer measuring the function they name. A test-level
 * placement guard pins this so a future move reddens CI instead.
 *
 * Returns the settled outcomes so a caller can report a failed restore rather than
 * discovering it from stderr. Resolves to [] when nothing was pending.
 *
 * @returns {Promise<Array<{token: string, projectId: string|null, ok: boolean, error: string|null}>>}
 */
export async function flushPendingStashPops() {
  if (_pendingStashPops.size === 0) return [];
  const inFlight = [..._pendingStashPops.values()];
  // Cleared BEFORE the await: an endSession that fires during the await registers
  // into an empty map and is picked up by the next flush, rather than being
  // dropped by a clear that runs afterwards.
  _pendingStashPops.clear();
  return Promise.all(inFlight);
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
/**
 * backlog.feat.wire-classify-chain-refusal
 *
 * Read a story's current phase from disk, or return null if it cannot be determined.
 *
 * NON-EXPORTED on purpose, and that is load-bearing rather than stylistic. Several suites
 * bound a source window with `src.indexOf("\nexport function", start + 1)` to slice
 * `checkAllowedTool`, `endSession` and `assertToolAllowed`. A new top-level `export function`
 * anywhere in this file would truncate one of those windows and silently weaken or break the
 * assertion inside it. A plain `function` is invisible to that matcher at any position.
 *
 * THE INVARIANT IS NOW TRUE-IN-PART, and the difference matters. Of the three suites that
 * slice this file, only tests/unit/session-tool-telemetry.test.mjs was widened to also match
 * `export async function`; tests/unit/research-agent-self-bootstrap.test.mjs and
 * tests/unit/wire-classify-chain-refusal.test.mjs still use the narrow delimiter. So an
 * `export async function` is invisible to those two, and the protection for them is
 * POSITIONAL: `flushPendingStashPops` is pinned immediately after `endSession`, outside the
 * `checkAllowedTool`→`advanceState` span those two suites bound. A plain `function` remains
 * safe anywhere; an `export async function` is safe only outside that span.
 *
 * NEVER THROWS. This runs inside the refusal path of `checkAllowedTool`, which server.mjs
 * calls for every governed tool call — so a throw here would fail every MCP call in the
 * session, including the ones needed to diagnose it. Concretely: an existing test calls
 * `checkAllowedTool` with `problemId: 'story-1'` for a note that does not exist on disk and
 * lands on this path. Missing note, unreadable file, unparseable frontmatter, and a null
 * `_projectRoot` all degrade to null, which `classifyChainRefusal` treats as "phase unknown"
 * and reports as `state`-blocked rather than inventing a phase verdict.
 *
 * @param {string|null|undefined} problemId
 * @returns {string|null}
 */
function resolveStoryPhase(problemId) {
  if (!problemId || typeof problemId !== "string") return null;
  if (!_projectRoot) return null;
  // problemId reaches here from caller-supplied tool arguments and is interpolated into a
  // path. Dendron ids are dot-delimited and never contain separators or traversal segments,
  // so anything that does is malformed or hostile — refuse rather than normalise it.
  if (/[\\/]/.test(problemId) || problemId.split(".").includes("..")) return null;
  try {
    const notePath = path.join(_projectRoot, "notes", `${problemId}.md`);
    if (!fs.existsSync(notePath)) return null;
    const parsed = parseFrontmatter(fs.readFileSync(notePath, "utf8"));
    const phase = parsed?.data?.phase;
    return typeof phase === "string" && phase !== "" ? phase : null;
  } catch {
    return null;
  }
}

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
  // backlog.feat.wire-classify-chain-refusal: enrich the refusal so a WEDGE is diagnosable.
  //
  // Two records gate a story-flow call and neither can see the other — the chain state on the
  // session, and the phase in the story's frontmatter. When they disagree the caller gets a
  // refusal from whichever layer it hit first, with no signal that the other is also blocking,
  // and bounces between them without converging.
  //
  // Placed HERE, at the refusal site, and nowhere earlier. classifyChainRefusal recomputes
  // state-blocking itself rather than calling checkStateAllowed, so it does not honour
  // STATE_BYPASS_TOOLS or the COMMON_TOOLS early return. Both of those have already returned
  // by this point, so its recomputation agrees with the real gate — upstream it would not.
  //
  // Never throws: resolveStoryPhase degrades to null, and a null phase makes the classifier
  // report `state` rather than guessing.
  let refusalClassification = null;
  try {
    refusalClassification = classifyChainRefusal({
      flowType: session.flowType,
      chainState: session.state,
      storyPhase: resolveStoryPhase(session.problemId),
      tool: toolName,
      phaseAllows,
    });
  } catch { /* classification is diagnostic — never let it break the refusal itself */ }

  return {
    ok: false,
    error: "chain_violation",
    tool: toolName,
    flowType: session.flowType,
    state: session.state,
    message: stateCheck.error ||
      `Blocked: '${toolName}' is not allowed in state '${session.state}' (${session.flowType} flow). ` +
      `Focus on the chain. If something failed, return { status: 'failed' } with the error.`,
    // Hoisted onto the refusal object itself, not nested under a sub-key: a caller reads
    // `violation.blockedBy`, not `violation.refusal.blockedBy`. Only the fields the classifier
    // ADDS are lifted — its `chainState`, `tool` and `message` are deliberately dropped here
    // because `state`, `tool` and `message` above already carry those values, and two spellings
    // of one fact is how a response object starts drifting from itself.
    ...(refusalClassification
      ? {
        blockedBy: refusalClassification.blockedBy,
        wedged: refusalClassification.wedged,
        recovery: refusalClassification.recovery,
        storyPhase: refusalClassification.storyPhase,
      }
      : {}),
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
 * backlog.fix.governor-phase-state-desync-and-recovery
 *
 * Undo an entry transition whose tool then FAILED.
 *
 * advanceState runs on tool ENTRY, before the tool body, and commits unconditionally — so a
 * call that fails still moves the chain. That is how the observed wedge formed: two
 * rks_agent_research calls died on "Agent exceeded max turns (7)", each having already
 * demoted `planned` -> `refining`, where rks_exec is forbidden. The story phase had
 * independently advanced to `executing`, which rks_plan rejects. Both exits closed at once.
 *
 * A failed call did no work, so it has no claim on the chain's position. Entry transitions
 * stay (they are needed to gate in-flight calls); they are simply not durable across a
 * failure.
 *
 * Deliberately conservative: this ONLY reverts to `previousState`, and only when the session
 * is still sitting on the state the entry transition produced. If anything else has moved the
 * session in the meantime — a result transition, a nested call — the rollback is declined
 * rather than guessed at. A terminal state is never resurrected: endSession already ran and
 * re-creating the session would be a different bug than the one this fixes.
 *
 * @param {string} token
 * @param {{ previousState: string, newState: string, transitioned: boolean } | null} transition
 * @returns {{ reverted: boolean, from?: string, to?: string, reason?: string }}
 */
export function revertStateOnFailure(token, transition) {
  if (!transition?.transitioned) return { reverted: false, reason: "no_transition" };
  const session = governorSessions.get(token);
  if (!session) return { reverted: false, reason: "no_session" };
  if (session.state !== transition.newState) {
    return { reverted: false, reason: "state_moved_since_entry" };
  }
  session.state = transition.previousState;
  persistSession(session);
  return { reverted: true, from: transition.newState, to: transition.previousState };
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

  // ── backlog.fix.refine-noop-escalation-false-positive: CONSECUTIVE-NO-OP COUNTER ──
  //
  // The anti-loop guarantee used to be "escalate on the first no-op", which killed healthy builds
  // whenever the no-op was a false positive. It is now "escalate on a REPEATED no-op", which needs
  // state across calls — hence a counter on the session, following the `toolCallCounts` precedent
  // (init at session creation, lazy-init here for rehydrated sessions, persisted on write).
  //
  // THIS MUST SIT OUTSIDE THE `newState !== previousState` BRANCH BELOW. The mandated target for a
  // first `refine_apply.noop` is a SELF-LOOP (refining -> refining, child_active -> child_active),
  // because only those states permit rks_refine / rks_refine_apply / rks_plan together. So
  // `newState === previousState` is the EXPECTED outcome and that branch never runs on this key.
  // Incrementing or persisting inside it would silently never happen, and the counter would read 0
  // forever — the escalation would then be unreachable rather than merely delayed.
  let effectiveResultKey = resultKey;
  let counterMutated = false;
  if (resultKey === 'refine_apply.noop') {
    session.consecutiveNoopCounts = session.consecutiveNoopCounts || {};
    const next = (session.consecutiveNoopCounts[resultKey] || 0) + 1;
    session.consecutiveNoopCounts[resultKey] = next;
    counterMutated = true;
    if (next >= NOOP_ESCALATION_THRESHOLD) {
      // Substitute the key the state table is keyed on. The caller is told which key actually
      // drove the transition via `effectiveResultKey`, so telemetry cannot claim the wrong one.
      effectiveResultKey = 'refine_apply.noop_repeated';
    }
  } else if (session.consecutiveNoopCounts && Object.keys(session.consecutiveNoopCounts).length > 0) {
    // Any other result means the story moved: the run is no longer stuck, so the streak resets.
    // "Consecutive" is the whole point — a cumulative count would escalate a healthy long build.
    session.consecutiveNoopCounts = {};
    counterMutated = true;
  }

  const newState = transitionOnResult(session.flowType, previousState, effectiveResultKey);

  if (newState !== previousState) {
    session.state = newState;
    if (isTerminal(session.flowType, newState)) {
      endSession(token);
    } else {
      persistSession(session);
    }
    return { previousState, newState, transitioned: true, resultKey, effectiveResultKey };
  }

  // Self-loop (or an unmapped key): state is unchanged, but the counter may not be. Persist it so a
  // later MCP request sees the streak — without this the repeat can never be observed.
  if (counterMutated) persistSession(session);

  return { previousState, newState: previousState, transitioned: false, resultKey, effectiveResultKey };
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
  'rks_guardrails_abort', // discard-exit sibling of guardrails_on — endable without a fresh token
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
 * Open-flow states from which a `backlog.*` create must still be refused.
 *
 * backlog.fix.open-flow-research-note-creation: the open flow is ONE state table
 * serving TWO prompts with different chains. governor-research.md needs one research
 * call then a write; governor-po.md (which also inits open, at :39) must traverse
 * concern-separation and the test-file scan before it may create a story. The state
 * table now permits dendron_create_note in both research states so the Research
 * Governor's documented chain is executable — this set is what keeps the PO gate
 * intact by namespace instead.
 *
 * It must NOT include 'writing': that is the state the PO legitimately reaches after
 * completing both gates, and it is where backlog.* creation is supposed to happen.
 * Correspondingly, dendron_create_note SELF-LOOPS in these two states rather than
 * advancing to 'writing' — otherwise one research.* create would promote the session
 * out of this set and the next backlog.* create would sail through.
 */
const OPEN_RESEARCH_STATES_NO_BACKLOG_WRITE = new Set([
  'researching',
  'concern-separating',
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

      // Open-flow PO gate, enforced by namespace because the state check cannot see
      // args. NAMESPACE_ALLOWLIST maps open -> null (all namespaces), which is right
      // for the Research Governor but would also let a PO Governor create a backlog.*
      // story straight out of `researching`, skipping the mandatory concern-separation
      // and test-file-scan steps. Scoped to dendron_create_note: editing or updating an
      // existing backlog note from a research state is not story creation.
      if (
        toolName === 'dendron_create_note' &&
        session.flowType === 'open' &&
        OPEN_RESEARCH_STATES_NO_BACKLOG_WRITE.has(session.state) &&
        namespace === 'backlog'
      ) {
        return {
          ok: false,
          error: 'namespace_violation',
          tool: toolName,
          flowType: session.flowType,
          state: session.state,
          sessionType: session.sessionType,
          message: `Namespace 'backlog' is not allowed from open-flow state '${session.state}'. The PO chain must traverse concern-separating -> test-file-scanning -> writing before creating a story. Research notes (design.*, research.*, notes.*) are permitted here.`,
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
