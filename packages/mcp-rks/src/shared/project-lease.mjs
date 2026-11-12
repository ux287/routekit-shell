import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getTelemetryCollector } from "@routekit/telemetry";
import { isLiveRootUnderTest, refuseLiveRootDeletion } from "./live-root-guard.mjs";

/**
 * Project lease (backlog.feat.project-lease-actor-attribution, Phase 1a of
 * notes/research.2026.10.29.external-agent-dispatch-parity.md).
 *
 * A readers-writer lease per projectId that mirrors the CLAUDE.md Singleton Rule:
 *   - shared:    flowType "open" (Research, PO, ARCH). Any number may coexist.
 *   - exclusive: flowType "story", "qa", "ship", "ops", and every off-rail holder.
 * An exclusive request is refused while any OTHER holder is live; any request is refused while
 * another holder's exclusive lease is live. The same holder (equal holderKey) is never refused.
 *
 * Holder key: `run:<RKS_DISPATCH_RUN_ID>` when the session carries a run id, else
 * `session:<token>`; an off-rail holder entered without a valid caller token is `offrail:<uuid>`.
 * The run id, actor and via are SELF-REPORTED attribution, not authentication: a process that
 * guesses a live run id joins that holder (§2 residual risk, same trust level as all §3 fields).
 *
 * Store (§3, §5b):
 *   - disk:   one JSON record per holder under <sessionRoot>/.rks/session/lease/ (gitignored).
 *             Every check-then-write runs inside a critical section guarded by a KERNEL-HELD lock
 *             (backlog.feat.project-lease-kernel-held-acquire): a node:sqlite DatabaseSync connection
 *             on acquire.sqlite in the same directory, with PRAGMA busy_timeout = 0 and BEGIN EXCLUSIVE
 *             to take it and COMMIT + close() to release it. The operating system drops the lock when
 *             the holder closes the connection or dies (SIGKILL included), so nothing judges the lock's
 *             age and no production path unlinks, renames or truncates the lock file. Two mcp-rks
 *             processes racing for an exclusive lease therefore cannot both succeed. The default
 *             rollback journal is kept (never the write-ahead log), and no plain fs fd is ever opened on
 *             the lock file: closing any fd on it would drop this process's POSIX locks.
 *             A busy lock (SQLITE_BUSY / SQLITE_LOCKED) is retried for a bounded attempt count; any
 *             other failure (a lock file that is not a SQLite database, EACCES, a failed mkdir, a
 *             failed node:sqlite load) fails closed at once and the refusal carries `lockError`
 *             (the error's generic `code`), plus SQLite's numeric `errcode` and its `errstr` when the
 *             thrown error carries them (node:sqlite gives every SQLite failure the same generic code,
 *             so errcode is what tells a non-database lock file from a directory at the lock path).
 *             The one-time [project-lease] log line names the lock file and the remedy; rks never
 *             removes the file itself.
 *             node:sqlite is loaded lazily on the first lock use, so an importer that only calls
 *             resolveAttribution loads no SQLite and sees no ExperimentalWarning.
 *             RESTART RULE (mixed versions): servers that predate this lock guard the section with the
 *             legacy exclusive-create acquire file and do not exclude servers running this code, so
 *             every running mcp-rks server for a project (every IDE window and every dispatch process)
 *             must be restarted onto this code; until then an old-code and a new-code server can both
 *             be admitted exclusive leases. A leftover legacy acquire file is inert here.
 *             No path runs a critical section without the lock: when the lock stays held past the
 *             bounded wait or fails, every operation writes nothing and refuses, the three releases
 *             (releaseLease, revertOffRail, releaseOffRail) included. A refused release returns
 *             { released|reverted: false, contended: true, ... } with the lock-error detail and emits
 *             lease.release_contended naming its op; the holder it left is reclaimed by the normal
 *             liveness rules (expired / offrail_orphan) on a later locked acquire
 *             (backlog.fix.project-lease-release-runs-unlocked-on-contention).
 *   - memory: used when the governor-token session root is null. Same compatibility rules,
 *             process-local reach. The degradation is volunteered (store: "memory",
 *             degraded: "no_project_root", one console.error per module instance). When a root is
 *             set later, acquisition consults the UNION of both stores.
 * Every exported operation result carries `store` naming the store it read and wrote.
 *
 * Liveness: a holder is live while it is off-rail (until rks_guardrails_on / rks_guardrails_abort
 * releases it, or orphan reclaim), or while at least one of its sessions was active within
 * LEASE_MAX_AGE_MS. touchSession refreshes a session's on-disk activity at most once per
 * LEASE_REFRESH_INTERVAL_MS, so a peer process never sees an active holder lag by more than that.
 *
 * Release NEVER deletes or edits .rks/active-scope.json, the guard state file or hooks.bak.
 *
 * This module is the ONLY home of the lock primitive: governor-init.mjs and governor-token.mjs
 * carry none (pinned by tests/unit/governor-session-multi-caller.test.mjs).
 */

/** Flow types that take an exclusive lease. "open" takes a shared lease. */
export const EXCLUSIVE_FLOWS = new Set(["story", "qa", "ship", "ops"]);

/** Lane values accepted for `via` (input and RKS_VIA). */
export const VALID_VIA = new Set(["ide", "dispatch", "call", "mcp", "remote"]);

/** Mirrors governor-token.mjs MAX_AGE_MS (30 minutes). Kept local: this module stays a leaf. */
export const LEASE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * backlog.feat.remote-surface-lane: the shorter idle window for remote-lane holders and governor
 * sessions (10 minutes). governor-token.mjs imports it from here, so this module stays a leaf.
 */
export const REMOTE_IDLE_MS = 10 * 60 * 1000;

/** touchSession refreshes a holder's on-disk liveness at most once per this interval. */
export const LEASE_REFRESH_INTERVAL_MS = 60 * 1000;

