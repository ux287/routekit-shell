/**
 * backlog.feat.rag-embed-lock-kernel-held — the embed lock is a kernel-held node:sqlite lock
 * (DatabaseSync, PRAGMA busy_timeout = 0, BEGIN EXCLUSIVE) on the permanent file
 * .rks/rag/embed-lock.sqlite, never unlinked, with holder metadata in .rks/rag/embed-lock.holder.json.
 * The reclaim/guard/publish tests this file used to hold are gone with the reclaim design.
 *
 * Every real-lock test runs against the real node:sqlite module (nothing here mocks it), across a real
 * child process where the requirement names one.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-stale-reclaim.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as embedLock from "../../packages/rag/src/embed-lock.mjs";
import {
  acquireEmbedLock,
  inspectEmbedLock,
  releaseEmbedLock,
  embedLockPath,
  EMBED_LOCK_HELD_EXIT_CODE,
} from "../../packages/rag/src/embed-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const EMBED_LOCK_SRC = path.join(REPO_ROOT, "packages", "rag", "src", "embed-lock.mjs");
const EMBED_LOCK_URL = pathToFileURL(EMBED_LOCK_SRC).href;
const RAG_PACKAGE_JSON = path.join(REPO_ROOT, "packages", "rag", "package.json");

/** Spawn-family timeout floor (tests/unit/subprocess-timeout-convention.test.mjs). */
const CHILD_TIMEOUT_MS = 120_000;
/** Per-test timeout: exceeds the largest spawn timeout in each test. */
const TEST_TIMEOUT_MS = 300_000;

let projectRoot;
const ragDir = () => path.join(projectRoot, ".rks", "rag");
const lockPath = () => embedLockPath(projectRoot);
const sidecarPath = () => path.join(ragDir(), "embed-lock.holder.json");
const legacyPath = () => path.join(ragDir(), ".embed-lock");
const inode = () => fs.statSync(lockPath()).ino;
const isThenable = (v) => v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";

/** A held lock taken by this test, released in afterEach if the test did not release it. */
let open = [];
function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}

/** Run a one-shot child that acquires the lock on projectRoot and prints its result as JSON. */
function contendInChild(holder) {
  const script = `
    const { acquireEmbedLock } = await import(${JSON.stringify(EMBED_LOCK_URL)});
    const r = acquireEmbedLock(${JSON.stringify(projectRoot)}, { holder: ${JSON.stringify(holder)} });
    console.log(JSON.stringify({ acquired: r.acquired, pid: r.pid, holder: r.holder, errorCode: r.errorCode, self: process.pid }));
    if (r.acquired) r.release();
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  expect(r.error, `child spawn failed or timed out: ${r.error}`).toBeUndefined();
  expect(r.status, `child exited ${r.status}: ${r.stderr}`).toBe(0);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(line);
}

/**
 * Start a child that acquires the lock (holder `holder`), prints {"event":"held",...} and then stays
 * alive until killed. Resolves { child, held, closed } once the held line arrives.
 */
function startHolderChild(holder) {
  const script = `
    const { acquireEmbedLock } = await import(${JSON.stringify(EMBED_LOCK_URL)});
    const r = acquireEmbedLock(${JSON.stringify(projectRoot)}, { holder: ${JSON.stringify(holder)} });
    console.log(JSON.stringify({ event: r.acquired ? "held" : "refused", pid: process.pid }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  const closed = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal });
    });
  });
  const held = new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { err += c; });
    child.stdout.on("data", (c) => {
      out += c;
      const nl = out.indexOf("\n");
      if (nl !== -1) resolve(JSON.parse(out.slice(0, nl)));
    });
    closed.then(({ code, signal }) => reject(new Error(`holder child exited early (${code}, ${signal}): ${err}`)));
  });
  return { child, held, closed };
}

