/**
 * backlog.feat.project-lease-kernel-held-acquire: the project lease critical section is a
 * kernel-held node:sqlite BEGIN EXCLUSIVE lock, not an exclusive-create file with an age-based
 * stale-break. Cross-process cases spawn real child processes; every spawn carries an explicit
 * timeout (tests/unit/subprocess-timeout-convention.test.mjs).
 *
 * Telemetry is observed through project-lease.mjs's own leaseTelemetry seam (vi.spyOn), so this file
 * never reads the globally mocked telemetry package.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEASE_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/project-lease.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const END_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-end.mjs");
const CHILD_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;
const SQLITE_SIBLING = /-(journal|wal|shm)$/;
const NOT_A_DATABASE = "this file is not a SQLite database; ".repeat(20);

let dir, lease, emitSpy;
const children = [];

const req = (token, flowType = "qa") => ({ projectRoot: dir, projectId: "p", flowType, problemId: null, token, runId: null });
const leaseRecords = () => {
  const d = lease.getLeaseDir(dir);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), "utf8")));
};
const lockCandidates = () => {
  const d = lease.getLeaseDir(dir);
  return fs.readdirSync(d).filter((n) => !n.endsWith(".json") && !n.startsWith(".") && !SQLITE_SIBLING.test(n));
};
/** Discover the private lock file by one acquire + release round trip. */
function discoverLockPath() {
  expect(lease.acquireLease(req("tok-probe")).ok).toBe(true);
  lease.releaseLease({ projectRoot: dir, token: "tok-probe" });
  const names = lockCandidates();
  expect(names).toHaveLength(1);
  return path.join(lease.getLeaseDir(dir), names[0]);
}
/** Every holder record file in the lease dir, by name, as raw bytes (base64). */
const recordBytes = () => {
  const d = lease.getLeaseDir(dir);
  if (!fs.existsSync(d)) return {};
  return Object.fromEntries(fs.readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort().map((n) => [n, fs.readFileSync(path.join(d, n)).toString("base64")]));
};
const eventPayloads = (name) => emitSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[2]);
const refusedPayloads = () => emitSpy.mock.calls.filter((c) => c[0] === "lease.refused").map((c) => c[2]);
const leaseErrors = (spy) => spy.mock.calls.filter((c) => String(c[0]).includes("[project-lease]"));
/** Step Date (only) past the refreshLease throttle. Call only after any holder child reports ready. */
const stepPastRefreshThrottle = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + lease.LEASE_REFRESH_INTERVAL_MS + 1);
};

const HOLDER_SRC = `
  import fs from "node:fs";
  const [lockPath, readyPath, releasePath] = process.argv.slice(1);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(lockPath);
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN EXCLUSIVE");
  fs.writeFileSync(readyPath, String(process.pid));
  const tick = setInterval(() => {
    if (fs.existsSync(releasePath)) { db.exec("COMMIT"); db.close(); clearInterval(tick); process.exit(0); }
  }, 10);
`;

/** Spawn a child that holds the kernel lock until releasePath appears (or it is killed). */
async function holdInChild(lockPath) {
  const readyPath = path.join(dir, `ready-${children.length}`);
  const releasePath = path.join(dir, `release-${children.length}`);
  const proc = spawn(process.execPath, ["--input-type=module", "-e", HOLDER_SRC, lockPath, readyPath, releasePath], { stdio: "ignore", timeout: CHILD_TIMEOUT_MS });
  const exited = new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ timedOut: true }); }, CHILD_TIMEOUT_MS);
    proc.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  children.push(proc);
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() > deadline) throw new Error("holder child never reported ready");
    await new Promise((r) => setTimeout(r, 10));
  }
  return { proc, exited, release: () => fs.writeFileSync(releasePath, "go") };
}