/** How long an acquisition waits for a held lease lock before giving up (attempt-counted). */
export const ACQUIRE_WAIT_MS = 200;

/**
 * A holder session whose session record is not observable yet (acquire precedes createSession, so a
 * peer process can look between the two) stays live this long after it joined the holder.
 */
export const PENDING_SESSION_GRACE_MS = 30 * 1000;

/**
 * backlog.fix.project-lease-post-init-verification-and-conversion-window (D4): an off-rail holder is
 * not reclaimed as an orphan within this long of its conversion stamp (offRailConvertedAt).
 * rks_guardrails_off converts the lease BEFORE guardrailsOff writes the guard state and hooks.bak, so
 * without the grace a peer could reclaim the new holder in between. A holder whose process died
 * before guardrailsOff ran is still reclaimed once the grace has passed.
 */
export const OFFRAIL_CONVERSION_GRACE_MS = 2 * 60 * 1000;

/** The reason a session whose holder was lost is refused with at tool dispatch (D3). */
export const LEASE_LOST = "lease_lost";

/** The kernel lock file in the lease dir. Not *.json, so loadAll never reads it. Never unlinked. */
const LOCK_FILE = "acquire.sqlite";
const ACQUIRE_POLL_MS = 10;

/** The stable lockError when node:sqlite cannot be loaded (mirrors ERR_EMBED_LOCK_SQLITE_UNAVAILABLE). */
export const LEASE_LOCK_SQLITE_UNAVAILABLE = "ERR_LEASE_LOCK_SQLITE_UNAVAILABLE";

/** SQLITE_BUSY and SQLITE_LOCKED primary result codes: the lock is held by another connection. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** The degradation object volunteered on the memory store (§5b, §5c). */
export const MEMORY_DEGRADATION = Object.freeze({ store: "memory", degraded: "no_project_root" });

/** @type {Map<string, object>} memory store: `${projectId}\n${holderKey}` -> holder record */
const _memory = new Map();
/** @type {Map<string, {projectRoot: string|null, projectId: string, holderKey: string}>} token -> holder location */
const _tokenIndex = new Map();
/** @type {Map<string, number>} token -> last refresh attempt (throttle) */
const _refreshAt = new Map();
/**
 * backlog.fix.project-lease-post-init-verification-and-conversion-window (D3): tokens this process
 * knows held a lease and has NOT seen deliberately released, with what re-acquiring needs.
 * token -> { projectRoot, projectId, holderKey, flowType, problemId, runId, actor, via, client, offRail }
 * Unlike _tokenIndex, an entry survives reclaim in loadLiveHolders (reason "expired"), so a later
 * observed holder-record absence reads as LOST. A deliberate end (releaseLease, releaseOffRail,
 * revertOffRail with created, off-rail orphan reclaim) deletes the entry; an entry whose holder was
 * off-rail when last seen is never lost (the off-rail lifecycle ends only deliberately).
 * @type {Map<string, object>}
 */
const _heldIndex = new Map();
let _degradationLogged = false;
/** lockError (+ errcode) keys already logged by this module instance (kept apart from _degradationLogged). */
const _lockErrorsLogged = new Set();

/**
 * Telemetry seam. Every lease event goes through leaseTelemetry.emit so a test can observe it
 * with vi.spyOn without re-mocking the telemetry package. Best-effort: never changes a decision.
 */
export const leaseTelemetry = {
  emit(event, projectId, payload) {
    try { getTelemetryCollector().emit(event, projectId, payload); } catch { /* best-effort */ }
  },
};

export function emitLeaseEvent(event, projectId, payload) {
  try { leaseTelemetry.emit(event, projectId, payload); } catch { /* best-effort */ }
}

/** @returns {"shared"|"exclusive"} */
export function leaseModeFor(flowType) {
  return EXCLUSIVE_FLOWS.has(flowType) ? "exclusive" : "shared";
}

/** Holder key: one per dispatch run, else one per session token. */
export function holderKeyFor({ runId, token }) {
  return runId ? `run:${runId}` : `session:${token}`;
}

export function getLeaseDir(projectRoot) {
  return path.join(projectRoot, ".rks", "session", "lease");
}

const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Resolve attribution (§6). Env wins because the launcher, not the LLM inside it, sets the run
 * identity: actor = RKS_ACTOR, else input, else null; via = a valid RKS_VIA, else a valid
 * RKS_VIA_DEFAULT, else a valid input, else "mcp"; client = the MCP client name handed in by the handler, else null; runId =
 * RKS_DISPATCH_RUN_ID, else null.
 */
export function resolveAttribution({ actor, via, clientName } = {}) {
  const envActor = process.env.RKS_ACTOR;
  const envVia = process.env.RKS_VIA;
  // backlog.feat.server-lane-policy AC1: RKS_VIA_DEFAULT is consulted only when RKS_VIA is unset or
  // invalid, so an rks-authored .mcp.json label (ide) never overrides an inherited RKS_VIA=dispatch.
  const envViaDefault = process.env.RKS_VIA_DEFAULT;
  const envRun = process.env.RKS_DISPATCH_RUN_ID;
  return {
    actor: nonEmpty(envActor) ? envActor : (nonEmpty(actor) ? actor : null),
    via: VALID_VIA.has(envVia) ? envVia
      : VALID_VIA.has(envViaDefault) ? envViaDefault
      : (VALID_VIA.has(via) ? via : "mcp"),
    client: nonEmpty(clientName) ? clientName : null,
    runId: nonEmpty(envRun) ? envRun : null,
  };
}

/** The run id this process inherits (RKS_DISPATCH_RUN_ID), or null. */
export function currentRunId() {
  return resolveAttribution().runId;
}

// ── store primitives ────────────────────────────────────────────────

const memKey = (projectId, holderKey) => `${projectId}\n${holderKey}`;

