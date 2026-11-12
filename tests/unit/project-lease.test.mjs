/**
 * backlog.feat.project-lease-actor-attribution — strict server-side project lease with actor / via /
 * client attribution (Phase 1a of notes/research.2026.10.29.external-agent-dispatch-parity.md).
 *
 * Unit tier. Races and restarts are simulated IN-PROCESS: a fresh module instance (vi.resetModules
 * plus re-import) against the same fs.mkdtempSync project root stands in for a second mcp-rks
 * process, and a test-held node:sqlite BEGIN EXCLUSIVE on the lease's kernel lock file stands in for
 * a peer mid-acquisition (backlog.feat.project-lease-kernel-held-acquire; the cross-process cases live
 * in tests/unit/project-lease-kernel-lock.test.mjs). No subprocess is spawned. guardrailsOff / guardrailsOn / guardrailsAbort and loadContext are mocked,
 * so the governance handlers run against the REAL lease and session modules with no worktree effect.
 *
 * Telemetry is observed through project-lease.mjs's own leaseTelemetry seam (vi.spyOn), so this file
 * never re-mocks the globally mocked telemetry package.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const h = vi.hoisted(() => ({
  guardrailsOff: vi.fn(),
  guardrailsOn: vi.fn(),
  guardrailsAbort: vi.fn(),
  loadRoot: { value: null },
}));

vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (io) => ({ ...(await io()), guardrailsOff: h.guardrailsOff, guardrailsOn: h.guardrailsOn, guardrailsAbort: h.guardrailsAbort }));
vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (io) => ({
  ...(await io()),
  loadContext: async (projectId) => ({ record: { id: projectId, root: h.loadRoot.value }, projectJson: {} }),
}));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const END_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-end.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const LEASE_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/project-lease.mjs");
const GOV_PATH = path.join(ROOT, "packages/mcp-rks/src/server/handlers/governance.mjs");
const REGISTRY_PATH = path.join(ROOT, "packages/mcp-rks/src/server/handlers/registry.mjs");
const SERVER_PATH = path.join(ROOT, "packages/mcp-rks/src/server.mjs");

const MAX_AGE_MS = 30 * 60 * 1000;
const MEMORY = { store: "memory", degraded: "no_project_root" };
const EXCLUSIVE = ["story", "qa", "ship", "ops"];
const initArgs = (flowType, projectId = "p") => (flowType === "story"
  ? { projectId, problemId: "backlog.feat.lease-story" }
  : flowType === "open" ? { projectId } : { projectId, flowType, problemId: `backlog.feat.lease-${flowType}` });

let dir, otherRoot, tok, init, lease, emitSpy;

// Fresh module instances against the same project root simulate a second mcp-rks process.
async function boot({ root = dir } = {}) {
  vi.resetModules();
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  lease = await import(LEASE_PATH);
  emitSpy = vi.spyOn(lease.leaseTelemetry, "emit");
  tok.setProjectRoot(root);
}

const leaseRecords = (root = dir) => {
  const d = path.join(root, ".rks", "session", "lease");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), "utf8")));
};
const governorFiles = () => {
  const d = path.join(dir, ".rks", "session", "governor");
  return fs.existsSync(d) ? fs.readdirSync(d).length : 0;
};
const events = (name) => emitSpy.mock.calls.filter((c) => c[0] === name).map((c) => c[2]);
const offRailEvidence = () => fs.mkdirSync(path.join(dir, ".routekit", "hooks.bak"), { recursive: true });
const parse = (res) => JSON.parse(res.content[0].text);

async function governance() {
  const { createHandlerRegistry } = await import(REGISTRY_PATH);
  const { registerGovernanceHandlers } = await import(GOV_PATH);
  const r = createHandlerRegistry();
  const pass = z.object({}).passthrough();
  registerGovernanceHandlers(r, {
    guardrailsOffSchema: pass, guardrailsOnSchema: pass, guardrailsAbortSchema: pass, guardrailsStatusSchema: pass,
    phaseRepairSchema: pass, archVerdictSchema: pass, governorInitSchema: pass, governorEndSchema: pass,
  }, {
    getDendronContext: vi.fn(), assertNotesDir: vi.fn(), notePathFromFilename: vi.fn(), commitDendronWriteResult: vi.fn(),
    reconcileActiveScopeOnInit: vi.fn(() => ({ removed: false, reason: "lease-test" })),
  });
  return (tool, args, ctx = {}) => r.lookupHandler(tool)(args, Object.freeze({ tool, args, activeToken: undefined, governorToken: undefined, clientName: null, ...ctx }));
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-lease-"));
  otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "project-lease-loadctx-"));
  h.loadRoot.value = otherRoot; // deliberately NOT the session root (store parity, §5b)
  delete process.env.RKS_DISPATCH_RUN_ID;
  delete process.env.RKS_ACTOR;
  delete process.env.RKS_VIA;
  // backlog.feat.server-lane-policy AC1: a runner env carrying RKS_VIA_DEFAULT (e.g. an
  // rks-labelled IDE server) must not change the via-default and RKS_VIA outcomes below.
  delete process.env.RKS_VIA_DEFAULT;
  h.guardrailsOff.mockReset();
  h.guardrailsOn.mockReset();
  h.guardrailsAbort.mockReset();
  // The real guardrailsOff relocates hooks to hooks.bak; that is the off-rail evidence the lease reads.
  h.guardrailsOff.mockImplementation(async () => { offRailEvidence(); return { ok: true, sessionId: "off-1" }; });
  h.guardrailsOn.mockImplementation(async () => { fs.rmSync(path.join(dir, ".routekit", "hooks.bak"), { recursive: true, force: true }); return { ok: true }; });
  h.guardrailsAbort.mockImplementation(async () => { fs.rmSync(path.join(dir, ".routekit", "hooks.bak"), { recursive: true, force: true }); return { ok: true }; });
  await boot();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock(TOKEN_PATH);
  vi.doUnmock(LEASE_PATH);
  vi.doUnmock(END_PATH);
  try { tok.resetToken(); } catch { /* ignore */ }
  try { tok.setProjectRoot(null); } catch { /* ignore */ }
  delete process.env.RKS_DISPATCH_RUN_ID;
  delete process.env.RKS_ACTOR;
  delete process.env.RKS_VIA;
  delete process.env.RKS_VIA_DEFAULT;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(otherRoot, { recursive: true, force: true });
});

describe("project lease: shared and exclusive compatibility", () => {
  it("AC1: open + open on one project both succeed with distinct non-empty tokens", () => {
    const a = init.handleGovernorInit({ projectId: "p" });
    const b = init.handleGovernorInit({ projectId: "p" });
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(b.token).not.toBe(a.token);
  });

  it.each(EXCLUSIVE)("AC2: with a live open session, a %s init is refused before any session exists", (flowType) => {
    const open = init.handleGovernorInit({ projectId: "p" });
    expect(open.ok).toBe(true);
    const before = governorFiles();
    const r = init.handleGovernorInit(initArgs(flowType));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("project_leased");
    expect(r).not.toHaveProperty("token");
    expect(r.holder.flowType).toBe("open");
    for (const k of ["actor", "via", "since"]) expect(r.holder).toHaveProperty(k);
    expect(r.holder.via).toBe("mcp");
    expect(typeof r.holder.since).toBe("string");
    expect(r.requested).toEqual({ flowType, problemId: initArgs(flowType).problemId ?? null });
    expect(governorFiles()).toBe(before);
  });

  it.each(EXCLUSIVE)("AC3: a live %s session refuses every other holder, open included; another projectId is not refused", (flowType) => {
    const held = init.handleGovernorInit(initArgs(flowType));
    expect(held.ok).toBe(true);
    for (const other of ["open", ...EXCLUSIVE]) {
      const args = other === flowType ? { ...initArgs(other), problemId: "backlog.feat.lease-different" } : initArgs(other);
      const r = init.handleGovernorInit(args);
      expect(r.reason, `${flowType} then ${other}`).toBe("project_leased");
      expect(r.holder.flowType).toBe(flowType);
    }
    expect(init.handleGovernorInit(initArgs("open", "q")).ok).toBe(true);
    expect(init.handleGovernorInit(initArgs(flowType, "r")).ok).toBe(true);
  });

  it("AC4: re-init with the same projectId, flowType and problemId resumes the exclusive session with the same token", () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const again = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(again.mode).toBe("resumed");
    expect(again.token).toBe(a.token);
    expect(leaseRecords()).toHaveLength(1);
  });

  it("self-replacement: reset, stale_reset and terminal auto-reset release the ended session's lease before acquiring", () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const reset = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A", reset: true });
    expect(reset).toMatchObject({ ok: true, mode: "reset" });
    expect(reset.token).not.toBe(a.token);

    tok.getSession(reset.token).state = "shipped"; // terminal for qa
    const terminal = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(terminal).toMatchObject({ ok: true, mode: "new" });
    expect(leaseRecords().map((r) => r.holderKey)).toEqual([`session:${terminal.token}`]);

    // stale_reset: a story session at 'planned' whose note now reads a phase rks_exec does not admit.
    const pid = "backlog.feat.lease-stale";
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", `${pid}.md`), `---\nid: "${pid}"\nphase: "draft"\n---\n\nbody\n`);
    tok.endSession(terminal.token);
    const story = init.handleGovernorInit({ projectId: "p", problemId: pid });
    tok.getSession(story.token).state = "planned";
    const stale = init.handleGovernorInit({ projectId: "p", problemId: pid });
    expect(stale.ok).toBe(true);
    expect(stale.mode).toBe("stale_reset");
    expect(leaseRecords().map((r) => r.holderKey)).toEqual([`session:${stale.token}`]);
  });
});

