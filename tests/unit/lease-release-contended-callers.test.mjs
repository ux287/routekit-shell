/**
 * backlog.fix.lease-release-contended-result-discarded-by-callers
 * Unit tier. No subprocess is spawned. Contention is injected by wrapping project-lease.mjs's
 * releaseLease: the wrapper performs the REAL release and overrides only the returned value, so the
 * lease store stays consistent and no lease.release_contended is emitted by the double. Real kernel-lock
 * contention is covered in tests/unit/project-lease-kernel-lock.test.mjs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const LEASE_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/project-lease.mjs");

const contendedFor = (token) => ({ released: false, contended: true, holderKey: `session:${token}`, store: "disk" });

// Site tags of the console.error lines this story adds. Assertions count only these, so an unrelated
// log line on the same path (for example the governor-init session-sweep failure) cannot skew a count.
const INIT_TAG = "[governor-init] contended";
const TOKEN_TAG = "[governor-token] contended";

const STALE_PID = "backlog.fix.lrc-stale";

let dir, tok, init, lease, emitSpy, errSpy;
// When set, the releaseLease wrapper returns override(args, realResult) instead of the real result.
let override = null;
// When set, the acquireLease wrapper returns acquireOverride(args) instead of acquiring.
let acquireOverride = null;

async function boot({ mockCreateSession } = {}) {
  vi.resetModules();
  vi.doUnmock(TOKEN_PATH);
  vi.doMock(LEASE_PATH, async (io) => {
    const real = await io();
    return {
      ...real,
      releaseLease: vi.fn((args) => {
        const r = real.releaseLease(args);
        if (!override) return r;
        const o = override(args, r);
        return o === undefined ? r : o;
      }),
      acquireLease: vi.fn((args) => (acquireOverride ? acquireOverride(args) : real.acquireLease(args))),
    };
  });
  if (mockCreateSession) {
    vi.doMock(TOKEN_PATH, async (io) => ({ ...(await io()), createSession: mockCreateSession }));
  }
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  lease = await import(LEASE_PATH);
  emitSpy?.mockRestore?.();
  emitSpy = vi.spyOn(lease.leaseTelemetry, "emit");
  tok.setProjectRoot(dir);
}

const contendedEvents = () => emitSpy.mock.calls.filter((c) => c[0] === "lease.release_contended");
const tagged = (tag) => errSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes(tag));

function writeStaleNote(body) {
  const src = `---\nid: "${STALE_PID}"\nphase: "executing"\n---\n\n${body}`;
  fs.writeFileSync(path.join(dir, "notes", `${STALE_PID}.md`), src);
}

// A story session at `planned` whose plan-time subject digest no longer matches the note, so the
// next init of the same problemId takes the stale_reset path. Mirrors the toPlanned harness in
// tests/unit/governor-init-stale-resume.test.mjs (the real rks_plan entry transition captures the digest).
function staleSession() {
  writeStaleNote("## Problem\n\noriginal\n");
  const a = init.handleGovernorInit({ projectId: "p", problemId: STALE_PID });
  expect(a.ok, JSON.stringify(a)).toBe(true);
  tok.getSession(a.token).state = "refining";
  expect(tok.advanceState(a.token, "rks_plan").newState).toBe("planning");
  expect(tok.advanceStateOnResult(a.token, "plan.ok").newState).toBe("planned");
  writeStaleNote(`## Problem\n\namended ${Math.random()}\n`);
  return a;
}

// A live story session placed at `state`, holding the project lease.
function storySessionAt(state, problemId = "backlog.feat.lrc-term") {
  const a = init.handleGovernorInit({ projectId: "p", problemId });
  expect(a.ok, JSON.stringify(a)).toBe(true);
  tok.getSession(a.token).state = state;
  return a.token;
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-lease-contended-callers-")));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  override = null;
  acquireOverride = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await boot();
});

afterEach(() => {
  override = null;
  acquireOverride = null;
  vi.useRealTimers();
  vi.doUnmock(LEASE_PATH);
  vi.doUnmock(TOKEN_PATH);
  vi.restoreAllMocks();
  emitSpy = null;
  try { tok?.resetToken?.(); } catch { /* ignore */ }
  try { tok?.setProjectRoot?.(null); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("contended lease release at callers", () => {
  it("governor-init reset volunteers a contended endSession release as leaseRelease", () => {
    const first = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    override = (args) => contendedFor(args.token);
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    override = null;
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.mode).toBe("reset");
    expect(second.leaseRelease).toEqual(contendedFor(first.token));
  });

  it("governor-init stale_reset volunteers a contended endSession release as leaseRelease", () => {
    const a = staleSession();
    override = (args) => contendedFor(args.token);
    const r = init.handleGovernorInit({ projectId: "p", problemId: STALE_PID });
    override = null;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.mode).toBe("stale_reset");
    expect(r.reason).toBe("story_changed_since_plan");
    expect(r.token).not.toBe(a.token);
    expect(r.leaseRelease).toEqual(contendedFor(a.token));
  });

  it("governor-init reset and stale_reset add no leaseRelease when uncontended or null", () => {
    const first = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.mode).toBe("reset");
    expect(second).not.toHaveProperty("leaseRelease");
    override = () => null;
    const third = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    override = null;
    expect(third.ok, JSON.stringify(third)).toBe(true);
    expect(third.mode).toBe("reset");
    expect(third).not.toHaveProperty("leaseRelease");
    expect(first.token).not.toBe(second.token);
    // Release the qa session so the story-flow stale sessions below can take the exclusive lease.
    tok.endSession(third.token);

    // stale_reset, uncontended (the real release result, released true).
    staleSession();
    const s1 = init.handleGovernorInit({ projectId: "p", problemId: STALE_PID });
    expect(s1.ok, JSON.stringify(s1)).toBe(true);
    expect(s1.mode).toBe("stale_reset");
    expect(s1).not.toHaveProperty("leaseRelease");
    tok.endSession(s1.token);

    // stale_reset, endSession returning null.
    staleSession();
    override = () => null;
    const s2 = init.handleGovernorInit({ projectId: "p", problemId: STALE_PID });
    override = null;
    expect(s2.ok, JSON.stringify(s2)).toBe(true);
    expect(s2.mode).toBe("stale_reset");
    expect(s2).not.toHaveProperty("leaseRelease");
    expect(tagged(INIT_TAG)).toEqual([]);
  });

  it("governor-init reset volunteers a contended owned release as leaseRelease on a refused acquireLease", () => {
    const first = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const refusal = { ok: false, reason: "project_leased", holder: { flowType: "qa", problemId: "backlog.feat.other" }, requested: { mode: "exclusive" }, store: "disk" };
    override = (args) => contendedFor(args.token);
    acquireOverride = () => refusal;
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    override = null;
    acquireOverride = null;
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("project_leased");
    expect(second).not.toHaveProperty("token");
    expect(second.leaseRelease).toEqual(contendedFor(first.token));

    // Uncontended owned release on the same refused path adds no leaseRelease key.
    const third = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    expect(third.ok, JSON.stringify(third)).toBe(true);
    acquireOverride = () => refusal;
    const fourth = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    acquireOverride = null;
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toBe("project_leased");
    expect(fourth).not.toHaveProperty("leaseRelease");
  });

  it("advanceState terminal transition volunteers a contended release as leaseRelease", () => {
    // Story flow: refining --rks_exec_abort--> failed (terminal), entered on tool entry.
    const t1 = storySessionAt("refining");
    override = (args) => contendedFor(args.token);
    const r1 = tok.advanceState(t1, "rks_exec_abort");
    override = null;
    expect(r1).toEqual({ previousState: "refining", newState: "failed", transitioned: true, leaseRelease: contendedFor(t1) });
    expect(tok.getSession(t1)).toBeNull();

    // Uncontended: exactly the pre-existing shape.
    const t2 = storySessionAt("refining");
    const r2 = tok.advanceState(t2, "rks_exec_abort");
    expect(r2).toEqual({ previousState: "refining", newState: "failed", transitioned: true });
    expect(tagged(TOKEN_TAG)).toEqual([]);
  });

  it("advanceStateOnResult terminal transition volunteers a contended release as leaseRelease", () => {
    // Story flow: approval-pending --approve.denied--> failed (terminal), on the tool's result.
    const t1 = storySessionAt("approval-pending");
    override = (args) => contendedFor(args.token);
    const r1 = tok.advanceStateOnResult(t1, "approve.denied");
    override = null;
    expect(r1).toEqual({
      previousState: "approval-pending", newState: "failed", transitioned: true,
      resultKey: "approve.denied", effectiveResultKey: "approve.denied",
      leaseRelease: contendedFor(t1),
    });

    const t2 = storySessionAt("approval-pending");
    const r2 = tok.advanceStateOnResult(t2, "approve.denied");
    expect(r2).toEqual({
      previousState: "approval-pending", newState: "failed", transitioned: true,
      resultKey: "approve.denied", effectiveResultKey: "approve.denied",
    });
    expect(r2).not.toHaveProperty("leaseRelease");
  });

  it("dead persisted record with a contended expired release logs one console.error and returns null", async () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc-dead" });
    expect(a.ok, JSON.stringify(a)).toBe(true);
    const recordPath = path.join(dir, ".rks", "session", "governor", `${a.token}.json`);
    expect(fs.existsSync(recordPath)).toBe(true);
    // Idle past MAX_AGE_MS (30 min), not `executing`: isLiveSession rejects it as expired.
    const rec = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.writeFileSync(recordPath, JSON.stringify({ ...rec, state: "init", lastActivity: old, createdAt: old }));

    // A fresh module graph drops the in-memory copy, as an MCP server restart would.
    await boot();
    const seen = [];
    override = (args) => {
      seen.push(args.reason);
      return args.reason === "expired" ? contendedFor(args.token) : undefined;
    };
    expect(tok.validateToken(a.token)).toBe(false);
    override = null;
    expect(seen).toEqual(["expired"]);
    expect(tok.getSession(a.token)).toBeNull();
    expect(fs.existsSync(recordPath)).toBe(false);
    const lines = tagged(TOKEN_TAG);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`session:${a.token}`);
    expect(lines[0]).toContain("expired");
  });

  it("createSession failure rethrows the original error carrying a contended leaseRelease", async () => {
    const boom = new Error("lrc createSession boom");
    await boot({ mockCreateSession: () => { throw boom; } });
    override = (args) => contendedFor(args.token);
    let caught;
    try { init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" }); } catch (e) { caught = e; }
    override = null;
    expect(caught).toBe(boom);
    expect(caught.leaseRelease).toMatchObject({ released: false, contended: true });
    expect(caught.leaseRelease.holderKey).toMatch(/^session:/);
    expect(tagged(INIT_TAG)).toHaveLength(1);

    const boom2 = new Error("lrc createSession boom uncontended");
    await boot({ mockCreateSession: () => { throw boom2; } });
    errSpy.mockClear();
    let caught2;
    try { init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" }); } catch (e) { caught2 = e; }
    expect(caught2).toBe(boom2);
    expect(caught2).not.toHaveProperty("leaseRelease");
    expect(tagged(INIT_TAG)).toEqual([]);
  });

  it("callers emit no lease.release_contended telemetry of their own", async () => {
    // init reset
    const first = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    override = (args) => contendedFor(args.token);
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    override = null;
    expect(second.leaseRelease).toEqual(contendedFor(first.token));
    // The double never emits; any lease.release_contended here came from a caller.
    expect(contendedEvents()).toEqual([]);
    tok.endSession(second.token);

    // init stale_reset
    staleSession();
    override = (args) => contendedFor(args.token);
    const stale = init.handleGovernorInit({ projectId: "p", problemId: STALE_PID });
    override = null;
    expect(stale.leaseRelease).toMatchObject({ contended: true });
    expect(contendedEvents()).toEqual([]);
    tok.endSession(stale.token);

    // terminal transitions
    const t1 = storySessionAt("refining");
    override = (args) => contendedFor(args.token);
    expect(tok.advanceState(t1, "rks_exec_abort").leaseRelease).toEqual(contendedFor(t1));
    override = null;
    const t2 = storySessionAt("approval-pending");
    override = (args) => contendedFor(args.token);
    expect(tok.advanceStateOnResult(t2, "approve.denied").leaseRelease).toEqual(contendedFor(t2));
    override = null;
    expect(contendedEvents()).toEqual([]);

    // createSession rollback (a fresh module graph, so check its own emitter spy)
    const boom = new Error("lrc telemetry boom");
    await boot({ mockCreateSession: () => { throw boom; } });
    override = (args) => contendedFor(args.token);
    let caught;
    try { init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc-tel" }); } catch (e) { caught = e; }
    override = null;
    expect(caught).toBe(boom);
    expect(caught.leaseRelease).toMatchObject({ contended: true });
    expect(contendedEvents()).toEqual([]);
  });

  it("a memory-store release adds no leaseRelease key and no console.error line", async () => {
    const memory = (args) => ({ released: true, holderKey: `session:${args.token}`, store: "memory" });

    // init reset
    init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc" });
    override = memory;
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc", reset: true });
    override = null;
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second).not.toHaveProperty("leaseRelease");
    tok.endSession(second.token);

    // terminal transition
    const t1 = storySessionAt("refining");
    override = memory;
    const r1 = tok.advanceState(t1, "rks_exec_abort");
    override = null;
    expect(r1).toEqual({ previousState: "refining", newState: "failed", transitioned: true });

    // createSession rollback
    const boom = new Error("lrc memory boom");
    await boot({ mockCreateSession: () => { throw boom; } });
    override = memory;
    let caught;
    try { init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "backlog.feat.lrc-mem" }); } catch (e) { caught = e; }
    override = null;
    expect(caught).toBe(boom);
    expect(caught).not.toHaveProperty("leaseRelease");

    expect(tagged(INIT_TAG)).toEqual([]);
    expect(tagged(TOKEN_TAG)).toEqual([]);
  });
});