function recordFile(projectRoot, projectId, holderKey) {
  const digest = crypto.createHash("sha256").update(`${projectId}\n${holderKey}`).digest("hex").slice(0, 40);
  return path.join(getLeaseDir(projectRoot), `${digest}.json`);
}

function noteStore(projectRoot) {
  if (projectRoot) return "disk";
  if (!_degradationLogged) {
    _degradationLogged = true;
    console.error("[project-lease] no project root set: the project lease is held in process memory only (store: memory, degraded: no_project_root); it is not visible to other mcp-rks processes");
  }
  return "memory";
}

/** All holder records: the disk store under projectRoot (when set) plus the memory store. */
function loadAll(projectRoot) {
  const out = [];
  if (projectRoot) {
    const dir = getLeaseDir(projectRoot);
    let names = [];
    try { names = fs.existsSync(dir) ? fs.readdirSync(dir) : []; } catch { names = []; }
    for (const name of names) {
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        if (rec && typeof rec === "object" && rec.projectId && rec.holderKey) out.push({ ...rec, _store: "disk" });
      } catch { /* a torn or foreign file is skipped */ }
    }
  }
  for (const rec of _memory.values()) out.push({ ...rec, _store: "memory" });
  return out;
}

function readOne(projectRoot, projectId, holderKey) {
  if (projectRoot) {
    try {
      const file = recordFile(projectRoot, projectId, holderKey);
      if (fs.existsSync(file)) return { ...JSON.parse(fs.readFileSync(file, "utf8")), _store: "disk" };
    } catch { /* fall through to memory */ }
  }
  const mem = _memory.get(memKey(projectId, holderKey));
  return mem ? { ...mem, _store: "memory" } : null;
}

