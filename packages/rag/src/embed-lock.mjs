/**
 * The RAG embed lock: one mutex for every embed, reset and compact entry point in @routekit/rag.
 * backlog.feat.rag-embed-lock-kernel-held (decision: notes/research.2026.11.11.rag-embed-lock-kernel-binding-decision.md).
 *
 * Ownership is a SQLite exclusive lock held by an open node:sqlite DatabaseSync connection inside
 * BEGIN EXCLUSIVE, with busy_timeout = 0 so a contender is refused at once instead of waiting. The
 * operating system drops that lock when the holder closes the connection or dies (SIGKILL included),
 * so there is no pid probe, no age rule and no reclaim step. SQLite's default rollback journal is
 * kept (never the write-ahead log mode): BEGIN EXCLUSIVE must block an independent reader too.
 *
 * Files under .rks/rag:
 *   embed-lock.sqlite        the kernel lock file. Created once and never unlinked, renamed or
 *                            truncated by this module. SQLite may create a sibling
 *                            embed-lock.sqlite-journal while the lock is held; it is not a lock.
 *   embed-lock.holder.json   holder metadata ({ pid, holder, started, nonce }) written after the
 *                            kernel lock is held and removed at release while it is still held. It
 *                            is used only for refusal messages and inspectEmbedLock, never for
 *                            ownership; after a SIGKILL it may be stale until the next acquire.
 *   .embed-lock              the legacy (pre-redesign) record. Never created, read or removed by this
 *                            module, and ignored for ownership (backlog.chore.rag-embed-lock-retire-legacy-compat).
 *
 * Leaf module: node builtins only and no sibling import, so tools.mjs, embed.mjs, the mcp-rks host and
 * the post-commit hook's detached child (which may load a lone copy of this file) can all import it.
 * node:sqlite is loaded lazily and synchronously on the first lock call, so importing this module on a
 * Node without node:sqlite does not fail; the lock call does, with a clear message.
 *
 * Unreadable lock: when SQLite cannot open or lock the file for a reason other than "held" (for
 * example the path is a directory, or permission is denied), the refusal carries errorCode, taken from
 * a plain fs open of the path. That open is made only after SQLite has failed, not before: closing any
 * fd on a file whose POSIX locks this process holds drops those locks, so this module never opens and
 * closes the lock file itself while a lock could be held. When that fs open succeeds (a regular file
 * that is not a SQLite database), errorCode is node:sqlite's generic code, and the refusal also carries
 * SQLite's errcode and errstr (backlog.fix.rag-embed-lock-error-detail); lockRefusalDetail formats
 * errorCode, errcode, errstr and a remedy naming the lock path for the tools.mjs and CLI messages.
 *
 * Same-process guard (backlog.fix.rag-embed-lock-held-map-guard): acquireEmbedLock, inspectEmbedLock
 * and unreadableDetail answer from this module's held entry for a lock file it holds, before opening any
 * DatabaseSync or fs fd on it. The held map is keyed by one canonical path for the lock file (the
 * realpath of .rks/rag joined with embed-lock.sqlite, or the plain joined path when .rks/rag does not
 * resolve), so every spelling of the same project root (a symlinked root) reaches the same entry.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

/** Exit code of the embed.mjs CLI when it refuses because another embed holds the lock (EX_TEMPFAIL). */
export const EMBED_LOCK_HELD_EXIT_CODE = 75;

/** SQLITE_BUSY and SQLITE_LOCKED: the lock is held by another connection. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** Locks this module instance holds, by canonical lock key (heldKey): { db, nonce, pid, holder, started }. */
const held = new Map();

let sqliteModule = null;

/** Load node:sqlite synchronously on first use. Throws a clear error when the module is unavailable. */
function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule =
      typeof process.getBuiltinModule === "function"
        ? process.getBuiltinModule("node:sqlite")
        : createRequire(import.meta.url)("node:sqlite");
  } catch (err) {
    sqliteModule = null;
    const wrapped = new Error(
      `embed lock requires node:sqlite (Node >=22.13.0); this is Node ${process.version}: ${err?.message ?? err}`,
    );
    wrapped.code = "ERR_EMBED_LOCK_SQLITE_UNAVAILABLE";
    throw wrapped;
  }
  if (!sqliteModule || typeof sqliteModule.DatabaseSync !== "function") {
    sqliteModule = null;
    const err = new Error(`embed lock requires node:sqlite (Node >=22.13.0); this is Node ${process.version}`);
    err.code = "ERR_EMBED_LOCK_SQLITE_UNAVAILABLE";
    throw err;
  }
  return sqliteModule;
}