describe("project lease: run inheritance, restarts and races", () => {
  it("AC5: one RKS_DISPATCH_RUN_ID shares one holder; another or absent run id is refused while it is live", () => {
    process.env.RKS_DISPATCH_RUN_ID = "run-1";
    const ex = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.run" });
    const open = init.handleGovernorInit({ projectId: "p" });
    expect(ex.ok).toBe(true);
    expect(open.ok).toBe(true);
    expect(ex.lease.holderKey).toBe("run:run-1");
    expect(open.lease.holderKey).toBe("run:run-1");
    expect(ex.runId).toBe("run-1");
    process.env.RKS_DISPATCH_RUN_ID = "run-2";
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    delete process.env.RKS_DISPATCH_RUN_ID;
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
  });

  it("AC6: a holder written by one module instance blocks an incompatible init from a fresh instance", async () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "ops" });
    expect(a.ok).toBe(true);
    await boot();
    const r = init.handleGovernorInit({ projectId: "p" });
    expect(r.reason).toBe("project_leased");
    expect(r.holder.flowType).toBe("ops");
  });

  it("AC7: of two racing exclusive acquisitions exactly one succeeds; a held kernel lock refuses and no .acquire file is written", async () => {
    // Discover the private kernel lock file: the one non-.json, non-dot, non-SQLite-sibling entry of
    // the lease dir after one acquire + release round trip.
    expect(lease.acquireLease({ projectRoot: dir, projectId: "probe", flowType: "qa", token: "tok-probe", runId: null }).ok).toBe(true);
    lease.releaseLease({ projectRoot: dir, token: "tok-probe" });
    const leaseDir = lease.getLeaseDir(dir);
    const names = fs.readdirSync(leaseDir).filter((n) => !n.endsWith(".json") && !n.startsWith(".") && !/-(journal|wal|shm)$/.test(n));
    expect(names).toHaveLength(1);
    const lockPath = path.join(leaseDir, names[0]);
    // Instance A is mid-critical-section: it holds the kernel lock with BEGIN EXCLUSIVE.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const held = new DatabaseSync(lockPath);
    held.exec("PRAGMA busy_timeout = 0");
    held.exec("BEGIN EXCLUSIVE");
    const first = await import(LEASE_PATH);
    await boot(); // instance B
    let b1;
    try {
      b1 = lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "qa", token: "tok-b", runId: null });
    } finally {
      // A completes and releases the kernel lock.
      held.exec("COMMIT");
      held.close();
    }
    expect(b1).toMatchObject({ ok: false, reason: "lease_contended", holder: null });
    const a = first.acquireLease({ projectRoot: dir, projectId: "p", flowType: "qa", token: "tok-a", runId: null });
    const b2 = lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "qa", token: "tok-b", runId: null });
    expect([b1.ok, a.ok, b2.ok].filter(Boolean)).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b2.reason).toBe("project_leased");
    // No legacy exclusive-create acquire file is ever written, and the kernel lock file persists.
    expect(fs.readdirSync(leaseDir).filter((n) => n.startsWith(".acquire"))).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("AC8: endSession emits lease.released (session_end), a refused exclusive init then succeeds, and the scope file is byte-identical", () => {
    const scope = path.join(dir, ".rks", "active-scope.json");
    fs.mkdirSync(path.dirname(scope), { recursive: true });
    fs.writeFileSync(scope, '{"problemId":"x","allowedFiles":["a"]}');
    const before = fs.readFileSync(scope);
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(init.handleGovernorInit({ projectId: "p", flowType: "ops" }).reason).toBe("project_leased");
    tok.endSession(a.token);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${a.token}`, reason: "session_end" });
    expect(init.handleGovernorInit({ projectId: "p", flowType: "ops" }).ok).toBe(true);
    expect(fs.readFileSync(scope).equals(before)).toBe(true);
  });

  it("AC9: a holder whose sessions all aged past MAX_AGE_MS is reclaimed by the next init (reason expired)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = init.handleGovernorInit({ projectId: "p" });
    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);
    await boot();
    const r = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(r.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${a.token}`, reason: "expired" });
  });

  it("AC10: touchSession refreshes on-disk liveness within the throttle bound; no-op for a createSession-direct token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const a = init.handleGovernorInit({ projectId: "p" });
    vi.setSystemTime(t0 + MAX_AGE_MS - 60_000); // 29 minutes
    tok.touchSession(a.token);
    const rec = leaseRecords().find((r) => r.holderKey === `session:${a.token}`);
    expect(rec.sessions[a.token].lastActivity).toBe(t0 + MAX_AGE_MS - 60_000);
    vi.setSystemTime(t0 + MAX_AGE_MS + 60_000); // 31 minutes since acquire, 2 since the refresh
    await boot();
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).reason).toBe("project_leased");

    // Throttle: a second touch inside LEASE_REFRESH_INTERVAL_MS writes nothing.
    await boot();
    vi.setSystemTime(t0);
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "project-lease-throttle-"));
    try {
      tok.setProjectRoot(fresh);
      const b = init.handleGovernorInit({ projectId: "p" });
      vi.setSystemTime(t0 + lease.LEASE_REFRESH_INTERVAL_MS - 1);
      tok.touchSession(b.token);
      expect(leaseRecords(fresh)[0].sessions[b.token].lastActivity).toBe(t0);
    } finally {
      tok.setProjectRoot(dir);
      fs.rmSync(fresh, { recursive: true, force: true });
    }

    // No lease held: touchSession, refreshLease and endSession are no-ops that write no record.
    fs.rmSync(path.join(dir, ".rks", "session", "lease"), { recursive: true, force: true });
    const { token } = tok.createSession({ projectId: "p-direct" });
    vi.setSystemTime(t0 + 10 * lease.LEASE_REFRESH_INTERVAL_MS);
    expect(() => tok.touchSession(token)).not.toThrow();
    expect(lease.refreshLease({ projectRoot: dir, token })).toMatchObject({ refreshed: false, holderKey: null });
    expect(tok.endSession(token)).toBeNull();
    expect(leaseRecords()).toEqual([]);
  });
});

