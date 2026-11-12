/**
 * backlog.fix.rag-embed-lock-held-map-guard - acquireEmbedLock and inspectEmbedLock answer from this
 * module's held entry for a lock file it holds (under any spelling of the project root), never opening a
 * node:sqlite DatabaseSync or an fs fd on a held lock file; the legacy live-pid refusal names the record.
 *
 * Real node:sqlite throughout; a real child process where a requirement names another process.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-held-map-guard.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireEmbedLock, inspectEmbedLock, embedLockPath } from "../../packages/rag/src/embed-lock.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBED_LOCK_URL = pathToFileURL(path.resolve(HERE, "..", "..", "packages", "rag", "src", "embed-lock.mjs")).href;
/** Spawn-family timeout floor (tests/unit/subprocess-timeout-convention.test.mjs). */
const CHILD_TIMEOUT_MS = 120_000;
/** Per-test timeout: exceeds the largest spawn timeout in each test. */
const TEST_TIMEOUT_MS = 300_000;
const sqlite = process.getBuiltinModule("node:sqlite");

let base;
let projectRoot;
let linkRoot;
let held = [];
const legacyPath = () => path.join(projectRoot, ".rks", "rag", ".embed-lock");

function take(root, holder) {
  const lock = acquireEmbedLock(root, { holder });
  if (lock.acquired) held.push(lock);
  return lock;
}

function seedLegacy(record) {
  const content = JSON.stringify(record);
  fs.mkdirSync(path.dirname(legacyPath()), { recursive: true });
  fs.writeFileSync(legacyPath(), content);
  return Buffer.from(content);
}

/** One-shot child that acquires the lock on `root` and reports the result as JSON on stdout. */
function contendInChild(root, holder) {
  const script = `
    const { acquireEmbedLock } = await import(${JSON.stringify(EMBED_LOCK_URL)});
    const r = acquireEmbedLock(${JSON.stringify(root)}, { holder: ${JSON.stringify(holder)} });
    process.stdout.write(JSON.stringify({ acquired: r.acquired, pid: r.pid, holder: r.holder }));
    if (r.acquired) r.release();
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  expect(r.error, `child spawn failed or timed out: ${r.error}`).toBeUndefined();
  expect(r.status, `child exited ${r.status}: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout.trim());
}

/**
 * Spies on DatabaseSync construction and fs.openSync / fs.closeSync. since(mark) returns the calls made
 * after mark() whose target is the projectRoot lock file, compared by realpath (closeSync by the fd an
 * openSync on the lock file returned).
 */