function writeRecord(projectRoot, rec) {
  const { _store, ...data } = rec;
  if (_store === "disk" && projectRoot) {
    const file = recordFile(projectRoot, data.projectId, data.holderKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return;
  }
  _memory.set(memKey(data.projectId, data.holderKey), data);
}

/**
 * Remove one holder record. `deliberate` names the tokens whose lease ends deliberately with it
 * ("all", the default, or an array): their _heldIndex entries go too. Any other token of the record
 * keeps its entry, so its next lease check sees the absence as a lost holder (D3).
 */
function removeRecord(projectRoot, rec, { deliberate = "all" } = {}) {
  if (rec._store === "disk" && projectRoot) {
    try { fs.unlinkSync(recordFile(projectRoot, rec.projectId, rec.holderKey)); } catch { /* already gone */ }
  } else {
    _memory.delete(memKey(rec.projectId, rec.holderKey));
  }
  for (const token of Object.keys(rec.sessions || {})) {
    _tokenIndex.delete(token);
    _refreshAt.delete(token);
    if (deliberate === "all" || deliberate.includes(token)) _heldIndex.delete(token);
  }
}

/** Record that `token` holds a lease in `rec` (D3), keeping what a re-acquire needs. */
function noteHeld(projectRoot, rec, token, { flowType } = {}) {
  if (!token) return;
  const s = rec.sessions?.[token];
  _heldIndex.set(token, {
    projectRoot: projectRoot || null,
    projectId: rec.projectId,
    holderKey: rec.holderKey,
    flowType: flowType !== undefined ? flowType : (s?.flowType ?? rec.flowType ?? null),
    problemId: rec.problemId ?? null,
    runId: rec.runId ?? null,
    actor: rec.actor ?? null,
    via: rec.via ?? null,
    client: rec.client ?? null,
    offRail: rec.offRail === true,
  });
}

/** Mark every known token of rec as off-rail (or not) in _heldIndex. */
function markHeldOffRail(rec, offRail) {
  for (const token of Object.keys(rec.sessions || {})) {
    const entry = _heldIndex.get(token);
    if (entry) entry.offRail = offRail;
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best-effort pause */ }
}

let _sqlite = null;

/** Load node:sqlite synchronously on first lock use. Throws with code LEASE_LOCK_SQLITE_UNAVAILABLE. */
function loadSqlite() {
  if (_sqlite) return _sqlite;
  let mod = null;
  try {
    mod = typeof process.getBuiltinModule === "function"
      ? process.getBuiltinModule("node:sqlite")
      : createRequire(import.meta.url)("node:sqlite");
  } catch (err) {
    const wrapped = new Error(`project lease lock requires node:sqlite (Node >=22.13.0); this is Node ${process.version}: ${err?.message ?? err}`);
    wrapped.code = LEASE_LOCK_SQLITE_UNAVAILABLE;
    throw wrapped;
  }
  if (!mod || typeof mod.DatabaseSync !== "function") {
    const err = new Error(`project lease lock requires node:sqlite (Node >=22.13.0); this is Node ${process.version}`);
    err.code = LEASE_LOCK_SQLITE_UNAVAILABLE;
    throw err;
  }
  _sqlite = mod;
  return _sqlite;
}

/** Busy is classified by SQLite's result code (errcode, primary byte), never by the generic `code`. */
function isBusy(err) {
  const c = err?.errcode;
  if (typeof c !== "number") return false;
  const primary = c & 0xff;
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

function closeQuietly(db) {
  try { db?.close(); } catch { /* already closed */ }
}

/**
 * One [project-lease] console.error per distinct lockError + errcode per module instance. The line
 * names the lock file, the lockError, SQLite's errcode / errstr when present, and the remedy: rks
 * never removes the lock file, so a person removes it once no mcp-rks process for the project runs.
 */
function noteLockError(detail, lockPath) {
  const { lockError, errcode, errstr } = detail;
  const key = errcode === undefined ? lockError : `${lockError}:${errcode}`;
  if (_lockErrorsLogged.has(key)) return;
  _lockErrorsLogged.add(key);
  const sqlite = (errcode === undefined ? "" : `, errcode: ${errcode}`) + (errstr === undefined ? "" : `, errstr: ${errstr}`);
  console.error(`[project-lease] the lease lock could not be taken (lockError: ${lockError}${sqlite}, lock file: ${lockPath}); exclusive lease operations are refused (lease_contended) until it is fixed. rks never removes this file; if no mcp-rks process for this project is running, remove ${lockPath} and retry`);
}

/**
 * Take the kernel-held lease lock. Returns { db } (an open DatabaseSync inside BEGIN EXCLUSIVE),
 * { held: true } when it stays busy for the bounded wait, or { lockError, errcode?, errstr? } when
 * it failed for a non-busy reason (fails at once, no wait). Bounded by attempt count (not the clock),
 * so fake timers cannot spin it forever. lockError is the generic `code` of the error SQLite,
 * mkdirSync or the node:sqlite load threw; errcode (a number) and errstr (a non-empty string) are
 * SQLite's own result code and message, present only when the thrown error carries them. No plain
 * fs fd is ever opened on the lock file.
 */
function takeAcquireFile(projectRoot, { wait }) {
  const dir = getLeaseDir(projectRoot);
  const lockPath = path.join(dir, LOCK_FILE);
  const fail = (err) => {
    const lockError = typeof err?.code === "string" && err.code !== "" ? err.code : "UNKNOWN";
    const detail = { lockError };
    if (typeof err?.errcode === "number") detail.errcode = err.errcode;
    if (typeof err?.errstr === "string" && err.errstr !== "") detail.errstr = err.errstr;
    noteLockError(detail, lockPath);
    return detail;
  };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { return fail(err); }
  let DatabaseSync;
  try { ({ DatabaseSync } = loadSqlite()); } catch (err) { return fail(err); }
  const attempts = wait ? Math.max(1, Math.ceil(ACQUIRE_WAIT_MS / ACQUIRE_POLL_MS)) : 1;
  for (let i = 0; i <= attempts; i++) {
    let db;
    try {
      db = new DatabaseSync(lockPath);
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      return { db };
    } catch (err) {
      closeQuietly(db);
      if (!isBusy(err)) return fail(err);
    }
    if (i < attempts) sleepSync(ACQUIRE_POLL_MS);
  }
  return { held: true };
}

/** End the exclusive transaction and close the connection; the kernel drops the lock. */
function releaseAcquireFile(db) {
  try {
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
  }
  closeQuietly(db);
}

/**
 * A refused critical section: lockError is set only for a non-busy lock failure, and errcode /
 * errstr only when that failure's thrown error carried them.
 */
class Contended {
  constructor(lock = {}) {
    if (lock.lockError) {
      this.lockError = lock.lockError;
      if (lock.errcode !== undefined) this.errcode = lock.errcode;
      if (lock.errstr !== undefined) this.errstr = lock.errstr;
    }
  }
}

/**
 * Spread into a refusal / payload: { lockError, errcode?, errstr? } for a non-busy failure (each
 * SQLite key only when observed), else nothing (a busy refusal carries none of the three).
 */
const lockErrorField = (c) => {
  if (!c.lockError) return {};
  const field = { lockError: c.lockError };
  if (c.errcode !== undefined) field.errcode = c.errcode;
  if (c.errstr !== undefined) field.errstr = c.errstr;
  return field;
};

/**
 * Run fn inside the kernel-held lock. The memory store needs no lock: this module is synchronous,
 * so a call is atomic within its process. When no connection was obtained (busy past the bounded
 * wait, or a non-busy lock failure) fn never runs and a Contended is returned: no caller, release
 * or otherwise, runs its read-modify-write without the lock.
 */
function withAcquireFile(projectRoot, fn, { wait = true } = {}) {
  if (!projectRoot) return fn();
  const lock = takeAcquireFile(projectRoot, { wait });
  if (!lock.db) return new Contended(lock);
  try {
    return fn();
  } finally {
    releaseAcquireFile(lock.db);
  }
}

// ── liveness ────────────────────────────────────────────────────────

/** @type {null | ((token: string) => { known: boolean, live?: boolean, lastActivity?: number })} */
let _sessionProbe = null;

/**
 * Install the session-liveness probe (governor-token.mjs registers its own at load, keeping this
 * module a leaf). A holder session is live when the probe knows it, reports it live (not terminal;
 * a persisted `executing` record is NOT dead by itself), and the later of its own activity and the lease's refreshed stamp is within
 * LEASE_MAX_AGE_MS. A session the probe does not know (no in-memory session, no persisted record)
 * is not live. With no probe installed, the lease's own stamp alone decides.
 */
export function setSessionLivenessProbe(probe) {
  _sessionProbe = typeof probe === "function" ? probe : null;
}

function liveSessionTokens(rec, now) {
  // backlog.feat.remote-surface-lane: a remote-lane holder uses REMOTE_IDLE_MS on both comparisons.
  const maxAge = rec.via === "remote" ? REMOTE_IDLE_MS : LEASE_MAX_AGE_MS;
  return Object.entries(rec.sessions || {})
    .filter(([token, s]) => {
      let last = Number(s?.lastActivity) || 0;
      if (_sessionProbe) {
        let seen;
        try { seen = _sessionProbe(token); } catch { seen = undefined; }
        if (seen === undefined) return now - last <= maxAge; // probe failed: the stamp decides
        if (!seen || !seen.known) {
          // Acquire precedes createSession, so a peer process can see a holder whose session record
          // is not written yet. Such a session is live for PENDING_SESSION_GRACE_MS after it joined.
          const joined = Number(s?.joinedAt) || last;
          return now - joined <= PENDING_SESSION_GRACE_MS;
        }
        // Only a terminal session is dead outright. An `executing` one is decided by the refreshed
        // stamp below, like any other (backlog.fix.project-lease-executing-holder-and-offrail-retry D1).
        if (!seen.live) return false;
        last = Math.max(last, Number(seen.lastActivity) || 0);
      }
      return now - last <= maxAge;
    })
    .map(([token]) => token);
}

function holderMode(rec, now) {
  if (rec.offRail) return "exclusive";
  const live = new Set(liveSessionTokens(rec, now));
  return Object.entries(rec.sessions || {}).some(([t, s]) => live.has(t) && s?.mode === "exclusive") ? "exclusive" : "shared";
}

/**
 * Orphan evidence for an off-rail holder (§5): hooks.bak absent AND guard state not off. The
 * guard state is "off" when .rks/guardrails-state.json parses with active === false; an
 * unparseable file is ambiguous and fails closed (treated as off, so no reclaim).
 *
 * backlog.fix.project-lease-post-init-verification-and-conversion-window (D4): a holder within
 * OFFRAIL_CONVERSION_GRACE_MS of its conversion stamp is never an orphan, because guardrailsOff
 * has not yet had the chance to write that evidence. Outside the grace the rule is unchanged.
 */
function withinConversionGrace(rec, now) {
  const stamp = Number(rec?.offRailConvertedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return Math.abs(now - stamp) <= OFFRAIL_CONVERSION_GRACE_MS;
}

function isOffRailOrphan(projectRoot, rec, now) {
  if (!projectRoot) return false;
  if (withinConversionGrace(rec, now)) return false;
  if (fs.existsSync(path.join(projectRoot, ".routekit", "hooks.bak"))) return false;
  const statePath = path.join(projectRoot, ".rks", "guardrails-state.json");
  if (!fs.existsSync(statePath)) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return !(parsed && typeof parsed === "object" && parsed.active === false);
  } catch {
    return false;
  }
}

/**
 * Live holders for projectId. Reclaims (removes, with lease.released) an expired non-off-rail
 * holder (reason "expired") and an orphaned off-rail holder (reason "offrail_orphan").
 */
function loadLiveHolders(projectRoot, projectId, now) {
  const live = [];
  for (const rec of loadAll(projectRoot)) {
    if (rec.projectId !== projectId) continue;
    if (rec.offRail) {
      if (isOffRailOrphan(projectRoot, rec, now)) {
        removeRecord(projectRoot, rec);
        emitLeaseEvent("lease.released", projectId, { projectId, holderKey: rec.holderKey, reason: "offrail_orphan" });
        continue;
      }
      live.push(rec);
      continue;
    }
    if (liveSessionTokens(rec, now).length === 0) {
      // Not deliberate: a session of this holder that is still in use sees the absence as lost (D3).
      removeRecord(projectRoot, rec, { deliberate: [] });
      emitLeaseEvent("lease.released", projectId, { projectId, holderKey: rec.holderKey, reason: "expired" });
      continue;
    }
    live.push(rec);
  }
  return live;
}

/** The `holder` object a project_leased refusal carries. */
function summarizeHolder(rec) {
  return {
    holderKey: rec.holderKey,
    actor: rec.actor ?? null,
    via: rec.via ?? null,
    client: rec.client ?? null,
    flowType: rec.flowType ?? null,
    problemId: rec.problemId ?? null,
    runId: rec.runId ?? null,
    since: rec.since ?? null,
    offRail: rec.offRail === true,
  };
}

function findHolderLocation(projectRoot, token) {
  if (!token) return null;
  const indexed = _tokenIndex.get(token);
  if (indexed) return indexed;
  for (const rec of loadAll(projectRoot)) {
    if (rec.sessions && Object.prototype.hasOwnProperty.call(rec.sessions, token)) {
      return { projectRoot: rec._store === "disk" ? projectRoot : null, projectId: rec.projectId, holderKey: rec.holderKey };
    }
  }
  return null;
}

// ── operations ──────────────────────────────────────────────────────

/**
 * Try to acquire the project lease for one session. Returns
 * { ok: true, holderKey, mode, store } or
 * { ok: false, reason: "project_leased", holder, requested, store } (or reason "lease_contended"
 * with holder null when the lease lock stayed held, plus lockError when it failed for a non-busy
 * reason). Nothing is written on refusal.
 */
export function acquireLease({ projectRoot, projectId, flowType, problemId, token, runId, actor, via, client }) {
  const root = projectRoot || null;
  const store = noteStore(root);
  const mode = leaseModeFor(flowType);
  const holderKey = holderKeyFor({ runId, token });
  const requested = { flowType: flowType ?? null, problemId: problemId ?? null, actor: actor ?? null, via: via ?? null, runId: runId ?? null };

  const out = withAcquireFile(root, () => {
    const now = Date.now();
    const live = loadLiveHolders(root, projectId, now);
    const conflict = live.find((h) => h.holderKey !== holderKey && (mode === "exclusive" || holderMode(h, now) === "exclusive"));
    if (conflict) {
      return { ok: false, reason: "project_leased", holder: summarizeHolder(conflict), requested: { flowType: requested.flowType, problemId: requested.problemId }, store };
    }
    let rec = live.find((h) => h.holderKey === holderKey);
    if (rec) {
      rec.sessions = { ...(rec.sessions || {}), [token]: { mode, flowType: flowType ?? null, lastActivity: now, joinedAt: now } };
      if (mode === "exclusive" && leaseModeFor(rec.flowType) !== "exclusive") {
        rec.flowType = flowType ?? null;
        rec.problemId = problemId ?? null;
      }
    } else {
      rec = {
        v: 1,
        projectId,
        holderKey,
        token: token ?? null,
        flowType: flowType ?? null,
        problemId: problemId ?? null,
        runId: runId ?? null,
        actor: actor ?? null,
        via: via ?? null,
        client: client ?? null,
        since: new Date(now).toISOString(),
        offRail: false,
        sessions: { [token]: { mode, flowType: flowType ?? null, lastActivity: now, joinedAt: now } },
        _store: store,
      };
    }
    writeRecord(root, rec);
    _tokenIndex.set(token, { projectRoot: rec._store === "disk" ? root : null, projectId, holderKey });
    _refreshAt.set(token, now);
    noteHeld(rec._store === "disk" ? root : null, rec, token, { flowType: flowType ?? null });
    return { ok: true, holderKey, mode: holderMode(rec, now), store };
  });

  if (out instanceof Contended) {
    const refused = { ok: false, reason: "lease_contended", holder: null, requested: { flowType: requested.flowType, problemId: requested.problemId }, store, ...lockErrorField(out) };
    emitLeaseEvent("lease.refused", projectId, { projectId, requested, holder: null, store, contended: true, ...lockErrorField(out) });
    return refused;
  }
  if (out.ok) {
    emitLeaseEvent("lease.acquired", projectId, { projectId, holderKey: out.holderKey, mode: out.mode, flowType: requested.flowType, problemId: requested.problemId, actor: requested.actor, via: requested.via, runId: requested.runId, store });
  } else {
    emitLeaseEvent("lease.refused", projectId, { projectId, requested, holder: out.holder, store });
  }
  return out;
}

/**
 * Release one session token from its holder (endSession, §4/§4a). Returns null when the token
 * holds no lease; otherwise { released: true, holderKey, store } when the holder record was
 * removed, or { released: false, holderKey, remaining: "run_sessions" | "offrail", store } when
 * other live sessions of the holder, or its off-rail state, keep it. When the lock is contended it
 * writes nothing and returns { released: false, contended: true, holderKey, store } plus the
 * lock-error detail; the token stays listed until the holder is reclaimed as expired.
 */
export function releaseLease({ projectRoot, token, reason = "session_end" }) {
  // A deliberate end of this token's lease (D3): it is never re-acquired or refused for it.
  if (token) _heldIndex.delete(token);
  const loc = findHolderLocation(projectRoot || null, token);
  if (!loc) return null;
  const root = loc.projectRoot;
  noteStore(root);
  // `store` in each result names the store of the record actually touched (§5c).
  const out = withAcquireFile(root, () => {
    const rec = readOne(root, loc.projectId, loc.holderKey);
    if (!rec || !rec.sessions || !Object.prototype.hasOwnProperty.call(rec.sessions, token)) {
      _tokenIndex.delete(token);
      _refreshAt.delete(token);
      return null;
    }
    const sessions = { ...rec.sessions };
    delete sessions[token];
    rec.sessions = sessions;
    _tokenIndex.delete(token);
    _refreshAt.delete(token);
    if (rec.offRail) {
      writeRecord(root, rec);
      return { released: false, holderKey: rec.holderKey, remaining: "offrail", store: rec._store };
    }
    if (liveSessionTokens(rec, Date.now()).length > 0) {
      writeRecord(root, rec);
      return { released: false, holderKey: rec.holderKey, remaining: "run_sessions", store: rec._store };
    }
    removeRecord(root, rec, { deliberate: [token] });
    emitLeaseEvent("lease.released", rec.projectId, { projectId: rec.projectId, holderKey: rec.holderKey, reason });
    return { released: true, holderKey: rec.holderKey, store: rec._store };
  });
  if (out instanceof Contended) {
    const store = root ? "disk" : "memory";
    emitLeaseEvent("lease.release_contended", loc.projectId, { projectId: loc.projectId, holderKey: loc.holderKey, op: "releaseLease", store, ...lockErrorField(out) });
    return { released: false, contended: true, holderKey: loc.holderKey, store, ...lockErrorField(out) };
  }
  return out ?? null;
}

/**
 * Refresh one session's activity on its holder record (touchSession, throttled to
 * LEASE_REFRESH_INTERVAL_MS per token). A token with no holder is a no-op that writes nothing.
 */
export function refreshLease({ projectRoot, token }) {
  const now = Date.now();
  const last = _refreshAt.get(token);
  const fallbackStore = projectRoot ? "disk" : "memory";
  if (last !== undefined && now - last < LEASE_REFRESH_INTERVAL_MS) {
    return { refreshed: false, throttled: true, holderKey: _tokenIndex.get(token)?.holderKey ?? null, store: fallbackStore };
  }
  if (token) _refreshAt.set(token, now);
  const loc = findHolderLocation(projectRoot || null, token);
  if (!loc) return { refreshed: false, holderKey: null, store: fallbackStore };
  const root = loc.projectRoot;
  const store = root ? "disk" : "memory";
  const out = withAcquireFile(root, () => {
    const rec = readOne(root, loc.projectId, loc.holderKey);
    if (!rec || !rec.sessions || !Object.prototype.hasOwnProperty.call(rec.sessions, token)) {
      _tokenIndex.delete(token);
      return { refreshed: false, holderKey: null, store };
    }
    rec.sessions = { ...rec.sessions, [token]: { ...rec.sessions[token], lastActivity: now } };
    writeRecord(root, rec);
    return { refreshed: true, holderKey: rec.holderKey, store: rec._store };
  }, { wait: false });
  if (out instanceof Contended) {
    _refreshAt.delete(token); // retry on the next touch
    return { refreshed: false, contended: true, holderKey: loc.holderKey, store, ...lockErrorField(out) };
  }
  return out;
}

/**
 * backlog.fix.project-lease-post-init-verification-and-conversion-window (D3): classify one token's
 * lease WITHOUT writing anything. Returns { status, holderKey, store }:
 *   - "held": a holder record carrying the token exists (live or not yet reclaimed; an `executing`
 *             holder whose record is still on disk is held, never lost).
 *   - "lost": this process saw the token hold a lease, did not see it deliberately released, the
 *             holder was not off-rail when last seen, and its holder record (or the token's entry in
 *             it) is now observed absent, e.g. after reclaim with reason "expired".
 *   - "none": the token never held a lease here (createSession-direct, pre-lease) or its lease ended
 *             deliberately (releaseLease / endSession, releaseOffRail, revertOffRail with created).
 */
export function checkLease({ projectRoot, token }) {
  const fallbackStore = projectRoot ? "disk" : "memory";
  if (!token) return { status: "none", holderKey: null, store: fallbackStore };
  const entry = _heldIndex.get(token);
  if (entry) {
    const rec = readOne(entry.projectRoot, entry.projectId, entry.holderKey);
    const store = entry.projectRoot ? "disk" : "memory";
    if (rec && rec.sessions && Object.prototype.hasOwnProperty.call(rec.sessions, token)) {
      entry.offRail = rec.offRail === true;
      return { status: "held", holderKey: rec.holderKey, store: rec._store };
    }
    if (entry.offRail) {
      _heldIndex.delete(token); // an off-rail holder only ever ends deliberately
      return { status: "none", holderKey: null, store };
    }
    return { status: "lost", holderKey: entry.holderKey, store };
  }
  const loc = findHolderLocation(projectRoot || null, token);
  if (loc) {
    const rec = readOne(loc.projectRoot, loc.projectId, loc.holderKey);
    if (rec && rec.sessions && Object.prototype.hasOwnProperty.call(rec.sessions, token)) {
      noteHeld(loc.projectRoot, rec, token); // observed held: a later absence reads as lost
      return { status: "held", holderKey: rec.holderKey, store: rec._store };
    }
  }
  return { status: "none", holderKey: null, store: fallbackStore };
}

/**
 * D3: re-verify one token's lease on use. "held" and "none" are admitted unchanged and write nothing.
 * A "lost" holder is re-acquired through acquireLease (same flowType, problemId, run id and
 * attribution as when it was last held) when no conflicting holder is live; otherwise the acquire's
 * refusal is returned and nothing is written. Returns
 *   { ok: true, status: "held" | "none", holderKey, store }
 *   { ok: true, status: "reacquired", holderKey, mode, store }
 *   { ok: false, status: "lost", reason: "project_leased" | "lease_contended", holder, requested, store }
 */
export function verifyLease({ projectRoot, token }) {
  const c = checkLease({ projectRoot, token });
  if (c.status !== "lost") return { ok: true, ...c };
  const entry = _heldIndex.get(token);
  const out = acquireLease({
    projectRoot: entry.projectRoot,
    projectId: entry.projectId,
    flowType: entry.flowType,
    problemId: entry.problemId,
    token,
    runId: entry.runId,
    actor: entry.actor,
    via: entry.via,
    client: entry.client,
  });
  if (out.ok) return { ok: true, status: "reacquired", holderKey: out.holderKey, mode: out.mode, store: out.store };
  return { ok: false, status: "lost", reason: out.reason, holder: out.holder, requested: out.requested, store: out.store };
}

/**
 * rks_guardrails_off conversion (§5, §5a). callerToken must already be VALID for conversion
 * (live, non-terminal, same projectId) or null. Run inheritance: with runId set, a live
 * `run:<runId>` holder IS the caller. Outcomes:
 *   - another holder live: { ok: false, reason: "project_leased", holder, requested, store }
 *   - caller's holder live: converted to off-rail; { ok: true, holderKey, converted: true, created: false, store }.
 *     When that holder was ALREADY off-rail (a retried rks_guardrails_off), the result also carries
 *     alreadyOffRail: true and prior: { offRail: true, offRailProblemId }, so a rollback restores the
 *     prior off-rail state instead of clearing it; a first conversion carries alreadyOffRail: false.
 *   - no holder live: a new exclusive off-rail holder (anonymous `offrail:<uuid>` / `run:<id>`
 *     with token null and flowType null when there is no caller token); { ok: true, holderKey, converted: false, created: true, store }
 */
export function convertToOffRail({ projectRoot, projectId, token = null, problemId = null, runId = null, actor = null, via = null, client = null }) {
  const root = projectRoot || null;
  const store = noteStore(root);
  const requested = { flowType: null, problemId: problemId ?? null, offRail: true };
  const out = withAcquireFile(root, () => {
    const now = Date.now();
    const live = loadLiveHolders(root, projectId, now);
    let callerKey = null;
    if (token) {
      const own = live.find((h) => h.sessions && Object.prototype.hasOwnProperty.call(h.sessions, token));
      callerKey = own ? own.holderKey : holderKeyFor({ runId, token });
    } else if (runId) {
      callerKey = `run:${runId}`;
    }
    const conflict = live.find((h) => h.holderKey !== callerKey);
    if (conflict) {
      return { ok: false, reason: "project_leased", holder: summarizeHolder(conflict), requested, store };
    }
    const own = callerKey ? live.find((h) => h.holderKey === callerKey) : null;
    if (own) {
      const alreadyOffRail = own.offRail === true;
      const prior = alreadyOffRail ? { offRail: true, offRailProblemId: own.offRailProblemId ?? null } : null;
      own.offRail = true;
      own.offRailProblemId = problemId ?? null;
      // D4: the conversion stamp. A retried conversion (already off-rail) keeps its original stamp.
      if (!alreadyOffRail) own.offRailConvertedAt = now;
      writeRecord(root, own);
      markHeldOffRail(own, true);
      return alreadyOffRail
        ? { ok: true, holderKey: own.holderKey, converted: true, created: false, alreadyOffRail: true, prior, store }
        : { ok: true, holderKey: own.holderKey, converted: true, created: false, alreadyOffRail: false, store };
    }
    const holderKey = callerKey ?? `offrail:${crypto.randomUUID()}`;
    const rec = {
      v: 1,
      projectId,
      holderKey,
      token: token ?? null,
      flowType: null,
      problemId: problemId ?? null,
      runId: runId ?? null,
      actor: actor ?? null,
      via: via ?? null,
      client: client ?? null,
      since: new Date(now).toISOString(),
      offRail: true,
      offRailProblemId: problemId ?? null,
      offRailConvertedAt: now,
      sessions: token ? { [token]: { mode: "exclusive", flowType: null, lastActivity: now, joinedAt: now } } : {},
      _store: store,
    };
    writeRecord(root, rec);
    markHeldOffRail(rec, true);
    if (token) _tokenIndex.set(token, { projectRoot: store === "disk" ? root : null, projectId, holderKey });
    return { ok: true, holderKey, converted: false, created: true, store };
  });
  if (out instanceof Contended) {
    emitLeaseEvent("lease.refused", projectId, { projectId, requested, holder: null, store, contended: true, ...lockErrorField(out) });
    return { ok: false, reason: "lease_contended", holder: null, requested, store, ...lockErrorField(out) };
  }
  if (out.ok) {
    emitLeaseEvent("lease.offrail_converted", projectId, { projectId, holderKey: out.holderKey, problemId: problemId ?? null });
  } else {
    emitLeaseEvent("lease.refused", projectId, { projectId, requested, holder: out.holder, store });
  }
  return out;
}

/**
 * Roll back a conversion when guardrailsOff returned non-ok or threw (§5a): a created holder is
 * removed, a converted holder returns to its prior mode with offRail false. Emits lease.released
 * with reason "guardrails_off_failed".
 *
 * With `prior` (from a convertToOffRail result with alreadyOffRail: true), the holder was off-rail
 * BEFORE the failed call, so the project is still off-rail: its prior offRail / offRailProblemId are
 * restored, nothing is released, and no event is emitted. Returns { reverted: false, restored: true }.
 *
 * When the lock is contended nothing is written and no lease.released is emitted: it returns
 * { reverted: false, contended: true, holderKey, store } plus the lock-error detail and emits
 * lease.release_contended. A created holder then stays off-rail until the conversion grace passes.
 */
export function revertOffRail({ projectRoot, projectId, holderKey, created, prior = null }) {
  const root = projectRoot || null;
  const store = noteStore(root);
  const out = withAcquireFile(root, () => {
    const rec = readOne(root, projectId, holderKey);
    if (!rec) return { reverted: false, holderKey, store };
    if (!created && prior && prior.offRail === true) {
      rec.offRail = true;
      rec.offRailProblemId = prior.offRailProblemId ?? null;
      writeRecord(root, rec);
      return { reverted: false, restored: true, holderKey, store: rec._store };
    }
    if (created) {
      removeRecord(root, rec); // deliberate (D3): the created holder's sessions hold no lease afterwards
    } else {
      rec.offRail = false;
      delete rec.offRailProblemId;
      delete rec.offRailConvertedAt;
      writeRecord(root, rec);
      markHeldOffRail(rec, false);
    }
    return { reverted: true, holderKey, store: rec._store };
  });
  if (out instanceof Contended) {
    emitLeaseEvent("lease.release_contended", projectId, { projectId, holderKey, op: "revertOffRail", store, ...lockErrorField(out) });
    return { reverted: false, contended: true, holderKey, store, ...lockErrorField(out) };
  }
  if (out.reverted) emitLeaseEvent("lease.released", projectId, { projectId, holderKey, reason: "guardrails_off_failed" });
  return out;
}

/**
 * Release the project's off-rail holder after an ok rks_guardrails_on / rks_guardrails_abort
 * (§5, §5a). Per project, not per token: at most one off-rail holder exists per projectId. The
 * holder record is removed entirely, including one converted from a caller session (that session
 * keeps existing but holds no lease afterwards). Returns { released, holderKey, store }. When the
 * lock is contended nothing is removed and no lease.released is emitted: it returns
 * { released: false, contended: true, holderKey: null, store } plus the lock-error detail and emits
 * lease.release_contended; the holder is reclaimed as offrail_orphan once its evidence is gone.
 */
export function releaseOffRail({ projectRoot, projectId, reason }) {
  const root = projectRoot || null;
  const store = noteStore(root);
  const released = withAcquireFile(root, () => {
    const out = [];
    for (const rec of loadAll(root)) {
      if (rec.projectId !== projectId || !rec.offRail) continue;
      removeRecord(root, rec);
      out.push(rec.holderKey);
    }
    return out;
  });
  if (released instanceof Contended) {
    emitLeaseEvent("lease.release_contended", projectId, { projectId, holderKey: null, op: "releaseOffRail", store, ...lockErrorField(released) });
    return { released: false, contended: true, holderKey: null, store, ...lockErrorField(released) };
  }
  for (const holderKey of released) {
    emitLeaseEvent("lease.released", projectId, { projectId, holderKey, reason });
  }
  return { released: released.length > 0, holderKey: released[0] ?? null, store };
}

/**
 * Every governor token referenced by ANY holder record's sessions map (disk store under
 * projectRoot plus the memory store), live, expired or off-rail alike
 * (backlog.fix.governor-session-records-never-swept). Read-only: it takes no lease lock and
 * never reclaims or removes a holder record, so the lease keeps sole authority over its own
 * expiry, and the governor-token sweep never deletes a record that leaseSessionProbe reads.
 * @returns {Set<string>}
 */
export function leaseListedTokens(projectRoot) {
  const out = new Set();
  for (const rec of loadAll(projectRoot)) {
    for (const token of Object.keys(rec.sessions || {})) out.add(token);
  }
  return out;
}

/**
 * Clear lease state for a project root: the memory store, the token index and the disk records.
 * Called by governor-token resetToken (which likewise removes every persisted session record) so
 * no holder leaks across test cases.
 */
export function resetLeases({ projectRoot } = {}) {
  _memory.clear();
  _tokenIndex.clear();
  _refreshAt.clear();
  _heldIndex.clear();
  if (projectRoot) {
    if (isLiveRootUnderTest(projectRoot)) refuseLiveRootDeletion("project lease records", getLeaseDir(projectRoot));
    try { fs.rmSync(getLeaseDir(projectRoot), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