describe("project lease: off-rail conversion through the governance handlers", () => {
  it("AC11: the live holder's guardrails_off converts it before guardrailsOff; it then blocks others past MAX_AGE_MS; a non-holder caller is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const call = await governance();
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.offrail" });
    let seenInsideOff = null;
    h.guardrailsOff.mockImplementation(async () => {
      seenInsideOff = leaseRecords().find((r) => r.holderKey === `session:${story.token}`);
      offRailEvidence();
      return { ok: true, sessionId: "off-1" };
    });
    const res = parse(await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.offrail" }, { governorToken: story.token }));
    expect(res).toEqual({ ok: true, sessionId: "off-1" });
    expect(seenInsideOff?.offRail).toBe(true);
    expect(events("lease.offrail_converted")).toContainEqual({ projectId: "p", holderKey: `session:${story.token}`, problemId: "backlog.feat.offrail" });

    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    await boot();
    const r = init.handleGovernorInit({ projectId: "p" });
    expect(r.reason).toBe("project_leased");
    expect(r.holder.offRail).toBe(true);
  });

  it("AC11: a valid caller token that is not the live holder is refused while another holder is live", async () => {
    const call = await governance();
    const holder = init.handleGovernorInit({ projectId: "p" });
    const caller = init.handleGovernorInit({ projectId: "p" });
    expect(holder.ok && caller.ok).toBe(true);
    const res = await call("rks_guardrails_off", { projectId: "p", reason: "r" }, { governorToken: caller.token });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, reason: "project_leased", requested: { flowType: null, offRail: true } });
    expect(h.guardrailsOff).not.toHaveBeenCalled();
  });

  it("AC12: ok guardrails_on / guardrails_abort release the off-rail holder with or without a token; non-ok leaves it held", async () => {
    const call = await governance();
    const scope = path.join(dir, ".rks", "active-scope.json");
    fs.mkdirSync(path.dirname(scope), { recursive: true });
    fs.writeFileSync(scope, '{"problemId":"y"}');
    const scopeBefore = fs.readFileSync(scope);

    for (const [tool, reason, mock] of [["rks_guardrails_on", "guardrails_on", h.guardrailsOn], ["rks_guardrails_abort", "guardrails_abort", h.guardrailsAbort]]) {
      for (const withToken of [true, false]) {
        const s = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.offrail" });
        await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.offrail" }, { governorToken: s.token });
        // Non-ok: still held.
        mock.mockImplementationOnce(async () => ({ ok: false, error: "nope" }));
        expect(parse(await call(tool, { projectId: "p", detail: "full" }, withToken ? { governorToken: s.token } : {}))).toEqual({ ok: false, error: "nope" });
        expect(init.handleGovernorInit({ projectId: "p", flowType: "ops" }).reason).toBe("project_leased");
        // Ok: released, per project.
        emitSpy.mockClear();
        expect(parse(await call(tool, { projectId: "p", detail: "full" }, withToken ? { governorToken: s.token } : {}))).toEqual({ ok: true });
        expect(events("lease.released")).toContainEqual(expect.objectContaining({ projectId: "p", reason }));
        const ops = init.handleGovernorInit({ projectId: "p", flowType: "ops" });
        expect(ops.ok, `${tool} token=${withToken}`).toBe(true);
        tok.endSession(ops.token);
        tok.endSession(s.token);
      }
    }
    // An ok call with no off-rail holder is a no-op that still returns the underlying result.
    expect(parse(await call("rks_guardrails_abort", { projectId: "p" }))).toEqual({ ok: true });
    expect(fs.readFileSync(scope).equals(scopeBefore)).toBe(true);
  });

  it.each([
    ["hooks.bak absent, guard state not off", false, null, true],
    ["hooks.bak present, guard state not off", true, null, false],
    ["hooks.bak absent, guard state off", false, { active: false }, false],
    ["hooks.bak present, guard state off", true, { active: false }, false],
  ])("AC12 orphan reclaim: %s", (_label, bak, guard, reclaimed) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: null, problemId: "x" });
    expect(conv.ok).toBe(true);
    if (bak) offRailEvidence();
    if (guard) {
      fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".rks", "guardrails-state.json"), JSON.stringify(guard));
    }
    // backlog.fix.project-lease-post-init-verification-and-conversion-window (D4): an off-rail holder is
    // not an orphan within the conversion grace, so the reclaim row first moves past it.
    if (reclaimed) vi.setSystemTime(Date.now() + lease.OFFRAIL_CONVERSION_GRACE_MS + 1_000);
    const r = init.handleGovernorInit({ projectId: "p" });
    expect(r.ok).toBe(reclaimed);
    if (reclaimed) expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: conv.holderKey, reason: "offrail_orphan" });
    else expect(r.reason).toBe("project_leased");
  });

  it("AC17: absent, unknown, expired, terminal and other-project caller tokens are refused while an exclusive holder is live", async () => {
    const call = await governance();
    const live = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.held" });
    expect(live.ok).toBe(true);
    const expired = tok.createSession({ projectId: "p" });
    tok.getSession(expired.token).lastActivity = Date.now() - MAX_AGE_MS - 60_000;
    const terminal = tok.createSession({ projectId: "p" });
    tok.getSession(terminal.token).state = "review"; // terminal for the open flow
    const otherProject = tok.createSession({ projectId: "q" });
    for (const [label, governorToken] of [["absent", undefined], ["unknown", "00000000-0000-4000-8000-000000000000"], ["expired", expired.token], ["terminal", terminal.token], ["other-project", otherProject.token]]) {
      const res = await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.x" }, { governorToken });
      const p = parse(res);
      expect(p.reason, label).toBe("project_leased");
      expect(p.ok).toBe(false);
      expect(p.requested.flowType).toBeNull();
      expect(p.requested.offRail).toBe(true);
    }
    expect(h.guardrailsOff).not.toHaveBeenCalled();
  });

  it("AC17: with RKS_DISPATCH_RUN_ID set and the live holder run:<id>, an untokened guardrails_off converts it", async () => {
    process.env.RKS_DISPATCH_RUN_ID = "run-x";
    const call = await governance();
    expect(init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.run" }).lease.holderKey).toBe("run:run-x");
    const res = parse(await call("rks_guardrails_off", { projectId: "p", reason: "r" }));
    expect(res.ok).toBe(true);
    expect(h.guardrailsOff).toHaveBeenCalledTimes(1);
    expect(leaseRecords().find((r) => r.holderKey === "run:run-x").offRail).toBe(true);
  });

  it("AC18: with no valid caller and no live holder, an anonymous off-rail holder is created before guardrailsOff", async () => {
    const call = await governance();
    let inside = null;
    h.guardrailsOff.mockImplementation(async () => { inside = leaseRecords(); offRailEvidence(); return { ok: true }; });
    await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.anon" }, { clientName: "client-x" });
    expect(inside).toHaveLength(1);
    expect(inside[0].holderKey).toMatch(/^offrail:[0-9a-f-]{36}$/);
    expect(inside[0]).toMatchObject({ token: null, flowType: null, problemId: "backlog.feat.anon", offRail: true, client: "client-x" });
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).reason).toBe("project_leased");
    expect(parse(await call("rks_guardrails_on", { projectId: "p", detail: "full" }))).toEqual({ ok: true });
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).ok).toBe(true);
  });

  it("AC18: the anonymous holder is run:<id> when RKS_DISPATCH_RUN_ID is set", async () => {
    process.env.RKS_DISPATCH_RUN_ID = "run-anon";
    const call = await governance();
    let inside = null;
    h.guardrailsOff.mockImplementation(async () => { inside = leaseRecords(); offRailEvidence(); return { ok: true }; });
    await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.anon" });
    expect(inside.map((r) => r.holderKey)).toEqual(["run:run-anon"]);
    expect(inside[0].token).toBeNull();
  });

  it("AC19: a non-ok or throwing guardrailsOff reverts the conversion (guardrails_off_failed)", async () => {
    const call = await governance();
    // Converted holder (open caller) returns to shared: another open init is admitted.
    const caller = init.handleGovernorInit({ projectId: "p" });
    h.guardrailsOff.mockImplementationOnce(async () => { offRailEvidence(); return { ok: false, reason: "story_not_ready" }; });
    expect(parse(await call("rks_guardrails_off", { projectId: "p", reason: "r" }, { governorToken: caller.token }))).toEqual({ ok: false, reason: "story_not_ready" });
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${caller.token}`, reason: "guardrails_off_failed" });
    expect(leaseRecords().find((r) => r.holderKey === `session:${caller.token}`).offRail).toBe(false);
    expect(init.handleGovernorInit({ projectId: "p" }).ok).toBe(true);

    // Anonymous holder is removed when guardrailsOff throws.
    tok.resetToken();
    const boom = new Error("boom");
    h.guardrailsOff.mockImplementationOnce(async () => { offRailEvidence(); throw boom; });
    await expect(call("rks_guardrails_off", { projectId: "p", reason: "r" })).rejects.toBe(boom);
    expect(leaseRecords()).toEqual([]);
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).ok).toBe(true);
  });

  it("AC23: release removes a converted holder; the caller session survives and its touchSession writes no lease record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const call = await governance();
    const caller = init.handleGovernorInit({ projectId: "p" });
    await call("rks_guardrails_off", { projectId: "p", reason: "r" }, { governorToken: caller.token });
    expect(parse(await call("rks_guardrails_on", { projectId: "p", detail: "full" }, { governorToken: caller.token }))).toEqual({ ok: true });
    const ex = init.handleGovernorInit({ projectId: "p", flowType: "ops" });
    expect(ex.ok).toBe(true);
    expect(tok.getSession(caller.token)).toBeTruthy();
    const before = JSON.stringify(leaseRecords());
    vi.setSystemTime(Date.now() + 2 * lease.LEASE_REFRESH_INTERVAL_MS);
    tok.touchSession(caller.token);
    expect(JSON.stringify(leaseRecords())).toBe(before);
    expect(JSON.stringify(leaseRecords())).not.toContain(caller.token);
  });

  // backlog.fix.project-lease-post-init-verification-and-conversion-window (AC7 handler half): with NO
  // other holder live, a session whose converted holder an ok guardrails_on removed neither re-acquires
  // a lease on touch nor blocks a later exclusive init (a deliberate release, not a lost holder).
  it("AC23 no-conflict variant: after an ok guardrails_on with no other holder live, the caller's touchSession re-acquires nothing and a later exclusive init is admitted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const call = await governance();
    const caller = init.handleGovernorInit({ projectId: "p" });
    expect(parse(await call("rks_guardrails_off", { projectId: "p", reason: "r" }, { governorToken: caller.token })).ok).toBe(true);
    expect(parse(await call("rks_guardrails_on", { projectId: "p", detail: "full" }, { governorToken: caller.token }))).toEqual({ ok: true });
    expect(leaseRecords()).toEqual([]);
    emitSpy.mockClear();
    vi.setSystemTime(Date.now() + 2 * lease.LEASE_REFRESH_INTERVAL_MS);
    tok.touchSession(caller.token);
    expect(leaseRecords()).toEqual([]);
    expect(JSON.stringify(leaseRecords())).not.toContain(caller.token);
    expect(tok.verifySessionLease(caller.token)).toBeNull();
    expect(leaseRecords()).toEqual([]);
    expect(events("lease.acquired").filter((e) => e.holderKey === `session:${caller.token}`)).toEqual([]);
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).ok).toBe(true);
  });

  it("D4 window: while guardrailsOff has not yet written hooks.bak or guard state, a peer is refused and the converted holder is not reclaimed as an orphan", async () => {
    const call = await governance();
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.offrail-window" });
    expect(story.ok).toBe(true);
    let peer = null;
    let inside = null;
    h.guardrailsOff.mockImplementation(async () => {
      // The window: the lease is converted, but no hooks.bak and no guard-state file exist yet.
      expect(fs.existsSync(path.join(dir, ".routekit", "hooks.bak"))).toBe(false);
      expect(fs.existsSync(path.join(dir, ".rks", "guardrails-state.json"))).toBe(false);
      peer = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
      inside = leaseRecords().find((r) => r.holderKey === `session:${story.token}`);
      offRailEvidence();
      return { ok: true, sessionId: "off-window" };
    });
    const res = parse(await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.offrail-window" }, { governorToken: story.token }));
    expect(res.ok).toBe(true);
    expect(peer.ok).toBe(false);
    expect(peer.reason).toBe("project_leased");
    expect(peer.holder.holderKey).toBe(`session:${story.token}`);
    expect(peer.holder.offRail).toBe(true);
    expect(inside?.offRail).toBe(true);
    expect(events("lease.released").filter((e) => e.reason === "offrail_orphan")).toEqual([]);
  });

  it("D4 grace expiry: past the conversion grace, a converted holder with no hooks.bak and no guard state is reclaimed (offrail_orphan)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: null, problemId: "x" });
    expect(conv.ok).toBe(true);
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased"); // still inside the grace
    vi.setSystemTime(Date.now() + lease.OFFRAIL_CONVERSION_GRACE_MS + 1_000);
    const r = init.handleGovernorInit({ projectId: "p" });
    expect(r.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: conv.holderKey, reason: "offrail_orphan" });
  });

  it("D4 stamp: convertToOffRail writes a conversion timestamp; the grace is an exported positive number", () => {
    expect(typeof lease.OFFRAIL_CONVERSION_GRACE_MS).toBe("number");
    expect(lease.OFFRAIL_CONVERSION_GRACE_MS).toBeGreaterThan(0);
    const before = Date.now();
    const anon = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: null, problemId: "x" });
    const rec = leaseRecords().find((r) => r.holderKey === anon.holderKey);
    expect(typeof rec.offRailConvertedAt).toBe("number");
    expect(rec.offRailConvertedAt).toBeGreaterThanOrEqual(before);
    lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" });
    const s = init.handleGovernorInit({ projectId: "p" });
    const conv = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: s.token, problemId: "x" });
    expect(conv.converted).toBe(true);
    expect(typeof leaseRecords().find((r) => r.holderKey === conv.holderKey).offRailConvertedAt).toBe("number");
  });

  it("AC20 store parity: the guardrails handlers use the governor-token session root, not loadContext's root", async () => {
    expect(h.loadRoot.value).not.toBe(dir);
    const call = await governance();
    await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: "backlog.feat.parity" });
    expect(leaseRecords(dir)).toHaveLength(1);
    expect(leaseRecords(otherRoot)).toEqual([]);
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    expect(tok.getSessionProjectRoot()).toBe(dir);
  });
});

describe("project lease: an executing holder stays live across processes (backlog.fix.project-lease-executing-holder-and-offrail-retry D1)", () => {
  const recordPath = (token) => path.join(dir, ".rks", "session", "governor", `${token}.json`);
  const rewriteRecord = (token, patch) => {
    const p = recordPath(token);
    const rec = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.writeFileSync(p, JSON.stringify({ ...rec, ...patch }, null, 2));
  };
  const expiredFor = (holderKey) => events("lease.released").filter((e) => e.holderKey === holderKey && e.reason === "expired");

  it.each(["qa", "ops"])("D1 live: a persisted executing story holder is live to a fresh instance; a peer %s init is refused and nothing is reclaimed", async (flowType) => {
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec" });
    expect(story.ok).toBe(true);
    rewriteRecord(story.token, { state: "executing", lastActivity: Date.now() });
    await boot();
    const r = init.handleGovernorInit(initArgs(flowType));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("project_leased");
    expect(r.holder.holderKey).toBe(`session:${story.token}`);
    expect(leaseRecords().map((x) => x.holderKey)).toContain(`session:${story.token}`);
    expect(expiredFor(`session:${story.token}`)).toEqual([]);
  });

  it("D1 refreshed stamp: an executing record with stale own activity is live while the lease's refreshed stamp is within LEASE_MAX_AGE_MS", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec" });
    vi.setSystemTime(t0 + MAX_AGE_MS - 60_000);
    tok.touchSession(story.token);
    expect(leaseRecords().find((x) => x.holderKey === `session:${story.token}`).sessions[story.token].lastActivity).toBe(t0 + MAX_AGE_MS - 60_000);
    rewriteRecord(story.token, { state: "executing", lastActivity: t0, createdAt: t0 });
    vi.setSystemTime(t0 + MAX_AGE_MS + 60_000); // record activity 31 min old, lease stamp 2 min old
    await boot();
    const r = init.handleGovernorInit(initArgs("qa"));
    expect(r.reason).toBe("project_leased");
    expect(r.holder.holderKey).toBe(`session:${story.token}`);
    expect(expiredFor(`session:${story.token}`)).toEqual([]);
  });

  it("D1 expiry: past LEASE_MAX_AGE_MS beyond both the lease stamp and the executing record's activity, the holder is reclaimed (expired)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec" });
    rewriteRecord(story.token, { state: "executing", lastActivity: t0 });
    vi.setSystemTime(t0 + MAX_AGE_MS + 60_000);
    await boot();
    const r = init.handleGovernorInit(initArgs("qa"));
    expect(r.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${story.token}`, reason: "expired" });
  });

  it("D1 terminal no regression: an ops holder rewritten to 'done' is reclaimed by a peer within LEASE_MAX_AGE_MS", async () => {
    const ops = init.handleGovernorInit(initArgs("ops"));
    expect(ops.ok).toBe(true);
    rewriteRecord(ops.token, { state: "done", lastActivity: Date.now() });
    await boot();
    const r = init.handleGovernorInit(initArgs("qa"));
    expect(r.ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${ops.token}`, reason: "expired" });
  });

  it("D1 loadPersistedSession no release: validateToken rejects a fresh executing record but keeps the file and the holder", async () => {
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec" });
    rewriteRecord(story.token, { state: "executing", lastActivity: Date.now() });
    await boot();
    expect(tok.validateToken(story.token)).toBe(false);
    expect(fs.existsSync(recordPath(story.token))).toBe(true);
    const holder = leaseRecords().find((x) => x.holderKey === `session:${story.token}`);
    expect(holder).toBeTruthy();
    expect(Object.keys(holder.sessions)).toContain(story.token);
    expect(expiredFor(`session:${story.token}`)).toEqual([]);
  });

  it("D1 executing past MAX_AGE_MS still released: validateToken removes the record and releases the lease (expired)", async () => {
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec" });
    const old = Date.now() - MAX_AGE_MS - 60_000;
    rewriteRecord(story.token, { state: "executing", lastActivity: old, createdAt: old });
    await boot();
    expect(tok.validateToken(story.token)).toBe(false);
    expect(fs.existsSync(recordPath(story.token))).toBe(false);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${story.token}`, reason: "expired" });
  });
});