/** The kernel lock file. */
export function embedLockPath(projectRoot) {
  return path.join(projectRoot, ".rks", "rag", "embed-lock.sqlite");
}

/**
 * Message suffix for a refusal that carries errorCode (the lock file could not be opened or locked for
 * a reason other than "held"): errorCode, then errcode / errstr when present, then a remedy naming the
 * lock path. Empty for a refusal without errorCode, so a busy (held) refusal message is unchanged.
 * rks never removes the lock file; the remedy tells the person when it is safe to.
 * backlog.fix.rag-embed-lock-error-detail.
 */
export function lockRefusalDetail(lock, lockPath) {
  if (!lock?.errorCode) return "";
  const parts = [`errorCode: ${lock.errorCode}`];
  if (typeof lock.errcode === "number") parts.push(`errcode: ${lock.errcode}`);
  if (typeof lock.errstr === "string" && lock.errstr.length > 0) parts.push(`errstr: ${lock.errstr}`);
  const remedy = lockPath
    ? `; rks never removes the lock file ${lockPath}: if no embed is running for this project, remove it and retry`
    : "";
  return ` (${parts.join(", ")}${remedy})`;
}

/**
 * The held-map key for a kernel lock path: the realpath of its directory joined with its basename, so
 * every spelling of the same project root yields one key. Falls back to the path as given when the
 * directory does not resolve (for example .rks/rag does not exist yet). Never throws, never creates.
 */
function heldKey(lockPath) {
  try {
    return path.join(fs.realpathSync(path.dirname(lockPath)), path.basename(lockPath));
  } catch {
    return lockPath;
  }
}

function holderRecordPath(projectRoot) {
  return path.join(projectRoot, ".rks", "rag", "embed-lock.holder.json");
}

function isBusy(err) {
  return err?.errcode === SQLITE_BUSY || err?.errcode === SQLITE_LOCKED;
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    // already closed
  }
}

/** Read a JSON record, or null when it is absent or unparseable. */
function readRecord(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Holder metadata for a held lock: this module's own entry when it holds it, else the sidecar. */
function holderInfo(projectRoot, lockPath) {
  const own = held.get(heldKey(lockPath));
  if (own) return { pid: own.pid, started: own.started, holder: own.holder };
  const data = readRecord(holderRecordPath(projectRoot));
  const info = {};
  if (data?.pid) info.pid = data.pid;
  if (data?.started !== undefined) info.started = data.started;
  if (data?.holder !== undefined) info.holder = data.holder;
  return info;
}

/**
 * SQLite's own errcode and errstr, when present, for a refusal whose errorCode is the generic SQLite
 * code (for example a regular file that is not a SQLite database: ERR_SQLITE_ERROR, errcode 26).
 * backlog.fix.rag-embed-lock-error-detail.
 */
function sqliteDetail(sqliteErr) {
  const detail = {};
  if (typeof sqliteErr?.errcode === "number") detail.errcode = sqliteErr.errcode;
  if (typeof sqliteErr?.errstr === "string" && sqliteErr.errstr.length > 0) detail.errstr = sqliteErr.errstr;
  return detail;
}

/**
 * { errorCode, errcode?, errstr? } for a lock file SQLite could not open or lock. errorCode is the OS
 * error code from a plain fs open of the path (EISDIR for a directory, EACCES for a permission
 * failure), falling back to the SQLite error's code; errcode / errstr are carried only on that fallback
 * (the fs probe could not name the failure) and never replace errorCode. A lock file this module holds
 * is never opened: closing that fd would drop the held POSIX locks. Never unlinks the file.
 */
function unreadableDetail(lockPath, sqliteErr) {
  const fallback = () => ({ errorCode: sqliteErr?.code || "UNKNOWN", ...sqliteDetail(sqliteErr) });
  if (held.has(heldKey(lockPath))) return fallback();
  let fd;
  try {
    fd = fs.openSync(lockPath, "r+");
  } catch (err) {
    if (err?.code) return { errorCode: err.code };
  }
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      // nothing to close
    }
  }
  return fallback();
}

