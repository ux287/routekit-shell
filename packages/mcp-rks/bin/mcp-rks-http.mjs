#!/usr/bin/env node
// backlog.feat.remote-surface-http-entry
// backlog.feat.remote-http-entry-multi-session
// Loopback Streamable-HTTP entry for the remote lane. Single owner, single project, many MCP sessions:
// each initialize gets its own stateful StreamableHTTPServerTransport and its own MCP server, kept in a
// bounded map keyed by mcp-session-id, so a client can re-initialize (for example once per
// conversation) without a restart. Boot side effects run once per process (bootServer); every
// session shares the pinned lane, root, project id and actor.
//
// Boot order (every refusal exits non-zero and names its cause only; all but boot_index_failed, step 6,
// refuse before anything listens):
//   1. snapshot RKS_ACTOR from the launch env, BEFORE any .env is read;
//   2. parse RKS_REMOTE_ROOT/.env (never loaded into process.env here) for RKS_REMOTE_BEARER;
//   3. checkBootEnv over the launch env merged with that .env: token-gate bypass vars (from either
//      source), RKS_REMOTE_ROOT a linked git worktree that is not the primary checkout, the worktree
//      project id, the bearer secret (.env only, >= 32 chars), the remote-lane actor rule (asked of
//      the exported decideLane, so the rule keeps one source) and the bind host (127.0.0.1 only);
//   4. pin RKS_VIA=remote, ROUTEKIT_PROJECT_ROOT, ROUTEKIT_PROJECT_ID (from the worktree's
//      .rks/project.json, never the launch env), RKS_ACTOR and CLAUDE_PROJECT_DIR in process.env;
//   5. only then dynamic-import ../src/server.mjs, so no read of ROUTEKIT_PROJECT_ID there can see a
//      launch value;
//   6. boot index (backlog.fix.remote-rag-query-inline-full-index-build): after bootServer() and BEFORE
//      connectServer is set, so no request reaches a session while it runs (an initialize then gets the
//      not-ready 404). The pinned worktree's RAG index is presence-checked (ensureRagIndex with
//      autoEmbed false) and, when absent, built here, logging "boot index: start" and "boot index: done"
//      on stderr before the listening line. The remote lane never builds the index inside a tool call:
//      rks_rag_query against a worktree with no index returns rag_index_unavailable with a remedy.
//      Failure posture: REFUSE BOOT. A boot-index step that reports ok false (the presence check or the
//      embed threw, or the embed reported ok false) logs its cause, closes the HTTP server and exits
//      non-zero with the named reason boot_index_failed. The owner's opt-out for starting without an
//      index is RKS_REMOTE_BOOT_INDEX=skip (queries then get rag_index_unavailable until one exists).
// Every request is bearer-checked (constant time) before any routing; each per-session transport's
// DNS-rebinding protection is enabled explicitly with allowedHosts built from the bound port.
//
// Session routing (after the bearer front door and the /mcp path check):
//   - mcp-session-id present and in the map    -> that session's transport;
//   - mcp-session-id present, not in the map   -> 404, nothing created;
//   - no mcp-session-id, POST initialize body  -> new transport + server, if under the cap (else 503);
//   - no mcp-session-id, anything else         -> 400, nothing created.
// An initialize reserves a slot synchronously (before any await); the cap counts registered plus
// reserved sessions. An initialize the transport rejects (bad Host, bad Accept, ...) releases its slot
// and closes its transport and server, logging "released uninitialized session (closed: <observed>)".
// A session with a request in flight or a response stream open (e.g. a GET SSE stream) is never
// idle; once its last activity ends (response finish/close, or a rejected handleRequest), a session
// idle past the idle timeout from that end is evicted ("evicted idle session (closed: <observed>)").
// Shutdown closes every session and logs "shutdown sessions=<n> closed=<n> failed=<n> fallback=false";
// it exits 0 only when no close failed. The 2s fallback logs "shutdown fallback fired (...)" and exits 1.
//
// Owner configuration (launch env):
//   RKS_REMOTE_ROOT           dedicated linked worktree of the project (required)
//   RKS_ACTOR                 remote actor, lowercase letters, digits and hyphens (required)
//   RKS_REMOTE_PORT           port to bind (default 0 = ephemeral; the bound port is logged)
//   RKS_REMOTE_HOST           bind host; anything other than 127.0.0.1 is refused
//   RKS_REMOTE_ALLOWED_HOSTS  extra allowed Host header values, comma separated (e.g. a tunnel host)
//   RKS_REMOTE_MAX_SESSIONS   concurrent MCP session cap, a positive integer (default 8)
//   RKS_REMOTE_SESSION_IDLE_MS idle timeout before a session is evicted, positive integer ms (default 30 min)
//   RKS_REMOTE_STREAM_MAX_MS  max lifetime of a routed response (e.g. a GET SSE stream), positive integer ms
//                             (default 30 min); a response still open then is ended, and destroyed if it does not end
//   RKS_REMOTE_SSE_HEARTBEAT_MS interval of the ": keepalive" SSE comment written to an open text/event-stream
//                             response, positive integer ms (default 25 s); a failed write tears the response down
//   RKS_REMOTE_BOOT_INDEX     unset = presence-check the worktree RAG index at boot and build it when
//                             absent (a failure refuses boot, boot_index_failed); skip = no boot-index
//                             step. Any other value is treated as unset.
// Secret (RKS_REMOTE_ROOT/.env, gitignored): RKS_REMOTE_BEARER, at least 32 characters.