describe("project lease: a retried rks_guardrails_off keeps the off-rail lease (backlog.fix.project-lease-executing-holder-and-offrail-retry D2)", () => {
  const P1 = "backlog.feat.offrail-p1";
  const P2 = "backlog.feat.offrail-p2";

  async function offRailHolder() {
    const call = await governance();
    const story = init.handleGovernorInit({ projectId: "p", problemId: P1 });
    expect(story.ok).toBe(true);
    const first = parse(await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: P1 }, { governorToken: story.token }));
    expect(first.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, ".routekit", "hooks.bak"))).toBe(true);
    const key = `session:${story.token}`;
    expect(leaseRecords().find((x) => x.holderKey === key)).toMatchObject({ offRail: true, offRailProblemId: P1 });
    emitSpy.mockClear();
    return { call, story, key };
  }
  const failedFor = (key) => events("lease.released").filter((e) => e.holderKey === key && e.reason === "guardrails_off_failed");

  it("D2 retry non-ok / no release: a second guardrails_off returning 'Guardrails already off' leaves the holder off-rail with its problemId, and peers stay refused", async () => {
    const { call, story, key } = await offRailHolder();
    h.guardrailsOff.mockImplementationOnce(async () => ({ ok: false, message: "Guardrails already off (scope=all)" }));
    const res = parse(await call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: P2 }, { governorToken: story.token }));
    expect(res).toEqual({ ok: false, message: "Guardrails already off (scope=all)" });
    expect(leaseRecords().find((x) => x.holderKey === key)).toMatchObject({ offRail: true, offRailProblemId: P1 });
    expect(failedFor(key)).toEqual([]);
    await boot();
    expect(init.handleGovernorInit(initArgs("qa")).reason).toBe("project_leased");
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
  });

  it("D2 retry throwing: the error is re-thrown and the holder stays off-rail with its problemId, no guardrails_off_failed", async () => {
    const { call, story, key } = await offRailHolder();
    const boom = new Error("boom");
    h.guardrailsOff.mockImplementationOnce(async () => { throw boom; });
    await expect(call("rks_guardrails_off", { projectId: "p", reason: "r", problemId: P2 }, { governorToken: story.token })).rejects.toBe(boom);
    expect(leaseRecords().find((x) => x.holderKey === key)).toMatchObject({ offRail: true, offRailProblemId: P1 });
    expect(failedFor(key)).toEqual([]);
  });

  it("D2 convertToOffRail result: an already-off-rail holder is reported with its prior state; a first conversion is not", () => {
    const s = init.handleGovernorInit({ projectId: "p", problemId: P1 });
    const first = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: s.token, problemId: P1 });
    expect(first).toMatchObject({ ok: true, converted: true, created: false });
    expect(first.alreadyOffRail).not.toBe(true);
    offRailEvidence(); // guardrails are off: hooks in hooks.bak (otherwise the holder reads as an orphan)
    const again = lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: s.token, problemId: P2 });
    expect(again).toMatchObject({ ok: true, converted: true, created: false, alreadyOffRail: true, prior: { offRail: true, offRailProblemId: P1 } });
    // revertOffRail with that prior restores, never clears, and releases nothing.
    emitSpy.mockClear();
    const back = lease.revertOffRail({ projectRoot: dir, projectId: "p", holderKey: again.holderKey, created: false, prior: again.prior });
    expect(back).toMatchObject({ reverted: false, restored: true });
    expect(leaseRecords().find((x) => x.holderKey === again.holderKey)).toMatchObject({ offRail: true, offRailProblemId: P1 });
    expect(events("lease.released")).toEqual([]);
  });
});

