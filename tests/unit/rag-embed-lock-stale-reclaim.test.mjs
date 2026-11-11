/**
 * backlog.fix.rag-embed-lock-stale-reclaim-integrity — a stale reclaim removes only the record it
 * inspected, an empty or non-JSON lock is reclaimable past a grace period and held inside it, and the
 * lock record is published atomically.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-stale-reclaim.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireEmbedLock, inspectEmbedLock, embedLockPath } from "../../packages/rag/src/embed-lock.mjs";

const DEAD_PID = 999999999;
const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

let projectRoot;
const lockPath = () => embedLockPath(projectRoot);
const readLock = () => fs.readFileSync(lockPath(), "utf8");
const guardPath = () => `${lockPath()}.reclaim`;

function seed(content, { aged = false } = {}) {
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), content);
  if (aged) fs.utimesSync(lockPath(), dayAgo(), dayAgo());
}

/** Run fn once, immediately after the first read of the lock path returns. */
function afterFirstLockRead(fn) {
  const realRead = fs.readFileSync;
  let fired = false;
  vi.spyOn(fs, "readFileSync").mockImplementation(function (p, ...rest) {
    const out = realRead.call(fs, p, ...rest);
    if (!fired && String(p) === lockPath()) {
      fired = true;
      fn();
    }
    return out;
  });
}

