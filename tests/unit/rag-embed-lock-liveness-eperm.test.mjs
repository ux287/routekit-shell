/**
 * backlog.chore.rag-embed-lock-retire-legacy-compat — the legacy .rks/rag/.embed-lock record is ignored.
 *
 * backlog.feat.rag-embed-lock-kernel-held kept, for one release, a rule that treated a legacy record
 * carrying a live pid as held (with a signal-0 liveness probe, backlog.fix.rag-embed-lock-liveness-eperm-alive),
 * and backlog.fix.rag-embed-lock-held-map-guard added a legacyLockPath hint to that refusal. Both are
 * retired: ownership is decided by the kernel lock alone, no lock function reads the legacy path, no pid
 * probe is sent, and a leftover legacy record is left in place untouched.
 *
 * Run: npx vitest run --config vitest.config.unit.mjs tests/unit/rag-embed-lock-liveness-eperm.test.mjs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireEmbedLock,
  inspectEmbedLock,
  embedLockPath,
} from "../../packages/rag/src/embed-lock.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A synthetic pid; process.kill is stubbed whenever it is used, so no real process is ever signalled. */
const PROBED_PID = 424242;

let projectRoot;
let open = [];
const ragDir = () => path.join(projectRoot, ".rks", "rag");
const legacyPath = () => path.join(ragDir(), ".embed-lock");
const readLegacy = () => fs.readFileSync(legacyPath());

function seedLegacy(record) {
  const content = JSON.stringify(record);
  fs.mkdirSync(path.dirname(legacyPath()), { recursive: true });
  fs.writeFileSync(legacyPath(), content);
  return Buffer.from(content);
}

function take(holder) {
  const lock = acquireEmbedLock(projectRoot, { holder });
  if (lock.acquired) open.push(lock);
  return lock;
}