// HTTP is the protocol channel here, not stdout, but keep dependency chatter on stderr like
// bin/mcp-rks.mjs does.
const _origLog = console.log;
console.log = (...args) => console.error(...args);

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { tokenGateBypass } from "../src/shared/token-gate-bypass.mjs";
import { decideLane } from "../src/shared/lane-policy.mjs";
import { scrubGitEnv } from "../src/shared/remote-env-scrub.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REMOTE_BIND_HOST = "127.0.0.1";
export const MIN_BEARER_LENGTH = 32;
export const MCP_PATH = "/mcp";
const GIT_TIMEOUT_MS = 10_000;
const BYPASS_KEYS = ["RKS_SKIP_PREFLIGHT", "NODE_ENV", "RKS_TEST_MODE"];
export const DEFAULT_MAX_SESSIONS = 8;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
// backlog.feat.http-entry-held-stream-bound: a routed response may stay open this long (finite, so a held
// stream cannot pin a session slot forever); an open SSE response gets a comment frame this often (under
// common 30 s proxy idle timeouts).
export const DEFAULT_STREAM_MAX_MS = 30 * 60_000;
export const DEFAULT_SSE_HEARTBEAT_MS = 25_000;
const SSE_HEARTBEAT_FRAME = ": keepalive\n\n";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_FALLBACK_MS = 2_000;

