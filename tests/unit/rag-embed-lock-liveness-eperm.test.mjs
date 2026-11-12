/**
 * backlog.feat.rag-embed-lock-kernel-held — one-release compatibility rule for the legacy
 * .rks/rag/.embed-lock record (retired by backlog.chore.rag-embed-lock-retire-legacy-compat).
 *
 * After taking the kernel lock, acquireEmbedLock treats a legacy record that carries a live pid as
 * held: it releases the kernel lock and refuses, and never deletes or rewrites the record. The
 * signal-0 liveness probe treats only ESRCH as a dead pid; EPERM (the process exists but belongs to
 * another user) means alive (backlog.fix.rag-embed-lock-liveness-eperm-alive).
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-liveness-eperm.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireEmbedLock } from "../../packages/rag/src/embed-lock.mjs";

/** A synthetic pid whose signal-0 probe is stubbed; no real process is ever signalled with it. */
const PROBED_PID = 424242;

let projectRoot;
let open = [];
const legacyPath = () => path.join(projectRoot, ".rks", "rag", ".embed-lock");
const readLegacy = () => fs.readFileSync(legacyPath());

function seedLegacy(record) {
  const content = JSON.stringify(record);
  fs.mkdirSync(path.dirname(legacyPath()), { recursive: true });
  fs.writeFileSync(legacyPath(), content);
  return Buffer.from(content);
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

function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-legacy-"));
  open = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("embed-lock legacy .embed-lock record compatibility", () => {
  it("a live-pid legacy record causes refusal, is left byte-identical, and does not keep the kernel lock held", () => {
    const before = seedLegacy({ pid: process.pid, started: Date.now(), holder: "pre-redesign" });
    const refused = acquireEmbedLock(projectRoot, { holder: "new-code" });
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(process.pid);
    expect(readLegacy().equals(before)).toBe(true);
    fs.unlinkSync(legacyPath());
    const lock = take("after-legacy");
    expect(lock.acquired).toBe(true);
  });

  it("an EPERM-probed legacy record is treated as live and left byte-identical", () => {
    const before = seedLegacy({ pid: PROBED_PID, started: Date.now(), holder: "foreign-user", nonce: "foreign" });
    const spy = probeThrows("EPERM");
    const refused = acquireEmbedLock(projectRoot, { holder: "second-embed" });
    expect(spy).toHaveBeenCalledWith(PROBED_PID, 0); // positive control: the probe ran
    expect(refused.acquired).toBe(false);
    expect(refused.pid).toBe(PROBED_PID);
    expect(readLegacy().equals(before)).toBe(true);
  });

  it("an ESRCH-probed legacy record does not block acquisition", () => {
    seedLegacy({ pid: PROBED_PID, started: Date.now(), holder: "dead-holder" });
    const spy = probeThrows("ESRCH");
    const lock = take("after-dead");
    expect(spy).toHaveBeenCalledWith(PROBED_PID, 0); // positive control: the probe ran
    expect(lock.acquired).toBe(true);
  });
});