/** names, inodes, sizes and mtimes of every entry under .rks/rag. */
function snapshotRag() {
  return fs.readdirSync(ragDir()).sort().map((name) => {
    const st = fs.statSync(path.join(ragDir(), name));
    return { name, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  });
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-kernel-"));
  open = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("embed-lock kernel-held lock", () => {
  it("embedLockPath returns .rks/rag/embed-lock.sqlite", () => {
    expect(embedLockPath(projectRoot)).toBe(path.join(projectRoot, ".rks", "rag", "embed-lock.sqlite"));
  });

  it("a second process is refused while this process holds the lock and acquires after release", () => {
    const lock = take("kernel-holder");
    expect(lock.acquired).toBe(true);
    const refused = contendInChild("child-contender");
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(process.pid);
    expect(refused.holder).toBe("kernel-holder");
    lock.release();
    const after = contendInChild("child-after-release");
    expect(after.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("a second acquire in the same process is refused while the first is held and succeeds after release", () => {
    const first = take("first-holder");
    expect(first.acquired).toBe(true);
    const second = acquireEmbedLock(projectRoot, { holder: "second-holder" });
    expect(second.acquired).toBe(false);
    expect(second.pid).toBe(process.pid);
    expect(second.holder).toBe("first-holder");
    first.release();
    const third = take("third-holder");
    expect(third.acquired).toBe(true);
  });

  it("after the holding child is killed with SIGKILL the next acquire succeeds with no cleanup step", async () => {
    const holderChild = startHolderChild("doomed-holder");
    const held = await holderChild.held;
    expect(held.event).toBe("held");
    const before = acquireEmbedLock(projectRoot, { holder: "before-kill" });
    expect(before.acquired).toBe(false);
    expect(before.pid).toBe(held.pid);
    const atKill = snapshotRag();
    holderChild.child.kill("SIGKILL");
    const exit = await holderChild.closed;
    expect(exit.signal).toBe("SIGKILL");
    // Nothing under .rks/rag was removed or modified between the kill and the acquire.
    expect(snapshotRag()).toEqual(atKill);
    const recovered = take("after-kill");
    expect(recovered.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("the kernel lock file keeps one inode across acquire, release, refusal and SIGKILL recovery", async () => {
    const lock = take("ino-holder");
    expect(lock.acquired).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
    const ino = inode();
    expect(acquireEmbedLock(projectRoot, { holder: "refused" }).acquired).toBe(false);
    expect(inode()).toBe(ino);
    lock.release();
    expect(inode()).toBe(ino);
    const holderChild = startHolderChild("doomed-holder");
    expect((await holderChild.held).event).toBe("held");
    holderChild.child.kill("SIGKILL");
    expect((await holderChild.closed).signal).toBe("SIGKILL");
    expect(inode()).toBe(ino);
    const recovered = take("recovery");
    expect(recovered.acquired).toBe(true);
    expect(inode()).toBe(ino);
  }, TEST_TIMEOUT_MS);

  it("no unlink, rm, rename or truncate touches the kernel lock path during acquire, refusal and release, with a positive-control fs spy hit under .rks/rag", () => {
    const src = fs.readFileSync(EMBED_LOCK_SRC, "utf8");
    expect(src.split("\n")).toContain('import fs from "node:fs";');
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']node:fs["']/);
    expect(src).not.toMatch(/import\s+\w+\s*,\s*\{[^}]*\}\s*from\s*["']node:fs["']/);
    expect(src).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s*["']node:fs["']/);

    const target = lockPath();
    const destructive = ["unlinkSync", "rmSync", "renameSync", "truncateSync", "ftruncateSync"].map((name) => [
      name,
      vi.spyOn(fs, name),
    ]);
    const control = ["mkdirSync", "openSync", "writeFileSync", "statSync"].map((name) => vi.spyOn(fs, name));
    const rag = ragDir();
    const underRag = (p) => typeof p === "string" && (p === rag || p.startsWith(rag + path.sep));

    const lock = acquireEmbedLock(projectRoot, { holder: "spied" });
    expect(lock.acquired).toBe(true);
    const controlHits = control.flatMap((spy) => spy.mock.calls).filter((args) => underRag(String(args[0])));
    expect(controlHits.length).toBeGreaterThan(0);
    const refused = acquireEmbedLock(projectRoot, { holder: "spied-refused" });
    expect(refused.acquired).toBe(false);
    expect(lock.release().released).toBe(true);

    for (const [name, spy] of destructive) {
      const hits = spy.mock.calls.filter((args) => String(args[0]) === target);
      expect(hits, `${name} was called on the kernel lock path`).toEqual([]);
    }
  });

  it("the held lock is a SQLite exclusive lock that blocks an independent reader and refuses without waiting", () => {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const lock = take("exclusive-holder");
    expect(lock.acquired).toBe(true);
    const reader = new DatabaseSync(lockPath());
    try {
      reader.exec("PRAGMA busy_timeout = 0");
      let error = null;
      try {
        reader.prepare("SELECT count(*) FROM sqlite_master").get();
      } catch (err) {
        error = err;
      }
      expect(error).not.toBeNull();
      expect(error.errcode).toBe(5);
      const t0 = Date.now();
      const refused = acquireEmbedLock(projectRoot, { holder: "impatient" });
      const elapsed = Date.now() - t0;
      expect(refused.acquired).toBe(false);
      expect(elapsed).toBeLessThan(1000);
      lock.release();
      expect(() => reader.prepare("SELECT count(*) FROM sqlite_master").get()).not.toThrow();
    } finally {
      reader.close();
    }
  });

  it("embed-lock.mjs source uses DatabaseSync with BEGIN EXCLUSIVE and busy_timeout 0, no static node:sqlite import, and no WAL journal mode", () => {
    const src = fs.readFileSync(EMBED_LOCK_SRC, "utf8");
    expect(src).toContain("DatabaseSync");
    expect(src).toContain("BEGIN EXCLUSIVE");
    expect(src).toMatch(/busy_timeout\s*=\s*0/);
    expect(src).not.toMatch(/^\s*import\s[^;]*["']node:sqlite["']/m);
    expect(src).not.toMatch(/^\s*import\s*["']node:sqlite["']/m);
    expect(src).not.toContain("better-sqlite3");
    expect(src).not.toContain("fs-ext");
    const lower = src.toLowerCase();
    expect(lower).not.toContain("journal_mode = wal");
    expect(lower).not.toContain("journal_mode=wal");
  });

  it("acquire, refusal and release return non-thenable values", () => {
    const lock = take("sync-holder");
    expect(lock.acquired).toBe(true);
    expect(isThenable(lock)).toBe(false);
    const refused = acquireEmbedLock(projectRoot, { holder: "sync-refused" });
    expect(refused.acquired).toBe(false);
    expect(isThenable(refused)).toBe(false);
    const released = lock.release();
    expect(isThenable(released)).toBe(false);
    expect(released.released).toBe(true);
  });

  it("importing embed-lock.mjs does not load node:sqlite and the first lock call loads it", () => {
    const script = `
      const sqliteEntries = () => process.moduleLoadList.filter((m) => m.includes("sqlite"));
      const mod = await import(${JSON.stringify(EMBED_LOCK_URL)});
      const afterImport = sqliteEntries();
      const r = mod.acquireEmbedLock(${JSON.stringify(projectRoot)}, { holder: "lazy" });
      const afterAcquire = sqliteEntries();
      console.log(JSON.stringify({ afterImport, afterAcquire, acquired: r.acquired }));
      if (r.acquired) r.release();
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    expect(r.error).toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop());
    expect(out.afterImport).toEqual([]);
    expect(out.afterAcquire.length).toBeGreaterThan(0);
    expect(out.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("packages/rag/package.json declares no sqlite or lock-binding dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(RAG_PACKAGE_JSON, "utf8"));
    expect(Object.keys(pkg.dependencies || {}).length).toBeGreaterThan(0); // positive control: the map is read
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const offenders = Object.keys(pkg[field] || {}).filter((k) => /sqlite|fs-ext|flock|lockfile/i.test(k));
      expect(offenders, field).toEqual([]);
    }
  });

  it("a directory at the kernel lock path is refused with errorCode EISDIR and left in place", () => {
    fs.mkdirSync(lockPath(), { recursive: true });
    let result;
    expect(() => {
      result = acquireEmbedLock(projectRoot, { holder: "over-dir" });
    }).not.toThrow();
    expect(result.acquired).toBe(false);
    expect(result.errorCode).toBe("EISDIR");
    expect(fs.statSync(lockPath()).isDirectory()).toBe(true);
    expect(fs.readdirSync(ragDir()).sort()).toEqual(["embed-lock.sqlite"]);
  });

  it("a lock held by another live holder is refused with pid and no errorCode", () => {
    const lock = take("live-holder");
    expect(lock.acquired).toBe(true);
    const refused = acquireEmbedLock(projectRoot, { holder: "contender" });
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(process.pid);
    expect(Object.prototype.hasOwnProperty.call(refused, "errorCode")).toBe(false);
  });

  it("inspectEmbedLock reports held and free without taking the lock or changing the inode", () => {
    expect(inspectEmbedLock(projectRoot)).toEqual({ locked: false }); // nothing on disk yet
    expect(fs.existsSync(lockPath())).toBe(false); // the probe creates nothing
    const lock = take("inspected-holder");
    expect(lock.acquired).toBe(true);
    const ino = inode();
    let status;
    expect(() => { status = inspectEmbedLock(projectRoot); }).not.toThrow();
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.holder).toBe("inspected-holder");
    lock.release();
    expect(inspectEmbedLock(projectRoot)).toEqual({ locked: false });
    expect(inode()).toBe(ino);
    const after = take("after-inspect");
    expect(after.acquired).toBe(true);
    expect(inode()).toBe(ino);
  });

  it("release and releaseEmbedLock never throw and a foreign nonce leaves the lock held", () => {
    const lock = take("release-holder");
    expect(lock.acquired).toBe(true);
    let foreign;
    expect(() => { foreign = releaseEmbedLock(projectRoot, "not-a-nonce"); }).not.toThrow();
    expect(foreign.released).toBe(false);
    expect(acquireEmbedLock(projectRoot, { holder: "still-held" }).acquired).toBe(false);
    const byNonce = releaseEmbedLock(projectRoot, lock.nonce);
    expect(byNonce.released).toBe(true);
    let second;
    expect(() => { second = lock.release(); }).not.toThrow();
    expect(second.released).toBe(false);
    const fresh = take("fresh");
    expect(fresh.acquired).toBe(true);
    expect(fresh.release().released).toBe(true);
    let again;
    expect(() => { again = fresh.release(); }).not.toThrow();
    expect(again.released).toBe(false);
  });

  it("embed-lock.mjs keeps its exported API and exit code 75", () => {
    expect(EMBED_LOCK_HELD_EXIT_CODE).toBe(75);
    for (const name of ["embedLockPath", "inspectEmbedLock", "acquireEmbedLock", "releaseEmbedLock"]) {
      expect(typeof embedLock[name], name).toBe("function");
    }
  });

  it("the holder record lives at embed-lock.holder.json and no lock function creates the legacy .embed-lock path", () => {
    expect(fs.existsSync(legacyPath())).toBe(false);
    const lock = take("sidecar-holder");
    expect(lock.acquired).toBe(true);
    expect(fs.existsSync(sidecarPath())).toBe(true);
    const record = JSON.parse(fs.readFileSync(sidecarPath(), "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.holder).toBe("sidecar-holder");
    expect(fs.existsSync(legacyPath())).toBe(false);
    expect(acquireEmbedLock(projectRoot, { holder: "refused" }).acquired).toBe(false);
    expect(fs.existsSync(legacyPath())).toBe(false);
    inspectEmbedLock(projectRoot);
    expect(fs.existsSync(legacyPath())).toBe(false);
    lock.release();
    expect(fs.existsSync(legacyPath())).toBe(false);
  });
});