/** A positive safe integer from a decimal string, or null. Undefined/empty means "use the default". */
function parsePositiveInt(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The session bounds from the env: { maxSessions, idleMs, streamMaxMs, sseHeartbeatMs } or
 * { refusal: { reason, message } }.
 * Unset means the default; any set value that is not a positive integer refuses boot.
 */
export function readSessionBounds(env = process.env) {
  let maxSessions = DEFAULT_MAX_SESSIONS;
  if (env.RKS_REMOTE_MAX_SESSIONS !== undefined) {
    maxSessions = parsePositiveInt(env.RKS_REMOTE_MAX_SESSIONS);
    if (maxSessions === null) {
      return { refusal: { reason: "remote_max_sessions_invalid", message: "RKS_REMOTE_MAX_SESSIONS must be a positive integer" } };
    }
  }
  let idleMs = DEFAULT_SESSION_IDLE_MS;
  if (env.RKS_REMOTE_SESSION_IDLE_MS !== undefined) {
    idleMs = parsePositiveInt(env.RKS_REMOTE_SESSION_IDLE_MS);
    if (idleMs === null) {
      return { refusal: { reason: "remote_session_idle_ms_invalid", message: "RKS_REMOTE_SESSION_IDLE_MS must be a positive integer number of milliseconds" } };
    }
  }
  let streamMaxMs = DEFAULT_STREAM_MAX_MS;
  if (env.RKS_REMOTE_STREAM_MAX_MS !== undefined) {
    streamMaxMs = parsePositiveInt(env.RKS_REMOTE_STREAM_MAX_MS);
    if (streamMaxMs === null) {
      return { refusal: { reason: "remote_stream_max_ms_invalid", message: "RKS_REMOTE_STREAM_MAX_MS must be a positive integer number of milliseconds" } };
    }
  }
  let sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS;
  if (env.RKS_REMOTE_SSE_HEARTBEAT_MS !== undefined) {
    sseHeartbeatMs = parsePositiveInt(env.RKS_REMOTE_SSE_HEARTBEAT_MS);
    if (sseHeartbeatMs === null) {
      return { refusal: { reason: "remote_sse_heartbeat_ms_invalid", message: "RKS_REMOTE_SSE_HEARTBEAT_MS must be a positive integer number of milliseconds" } };
    }
  }
  return { maxSessions, idleMs, streamMaxMs, sseHeartbeatMs };
}

/** Constant-time bearer check. Returns false on any length mismatch or missing header. Never throws. */
export function checkBearer(header, secret) {
  if (typeof header !== "string" || typeof secret !== "string" || secret.length === 0) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse RKS_REMOTE_ROOT/.env without touching process.env. Missing or unreadable -> {}. */
export function readRemoteDotenv(root) {
  if (typeof root !== "string" || root.length === 0) return {};
  try {
    return dotenv.parse(fs.readFileSync(path.join(root, ".env")));
  } catch {
    return {};
  }
}

/**
 * The env checkBootEnv judges: the launch env, with
 *   - any token-gate bypass value the .env carries added (a bypass var from either source refuses),
 *   - RKS_REMOTE_BEARER taken from the .env only,
 *   - RKS_ACTOR taken from the launch env only (an .env-only actor does not count).
 */
export function buildBootEnv(launchEnv = process.env, dotenvValues = {}) {
  const env = { ...launchEnv };
  const fromFile = tokenGateBypass(dotenvValues);
  for (const key of BYPASS_KEYS) {
    if (fromFile.vars.some((v) => v.startsWith(`${key}=`)) && !tokenGateBypass({ [key]: env[key] }).active) {
      env[key] = dotenvValues[key];
    }
  }
  if (typeof dotenvValues.RKS_REMOTE_BEARER === "string") env.RKS_REMOTE_BEARER = dotenvValues.RKS_REMOTE_BEARER;
  else delete env.RKS_REMOTE_BEARER;
  if (typeof launchEnv.RKS_ACTOR === "string") env.RKS_ACTOR = launchEnv.RKS_ACTOR;
  else delete env.RKS_ACTOR;
  return env;
}

function gitRevParse(cwd, args) {
  // The check is about the path, so an inherited GIT_DIR / GIT_WORK_TREE must not redirect it.
  const env = { ...process.env };
  scrubGitEnv(env);
  const r = spawnSync("git", ["rev-parse", ...args], { cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout.trim().split("\n");
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** The id in <root>/.rks/project.json, or null. */
export function readWorktreeProjectId(root) {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(root, ".rks", "project.json"), "utf8"))?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** null when root is the top of a linked worktree (not the primary checkout), else { reason, message }. */
function checkWorktree(root) {
  if (typeof root !== "string" || root.trim().length === 0) {
    return { reason: "remote_root_unset", message: "RKS_REMOTE_ROOT is not set; point it at a dedicated linked git worktree of the project" };
  }
  const abs = path.resolve(root);
  let stat = null;
  try { stat = fs.statSync(abs); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) {
    return { reason: "remote_root_missing", message: "RKS_REMOTE_ROOT does not name an existing directory" };
  }
  const out = gitRevParse(abs, ["--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (!out || out.length < 3) {
    return { reason: "remote_root_not_worktree", message: "RKS_REMOTE_ROOT is not a git worktree" };
  }
  const [top, gitDir, commonDir] = out;
  if (realpathOrSelf(path.resolve(abs, top)) !== realpathOrSelf(abs)) {
    return { reason: "remote_root_not_worktree", message: "RKS_REMOTE_ROOT is not the top directory of a git worktree" };
  }
  if (realpathOrSelf(path.resolve(abs, gitDir)) === realpathOrSelf(path.resolve(abs, commonDir))) {
    return { reason: "remote_root_primary_checkout", message: "RKS_REMOTE_ROOT is the primary checkout; create a dedicated worktree with git worktree add" };
  }
  return null;
}

/** Boot refusals. Returns null when boot may proceed, else { reason, message }. Names causes, never values. */
export function checkBootEnv(env = process.env) {
  if (tokenGateBypass(env).active) {
    return { reason: "token_gate_bypass", message: "mcp-rks-http refuses to boot with a token-gate bypass variable set (RKS_SKIP_PREFLIGHT=1, NODE_ENV=test or RKS_TEST_MODE=1)" };
  }
  const host = env.RKS_REMOTE_HOST;
  if (host !== undefined && host !== REMOTE_BIND_HOST) {
    return { reason: "bind_host_refused", message: `mcp-rks-http binds ${REMOTE_BIND_HOST} only; RKS_REMOTE_HOST names another host` };
  }
  const bounds = readSessionBounds(env);
  if (bounds.refusal) return bounds.refusal;
  const worktree = checkWorktree(env.RKS_REMOTE_ROOT);
  if (worktree) return worktree;
  const projectId = readWorktreeProjectId(path.resolve(env.RKS_REMOTE_ROOT));
  if (!projectId) {
    return { reason: "remote_project_unresolved", message: "RKS_REMOTE_ROOT/.rks/project.json carries no string id" };
  }
  const bearer = env.RKS_REMOTE_BEARER;
  if (typeof bearer !== "string" || bearer.length === 0) {
    return { reason: "bearer_missing", message: "RKS_REMOTE_BEARER is not set in RKS_REMOTE_ROOT/.env" };
  }
  if (bearer.length < MIN_BEARER_LENGTH) {
    return { reason: "bearer_too_short", message: `RKS_REMOTE_BEARER in RKS_REMOTE_ROOT/.env is shorter than ${MIN_BEARER_LENGTH} characters` };
  }
  // The remote lane's actor rule, asked of the exported decideLane with a synthetic admitted create.
  const actor = env.RKS_ACTOR;
  const laneRefusal = decideLane({
    lane: "remote",
    policy: null,
    tool: "dendron_create_note",
    args: { filename: `inbox.${actor}.boot`, projectId },
    tokenValid: true,
    bootProjectId: projectId,
    env: { RKS_ACTOR: actor },
  });
  if (laneRefusal) {
    return { reason: "actor_invalid", message: `RKS_ACTOR is unset or fails the remote lane actor rule (${laneRefusal.reason})` };
  }
  return null;
}

export const BOOT_INDEX_START = "[mcp-rks-http] boot index: start";
export const BOOT_INDEX_END = "[mcp-rks-http] boot index: done";
export const BOOT_INDEX_FAILED = "[mcp-rks-http] boot index: failed";

/**
 * The boot-index step. Presence-checks root's RAG index with ensure(root, { autoEmbed: false }) and,
 * only on an explicit absent report (reason "no-index"), builds it with embed(root, { glob: "*" }),
 * logging a start and a completion line through log. Never throws: resolves { ok: true, built } or
 * { ok: false, error }. Whether a failure refuses boot is main()'s decision, not this step's.
 */
export async function runBootIndex({ root, ensure, embed, log = (line) => console.error(line), now = Date.now }) {
  const fail = (err) => {
    const error = err?.message ?? String(err);
    log(`${BOOT_INDEX_FAILED} (${error})`);
    return { ok: false, error };
  };
  let presence;
  try {
    presence = await ensure(root, { autoEmbed: false });
  } catch (err) {
    return fail(err);
  }
  if (!(presence?.ok === false && presence.reason === "no-index")) return { ok: true, built: false };
  log(`${BOOT_INDEX_START} (no RAG index under ${path.join(root, ".rks", "rag")}; building before any session is served)`);
  const started = now();
  try {
    const result = await embed(root, { glob: "*" });
    if (result?.ok === false) return fail(new Error(result.error || "embed reported ok false"));
  } catch (err) {
    return fail(err);
  }
  log(`${BOOT_INDEX_END} in ${now() - started} ms`);
  return { ok: true, built: true };
}

function refuse(refusal) {
  console.error(`[mcp-rks-http] refusing to boot (${refusal.reason}): ${refusal.message}`);
  process.exit(1);
}

function jsonRpcError(res, status, code, message) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Close a session's server and transport; resolves { closed, error } from what was observed. */
async function closeEntry(entry) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => entry.server?.close?.()),
    Promise.resolve().then(() => entry.transport?.close?.()),
  ]);
  const failure = results.find((r) => r.status === "rejected");
  return failure
    ? { closed: false, error: failure.reason?.message ?? String(failure.reason) }
    : { closed: true, error: null };
}

/**
 * backlog.feat.http-entry-held-stream-bound: whether a writeHead call opens a text/event-stream response.
 * The SDK passes Content-Type in the writeHead headers object, so that object's content-type key (any
 * case) is read first; a header set earlier with setHeader is the fallback.
 */
function isEventStream(writeHeadArgs, res) {
  let value;
  for (const arg of writeHeadArgs.slice(1)) {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
    for (const [key, v] of Object.entries(arg)) {
      if (key.toLowerCase() === "content-type") value = v;
    }
  }
  if (value === undefined && typeof res.getHeader === "function") value = res.getHeader("content-type");
  return String(value ?? "").trim().toLowerCase().startsWith("text/event-stream");
}

function reportClose(what, result) {
  console.error(`[mcp-rks-http] ${what} (closed: ${result.closed})${result.error ? `: ${result.error}` : ""}`);
}

function handleFailure(res) {
  return (err) => {
    console.error(`[mcp-rks-http] request failed: ${err?.message ?? err}`);
    if (!res.headersSent) res.writeHead(500).end();
    else if (!res.writableEnded) res.destroy(); // headers already sent: close the socket instead of leaving the response open
  };
}

/**
 * backlog.fix.http-entry-reservation-race-test: the session registry and its new-session start.
 * `deps` is { Transport, connectServer, allowedHosts }, read on every startSession call, so main()
 * can build the registry before listen and fill deps afterwards. Returns the registry's single
 * `sessions` Map, `pending` Set and `startSession(req, res, body)`.
 * backlog.fix.http-entry-idle-eviction-inflight: also returns `routeSessionRequest(req, res,
 * sessionHeader)` (known-session routing with in-flight tracking) and `sweepIdle()` (one idle-eviction
 * pass). `idleMs` and the clock `now` are injectable; every lastSeen write uses `now()`.
 */
export function createSessionRegistry({ maxSessions, idleMs = DEFAULT_SESSION_IDLE_MS, streamMaxMs = DEFAULT_STREAM_MAX_MS, sseHeartbeatMs = DEFAULT_SSE_HEARTBEAT_MS, deps, now = Date.now }) {
  /**
   * sessionId -> { transport, server, lastSeen, active } for initialized sessions. `active` counts
   * routed requests whose response has not yet finished or closed (an open SSE stream included).
   */
  const sessions = new Map();
  /** Reservations for initializes in flight: { transport, server } entries not yet in `sessions`. */
  const pending = new Set();
  /**
   * backlog.feat.http-entry-held-stream-bound: the clear function of every routed response whose lifetime
   * or heartbeat timer may still be live. clearStreamTimers() runs them all and stops new timers (shutdown).
   */
  const streamTimers = new Set();
  let streamTimersStopped = false;

  /** A new-session initialize: cap check and reservation in one synchronous step, then connect. */
  const startSession = async (req, res, body) => {
    if (sessions.size + pending.size >= maxSessions) {
      jsonRpcError(res, 503, -32000, "Service unavailable: session limit reached");
      return;
    }
    const entry = { transport: null, server: null, lastSeen: now(), active: 0 };
    pending.add(entry);
    let initializedId = null;
    try {
      entry.transport = new deps.Transport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: true,
        allowedHosts: deps.allowedHosts,
        onsessioninitialized: (id) => {
          initializedId = id;
          pending.delete(entry);
          entry.lastSeen = now();
          sessions.set(id, entry);
        },
        onsessionclosed: (id) => { sessions.delete(id); },
      });
      entry.transport.onclose = () => {
        if (initializedId && sessions.get(initializedId) === entry) sessions.delete(initializedId);
      };
      entry.server = await deps.connectServer(entry.transport);
      await entry.transport.handleRequest(req, res, body);
    } catch (err) {
      handleFailure(res)(err);
    } finally {
      if (initializedId === null && pending.has(entry)) {
        pending.delete(entry);
        reportClose("released uninitialized session", await closeEntry(entry));
      }
    }
  };

  /**
   * A request carrying mcp-session-id: unknown -> 404; known -> that session's transport, tracked as
   * in flight until its response emits finish or close, or handleRequest rejects. Resolving is not an
   * end: the SDK's GET handler returns with its SSE stream still open.
   */
  const routeSessionRequest = (req, res, sessionHeader) => {
    const entry = typeof sessionHeader === "string" ? sessions.get(sessionHeader) : undefined;
    if (!entry) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    entry.active += 1;
    entry.lastSeen = now();
    let ended = false;
    let lifetimeTimer = null;
    let heartbeatTimer = null;
    const clearTimers = () => {
      if (lifetimeTimer) { clearTimeout(lifetimeTimer); lifetimeTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      streamTimers.delete(clearTimers);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimers();
      entry.active -= 1;
      entry.lastSeen = now();
    };
    // backlog.feat.http-entry-held-stream-bound: destroy the response and end its activity; never throws.
    const teardown = () => {
      try { res.destroy(); } catch { /* the activity still ends below */ }
      end();
    };
    const heartbeatFailed = (err) => {
      console.error(`[mcp-rks-http] heartbeat write failed, destroying the response: ${err?.message ?? err}`);
      teardown();
    };
    const startHeartbeat = () => {
      if (ended || heartbeatTimer || streamTimersStopped) return;
      heartbeatTimer = setInterval(() => {
        if (ended || res.writableEnded) return;
        if (res.destroyed) {
          console.error("[mcp-rks-http] heartbeat found the response destroyed; ending its activity");
          teardown();
          return;
        }
        try {
          res.write(SSE_HEARTBEAT_FRAME, (err) => { if (err && !ended) heartbeatFailed(err); });
        } catch (err) {
          heartbeatFailed(err);
        }
      }, sseHeartbeatMs);
      heartbeatTimer.unref?.();
    };
    // The transport writes its headers through writeHead; an open text/event-stream response gets the heartbeat.
    const writeHead = res.writeHead;
    res.writeHead = (...args) => {
      const out = writeHead.apply(res, args);
      if (isEventStream(args, res)) startHeartbeat();
      return out;
    };
    streamTimers.add(clearTimers);
    if (!streamTimersStopped) {
      lifetimeTimer = setTimeout(() => {
        lifetimeTimer = null;
        if (ended) return;
        try { if (!res.writableEnded) res.end(); } catch { /* destroyed below */ }
        const destroyed = !ended;
        if (destroyed) teardown();
        console.error(`[mcp-rks-http] routed response still open after ${streamMaxMs}ms was ended (destroyed: ${destroyed})`);
      }, streamMaxMs);
      lifetimeTimer.unref?.();
    }
    res.once("finish", end);
    res.once("close", end);
    entry.transport.handleRequest(req, res).catch((err) => {
      handleFailure(res)(err);
      end();
    });
  };

  /**
   * One idle-eviction pass: a session with nothing in flight whose last activity ended (or last
   * request started) more than idleMs ago is removed and closed. Resolves the observed close results.
   */
  const sweepIdle = () => {
    const t = now();
    const closing = [];
    for (const [id, entry] of sessions) {
      if (entry.active > 0) continue;
      if (t - entry.lastSeen <= idleMs) continue;
      sessions.delete(id);
      closing.push(closeEntry(entry).then((r) => {
        reportClose("evicted idle session", r);
        return { id, ...r };
      }));
    }
    return Promise.all(closing);
  };

  /** Clear every live per-response lifetime and heartbeat timer and start no new ones. Responses are not ended. */
  const clearStreamTimers = () => {
    streamTimersStopped = true;
    for (const clear of [...streamTimers]) clear();
  };

  return { sessions, pending, startSession, routeSessionRequest, sweepIdle, clearStreamTimers };
}