/** Run fn once, immediately after the first stat of the lock path returns (the age check). */
function afterFirstLockStat(fn) {
  let fired = false;
  for (const name of ["statSync", "lstatSync"]) {
    const real = fs[name];
    vi.spyOn(fs, name).mockImplementation(function (p, ...rest) {
      const out = real.call(fs, p, ...rest);
      if (!fired && String(p) === lockPath()) {
        fired = true;
        fn();
      }
      return out;
    });
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-reclaim-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("embed-lock stale reclaim integrity", () => {
  it("two acquirers racing over one dead-pid lock: only one acquires and the loser leaves the winner's lock in place", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    let inner;
    afterFirstLockRead(() => {
      inner = acquireEmbedLock(projectRoot, { holder: "inner" });
    });
    const outer = acquireEmbedLock(projectRoot, { holder: "outer" });
    expect(inner).toBeDefined();
    const winners = [outer, inner].filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    expect(JSON.parse(readLock()).nonce).toBe(winners[0].nonce);
  });

  it("two acquirers racing over one aged pid-less lock: only one acquires and the winner's lock stays in place", () => {
    seed(JSON.stringify({ started: Date.now() }), { aged: true });
    let inner;
    afterFirstLockStat(() => {
      inner = acquireEmbedLock(projectRoot, { holder: "inner" });
    });
    const outer = acquireEmbedLock(projectRoot, { holder: "outer" });
    expect(inner).toBeDefined();
    const winners = [outer, inner].filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    expect(JSON.parse(readLock()).nonce).toBe(winners[0].nonce);
  });

  it("a stale reclaim never removes a record that differs from the one it inspected", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    const injected = JSON.stringify({ pid: process.pid, started: Date.now(), holder: "other", nonce: "other-acquire" });
    afterFirstLockRead(() => fs.writeFileSync(lockPath(), injected));
    const result = acquireEmbedLock(projectRoot, { holder: "late" });
    expect(result.acquired).toBe(false);
    expect(readLock()).toBe(injected);
  });

  it("a reclaim never vacates a lock path holding a record not proven stale, so a third acquirer is never displaced", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    const live = JSON.stringify({ pid: process.pid, started: Date.now(), holder: "live", nonce: "live-acquire" });
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    const realWriteFile = fs.writeFileSync;
    let armed = false;
    let busy = false;
    let third;
    const check = () => {
      if (armed && !busy && third === undefined && !realExists.call(fs, lockPath())) {
        busy = true;
        try {
          third = acquireEmbedLock(projectRoot, { holder: "third" });
        } finally {
          busy = false;
        }
      }
    };
    const watched = ["existsSync", "statSync", "lstatSync", "openSync", "closeSync", "writeSync", "writeFileSync", "linkSync", "renameSync", "unlinkSync", "rmSync"];
    for (const name of watched) {
      const real = fs[name];
      vi.spyOn(fs, name).mockImplementation(function (...args) {
        const out = real.apply(fs, args);
        check();
        return out;
      });
    }
    vi.spyOn(fs, "readFileSync").mockImplementation(function (p, ...rest) {
      const out = realRead.call(fs, p, ...rest);
      if (!armed && !busy && String(p) === lockPath()) {
        busy = true;
        try {
          realWriteFile.call(fs, lockPath(), live);
        } finally {
          busy = false;
        }
        armed = true;
      }
      check();
      return out;
    });
    const result = acquireEmbedLock(projectRoot, { holder: "reclaimer" });
    expect(third).toBeUndefined();
    expect(result.acquired).toBe(false);
    expect(readLock()).toBe(live);
  });

  it("a reclaimer finding the reclaim guard held reclaims nothing and reports the lock held", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    const before = readLock();
    fs.writeFileSync(guardPath(), "other-reclaimer");
    const result = acquireEmbedLock(projectRoot, { holder: "blocked" });
    expect(result.acquired).toBe(false);
    expect(readLock()).toBe(before);
    expect(fs.readFileSync(guardPath(), "utf8")).toBe("other-reclaimer");
  });

  it("an abandoned reclaim guard is removed without reclaiming the lock in the same step", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    const before = readLock();
    fs.writeFileSync(guardPath(), "");
    fs.utimesSync(guardPath(), dayAgo(), dayAgo());
    const first = acquireEmbedLock(projectRoot, { holder: "after-crash" });
    expect(first.acquired).toBe(false);
    expect(readLock()).toBe(before);
    expect(fs.existsSync(guardPath())).toBe(false);
    const second = acquireEmbedLock(projectRoot, { holder: "after-crash-retry" });
    expect(second.acquired).toBe(true);
    expect(JSON.parse(readLock()).nonce).toBe(second.nonce);
    expect(fs.existsSync(guardPath())).toBe(false);
    second.release();
  });

  it("a reclaim takes the guard with an exclusive create and removes it even when the reclaim throws", () => {
    seed(JSON.stringify({ pid: DEAD_PID, started: Date.now() }));
    const realOpen = fs.openSync;
    const realUnlink = fs.unlinkSync;
    const realRm = fs.rmSync;
    const guardFlags = [];
    const denied = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    vi.spyOn(fs, "openSync").mockImplementation(function (p, flags, ...rest) {
      if (String(p) === guardPath()) guardFlags.push(flags);
      return realOpen.call(fs, p, flags, ...rest);
    });
    vi.spyOn(fs, "unlinkSync").mockImplementation(function (p, ...rest) {
      if (String(p) === lockPath()) denied();
      return realUnlink.call(fs, p, ...rest);
    });
    vi.spyOn(fs, "rmSync").mockImplementation(function (p, ...rest) {
      if (String(p) === lockPath()) denied();
      return realRm.call(fs, p, ...rest);
    });
    try {
      acquireEmbedLock(projectRoot, { holder: "denied" });
    } catch {
      // the error may propagate or be reported as held; either way the guard must be gone
    }
    expect(guardFlags.length).toBeGreaterThan(0);
    expect(guardFlags.every((f) => f === "wx")).toBe(true);
    expect(fs.existsSync(guardPath())).toBe(false);
  });

  it("reclaims a zero-length lock older than the grace period and acquires", () => {
    seed("", { aged: true });
    const lock = acquireEmbedLock(projectRoot, { holder: "after-empty" });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(readLock()).nonce).toBe(lock.nonce);
  });

  it("reclaims a non-JSON lock older than the grace period and acquires", () => {
    seed("not json{", { aged: true });
    const lock = acquireEmbedLock(projectRoot, { holder: "after-corrupt" });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(readLock()).nonce).toBe(lock.nonce);
  });

  it("reports a fresh zero-length lock as held and leaves it in place", () => {
    seed("");
    const result = acquireEmbedLock(projectRoot, { holder: "too-early" });
    expect(result.acquired).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(fs.statSync(lockPath()).size).toBe(0);
  });

  it("reports a fresh non-JSON lock as held and leaves its bytes unchanged", () => {
    seed("not json{");
    const result = acquireEmbedLock(projectRoot, { holder: "too-early" });
    expect(result.acquired).toBe(false);
    expect(readLock()).toBe("not json{");
  });

  it("inspectEmbedLock cleans an aged zero-length lock and reports a fresh one as locked", () => {
    seed("", { aged: true });
    expect(inspectEmbedLock(projectRoot)).toMatchObject({ locked: false, cleaned: true });
    expect(fs.existsSync(lockPath())).toBe(false);
    seed("");
    expect(inspectEmbedLock(projectRoot).locked).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
  });

  it("a failed record write propagates the error and leaves no file at the lock path", () => {
    const fail = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    vi.spyOn(fs, "writeSync").mockImplementation(fail);
    vi.spyOn(fs, "writeFileSync").mockImplementation(fail);
    expect(() => acquireEmbedLock(projectRoot, { holder: "doomed" })).toThrow(/ENOSPC/);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("a successful acquire publishes the full record and leaves no temp file behind", () => {
    const lock = acquireEmbedLock(projectRoot, { holder: "full-record" });
    expect(lock.acquired).toBe(true);
    const rec = JSON.parse(readLock());
    expect(Object.keys(rec).sort()).toEqual(["holder", "nonce", "pid", "started"]);
    expect(rec).toMatchObject({ pid: process.pid, holder: "full-record", nonce: lock.nonce });
    expect(typeof rec.started).toBe("number");
    expect(fs.readdirSync(path.dirname(lockPath()))).toEqual([".embed-lock"]);
    lock.release();
  });
});