/** The absolute path an fs call was made on, or null for an fd or a non-path argument. */
function argPath(arg) {
  if (typeof arg === "string") return path.resolve(arg);
  if (Buffer.isBuffer(arg)) return path.resolve(arg.toString());
  if (arg instanceof URL) return path.resolve(fileURLToPath(arg));
  return null;
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rag-embed-lock-legacy-")));
  open = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const lock of open) {
    try { lock.release(); } catch { /* best-effort */ }
  }
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("embed-lock legacy .embed-lock record is ignored", () => {
  it("a live-pid legacy record does not block acquisition and inspect reports the kernel holder", () => {
    seedLegacy({ pid: process.pid, started: Date.now(), holder: "pre-redesign" });
    const lock = take("after-legacy");
    expect(lock.acquired).toBe(true);
    const status = inspectEmbedLock(projectRoot);
    expect(status.locked).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.holder).toBe("after-legacy");
  });

  it("no signal-0 probe is sent to a legacy record pid and an EPERM stub does not block acquisition", () => {
    seedLegacy({ pid: PROBED_PID, started: Date.now(), holder: "foreign-user", nonce: "foreign" });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
    });
    const lock = take("second-embed");
    expect(lock.acquired).toBe(true);
    expect(spy.mock.calls.filter((call) => call[0] === PROBED_PID)).toEqual([]);
  });

  it("inspectEmbedLock reports free while only a live-pid legacy record exists", () => {
    seedLegacy({ pid: process.pid, started: Date.now(), holder: "pre-redesign" });
    // Kernel lock file absent.
    expect(inspectEmbedLock(projectRoot).locked).toBe(false);
    // Kernel lock file present and free.
    const lock = acquireEmbedLock(projectRoot, { holder: "probe" });
    expect(lock.acquired).toBe(true);
    lock.release();
    expect(fs.existsSync(embedLockPath(projectRoot))).toBe(true);
    expect(inspectEmbedLock(projectRoot).locked).toBe(false);
  });

  it("no lock function reads the legacy .embed-lock path, with a positive-control fs spy hit under .rks/rag", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "packages", "rag", "src", "embed-lock.mjs"), "utf8");
    expect(src.split("\n")).toContain('import fs from "node:fs";');
    expect(src).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["']node:fs["']/);
    expect(src).not.toMatch(/import\s+\w+\s*,\s*\{[^}]*\}\s*from\s*["']node:fs["']/);

    seedLegacy({ pid: process.pid, started: Date.now(), holder: "pre-redesign" });
    const legacyTargets = new Set([legacyPath(), path.resolve(legacyPath())]);
    const readNames = ["readFileSync", "openSync", "statSync", "lstatSync", "existsSync", "accessSync"];
    const controlNames = [...readNames, "mkdirSync", "writeFileSync"];
    const spies = Object.fromEntries(controlNames.map((name) => [name, vi.spyOn(fs, name)]));
    const callPaths = (names) =>
      names.flatMap((name) => spies[name].mock.calls.map((call) => argPath(call[0]))).filter(Boolean);
    const clear = () => controlNames.forEach((name) => spies[name].mockClear());

    // The acquire: no read of the legacy path, and a positive-control hit under .rks/rag.
    clear();
    const lock = acquireEmbedLock(projectRoot, { holder: "spied" });
    const acquirePaths = callPaths(controlNames);
    const acquireReads = callPaths(readNames);
    expect(lock.acquired).toBe(true);
    open.push(lock);
    const dir = ragDir();
    const control = acquirePaths.filter(
      (p) => (p === dir || p.startsWith(dir + path.sep)) && !legacyTargets.has(p),
    );
    expect(control.length).toBeGreaterThan(0);
    expect(acquireReads.filter((p) => legacyTargets.has(p))).toEqual([]);

    // A refused in-process acquire, inspectEmbedLock and release.
    clear();
    const refused = acquireEmbedLock(projectRoot, { holder: "contender" });
    const status = inspectEmbedLock(projectRoot);
    const released = lock.release();
    const laterReads = callPaths(readNames);
    vi.restoreAllMocks();
    expect(refused.acquired).toBe(false);
    expect(status.locked).toBe(true);
    expect(released.released).toBe(true);
    expect(laterReads.filter((p) => legacyTargets.has(p))).toEqual([]);
  });

  it("a leftover legacy record is left byte-identical or removed and the kernel lock file keeps its inode", () => {
    const before = seedLegacy({ pid: process.pid, started: Date.now(), holder: "pre-redesign" });
    const lock = acquireEmbedLock(projectRoot, { holder: "inode" });
    expect(lock.acquired).toBe(true);
    const heldIno = fs.statSync(embedLockPath(projectRoot)).ino;
    expect(lock.release().released).toBe(true);
    if (fs.existsSync(legacyPath())) {
      expect(readLegacy().equals(before)).toBe(true);
    }
    expect(fs.existsSync(embedLockPath(projectRoot))).toBe(true);
    expect(fs.statSync(embedLockPath(projectRoot)).ino).toBe(heldIno);
  });

  it("the kernel lock alone refuses a second acquire and frees on release", () => {
    expect(fs.existsSync(legacyPath())).toBe(false);
    const first = acquireEmbedLock(projectRoot, { holder: "kernel-only" });
    expect(first.acquired).toBe(true);
    const second = acquireEmbedLock(projectRoot, { holder: "contender" });
    expect(second.acquired).toBe(false);
    expect(second.pid).toBe(process.pid);
    expect(second.holder).toBe("kernel-only");
    expect(first.release().released).toBe(true);
    const third = take("after-release");
    expect(third.acquired).toBe(true);
  });

  it("no legacyLockPath field or legacy lock record hint remains in the lock, tools, CLI and hook sources", () => {
    const read = (...parts) => fs.readFileSync(path.join(REPO_ROOT, ...parts), "utf8");
    const lockSrc = read("packages", "rag", "src", "embed-lock.mjs");
    const toolsSrc = read("packages", "rag", "src", "tools.mjs");
    const embedSrc = read("packages", "rag", "src", "embed.mjs");
    const hookSrcs = [
      read("packages", "hooks", "system", "rag-embed-on-commit.mjs"),
      read(".routekit", "hooks", "system", "rag-embed-on-commit.mjs"),
      read("templates", "generic", ".routekit", "hooks", "system", "rag-embed-on-commit.mjs"),
    ];
    for (const src of [lockSrc, toolsSrc, embedSrc, ...hookSrcs]) {
      expect(src).not.toContain("legacyLockPath");
      expect(src).not.toContain("legacy lock record");
    }
    for (const name of ["liveLegacyRecord", "legacyRefusal", "isPidAlive"]) {
      expect(lockSrc).not.toContain(name);
    }
    // Positive controls on the same reads.
    expect(toolsSrc).toContain("lockErrorSuffix");
    expect(toolsSrc).toContain("errorCode");
    for (const src of hookSrcs) {
      expect(src).toContain("[rag-embed] Skipped: embed lock held by ");
    }
  });
});