/** Write the holder sidecar (best-effort: it is metadata, not ownership). */
function writeHolderRecord(projectRoot, record) {
  const file = holderRecordPath(projectRoot);
  const temp = `${file}.${record.nonce}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record), { flag: "wx" });
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      // never created
    }
  }
}

/** End the exclusive transaction and close the connection; the kernel drops the lock. */
function endTransaction(db) {
  try {
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no open transaction
    }
  }
  closeQuietly(db);
}

/**
 * Probe the lock without keeping it. Never throws and never creates or changes the kernel lock file.
 * Returns { locked: true, pid?, started?, holder?, errorCode?, errcode?, errstr? } or { locked: false };
 */
export function inspectEmbedLock(projectRoot) {
  try {
    const lockPath = embedLockPath(projectRoot);
    const own = held.get(heldKey(lockPath));
    if (own) return { locked: true, pid: own.pid, started: own.started, holder: own.holder };
    if (fs.existsSync(lockPath)) {
      const { DatabaseSync } = loadSqlite();
      let db;
      try {
        db = new DatabaseSync(lockPath);
        db.exec("PRAGMA busy_timeout = 0");
        // A shared read: refused at once while BEGIN EXCLUSIVE is held, released as soon as it ends.
        db.prepare("SELECT count(*) FROM sqlite_master").get();
      } catch (err) {
        closeQuietly(db);
        if (isBusy(err)) return { locked: true, ...holderInfo(projectRoot, lockPath) };
        return { locked: true, ...unreadableDetail(lockPath, err) };
      }
      closeQuietly(db);
    }
    return { locked: false };
  } catch {
    return { locked: true };
  }
}

/**
 * Release the lock this module holds under `nonce`: remove the sidecar while still holding the lock,
 * then COMMIT and close. Never throws. A nonce that does not own the lock leaves it held.
 */
export function releaseEmbedLock(projectRoot, nonce) {
  try {
    let key = heldKey(embedLockPath(projectRoot));
    let own = held.get(key);
    if (!own && nonce) {
      // The root no longer resolves to the key it was taken under (e.g. .rks/rag was removed while
      // held): find the entry by its nonce, which is unique to one acquire.
      for (const [k, entry] of held) {
        if (entry.nonce === nonce) {
          key = k;
          own = entry;
          break;
        }
      }
    }
    if (!own) return { released: false, reason: "absent" };
    if (!nonce || own.nonce !== nonce) return { released: false, reason: "not_owner" };
    held.delete(key);
    const sidecar = holderRecordPath(projectRoot);
    if (readRecord(sidecar)?.nonce === nonce) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        // already gone
      }
    }
    endTransaction(own.db);
    return { released: true };
  } catch (err) {
    return { released: false, reason: err?.code || "unreadable" };
  }
}

/**
 * Take the lock: open the kernel lock file and BEGIN EXCLUSIVE with busy_timeout = 0. Synchronous.
 * Returns { acquired: true, nonce, release } or { acquired: false, pid, started, holder }, with
 * errorCode on the refusal when the lock file could not be opened or locked for a reason other than
 * "held". A lock this module already holds (under any spelling of the root) is refused from its own
 * entry, without opening any DatabaseSync or fs fd on the lock file. Throws only when node:sqlite is
 * unavailable.
 */
export function acquireEmbedLock(projectRoot, { holder = "unknown" } = {}) {
  const lockPath = embedLockPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (err) {
    return { acquired: false, pid: undefined, started: undefined, holder: undefined, errorCode: err?.code || "UNKNOWN" };
  }
  const key = heldKey(lockPath);
  const own = held.get(key);
  if (own) return { acquired: false, pid: own.pid, started: own.started, holder: own.holder };
  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(lockPath);
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    closeQuietly(db);
    if (isBusy(err)) {
      const info = holderInfo(projectRoot, lockPath);
      return { acquired: false, pid: info.pid, started: info.started, holder: info.holder };
    }
    return {
      acquired: false,
      pid: undefined,
      started: undefined,
      holder: undefined,
      ...unreadableDetail(lockPath, err),
    };
  }

  const nonce = randomUUID();
  const record = { pid: process.pid, holder, started: Date.now(), nonce };
  held.set(key, { db, ...record });
  writeHolderRecord(projectRoot, record);
  return { acquired: true, nonce, release: () => releaseEmbedLock(projectRoot, nonce) };
}
