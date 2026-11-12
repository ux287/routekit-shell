/**
 * The RAG embed lock: one mutex for every embed and reset entry point in @routekit/rag.
 * backlog.fix.rag-embed-lock-never-acquired-in-process.
 *
 * Leaf module: node builtins only, so tools.mjs, embed.mjs and the mcp-rks host can all import it
 * without an import cycle. The record shape is the hook's ({ started, pid }, see
 * packages/hooks/system/rag-embed-on-commit.mjs) plus holder and a per-acquire nonce.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Exit code of the embed.mjs CLI when it refuses because another embed holds the lock (EX_TEMPFAIL). */
export const EMBED_LOCK_HELD_EXIT_CODE = 75;

/** A lock record with no pid is treated as stale after this many seconds (preserved from checkEmbedLock). */
const STALE_NO_PID_SECONDS = 300;

/**
 * An empty or unparseable lock file is treated as stale after this many seconds; younger than this it
 * is reported held so an in-flight (legacy, non-atomic) writer is not raced.
 * backlog.fix.rag-embed-lock-stale-reclaim-integrity.
 */
const STALE_UNPARSEABLE_SECONDS = 60;

/**
 * A reclaim guard file (`${lockPath}.reclaim`) older than this many seconds was abandoned by a crashed
 * reclaimer and is removed. A reclaim holds the guard for milliseconds.
 */
const RECLAIM_GUARD_STALE_SECONDS = 60;

export function embedLockPath(projectRoot) {
  return path.join(projectRoot, ".rks", "rag", ".embed-lock");
}