describe("project lease: re-verification on use (backlog.fix.project-lease-post-init-verification-and-conversion-window D3)", () => {
  const acquiredFor = (holderKey) => events("lease.acquired").filter((e) => e.holderKey === holderKey);

  it("D3 lost-holder distinctness: a reclaimed holder reads lost; a never-held token and deliberate releases read differently", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // lost: held, then reclaimed (expired) by a peer acquire.
    const lostTok = init.handleGovernorInit({ projectId: "p" }).token;
    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).ok).toBe(true);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${lostTok}`, reason: "expired" });
    const lost = lease.checkLease({ projectRoot: dir, token: lostTok });
    expect(lost.status).toBe("lost");

    // never held: a createSession-direct token.
    const never = lease.checkLease({ projectRoot: dir, token: tok.createSession({ projectId: "q" }).token });
    // deliberate: releaseLease (endSession), releaseOffRail and revertOffRail with created.
    const ended = init.handleGovernorInit({ projectId: "q" }).token;
    tok.endSession(ended);
    const viaEnd = lease.checkLease({ projectRoot: dir, token: ended });
    const off = init.handleGovernorInit({ projectId: "r" }).token;
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: "r", token: off }).converted).toBe(true);
    lease.releaseOffRail({ projectRoot: dir, projectId: "r", reason: "guardrails_on" });
    const viaOffRail = lease.checkLease({ projectRoot: dir, token: off });
    const created = lease.convertToOffRail({ projectRoot: dir, projectId: "r", token: off });
    expect(created.created).toBe(true);
    lease.revertOffRail({ projectRoot: dir, projectId: "r", holderKey: created.holderKey, created: true });
    const viaRevert = lease.checkLease({ projectRoot: dir, token: off });

    for (const [label, other] of [["never held", never], ["releaseLease", viaEnd], ["releaseOffRail", viaOffRail], ["revertOffRail created", viaRevert]]) {
      expect(other.status, label).not.toBe(lost.status);
      expect(other, label).not.toEqual(lost);
    }
    // The dispatch-facing helper agrees: only the lost token is refused while the qa peer is live.
    expect(tok.verifySessionLease(lostTok)).toMatchObject({ ok: false, reason: lease.LEASE_LOST });
    expect(tok.verifySessionLease(ended)).toBeNull();
    expect(tok.verifySessionLease(off)).toBeNull();
  });

  it("D3 no-op path (AC4): a session with a live holder record is admitted unchanged with no lease.acquired and no write", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    emitSpy.mockClear();
    const before = JSON.stringify(leaseRecords());
    vi.setSystemTime(Date.now() + 2 * lease.LEASE_REFRESH_INTERVAL_MS);
    expect(tok.verifySessionLease(a.token)).toBeNull();
    expect(lease.verifyLease({ projectRoot: dir, token: a.token })).toMatchObject({ ok: true, status: "held", holderKey: `session:${a.token}` });
    expect(JSON.stringify(leaseRecords())).toBe(before);
    expect(events("lease.acquired")).toEqual([]);
  });

  it("D3 scope: a createSession-direct token and a memory-store session keep current behaviour", () => {
    // createSession-direct (never held a lease), rooted.
    const direct = tok.createSession({ projectId: "p" });
    expect(() => tok.touchSession(direct.token)).not.toThrow();
    expect(lease.refreshLease({ projectRoot: dir, token: direct.token })).toMatchObject({ refreshed: false, holderKey: null });
    expect(tok.verifySessionLease(direct.token)).toBeNull();
    expect(leaseRecords()).toEqual([]);

    // memory store: no project root.
    tok.setProjectRoot(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const memDirect = tok.createSession({ projectId: "p" });
      expect(() => tok.touchSession(memDirect.token)).not.toThrow();
      expect(lease.refreshLease({ projectRoot: null, token: memDirect.token })).toMatchObject({ refreshed: false, holderKey: null });
      expect(tok.verifySessionLease(memDirect.token)).toBeNull();
      const memHeld = init.handleGovernorInit({ projectId: "p" });
      expect(memHeld.lease.store).toBe("memory");
      emitSpy.mockClear();
      expect(tok.verifySessionLease(memHeld.token)).toBeNull();
      expect(events("lease.acquired")).toEqual([]);
    } finally {
      errSpy.mockRestore();
      tok.setProjectRoot(dir);
    }
    expect(leaseRecords()).toEqual([]);
  });

  it("D3 off-rail unaffected: a converted off-rail holder aged past LEASE_MAX_AGE_MS is neither re-acquired nor refused; peers stay refused", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.offrail-aged" });
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: s.token, problemId: "x" }).converted).toBe(true);
    offRailEvidence();
    vi.setSystemTime(Date.now() + MAX_AGE_MS + 60_000);
    emitSpy.mockClear();
    const before = JSON.stringify(leaseRecords());
    expect(tok.verifySessionLease(s.token)).toBeNull();
    expect(JSON.stringify(leaseRecords())).toBe(before);
    expect(events("lease.acquired")).toEqual([]);
    const peer = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(peer.reason).toBe("project_leased");
    expect(peer.holder.offRail).toBe(true);
  });

  it("D3 executing holder not lost: a holder record on disk whose session record is executing-only is held, not lost", async () => {
    const story = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.lease-exec-d3" });
    // Same instance: the in-memory session is executing.
    tok.getSession(story.token).state = "executing";
    emitSpy.mockClear();
    expect(tok.verifySessionLease(story.token)).toBeNull();
    expect(events("lease.acquired")).toEqual([]);
    // Fresh instance: the persisted record is executing-only (validateToken would not rehydrate it).
    const p = path.join(dir, ".rks", "session", "governor", `${story.token}.json`);
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), state: "executing", lastActivity: Date.now() }, null, 2));
    await boot();
    expect(lease.checkLease({ projectRoot: dir, token: story.token }).status).toBe("held");
    expect(lease.verifyLease({ projectRoot: dir, token: story.token })).toMatchObject({ ok: true, status: "held" });
    expect(tok.verifySessionLease(story.token)).toBeNull();
    expect(acquiredFor(`session:${story.token}`)).toEqual([]);
    expect(leaseRecords().map((r) => r.holderKey)).toEqual([`session:${story.token}`]);
  });
});

describe("project lease: no project root (memory store, R9)", () => {
  it("AC20: rootless acquisitions are enforced in-process, volunteer the degradation, and log it once", () => {
    tok.setProjectRoot(null);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = init.handleGovernorInit({ projectId: "p" });
      const b = init.handleGovernorInit({ projectId: "p" });
      expect(a.lease).toEqual({ mode: "shared", holderKey: `session:${a.token}`, store: "memory", degraded: "no_project_root" });
      expect(b.lease.store).toBe("memory");
      const refused = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
      expect(refused.reason).toBe("project_leased");
      expect(refused.lease).toEqual(MEMORY);
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes("no_project_root"))).toHaveLength(1);
      expect(events("lease.acquired").every((p) => p.store === "memory")).toBe(true);
      expect(events("lease.refused").map((p) => p.store)).toEqual(["memory"]);

      // A memory-held holder still blocks after a root is set (union of stores).
      tok.setProjectRoot(dir);
      expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).reason).toBe("project_leased");
      const rooted = init.handleGovernorInit({ projectId: "q" });
      expect(rooted.lease.store).toBe("disk");
      expect(rooted.lease).not.toHaveProperty("degraded");
      expect(events("lease.acquired").at(-1).store).toBe("disk");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("AC20: every exported operation result carries store matching the store it used", () => {
    for (const root of [dir, null]) {
      const store = root ? "disk" : "memory";
      const pid = `ops-${store}`;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const acq = lease.acquireLease({ projectRoot: root, projectId: pid, flowType: "open", token: `t-${store}`, runId: null });
        expect(acq.store).toBe(store);
        expect(lease.refreshLease({ projectRoot: root, token: `t-${store}` }).store).toBe(store);
        expect(lease.releaseLease({ projectRoot: root, token: `t-${store}` }).store).toBe(store);
        const conv = lease.convertToOffRail({ projectRoot: root, projectId: pid, token: null, problemId: "x" });
        expect(conv.store).toBe(store);
        expect(lease.revertOffRail({ projectRoot: root, projectId: pid, holderKey: conv.holderKey, created: true }).store).toBe(store);
        lease.convertToOffRail({ projectRoot: root, projectId: pid, token: null, problemId: "x" });
        expect(lease.releaseOffRail({ projectRoot: root, projectId: pid, reason: "guardrails_on" }).store).toBe(store);
      } finally {
        errSpy.mockRestore();
      }
    }
  });
});

describe("project lease: attribution (AC14, AC24 server half)", () => {
  it("AC14: actor/via inputs, env precedence, via default and client; persisted, echoed and in the governor.init payload", () => {
    const a = init.handleGovernorInit({ projectId: "p", actor: "alice", via: "ide" }, { clientName: "claude-code" });
    expect(a).toMatchObject({ actor: "alice", via: "ide", client: "claude-code", runId: null });
    expect(a.lease).toEqual({ mode: "shared", holderKey: `session:${a.token}`, store: "disk" });
    const rec = JSON.parse(fs.readFileSync(path.join(dir, ".rks", "session", "governor", `${a.token}.json`), "utf8"));
    expect(rec).toMatchObject({ actor: "alice", via: "ide", client: "claude-code", runId: null });

    const d = init.handleGovernorInit({ projectId: "p" });
    expect(d).toMatchObject({ actor: null, via: "mcp", client: null });

    process.env.RKS_ACTOR = "bob";
    process.env.RKS_VIA = "dispatch";
    process.env.RKS_DISPATCH_RUN_ID = "run-attr";
    const e = init.handleGovernorInit({ projectId: "q", actor: "alice", via: "ide" });
    expect(e).toMatchObject({ actor: "bob", via: "dispatch", runId: "run-attr" });
    expect(e.lease.holderKey).toBe("run:run-attr");
    const erec = JSON.parse(fs.readFileSync(path.join(dir, ".rks", "session", "governor", `${e.token}.json`), "utf8"));
    expect(erec).toMatchObject({ actor: "bob", via: "dispatch", runId: "run-attr" });
    process.env.RKS_VIA = "not-a-lane";
    expect(init.handleGovernorInit({ projectId: "q", via: "call" }).via).toBe("call");

    // governor.init payload carries the attribution (source: the emit spreads it after the three ids).
    const src = fs.readFileSync(TOKEN_PATH, "utf8");
    const at = src.indexOf('"governor.init"');
    expect(src.slice(at, at + 300)).toMatch(/projectId, flowType, sessionId: token, \.\.\.initAttribution/);
    expect(src).toMatch(/const initAttribution = \{ actor: session\.actor, via: session\.via, client: session\.client, runId: session\.runId, leaseMode: lease\?\.mode \?\? null, holderKey: lease\?\.holderKey \?\? null \};/);
  });

  it("AC14: an invalid via is rejected by INPUT_SCHEMA and by governorInitSchema", async () => {
    expect(init.INPUT_SCHEMA.properties.via.enum).toEqual(["ide", "dispatch", "call", "mcp"]);
    expect(init.INPUT_SCHEMA.properties.actor.type).toBe("string");
    const { TOOL_ARG_SCHEMAS } = await import(SERVER_PATH);
    const schema = TOOL_ARG_SCHEMAS.rks_governor_init;
    expect(schema.safeParse({ projectId: "p", via: "bogus" }).success).toBe(false);
    expect(schema.parse({ projectId: "p", via: "call", actor: "x" })).toMatchObject({ via: "call", actor: "x" });
  });

  it("AC24 server half: with RKS_VIA=call the session records and echoes via call whatever the input says", () => {
    process.env.RKS_VIA = "call";
    for (const input of [{ projectId: "p", via: "mcp" }, { projectId: "p" }]) {
      const r = init.handleGovernorInit(input);
      expect(r.via).toBe("call");
      const rec = JSON.parse(fs.readFileSync(path.join(dir, ".rks", "session", "governor", `${r.token}.json`), "utf8"));
      expect(rec.via).toBe("call");
    }
  });
});

describe("project lease: RKS_VIA_DEFAULT fallback (backlog.feat.server-lane-policy AC1)", () => {
  it("only RKS_VIA_DEFAULT=ide set and input via mcp resolves via ide", () => {
    process.env.RKS_VIA_DEFAULT = "ide";
    expect(lease.resolveAttribution({ via: "mcp" }).via).toBe("ide");
    expect(lease.resolveAttribution({}).via).toBe("ide");
  });

  it("RKS_VIA=dispatch and RKS_VIA_DEFAULT=ide both set resolves via dispatch", () => {
    process.env.RKS_VIA = "dispatch";
    process.env.RKS_VIA_DEFAULT = "ide";
    expect(lease.resolveAttribution({ via: "call" }).via).toBe("dispatch");
    expect(init.handleGovernorInit({ projectId: "p" }).via).toBe("dispatch");
  });

  it("an RKS_VIA_DEFAULT value outside VALID_VIA is ignored: input via, then mcp", () => {
    process.env.RKS_VIA_DEFAULT = "not-a-lane";
    expect(lease.resolveAttribution({ via: "call" }).via).toBe("call");
    expect(lease.resolveAttribution({}).via).toBe("mcp");
  });

  it("an invalid RKS_VIA falls through to a valid RKS_VIA_DEFAULT", () => {
    process.env.RKS_VIA = "not-a-lane";
    process.env.RKS_VIA_DEFAULT = "ide";
    expect(lease.resolveAttribution({ via: "call" }).via).toBe("ide");
  });
});

describe("project lease: the rks_agent_research bootstrap (AC13)", () => {
  it("server.mjs acquires a shared lease before the bootstrap createSession and returns a refusal instead of swallowing it", () => {
    const src = fs.readFileSync(SERVER_PATH, "utf8");
    const start = src.indexOf("Self-bootstrap: rks_agent_research");
    const end = src.indexOf("Ensure project root is set for session persistence", start);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end);
    const acquireAt = block.indexOf("acquireLease(");
    const createAt = block.indexOf("createSession(");
    expect(acquireAt).toBeGreaterThan(-1);
    expect(acquireAt).toBeLessThan(createAt);
    expect(block.slice(acquireAt, createAt)).toMatch(/flowType: 'open'/);
    const catchAt = block.indexOf("fail-open");
    const after = block.slice(catchAt);
    expect(after).toMatch(/if \(_bootLease && !_bootLease\.ok\)/);
    expect(after).toMatch(/return \{ content: \[\{ type: "text", text: JSON\.stringify\(_bootRefusal, null, 2\) \}\], isError: true \};/);
  });

  it("a shared acquisition is refused by a live exclusive holder", () => {
    expect(lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "story", token: "ex", runId: null }).ok).toBe(true);
    const r = lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "open", token: "boot", runId: null });
    expect(r).toMatchObject({ ok: false, reason: "project_leased", store: "disk" });
  });
});

describe("project lease: sequential release through endSession / rks_governor_end (AC21, §4a Carrier)", () => {
  it.each(EXCLUSIVE)("AC21 (a): open ended, then a %s init succeeds with no clock advance", (flowType) => {
    const open = init.handleGovernorInit({ projectId: "p" });
    const rel = tok.endSession(open.token);
    expect(rel).toEqual({ released: true, holderKey: `session:${open.token}`, store: "disk" });
    expect(init.handleGovernorInit(initArgs(flowType)).ok).toBe(true);
  });

  it("AC21 (b)(c): an ended ops or qa session admits a following open init", () => {
    for (const flowType of ["ops", "qa"]) {
      const s = init.handleGovernorInit(initArgs(flowType));
      tok.endSession(s.token);
      const o = init.handleGovernorInit({ projectId: "p" });
      expect(o.ok, flowType).toBe(true);
      tok.endSession(o.token);
    }
  });

  it("AC21 (d)-(g) and the endSession return value", () => {
    process.env.RKS_DISPATCH_RUN_ID = "run-d";
    const r1 = init.handleGovernorInit({ projectId: "p", problemId: "backlog.feat.d" });
    const r2 = init.handleGovernorInit({ projectId: "p" });
    expect(tok.endSession(r2.token)).toEqual({ released: false, holderKey: "run:run-d", remaining: "run_sessions", store: "disk" });
    expect(tok.endSession(r1.token)).toEqual({ released: true, holderKey: "run:run-d", store: "disk" });
    delete process.env.RKS_DISPATCH_RUN_ID;

    const off = init.handleGovernorInit({ projectId: "p" });
    expect(lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: off.token, problemId: "x" }).converted).toBe(true);
    offRailEvidence();
    expect(tok.endSession(off.token)).toEqual({ released: false, holderKey: `session:${off.token}`, remaining: "offrail", store: "disk" });
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" }).reason).toBe("project_leased");
    lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" });

    const direct = tok.createSession({ projectId: "p" });
    expect(tok.endSession(direct.token)).toBeNull();
    expect(tok.endSession("00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(leaseRecords()).toEqual([]);
  });

  it("Carrier: each ended:true lease equals endSession's own return; releaseLease runs exactly once per end", async () => {
    vi.resetModules();
    vi.doMock(TOKEN_PATH, async (io) => {
      const real = await io();
      return { ...real, endSession: vi.fn((...a) => real.endSession(...a)) };
    });
    vi.doMock(LEASE_PATH, async (io) => {
      const real = await io();
      return { ...real, releaseLease: vi.fn((...a) => real.releaseLease(...a)) };
    });
    tok = await import(TOKEN_PATH);
    init = await import(INIT_PATH);
    lease = await import(LEASE_PATH);
    emitSpy = vi.spyOn(lease.leaseTelemetry, "emit");
    tok.setProjectRoot(dir);
    const { handleGovernorEnd } = await import(END_PATH);
    const endOnce = (token) => {
      const releasesBefore = lease.releaseLease.mock.calls.length;
      const endsBefore = tok.endSession.mock.calls.length;
      const res = handleGovernorEnd({ projectId: "p" }, token);
      expect(res.ended).toBe(true);
      expect(tok.endSession.mock.calls.length - endsBefore).toBe(1);
      expect(res.lease).toEqual(tok.endSession.mock.results.at(-1).value);
      return { res, releases: lease.releaseLease.mock.calls.length - releasesBefore };
    };

    // (i) released
    const a = init.handleGovernorInit({ projectId: "p" });
    const i = endOnce(a.token);
    expect(i.res.lease).toEqual({ released: true, holderKey: `session:${a.token}`, store: "disk" });
    expect(i.releases).toBe(1);
    expect(events("lease.released")).toContainEqual({ projectId: "p", holderKey: `session:${a.token}`, reason: "session_end" });

    // (ii) run with a second live session
    process.env.RKS_DISPATCH_RUN_ID = "run-c";
    const b1 = init.handleGovernorInit({ projectId: "p" });
    const b2 = init.handleGovernorInit({ projectId: "p" });
    const ii = endOnce(b1.token);
    expect(ii.res.lease).toEqual({ released: false, holderKey: "run:run-c", remaining: "run_sessions", store: "disk" });
    expect(ii.releases).toBe(1);
    expect(Object.keys(leaseRecords()[0].sessions)).toEqual([b2.token]);
    endOnce(b2.token);
    delete process.env.RKS_DISPATCH_RUN_ID;

    // (iii) converted off-rail
    const c = init.handleGovernorInit({ projectId: "p" });
    lease.convertToOffRail({ projectRoot: dir, projectId: "p", token: c.token, problemId: "x" });
    offRailEvidence();
    const iii = endOnce(c.token);
    expect(iii.res.lease).toEqual({ released: false, holderKey: `session:${c.token}`, remaining: "offrail", store: "disk" });
    expect(iii.releases).toBe(1);
    lease.releaseOffRail({ projectRoot: dir, projectId: "p", reason: "guardrails_on" });

    // (iv) createSession-direct token: no lease
    const d = tok.createSession({ projectId: "p" });
    const iv = endOnce(d.token);
    expect(iv.res.lease).toBeNull();
    expect(iv.res).toHaveProperty("lease", null);
  });

  it("no lease key on any non-ended outcome", async () => {
    const { handleGovernorEnd } = await import(END_PATH);
    expect(handleGovernorEnd({ projectId: "p" }, undefined)).not.toHaveProperty("lease");
    expect(handleGovernorEnd({ projectId: "p" }, "00000000-0000-4000-8000-000000000000")).not.toHaveProperty("lease");
    const twice = init.handleGovernorInit({ projectId: "p" });
    expect(handleGovernorEnd({ projectId: "p" }, twice.token).ended).toBe(true);
    const second = handleGovernorEnd({ projectId: "p" }, twice.token);
    expect(second.reason).toBe("session_not_live");
    expect(second).not.toHaveProperty("lease");
    const s = init.handleGovernorInit({ projectId: "p" });
    const mismatch = handleGovernorEnd({ projectId: "other" }, s.token);
    expect(mismatch.reason).toBe("project_mismatch");
    expect(mismatch).not.toHaveProperty("lease");
    tok.setGuardrailsDisabled(s.token, true);
    const blockedG = handleGovernorEnd({ projectId: "p" }, s.token);
    expect(blockedG.reason).toBe("end_blocked");
    expect(blockedG).not.toHaveProperty("lease");
    tok.setGuardrailsDisabled(s.token, false);
    tok.setPendingStash(s.token, async () => {});
    const blockedS = handleGovernorEnd({ projectId: "p" }, s.token);
    expect(blockedS.reason).toBe("end_blocked");
    expect(blockedS).not.toHaveProperty("lease");
    tok.clearPendingStash(s.token);

    // end_not_observed: an injected endSession that leaves the session in place.
    vi.resetModules();
    vi.doMock(TOKEN_PATH, async (io) => ({ ...(await io()), endSession: () => null }));
    const tok2 = await import(TOKEN_PATH);
    tok2.setProjectRoot(dir);
    const end2 = await import(END_PATH);
    const live = tok2.createSession({ projectId: "p" });
    const notObserved = end2.handleGovernorEnd({ projectId: "p" }, live.token);
    expect(notObserved.reason).toBe("end_not_observed");
    expect(notObserved).not.toHaveProperty("lease");
    tok2.resetToken();
  });

  it("governance passthrough: the rks_governor_end handler returns handleGovernorEnd's result unchanged and never touches releaseLease", async () => {
    for (const sentinel of [
      { ok: true, ended: true, flowType: "open", state: "init", lease: { released: false, holderKey: "run:s", remaining: "run_sessions", store: "memory" } },
      { ok: true, ended: false, reason: "session_not_live" },
    ]) {
      vi.resetModules();
      vi.doMock(END_PATH, async (io) => ({ ...(await io()), handleGovernorEnd: () => sentinel }));
      const call = await governance();
      const out = parse(await call("rks_governor_end", { projectId: "p" }, { governorToken: "t" }));
      expect(out).toEqual(sentinel);
      if (!("lease" in sentinel)) expect(out).not.toHaveProperty("lease");
      vi.doUnmock(END_PATH);
    }
    expect(fs.readFileSync(GOV_PATH, "utf8")).not.toMatch(/\breleaseLease\b/);
  });

  it("governor-token export surface: endSession stays in place and no top-level export function is added", () => {
    const src = fs.readFileSync(TOKEN_PATH, "utf8");
    expect(src).toContain("export function endSession(token)");
    const names = [...src.matchAll(/^export function ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    // Measured on HEAD f11f6c322 before this story's edit.
    expect(names).toEqual([
      "setProjectRoot", "generateToken", "setToken", "getToken", "validateToken", "resetToken", "createSession", "getSession",
      "endSession", "setGuardrailsDisabled", "restoreGuardrails", "detectOrphanedGuardrails", "touchSession", "checkAllowedTool",
      "advanceState", "revertStateOnFailure", "advanceStateOnResult", "isSessionTerminal", "setPendingStash", "clearPendingStash",
      "setChildQueue", "getActiveChild", "updateChildState", "advanceToNextChild", "getChildSummary", "unauthorizedResponse",
      "requireToken", "isProtectedTool", "assertToolAllowed",
    ]);
    expect(src).toMatch(/^export \{[^}]*\bgetSessionProjectRoot\b[^}]*\};$/m);
  });
});

// ── backlog.feat.remote-surface-lane: the shorter remote idle window ─────────────────────────────
// Every case runs against the per-test mkdtemp root (`dir`); RKS_VIA is set per init and cleared by
// the shared beforeEach/afterEach. Time is advanced with fake Date only.
describe("remote idle window (backlog.feat.remote-surface-lane)", () => {
  const PAST_REMOTE = () => lease.REMOTE_IDLE_MS + 60_000; // 11 minutes: past remote, inside 30

  const openInit = (via) => {
    if (via === undefined) delete process.env.RKS_VIA; else process.env.RKS_VIA = via;
    const r = init.handleGovernorInit({ projectId: "p" });
    delete process.env.RKS_VIA;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(tok.getSession(r.token)?.via).toBe(via ?? "mcp");
    return r;
  };

  it("project-lease exports REMOTE_IDLE_MS = 10 minutes, smaller than LEASE_MAX_AGE_MS", () => {
    expect(lease.REMOTE_IDLE_MS).toBe(10 * 60 * 1000);
    expect(lease.REMOTE_IDLE_MS).toBeLessThan(lease.LEASE_MAX_AGE_MS);
    expect(lease.VALID_VIA.has("remote")).toBe(true);
  });

  describe("lease holders", () => {
    it("probe installed: a remote holder idle past REMOTE_IDLE_MS is not live, so an exclusive init succeeds", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const a = openInit("remote");
      expect(leaseRecords().find((r) => r.holderKey === `session:${a.token}`)?.via).toBe("remote");
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      const r = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });

    it("probe installed: a non-remote holder at the same idle time still refuses the exclusive init", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      openInit("ide");
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      const r = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("project_leased");
    });

    it.each([["remote", true], ["ide", false]])("probe throwing (the stamp decides): via %s holder idle 11 minutes -> exclusive acquire ok=%s", (via, ok) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      lease.setSessionLivenessProbe(() => { throw new Error("probe unavailable"); });
      const held = lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "open", token: `holder-${via}`, via });
      expect(held.ok).toBe(true);
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      const r = lease.acquireLease({ projectRoot: dir, projectId: "p", flowType: "qa", problemId: "s", token: `excl-${via}`, via: "ide" });
      expect(r.ok, JSON.stringify(r)).toBe(ok);
      if (!ok) expect(r.reason).toBe("project_leased");
    });
  });

  describe("governor sessions (validateToken)", () => {
    it("in-memory (Map path): a remote session idle past REMOTE_IDLE_MS fails validateToken and requireToken; a non-remote one validates", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const remoteA = openInit("remote");
      const ideA = openInit("ide");
      openInit("ide"); // a later session, so neither A is the legacy _activeToken
      expect(tok.getToken()).not.toBe(remoteA.token);
      expect(tok.getToken()).not.toBe(ideA.token);
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      expect(tok.validateToken(remoteA.token)).toBe(false);
      expect(tok.requireToken(remoteA.token, "dendron_read_note")).not.toBeNull();
      expect(tok.validateToken(ideA.token)).toBe(true);
      expect(tok.requireToken(ideA.token, "dendron_read_note")).toBeNull();
    });

    it("legacy _activeToken path: a remote session idle past REMOTE_IDLE_MS fails even as the most recently created session", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const remoteA = openInit("remote");
      expect(tok.getToken()).toBe(remoteA.token);
      expect(tok.validateToken(remoteA.token)).toBe(true); // positive control before the idle window
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      expect(tok.getToken()).toBe(remoteA.token);
      expect(tok.validateToken(remoteA.token)).toBe(false);
    });

    it("persisted rehydration: an idle remote record is not rehydrated; a non-remote record at the same idle time is", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const remoteA = openInit("remote");
      const ideA = openInit("ide");
      vi.setSystemTime(Date.now() + PAST_REMOTE());
      await boot(); // fresh module instance: in-memory sessions cleared, records on disk under dir
      const recPath = (t) => path.join(dir, ".rks", "session", "governor", `${t}.json`);
      // Non-vacuity: both records are on disk, and the remote one is recorded via remote.
      expect(JSON.parse(fs.readFileSync(recPath(remoteA.token), "utf8")).via).toBe("remote");
      expect(fs.existsSync(recPath(ideA.token))).toBe(true);
      expect(tok.getSession(remoteA.token)).toBeNull();
      expect(tok.getSession(ideA.token)).toBeNull();
      expect(tok.validateToken(remoteA.token)).toBe(false);
      expect(tok.getSession(remoteA.token)).toBeNull();
      expect(tok.validateToken(ideA.token)).toBe(true);
      expect(tok.getSession(ideA.token)?.via).toBe("ide");
    });
  });
});
