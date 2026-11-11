/**
 * backlog.fix.rag-embed-lock-liveness-eperm-alive — the embed-lock liveness probe treats only ESRCH
 * as a dead pid. EPERM (the process exists but belongs to another user) and any other error code mean
 * the holder is alive, so its lock is reported held and left untouched.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-liveness-eperm.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireEmbedLock, inspectEmbedLock, embedLockPath } from "../../packages/rag/src/embed-lock.mjs";

/** A synthetic pid whose signal-0 probe is stubbed; no real process is ever signalled with it. */
const PROBED_PID = 424242;

let projectRoot;
const lockPath = () => embedLockPath(projectRoot);
const readLock = () => fs.readFileSync(lockPath(), "utf8");

function seedLock() {
  const content = JSON.stringify({ pid: PROBED_PID, started: Date.now(), holder: "foreign-user", nonce: "foreign" });
  fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
  fs.writeFileSync(lockPath(), content);
  return content;
}

/** Make process.kill(PROBED_PID, 0) throw with the given code; every other call is the real kill. */
function probeThrows(code) {
  const realKill = process.kill.bind(process);
  return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === PROBED_PID) {
      throw Object.assign(new Error(`kill ${code}`), { code, syscall: "kill" });
    }
    return realKill(pid, signal);
  });
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-liveness-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("embed-lock liveness probe", () => {
  it("an EPERM probe reports the lock held with the holder pid and leaves the file byte-identical", () => {
    const before = seedLock();
    const spy = probeThrows("EPERM");
    const status = inspectEmbedLock(projectRoot);
    expect(spy).toHaveBeenCalledWith(PROBED_PID, 0);
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(PROBED_PID);
    expect(status.cleaned).toBeUndefined();
    expect(readLock()).toBe(before);
  });

  it("an ESRCH probe reclaims the lock as before", () => {
    seedLock();
    probeThrows("ESRCH");
    expect(inspectEmbedLock(projectRoot)).toMatchObject({ locked: false, cleaned: true });
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("a probe failing with any other code reports the lock held and does not remove it", () => {
    const before = seedLock();
    probeThrows("EINVAL");
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(PROBED_PID);
    expect(readLock()).toBe(before);
  });

  it("acquireEmbedLock over an EPERM-probed lock refuses with the holder pid and leaves the lock untouched", () => {
    const before = seedLock();
    probeThrows("EPERM");
    const result = acquireEmbedLock(projectRoot, { holder: "second-embed" });
    expect(result.acquired).toBe(false);
    expect(result.pid).toBe(PROBED_PID);
    expect(readLock()).toBe(before);
  });

  it("acquireEmbedLock over an ESRCH-probed lock reclaims it and acquires", () => {
    seedLock();
    probeThrows("ESRCH");
    const lock = acquireEmbedLock(projectRoot, { holder: "after-dead" });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(readLock()).nonce).toBe(lock.nonce);
    lock.release();
  });
});