function watchLockFile() {
  // A bare vi.spyOn(sqlite, "DatabaseSync") records the call but invokes the native class without
  // `new` ("Cannot call constructor without `new`"), so the spy forwards construction to the real
  // class. Requirement 0's positive control still fails loudly if construction is not observed.
  const RealDatabaseSync = sqlite.DatabaseSync;
  const dbSpy = vi.spyOn(sqlite, "DatabaseSync").mockImplementation(function (...args) {
    return new RealDatabaseSync(...args);
  });
  const openSpy = vi.spyOn(fs, "openSync");
  const closeSpy = vi.spyOn(fs, "closeSync");
  const onLock = (p) => {
    try {
      return fs.realpathSync(String(p)) === fs.realpathSync(embedLockPath(projectRoot));
    } catch {
      return false;
    }
  };
  const mark = () => ({ db: dbSpy.mock.calls.length, open: openSpy.mock.calls.length, close: closeSpy.mock.calls.length });
  const since = (m) => {
    const opened = openSpy.mock.calls
      .slice(m.open)
      .map((args, i) => ({ args, result: openSpy.mock.results[m.open + i] }))
      .filter(({ args }) => onLock(args[0]));
    const fds = new Set(opened.map(({ result }) => result?.value));
    return {
      db: dbSpy.mock.calls.slice(m.db).filter((args) => onLock(args[0])),
      open: opened.map(({ args }) => args),
      close: closeSpy.mock.calls.slice(m.close).filter((args) => fds.has(args[0])),
    };
  };
  return { mark, since, openSpy };
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-held-map-")));
  projectRoot = path.join(base, "real");
  fs.mkdirSync(projectRoot);
  linkRoot = path.join(base, "link");
  fs.symlinkSync(projectRoot, linkRoot, "dir");
  held = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of held) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("embed-lock held-map guard", () => {
  it("a same-process second acquire is refused from the held entry without opening a DatabaseSync or an fs fd on the lock file", () => {
    const watch = watchLockFile(); // installed before the first acquire, as a positive control
    const first = take(projectRoot, "first-holder");
    expect(first.acquired).toBe(true);
    expect(watch.since({ db: 0, open: 0, close: 0 }).db.length).toBeGreaterThan(0); // the spy sees the module's construction
    const own = inspectEmbedLock(projectRoot);
    const m = watch.mark();
    const second = acquireEmbedLock(projectRoot, { holder: "second-holder" });
    expect(second.acquired).toBe(false);
    expect(second.pid).toBe(process.pid);
    expect(second.started).toBe(own.started);
    expect(second.holder).toBe("first-holder");
    expect(Object.prototype.hasOwnProperty.call(second, "errorCode")).toBe(false);
    const hits = watch.since(m);
    expect(hits.db).toEqual([]);
    expect(hits.open).toEqual([]);
  });

  it("after a refused same-process acquire the original lock still refuses another process and releases normally", () => {
    const first = take(projectRoot, "original");
    expect(first.acquired).toBe(true);
    expect(acquireEmbedLock(projectRoot, { holder: "same-process" }).acquired).toBe(false);
    const child = contendInChild(projectRoot, "child-contender");
    expect(child.acquired).toBe(false);
    expect(child.pid).toBe(process.pid);
    expect(child.holder).toBe("original");
    expect(first.release()).toEqual({ released: true });
    const fresh = take(projectRoot, "fresh");
    expect(fresh.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("an acquire through a symlinked project root is recognized as the same held lock", () => {
    const first = take(projectRoot, "real-root-holder");
    expect(first.acquired).toBe(true);
    const own = inspectEmbedLock(projectRoot);
    const watch = watchLockFile();
    const m = watch.mark();
    const viaLink = acquireEmbedLock(linkRoot, { holder: "via-link" });
    expect(viaLink.acquired).toBe(false);
    expect(viaLink.pid).toBe(process.pid);
    expect(viaLink.started).toBe(own.started);
    expect(viaLink.holder).toBe("real-root-holder");
    const hits = watch.since(m);
    expect(hits.db).toEqual([]);
    expect(hits.open).toEqual([]);
    vi.restoreAllMocks();
    expect(contendInChild(linkRoot, "child-via-link").acquired).toBe(false);
    expect(first.release()).toEqual({ released: true });
    const fresh = take(linkRoot, "fresh-via-link");
    expect(fresh.acquired).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("inspectEmbedLock through a symlinked project root reports the held lock without opening the lock file", () => {
    const first = take(projectRoot, "inspected");
    expect(first.acquired).toBe(true);
    const watch = watchLockFile();
    const m = watch.mark();
    const status = inspectEmbedLock(linkRoot);
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.holder).toBe("inspected");
    const hits = watch.since(m);
    expect(hits.db).toEqual([]);
    expect(hits.open).toEqual([]);
    vi.restoreAllMocks();
    expect(contendInChild(projectRoot, "after-inspect").acquired).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("no fs open or close reaches a held lock file from any refused entry point and the lock survives", () => {
    const first = take(projectRoot, "survivor");
    expect(first.acquired).toBe(true);
    const watch = watchLockFile();
    const m = watch.mark();
    for (const root of [projectRoot, linkRoot]) {
      expect(acquireEmbedLock(root, { holder: "probe" }).acquired).toBe(false);
      expect(inspectEmbedLock(root).locked).toBe(true);
    }
    const hits = watch.since(m);
    expect(hits.open).toEqual([]);
    expect(hits.close).toEqual([]);
    // Positive control: the openSync spy sees unreadableCode's open of an unheld directory lock path.
    const other = path.join(base, "other");
    fs.mkdirSync(embedLockPath(other), { recursive: true });
    expect(acquireEmbedLock(other, { holder: "over-dir" }).errorCode).toBe("EISDIR");
    expect(watch.openSpy.mock.calls.some((args) => String(args[0]) === embedLockPath(other))).toBe(true);
    vi.restoreAllMocks();
    expect(contendInChild(projectRoot, "after-probes").acquired).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("embedLockPath return value is unchanged for the real and the symlinked root", () => {
    expect(embedLockPath(projectRoot)).toBe(path.join(projectRoot, ".rks", "rag", "embed-lock.sqlite"));
    expect(embedLockPath(linkRoot)).toBe(path.join(linkRoot, ".rks", "rag", "embed-lock.sqlite"));
  });
});

describe("embed-lock legacy record path", () => {
  it("a legacy live-pid refusal carries legacyLockPath naming the record and leaves it byte-identical", () => {
    const before = seedLegacy({ pid: process.pid, started: 1700000000000, holder: "pre-redesign" });
    const refused = acquireEmbedLock(projectRoot, { holder: "new-code" });
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(process.pid);
    expect(path.isAbsolute(refused.legacyLockPath)).toBe(true);
    expect(refused.legacyLockPath).toBe(legacyPath());
    expect(fs.realpathSync(refused.legacyLockPath)).toBe(fs.realpathSync(legacyPath()));
    expect(fs.readFileSync(legacyPath()).equals(before)).toBe(true);
  });

  it("inspectEmbedLock legacy status carries the same legacyLockPath", () => {
    seedLegacy({ pid: process.pid, started: 1700000000000 });
    const refused = acquireEmbedLock(projectRoot, { holder: "new-code" });
    expect(refused.legacyLockPath).toBe(legacyPath()); // positive control: the refusal names it
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.legacyLockPath).toBe(refused.legacyLockPath);
  });

  it("a kernel-held refusal and inspect status carry no legacyLockPath", () => {
    const lock = take(projectRoot, "kernel-holder");
    expect(lock.acquired).toBe(true);
    const refused = acquireEmbedLock(projectRoot, { holder: "contender" });
    expect(refused.acquired).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(refused, "legacyLockPath")).toBe(false);
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(status, "legacyLockPath")).toBe(false);
  });
});