export async function main() {
  // 1. Snapshot the launch actor before any .env is read.
  const launchActor = process.env.RKS_ACTOR;
  const launchEnv = { ...process.env };
  // 2-3. Parse the worktree .env and judge the merged env.
  const remoteRoot = typeof launchEnv.RKS_REMOTE_ROOT === "string" && launchEnv.RKS_REMOTE_ROOT.trim()
    ? path.resolve(launchEnv.RKS_REMOTE_ROOT)
    : launchEnv.RKS_REMOTE_ROOT;
  const dotenvValues = typeof remoteRoot === "string" && remoteRoot ? readRemoteDotenv(remoteRoot) : {};
  const bootEnv = buildBootEnv({ ...launchEnv, RKS_ACTOR: launchActor }, dotenvValues);
  const refusal = checkBootEnv(bootEnv);
  if (refusal) refuse(refusal);

  const root = realpathOrSelf(remoteRoot);
  const projectId = readWorktreeProjectId(root);
  const secret = bootEnv.RKS_REMOTE_BEARER;

  // 4. Pin lane, root, project id, actor and project dir, overwriting any launch-env value.
  process.env.RKS_VIA = "remote";
  delete process.env.RKS_VIA_DEFAULT;
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  delete process.env.RKS_PROJECT_ROOT;
  process.env.ROUTEKIT_PROJECT_ID = projectId;
  process.env.RKS_ACTOR = launchActor;
  process.env.CLAUDE_PROJECT_DIR = root;
  delete process.env.RKS_REMOTE_BEARER;
  // backlog.fix.remote-http-entry-env-leaks: launch-env notes and git redirectors are cleared, not
  // judged, so notes resolve to <root>/notes and git to the worktree via cwd. Never logged.
  delete process.env.DENDRON_VAULT_PATH;
  delete process.env.ROUTEKIT_NOTES_DIR;
  scrubGitEnv(process.env);
  process.chdir(root);

  const extraHosts = String(process.env.RKS_REMOTE_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const port = Number(process.env.RKS_REMOTE_PORT || 0);

  const { maxSessions, idleMs, streamMaxMs, sseHeartbeatMs } = readSessionBounds(process.env);

  // Filled after listen with the bound-port allowedHosts, the SDK transport class and the real
  // connectServer; the registry reads them on each startSession call.
  const deps = { Transport: null, connectServer: null, allowedHosts: null };
  const registry = createSessionRegistry({ maxSessions, idleMs, streamMaxMs, sseHeartbeatMs, deps });
  const { sessions, pending, startSession } = registry;
  let shuttingDown = false;

  /** Read the request body (bounded) and JSON-parse it. Resolves { body } or { error: status }. */
  const readJsonBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { done = true; resolve({ error: 413 }); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try { resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { resolve({ error: 400 }); }
    });
    req.on("error", () => { if (!done) { done = true; resolve({ error: 400 }); } });
  });

  const isInitializeBody = (body) => {
    const isInit = (m) => m && typeof m === "object" && m.jsonrpc === "2.0" && m.method === "initialize" && m.id !== undefined;
    return Array.isArray(body) ? body.some(isInit) : isInit(body);
  };

  const httpServer = http.createServer((req, res) => {
    // Bearer front door: before any MCP handling, on every request and every path.
    if (!checkBearer(req.headers.authorization, secret)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== MCP_PATH || !deps.connectServer) {
      res.writeHead(404).end();
      return;
    }
    if (shuttingDown) {
      jsonRpcError(res, 503, -32000, "Service unavailable: shutting down");
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    if (sessionHeader !== undefined) {
      registry.routeSessionRequest(req, res, sessionHeader);
      return;
    }
    if (req.method !== "POST") {
      jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return;
    }
    readJsonBody(req).then(({ body, error }) => {
      if (error === 413) { jsonRpcError(res, 413, -32000, "Payload too large"); return; }
      if (error) { jsonRpcError(res, 400, -32700, "Parse error: Invalid JSON"); return; }
      if (!isInitializeBody(body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
        return;
      }
      return startSession(req, res, body);
    }).catch(handleFailure(res));
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, REMOTE_BIND_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const bound = httpServer.address();
  const boundPort = bound.port;
  deps.allowedHosts = [`${REMOTE_BIND_HOST}:${boundPort}`, `localhost:${boundPort}`, ...extraHosts];

  // 5. Load the server only after pinning. Boot side effects run once here; each session connects
  // its own server through connectServer.
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  deps.Transport = StreamableHTTPServerTransport;
  const serverModule = await import(pathToFileURL(path.join(__dirname, "..", "src", "server.mjs")).href);
  serverModule.bootServer();

  // 6. Boot index, before connectServer is set (see the header for the failure posture).
  if (process.env.RKS_REMOTE_BOOT_INDEX !== "skip") {
    const { ensureRagIndex, runRagEmbed } = await import("@routekit/rag");
    const indexed = await runBootIndex({ root, ensure: ensureRagIndex, embed: runRagEmbed });
    if (!indexed.ok) {
      console.error(`[mcp-rks-http] refusing to boot (boot_index_failed): ${indexed.error}`);
      httpServer.close();
      process.exit(1);
    }
  }
  deps.connectServer = serverModule.connectServer;

  // Idle eviction: the registry's sweepIdle pass (busy sessions are skipped; idle time is measured
  // from the end of the last activity).
  const sweepMs = Math.min(Math.max(Math.floor(idleMs / 2), 50), 60_000);
  const sweeper = setInterval(() => { registry.sweepIdle(); }, sweepMs);
  sweeper.unref();

  console.error(`[mcp-rks-http] listening on http://${bound.address}:${boundPort}${MCP_PATH} (project ${projectId}, actor ${launchActor})`);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Until every close is observed to succeed, an exit is a failed one.
    process.exitCode = 1;
    clearInterval(sweeper);
    registry.clearStreamTimers();
    const live = [...sessions.values(), ...pending];
    sessions.clear();
    pending.clear();
    let closed = 0;
    let failed = 0;
    const fallback = setTimeout(() => {
      console.error(`[mcp-rks-http] shutdown fallback fired (closed=${closed} failed=${failed} pending=${live.length - closed - failed})`);
      process.exit(1);
    }, SHUTDOWN_FALLBACK_MS);
    fallback.unref();
    Promise.allSettled(live.map((entry) => closeEntry(entry).then((r) => {
      if (r.closed) closed += 1;
      else { failed += 1; console.error(`[mcp-rks-http] shutdown close failed: ${r.error}`); }
    }))).then(() => {
      httpServer.close();
      httpServer.closeIdleConnections?.();
      console.error(`[mcp-rks-http] shutdown sessions=${live.length} closed=${closed} failed=${failed} fallback=false`);
      clearTimeout(fallback);
      process.exit(failed === 0 ? 0 : 1);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { httpServer, sessions, port: boundPort, maxSessions, idleMs };
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    _origLog([
      "mcp-rks-http - loopback Streamable-HTTP entry for the rks remote lane",
      "",
      "Usage:",
      "  RKS_REMOTE_ROOT=<worktree> RKS_ACTOR=<actor> mcp-rks-http",
      "",
      "The bearer secret is read from RKS_REMOTE_ROOT/.env (RKS_REMOTE_BEARER, 32+ characters).",
      "",
      "Multi-session: each MCP initialize opens its own session (its own transport and server,",
      "keyed by the mcp-session-id header), so a client can re-initialize without a restart.",
      `  RKS_REMOTE_MAX_SESSIONS     concurrent session cap, positive integer (default ${DEFAULT_MAX_SESSIONS});`,
      "                              an initialize over the cap gets 503",
      `  RKS_REMOTE_SESSION_IDLE_MS  idle sessions are evicted after this many ms (default ${DEFAULT_SESSION_IDLE_MS})`,
      `  RKS_REMOTE_STREAM_MAX_MS    a routed response still open after this many ms is ended (default ${DEFAULT_STREAM_MAX_MS})`,
      `  RKS_REMOTE_SSE_HEARTBEAT_MS an open SSE stream gets a ": keepalive" comment every this many ms (default ${DEFAULT_SSE_HEARTBEAT_MS})`,
      "A request with an unknown mcp-session-id gets 404; DELETE with the header ends that session.",
      "",
      "Boot index: the worktree RAG index is checked at boot and built when absent, before sessions are",
      "served; a failed build refuses boot (boot_index_failed). RKS_REMOTE_BOOT_INDEX=skip skips the step.",
    ].join("\n"));
    process.exit(0);
  }
  main().catch((err) => {
    console.error(`[mcp-rks-http] FATAL: ${err?.message ?? err}`);
    process.exit(1);
  });
}