/** Read the file at lockPath as { bytes, ino, mtimeMs }, or null when it is absent. */
function snapshotLock(lockPath) {
  try {
    const bytes = fs.readFileSync(lockPath);
    const st = fs.statSync(lockPath);
    return { bytes, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function sameRecord(a, b) {
  return Boolean(a && b) && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.bytes.equals(b.bytes);
}

function parseRecord(bytes) {
  try {
    const data = JSON.parse(bytes.toString("utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function heldStatus(data) {
  const status = { locked: true };
  if (data?.pid) status.pid = data.pid;
  if (data?.started !== undefined) status.started = data.started;
  if (data?.holder !== undefined) status.holder = data.holder;
  return status;
}

/** True only when the file at guardPath is still the guard inode this reclaimer created. */
function ownsGuard(guardPath, ownIno) {
  try {
    return fs.statSync(guardPath).ino === ownIno;
  } catch {
    return false;
  }
}

/**
 * Remove a reclaim guard judged abandoned (`judged` is its stat) without unlinking by path: the guard is
 * captured atomically by renaming it to a unique sibling, and only the captured file is examined and
 * removed. If the capture took a different guard (a fresh one that replaced the judged guard), it is put
 * back with an exclusive hard link; EEXIST means another reclaimer has since created a guard, which is
 * left alone. The captured name is always removed, so no helper file remains.
 * backlog.fix.rag-embed-lock-reclaim-guard-identity-removal.
 *
 * Residual interleaving (path-based POSIX operations cannot bind a stat and a rename atomically): if a
 * fresh guard F is captured here, then between the rename and the link-back a third reclaimer R may
 * create its own guard, so the link-back fails with EEXIST and F's file is removed with the captured
 * name. F's owner then no longer owns guardPath, and its pre-unlink ownership check (in
 * reclaimInspected) makes it report held without unlinking the lock, and its cleanup leaves R's guard.
 * F's owner can only be displaced this way; it cannot remove a lock or another reclaimer's guard.
 * The ownership checks in reclaimInspected are stat-then-unlink, so a guard can still be captured from
 * its owner between that stat and the unlink that follows; that needs the owner's guard to be older than
 * RECLAIM_GUARD_STALE_SECONDS, i.e. an owner stalled that long inside a millisecond reclaim. Identity is
 * the inode number, so a removed guard whose inode is reused by a new guard at the same path would be
 * mistaken for the original.
 */
function removeAbandonedGuard(guardPath, judged) {
  const captured = `${guardPath}.${randomUUID()}.stale`;
  try {
    fs.renameSync(guardPath, captured);
  } catch {
    return; // guard vanished or cannot be captured: leave it
  }
  try {
    const got = fs.statSync(captured);
    if (got.ino !== judged.ino || got.mtimeMs !== judged.mtimeMs) {
      try {
        fs.linkSync(captured, guardPath);
      } catch {
        // EEXIST: another reclaimer has created a guard since; leave that one
      }
    }
  } catch {
    // captured file unreadable: removed below either way
  } finally {
    try {
      fs.unlinkSync(captured);
    } catch {
      // already gone
    }
  }
}

/**
 * Remove the lock only if it is still the exact record judged stale (`inspected`), under the exclusive
 * reclaim guard `${lockPath}.reclaim`. Nothing at lockPath is ever moved or overwritten, and a record
 * that differs from the inspected one is never removed. If the guard is held by another reclaimer the
 * lock is reported held; an abandoned guard is removed and the lock is reported held for this step.
 * Every guard removal is bound to the guard's inode: this reclaimer unlinks the lock and removes the
 * guard only while the file at the guard path is still the inode it created.
 */
function reclaimInspected(lockPath, inspected, data) {
  const guardPath = `${lockPath}.reclaim`;
  let guardFd;
  try {
    guardFd = fs.openSync(guardPath, "wx");
  } catch (err) {
    if (err?.code !== "EEXIST") return heldStatus(data);
    try {
      const guard = fs.statSync(guardPath);
      if ((Date.now() - guard.mtimeMs) / 1000 > RECLAIM_GUARD_STALE_SECONDS) removeAbandonedGuard(guardPath, guard);
    } catch {
      // guard vanished or is unreadable: either way, do not reclaim in this step
    }
    return heldStatus(data);
  }
  let ownIno;
  try {
    try {
      ownIno = fs.fstatSync(guardFd).ino;
    } finally {
      fs.closeSync(guardFd);
    }
    const current = snapshotLock(lockPath);
    if (current === null) return { locked: false };
    if (!sameRecord(current, inspected)) return heldStatus(parseRecord(current.bytes));
    if (!ownsGuard(guardPath, ownIno)) return heldStatus(data); // guard taken over: not ours to reclaim
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err?.code === "ENOENT") return { locked: false };
      return heldStatus(data);
    }
    return { locked: false, cleaned: true };
  } finally {
    // Remove the guard only while it is still ours. If the identity could not be read (fstat threw),
    // the guard is left for abandoned-guard removal rather than removed by path.
    if (ownIno !== undefined && ownsGuard(guardPath, ownIno)) {
      try {
        fs.unlinkSync(guardPath);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Signal-0 liveness probe. The pid is dead only when the probe fails with ESRCH; EPERM (the process
 * exists but belongs to another user) and any other error mean the holder is treated as alive.
 * backlog.fix.rag-embed-lock-liveness-eperm-alive.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * Inspect the lock. A lock whose pid is dead, a pid-less lock older than STALE_NO_PID_SECONDS, or an
 * empty/unparseable lock older than STALE_UNPARSEABLE_SECONDS is reclaimed (only the inspected record,
 * under the reclaim guard) and reported cleaned: true. Never throws.
 */
export function inspectEmbedLock(projectRoot) {
  const lockPath = embedLockPath(projectRoot);
  if (!fs.existsSync(lockPath)) return { locked: false };
  try {
    const inspected = snapshotLock(lockPath);
    if (inspected === null) return { locked: false };
    const lockData = parseRecord(inspected.bytes);
    const ageSeconds = (Date.now() - inspected.mtimeMs) / 1000;
    if (lockData === null) {
      if (ageSeconds > STALE_UNPARSEABLE_SECONDS) return reclaimInspected(lockPath, inspected, null);
      return { locked: true };
    }
    if (lockData.pid) {
      if (isPidAlive(lockData.pid)) {
        return { locked: true, pid: lockData.pid, started: lockData.started, holder: lockData.holder };
      }
      return reclaimInspected(lockPath, inspected, lockData); // pid dead: orphaned lock
    }
    if (ageSeconds > STALE_NO_PID_SECONDS) return reclaimInspected(lockPath, inspected, lockData);
    return { locked: true, started: lockData.started, holder: lockData.holder };
  } catch {
    return { locked: true };
  }
}

/** Remove the lock only if it still carries this acquire's nonce. Never throws. */
export function releaseEmbedLock(projectRoot, nonce) {
  const lockPath = embedLockPath(projectRoot);
  try {
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!nonce || lockData?.nonce !== nonce) return { released: false, reason: "not_owner" };
    fs.unlinkSync(lockPath);
    return { released: true };
  } catch (err) {
    return { released: false, reason: err?.code === "ENOENT" ? "absent" : "unreadable" };
  }
}

/** Errors from fs.linkSync meaning the filesystem cannot hard-link: fall back to an exclusive create. */
const LINK_UNSUPPORTED = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"]);

/**
 * Publish the record at lockPath exclusively. The record is written to a unique temp file first and
 * hard-linked into place (link fails on EEXIST), so lockPath never holds a zero-length or partial record.
 * Throws EEXIST when the lock is taken; a write failure propagates and leaves nothing at lockPath.
 */
function publishRecord(lockPath, tempPath, record) {
  try {
    fs.linkSync(tempPath, lockPath);
    return;
  } catch (err) {
    if (!LINK_UNSUPPORTED.has(err?.code)) throw err;
  }
  const fd = fs.openSync(lockPath, "wx");
  try {
    fs.writeSync(fd, record);
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // nothing to clean
    }
    throw err;
  }
  fs.closeSync(fd);
}

/**
 * Atomically take the lock (exclusive publish of a fully written record). On EEXIST, apply the
 * dead-pid / staleness cleanup and retry the publish once. A live holder's lock file is never modified.
 * Returns { acquired: true, nonce, release } or { acquired: false, pid, started, holder }.
 */
export function acquireEmbedLock(projectRoot, { holder = "unknown" } = {}) {
  const lockPath = embedLockPath(projectRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const nonce = randomUUID();
  const record = JSON.stringify({ started: Date.now(), pid: process.pid, holder, nonce });
  const tempPath = `${lockPath}.${nonce}.tmp`;
  try {
    fs.writeFileSync(tempPath, record, { flag: "wx" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        publishRecord(lockPath, tempPath, record);
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        const status = inspectEmbedLock(projectRoot);
        if (status.locked) {
          return { acquired: false, pid: status.pid, started: status.started, holder: status.holder };
        }
        continue; // cleaned, or vanished: retry the exclusive publish once
      }
      return { acquired: true, nonce, release: () => releaseEmbedLock(projectRoot, nonce) };
    }
    const status = inspectEmbedLock(projectRoot);
    return { acquired: false, pid: status.pid, started: status.started, holder: status.holder };
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // never created, or already removed
    }
  }
}