/** Run a module script in a child process (explicit timeout), returning { status, stdout, stderr }. */
function runChildScript(src, args = []) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", src, ...args], { cwd: ROOT, encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-lease-kernel-"));
  vi.resetModules();
  lease = await import(LEASE_PATH);
  emitSpy = vi.spyOn(lease.leaseTelemetry, "emit");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("project lease kernel-held acquire lock", () => {
  it("AC1: an exclusive acquireLease is refused lease_contended while a separate process holds the section, and succeeds once it releases", async () => {
    const lockPath = discoverLockPath();
    const holder = await holdInChild(lockPath);
    expect(lease.acquireLease(req("tok-b"))).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expect(leaseRecords()).toEqual([]);
    holder.release();
    expect(await holder.exited).toMatchObject({ code: 0 });
    expect(lease.acquireLease(req("tok-b")).ok).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("AC2: after the holding process is SIGKILLed the next acquire enters on its first call with no cleanup step", async () => {
    const lockPath = discoverLockPath();
    const holder = await holdInChild(lockPath);
    expect(lease.acquireLease(req("tok-held")).reason).toBe("lease_contended");
    holder.proc.kill("SIGKILL");
    expect(await holder.exited).toMatchObject({ signal: "SIGKILL" });
    expect(fs.existsSync(lockPath)).toBe(true);
    const unlink = vi.spyOn(fs, "unlinkSync");
    expect(lease.acquireLease(req("tok-after-kill")).ok).toBe(true);
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("AC3: the source has no ACQUIRE_STALE_MS, no .acquire literal and no mtimeMs age comparison, and the module exports no ACQUIRE_STALE_MS", () => {
    const src = fs.readFileSync(LEASE_PATH, "utf8");
    expect(src).not.toContain("ACQUIRE_STALE_MS");
    expect(src).not.toMatch(/["'`]\.acquire["'`]/);
    expect(src).not.toContain("mtimeMs");
    expect(src).not.toContain("brokeStale");
    expect(lease).not.toHaveProperty("ACQUIRE_STALE_MS");
  });

  it("AC3: no lease operation unlinks or renames the lock file and it persists after release", () => {
    const lockPath = discoverLockPath();
    const unlink = vi.spyOn(fs, "unlinkSync");
    const rename = vi.spyOn(fs, "renameSync");
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    stepPastRefreshThrottle();
    expect(lease.refreshLease({ projectRoot: dir, token: "tok-a" })).toMatchObject({ refreshed: true });
    expect(lease.releaseLease({ projectRoot: dir, token: "tok-a" })).toMatchObject({ released: true });
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: "p", problemId: "s" })).toMatchObject({ ok: true, created: true });
    expect(lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" })).toMatchObject({ released: true });
    // The sequence really touched the store (positive control for the spies).
    expect(unlink).toHaveBeenCalled();
    expect(rename).toHaveBeenCalled();
    for (const call of [...unlink.mock.calls, ...rename.mock.calls]) {
      expect(call.map(String)).not.toContain(lockPath);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(leaseRecords()).toEqual([]);
  });

  it("AC4: the source keeps the attempt-counted wait with busy_timeout 0 and refreshLease keeps wait false", () => {
    const src = fs.readFileSync(LEASE_PATH, "utf8");
    expect(src).toContain("Math.max(1, Math.ceil(ACQUIRE_WAIT_MS / ACQUIRE_POLL_MS))");
    expect(src).toContain("sleepSync(ACQUIRE_POLL_MS)");
    expect(src).toContain("PRAGMA busy_timeout = 0");
    const refresh = src.slice(src.indexOf("export function refreshLease"), src.indexOf("export function checkLease"));
    expect(refresh).toContain("{ wait: false }");
  });

  it("AC4: refreshLease under a child-held lock returns refreshed false and contended true", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const holder = await holdInChild(lockPath);
    stepPastRefreshThrottle();
    expect(lease.refreshLease({ projectRoot: dir, token: "tok-a" })).toMatchObject({ refreshed: false, contended: true });
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("AC5: a clock step and a back-dated lock file mtime do not admit a second holder", async () => {
    const lockPath = discoverLockPath();
    const holder = await holdInChild(lockPath);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(lockPath, old, old);
    expect(lease.acquireLease(req("tok-b"))).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expect(leaseRecords()).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);
    vi.useRealTimers();
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("AC6: importing project-lease.mjs and calling only resolveAttribution does not load node:sqlite or emit ExperimentalWarning", () => {
    const url = pathToFileURL(LEASE_PATH).href;
    const probe = `
      const m = await import(${JSON.stringify(url)});
      m.resolveAttribution({ actor: "a" });
      console.log(JSON.stringify(process.moduleLoadList.filter((n) => /sqlite/i.test(n))));
    `;
    const r = runChildScript(probe);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split("\n").pop())).toEqual([]);
    expect(r.stderr).not.toContain("ExperimentalWarning");

    // Positive control: a real lock use in the same kind of child does load node:sqlite.
    const control = `
      const m = await import(${JSON.stringify(url)});
      const root = process.argv[1];
      m.leaseTelemetry.emit = () => {}; // no telemetry write from the child
      const out = m.acquireLease({ projectRoot: root, projectId: "p", flowType: "qa", token: "t", runId: null });
      console.log(JSON.stringify({ ok: out.ok, sqlite: process.moduleLoadList.filter((n) => /sqlite/i.test(n)) }));
    `;
    const c = runChildScript(control, [dir]);
    expect(c.status).toBe(0);
    const parsed = JSON.parse(c.stdout.trim().split("\n").pop());
    expect(parsed.ok).toBe(true);
    expect(parsed.sqlite.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("AC7: a lock file that is not a SQLite database fails closed with lease_contended, carries lockError in the refusal and telemetry, logs once and writes no holder", () => {
    const lockPath = discoverLockPath();
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = lease.acquireLease(req("tok-a"));
    const r2 = lease.acquireLease(req("tok-a"));
    for (const r of [r1, r2]) {
      expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
      expect(typeof r.lockError).toBe("string");
      expect(r.lockError.length).toBeGreaterThan(0);
    }
    expect(r2.lockError).toBe(r1.lockError);
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(2);
    for (const p of payloads) expect(p.lockError).toBe(r1.lockError);
    const logged = leaseErrors(errSpy);
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain(r1.lockError);
    expect(String(logged[0][0])).toContain(lockPath);
    expect(leaseRecords()).toEqual([]);
  });

  it("AC7: the memory store path with projectRoot null is unchanged and creates no lock file", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = lease.acquireLease({ projectRoot: null, projectId: "p", flowType: "qa", problemId: null, token: "tok-mem", runId: null });
    expect(r).toMatchObject({ ok: true, store: "memory" });
    expect(lease.acquireLease({ projectRoot: null, projectId: "p", flowType: "qa", problemId: null, token: "tok-mem-2", runId: null }).reason).toBe("project_leased");
    expect(fs.existsSync(lease.getLeaseDir(dir))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // backlog.fix.project-lease-release-runs-unlocked-on-contention (D6): a release refuses after the
  // bounded wait instead of running unlocked. These replace the former AC8 pin in place.
  it("RC1: the project-lease.mjs source has no onContended option", () => {
    const src = fs.readFileSync(LEASE_PATH, "utf8");
    expect(src).not.toContain("onContended");
    // Positive control: the file read is the lease module with its lock primitive.
    expect(src).toContain("function withAcquireFile(");
  });

  it("RC2: a contended releaseLease returns released false and contended true and leaves the holder record byte-identical", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const before = recordBytes();
    expect(Object.keys(before)).toHaveLength(1);
    const holder = await holdInChild(lockPath);
    const r = lease.releaseLease({ projectRoot: dir, token: "tok-a" });
    expect(r).toMatchObject({ released: false, contended: true, holderKey: "session:tok-a", store: "disk" });
    expect(recordBytes()).toEqual(before);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("RC3: a contended revertOffRail on a created holder returns reverted false and contended true, writes nothing and emits no lease.released", async () => {
    const lockPath = discoverLockPath();
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", problemId: "s" });
    expect(conv).toMatchObject({ ok: true, created: true });
    const before = recordBytes();
    expect(Object.keys(before)).toHaveLength(1);
    const holder = await holdInChild(lockPath);
    emitSpy.mockClear();
    const r = lease.revertOffRail({ projectRoot: dir, projectId: "p", holderKey: conv.holderKey, created: true });
    expect(r).toMatchObject({ reverted: false, contended: true, holderKey: conv.holderKey, store: "disk" });
    expect(recordBytes()).toEqual(before);
    expect(eventPayloads("lease.released")).toEqual([]);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("RC3: a contended revertOffRail on a converted holder returns reverted false and contended true and leaves it off-rail", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: "tok-a", problemId: "s" });
    expect(conv).toMatchObject({ ok: true, converted: true, created: false });
    const before = recordBytes();
    const holder = await holdInChild(lockPath);
    emitSpy.mockClear();
    const r = lease.revertOffRail({ projectRoot: dir, projectId: "p", holderKey: conv.holderKey, created: false });
    expect(r).toMatchObject({ reverted: false, contended: true, holderKey: conv.holderKey, store: "disk" });
    expect(recordBytes()).toEqual(before);
    expect(leaseRecords()).toHaveLength(1);
    expect(leaseRecords()[0].offRail).toBe(true);
    expect(eventPayloads("lease.released")).toEqual([]);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("RC4: a contended releaseOffRail does not throw, returns released false, contended true and holderKey null, and keeps the off-rail record", async () => {
    const lockPath = discoverLockPath();
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", problemId: "s" });
    expect(conv).toMatchObject({ ok: true, created: true });
    const before = recordBytes();
    const holder = await holdInChild(lockPath);
    emitSpy.mockClear();
    let r;
    expect(() => { r = lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" }); }).not.toThrow();
    expect(r).toMatchObject({ released: false, contended: true, holderKey: null, store: "disk" });
    expect(recordBytes()).toEqual(before);
    expect(leaseRecords()).toHaveLength(1);
    expect(leaseRecords()[0]).toMatchObject({ holderKey: conv.holderKey, offRail: true });
    expect(eventPayloads("lease.released")).toEqual([]);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("RC5: each contended release emits exactly one lease.release_contended naming its op", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: "tok-a", problemId: "s" });
    expect(conv).toMatchObject({ ok: true, converted: true });
    const holder = await holdInChild(lockPath);
    const ops = [
      ["releaseLease", () => lease.releaseLease({ projectRoot: dir, token: "tok-a" })],
      ["revertOffRail", () => lease.revertOffRail({ projectRoot: dir, projectId: "p", holderKey: conv.holderKey, created: false })],
      ["releaseOffRail", () => lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" })],
    ];
    for (const [op, run] of ops) {
      emitSpy.mockClear();
      expect(run(), op).toMatchObject({ contended: true });
      const payloads = eventPayloads("lease.release_contended");
      expect(payloads, op).toHaveLength(1);
      expect(payloads[0], op).toMatchObject({ projectId: "p", op, store: "disk" });
      expect(payloads[0], op).not.toHaveProperty("lockError");
    }
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("RC6: a contended releaseLease carries lockError on a non-database lock file and none under a busy holder", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const holder = await holdInChild(lockPath);
    const busy = lease.releaseLease({ projectRoot: dir, token: "tok-a" });
    expect(busy).toMatchObject({ released: false, contended: true });
    expect(busy).not.toHaveProperty("lockError");
    holder.release();
    await holder.exited;

    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    emitSpy.mockClear();
    const bad = lease.releaseLease({ projectRoot: dir, token: "tok-a" });
    expect(bad).toMatchObject({ released: false, contended: true });
    expect(typeof bad.lockError).toBe("string");
    expect(bad.lockError.length).toBeGreaterThan(0);
    const payloads = eventPayloads("lease.release_contended");
    expect(payloads).toHaveLength(1);
    expect(payloads[0].lockError).toBe(bad.lockError);
    expect(leaseRecords()).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("RC7: with a probe reporting the ended session unknown, a leftover session holder from a contended releaseLease is reclaimed as expired past PENDING_SESSION_GRACE_MS", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const holder = await holdInChild(lockPath);
    expect(lease.releaseLease({ projectRoot: dir, token: "tok-a" })).toMatchObject({ released: false, contended: true });
    holder.release();
    await holder.exited;
    const left = leaseRecords();
    expect(left).toHaveLength(1);
    const joinedAt = left[0].sessions["tok-a"].joinedAt;
    // Models endSession having dropped the governor session: the probe no longer knows the token.
    lease.setSessionLivenessProbe(() => ({ known: false }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(joinedAt + lease.PENDING_SESSION_GRACE_MS + 1);
    emitSpy.mockClear();
    expect(lease.acquireLease(req("tok-b")).ok).toBe(true);
    expect(eventPayloads("lease.released")).toContainEqual({ projectId: "p", holderKey: "session:tok-a", reason: "expired" });
  }, TEST_TIMEOUT_MS);

  it("RC7: a leftover off-rail holder from a contended releaseOffRail is reclaimed as offrail_orphan after the conversion grace", async () => {
    const lockPath = discoverLockPath();
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", problemId: "s" });
    expect(conv).toMatchObject({ ok: true, created: true });
    const holder = await holdInChild(lockPath);
    expect(lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" })).toMatchObject({ released: false, contended: true });
    holder.release();
    await holder.exited;
    const left = leaseRecords();
    expect(left).toHaveLength(1);
    // Guard evidence is absent in this temp root (no hooks.bak, no guard state file).
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks.bak"))).toBe(false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(left[0].offRailConvertedAt + lease.OFFRAIL_CONVERSION_GRACE_MS + 1);
    emitSpy.mockClear();
    expect(lease.acquireLease(req("tok-b")).ok).toBe(true);
    expect(eventPayloads("lease.released")).toContainEqual({ projectId: "p", holderKey: conv.holderKey, reason: "offrail_orphan" });
  }, TEST_TIMEOUT_MS);

  it("RC8: handleGovernorEnd with a contended release returns ended true and lease.contended true", async () => {
    // Imported after beforeEach's resetModules, so governor-token shares the `lease` instance emitSpy watches.
    const tok = await import(TOKEN_PATH);
    const init = await import(INIT_PATH);
    tok.setProjectRoot(dir);
    try {
      const lockPath = discoverLockPath();
      const a = init.handleGovernorInit({ projectId: "p" });
      expect(a.ok).toBe(true);
      expect(leaseRecords().map((r) => r.holderKey)).toEqual([`session:${a.token}`]);
      const { handleGovernorEnd } = await import(END_PATH);
      const holder = await holdInChild(lockPath);
      const res = handleGovernorEnd({ projectId: "p" }, a.token);
      expect(res).toMatchObject({ ok: true, ended: true });
      expect(res.lease).toMatchObject({ released: false, contended: true, holderKey: `session:${a.token}` });
      holder.release();
      await holder.exited;
    } finally {
      try { tok.resetToken(); } catch { /* ignore */ }
      try { tok.setProjectRoot(null); } catch { /* ignore */ }
    }
  }, TEST_TIMEOUT_MS);

  it("AC9: the source documents the kernel-held lock and the restart rule", () => {
    const src = fs.readFileSync(LEASE_PATH, "utf8");
    expect(src).toContain("BEGIN EXCLUSIVE");
    expect(src).toMatch(/restart/);
  });

  it("AC7: a refusal caused by a real busy holder carries no lockError and logs no console.error", async () => {
    const lockPath = discoverLockPath();
    const holder = await holdInChild(lockPath);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = lease.acquireLease(req("tok-b"));
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expect(r).not.toHaveProperty("lockError");
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("lockError");
    expect(leaseErrors(errSpy)).toEqual([]);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("AC7: refreshLease reports lockError on a non-database lock file and none under a busy holder", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const holder = await holdInChild(lockPath);
    stepPastRefreshThrottle();
    const busy = lease.refreshLease({ projectRoot: dir, token: "tok-a" });
    expect(busy).toMatchObject({ refreshed: false, contended: true });
    expect(busy).not.toHaveProperty("lockError");
    holder.release();
    await holder.exited;

    // A contended refresh deletes its throttle stamp, so this next call reaches the lock again.
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const bad = lease.refreshLease({ projectRoot: dir, token: "tok-a" });
    expect(bad).toMatchObject({ refreshed: false, contended: true });
    expect(typeof bad.lockError).toBe("string");
    expect(bad.lockError.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("AC7: convertToOffRail on a non-database lock file refuses lease_contended with lockError in the refusal and telemetry", () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const r = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: "tok-a", problemId: "s" });
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expect(typeof r.lockError).toBe("string");
    expect(r.lockError.length).toBeGreaterThan(0);
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].lockError).toBe(r.lockError);
    expect(leaseRecords().every((rec) => rec.offRail === false)).toBe(true);
  });
});

describe("project lease lock error detail", () => {
  const SQLITE_NOTADB = 26;
  const expectSqliteDetail = (obj, lockError = "ERR_SQLITE_ERROR") => {
    expect(obj.lockError).toBe(lockError);
    expect(typeof obj.errcode).toBe("number");
    expect(obj.errcode & 0xff).toBe(SQLITE_NOTADB);
    expect(typeof obj.errstr).toBe("string");
    expect(obj.errstr.length).toBeGreaterThan(0);
  };
  const expectNoDetail = (obj) => {
    for (const key of ["lockError", "errcode", "errstr"]) expect(obj).not.toHaveProperty(key);
  };

  it("acquireLease on a non-database lock file carries lockError, errcode 26 and errstr in the refusal and lease.refused payload", () => {
    const lockPath = discoverLockPath();
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = lease.acquireLease(req("tok-a"));
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expectSqliteDetail(r);
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ lockError: r.lockError, errcode: r.errcode, errstr: r.errstr });
  });

  it("convertToOffRail on a non-database lock file carries lockError, errcode 26 and errstr in the refusal and lease.refused payload", () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const r = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: "tok-a", problemId: "s" });
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expectSqliteDetail(r);
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ lockError: r.lockError, errcode: r.errcode, errstr: r.errstr });
  });

  it("refreshLease on a non-database lock file carries lockError, errcode 26 and errstr in its contended result", () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    stepPastRefreshThrottle();
    const r = lease.refreshLease({ projectRoot: dir, token: "tok-a" });
    expect(r).toMatchObject({ refreshed: false, contended: true });
    expectSqliteDetail(r);
  });

  it("a busy holder refusal, payload and refreshLease result carry no lockError, errcode or errstr", async () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    const holder = await holdInChild(lockPath);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = lease.acquireLease(req("tok-b"));
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    expectNoDetail(r);
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expectNoDetail(payloads[0]);
    stepPastRefreshThrottle();
    const refreshed = lease.refreshLease({ projectRoot: dir, token: "tok-a" });
    expect(refreshed).toMatchObject({ refreshed: false, contended: true });
    expectNoDetail(refreshed);
    expect(leaseErrors(errSpy)).toEqual([]);
    holder.release();
    await holder.exited;
  }, TEST_TIMEOUT_MS);

  it("node:sqlite unavailable carries lockError ERR_LEASE_LOCK_SQLITE_UNAVAILABLE and no errcode or errstr", () => {
    const original = process.getBuiltinModule.bind(process);
    const stub = vi.spyOn(process, "getBuiltinModule").mockImplementation((name) => {
      if (name === "node:sqlite") throw new Error("node:sqlite stubbed unavailable");
      return original(name);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = lease.acquireLease(req("tok-a"));
    expect(stub).toHaveBeenCalledWith("node:sqlite");
    expect(r).toMatchObject({ ok: false, reason: "lease_contended", holder: null, lockError: "ERR_LEASE_LOCK_SQLITE_UNAVAILABLE" });
    expect(r).not.toHaveProperty("errcode");
    expect(r).not.toHaveProperty("errstr");
    const payloads = refusedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].lockError).toBe("ERR_LEASE_LOCK_SQLITE_UNAVAILABLE");
    expect(payloads[0]).not.toHaveProperty("errcode");
    expect(payloads[0]).not.toHaveProperty("errstr");
  });

  it("the one-time log line names the lock path, lockError, errcode and the remove-if-no-mcp-rks-process remedy, and logs once for identical refusals", () => {
    const lockPath = discoverLockPath();
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r1 = lease.acquireLease(req("tok-a"));
    const r2 = lease.acquireLease(req("tok-a"));
    expect(r2.errcode).toBe(r1.errcode);
    const logged = leaseErrors(errSpy);
    expect(logged).toHaveLength(1);
    const line = String(logged[0][0]);
    expect(line).toContain(lockPath);
    expect(line).toContain(r1.lockError);
    expect(line).toContain(String(r1.errcode));
    expect(line).toMatch(/remove/i);
    expect(line).toMatch(/mcp-rks/);
  });

  it("a different errcode under the same lockError logs a second line", () => {
    const lockPath = discoverLockPath();
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = lease.acquireLease(req("tok-a"));
    expect(typeof first.errcode).toBe("number");
    expect(leaseErrors(errSpy)).toHaveLength(1);
    // Test-owned replacement of the lock file with a directory (production never does this).
    fs.rmSync(lockPath, { force: true });
    fs.mkdirSync(lockPath);
    const second = lease.acquireLease(req("tok-a"));
    expect(second).toMatchObject({ ok: false, reason: "lease_contended" });
    expect(second.lockError).toBe(first.lockError);
    expect(typeof second.errcode).toBe("number");
    expect(second.errcode).not.toBe(first.errcode);
    const logged = leaseErrors(errSpy);
    expect(logged).toHaveLength(2);
    expect(String(logged[1][0])).toContain(String(second.errcode));
  });

  it("no refusal unlinks, renames or truncates the corrupt lock file", () => {
    const lockPath = discoverLockPath();
    expect(lease.acquireLease(req("tok-a")).ok).toBe(true);
    fs.writeFileSync(lockPath, NOT_A_DATABASE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unlink = vi.spyOn(fs, "unlinkSync");
    const rename = vi.spyOn(fs, "renameSync");
    const truncate = vi.spyOn(fs, "truncateSync");
    expect(lease.acquireLease(req("tok-b"))).toMatchObject({ ok: false, reason: "lease_contended" });
    stepPastRefreshThrottle();
    expect(lease.refreshLease({ projectRoot: dir, token: "tok-a" })).toMatchObject({ refreshed: false, contended: true });
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: "tok-a", problemId: "s" })).toMatchObject({ ok: false, reason: "lease_contended" });
    for (const call of [...unlink.mock.calls, ...rename.mock.calls, ...truncate.mock.calls]) {
      expect(call.map(String)).not.toContain(lockPath);
    }
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(NOT_A_DATABASE);
  });
});
