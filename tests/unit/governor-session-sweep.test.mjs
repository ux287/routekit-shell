/**
 * backlog.fix.governor-session-records-never-swept
 *
 * Fail-closed sweep of dead governor session records under
 * <root>/.rks/session/governor. Every case runs against an os.tmpdir() root set with
 * setProjectRoot(); the prior root is restored in afterEach so the real repository's
 * .rks/session/ is never written or deleted. No vi.resetModules: governor-token.mjs is
 * over 1000 LOC (unit-tier-purity).
 *
 * Names below (sweepDeadSessionRecords, isProvablyDeadRecord, leaseListedTokens,
 * SESSION_SWEEP_THRESHOLD_MS, SESSION_SWEEP_MAX_REMOVALS) are the ones fixed in ARCH Guidance.
 * The governor-init throw case uses the spread vi.mock of governor-token.mjs described in
 * ARCH Guidance (static imports only); the unlink-failure case uses
 * vi.spyOn(fs, "unlinkSync") throwing EACCES for one path, never a read-only directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setProjectRoot,
  getSessionProjectRoot,
  resetToken,
  setToken,
  createSession,
  sweepDeadSessionRecords,
  isProvablyDeadRecord,
  SESSION_SWEEP_THRESHOLD_MS,
  SESSION_SWEEP_MAX_REMOVALS,
} from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { leaseListedTokens, acquireLease, getLeaseDir } from "../../packages/mcp-rks/src/shared/project-lease.mjs";
import { clearGuardState } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";

vi.mock("../../packages/mcp-rks/src/shared/governor-token.mjs", async (io) => {
  const real = await io();
  return { ...real, sweepDeadSessionRecords: vi.fn(real.sweepDeadSessionRecords) };
});

const MAX_AGE_MS = 30 * 60 * 1000;

let root;
let priorRoot;

const sessionDir = () => path.join(root, ".rks", "session", "governor");
const auditPath = () => path.join(root, ".rks", "session", "governor-sweep.jsonl");
const recordPath = (token) => path.join(sessionDir(), `${token}.json`);
const leaseDir = () => getLeaseDir(root);

function seed(token, fields = {}) {
  fs.mkdirSync(sessionDir(), { recursive: true });
  const now = Date.now();
  const rec = { token, projectId: "p", flowType: "story", state: "init", problemId: "story-A", createdAt: now, lastActivity: now, ...fields };
  fs.writeFileSync(recordPath(token), JSON.stringify(rec, null, 2));
  return rec;
}

function seedHolder(name, fields = {}) {
  fs.mkdirSync(leaseDir(), { recursive: true });
  const now = Date.now();
  const rec = {
    v: 1, projectId: "p", holderKey: `session:${name}`, token: null, flowType: "story", problemId: null,
    since: new Date(now).toISOString(), sessions: {}, ...fields,
  };
  fs.writeFileSync(path.join(leaseDir(), `${name}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

function auditLines() {
  if (!fs.existsSync(auditPath())) return [];
  return fs.readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const aged = () => Date.now() - SESSION_SWEEP_THRESHOLD_MS - 60 * 1000;

beforeEach(() => {
  priorRoot = getSessionProjectRoot();
  // Switch to the temp root BEFORE resetToken: resetToken removes every persisted record
  // under the CURRENT root, so calling it first would delete the real repo's records.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "rks-session-sweep-"));
  setProjectRoot(root);
  resetToken();
  setToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetToken();
  setProjectRoot(priorRoot);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("sweep constants", () => {
  it("SESSION_SWEEP_THRESHOLD_MS is 4 * MAX_AGE_MS (strictly greater than MAX_AGE_MS) and the cap is 200", () => {
    expect(SESSION_SWEEP_THRESHOLD_MS).toBe(4 * MAX_AGE_MS);
    expect(SESSION_SWEEP_THRESHOLD_MS).toBeGreaterThan(MAX_AGE_MS);
    expect(SESSION_SWEEP_MAX_REMOVALS).toBe(200);
  });
});

describe("sweepDeadSessionRecords", () => {
  it("removes a terminal record that is neither in memory nor lease-listed and audits it with rule terminal", () => {
    const rec = seed("tok-terminal", { state: "shipped", createdAt: 1000, lastActivity: 2000 });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(false);
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ token: "tok-terminal", rule: "terminal", state: "shipped", projectId: "p" });
    expect(r.removed).toBe(1);
    // Every field present; record-derived fields equal the record that was read.
    for (const k of ["token", "projectId", "flowType", "state", "problemId", "lastActivity", "createdAt", "rule", "sweptAt", "pid"]) {
      expect(lines[0]).toHaveProperty(k);
    }
    expect(lines[0]).toMatchObject({
      token: rec.token, projectId: rec.projectId, flowType: rec.flowType, state: rec.state,
      problemId: rec.problemId, lastActivity: rec.lastActivity, createdAt: rec.createdAt, pid: process.pid,
    });
    expect(typeof lines[0].sweptAt).toBe("string");
  });

  it("removes an aged non-terminal record with rule aged", () => {
    seed("tok-aged", { createdAt: aged(), lastActivity: aged() });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-aged"))).toBe(false);
    expect(auditLines()).toEqual([expect.objectContaining({ token: "tok-aged", rule: "aged" })]);
    expect(r.removed).toBe(1);
  });

  it("keeps a record aged past MAX_AGE_MS but not past SESSION_SWEEP_THRESHOLD_MS (the margin is real)", () => {
    const t = Date.now() - MAX_AGE_MS - 10 * 60 * 1000;
    seed("tok-margin", { createdAt: t, lastActivity: t });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-margin"))).toBe(true);
    expect(r.removed).toBe(0);
    expect(auditLines()).toHaveLength(0);
  });

  it("keeps a live non-terminal record", () => {
    seed("tok-live");
    sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-live"))).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  it("keeps a fresh executing record", () => {
    seed("tok-exec", { state: "executing" });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-exec"))).toBe(true);
    expect(r.removed).toBe(0);
  });

  it("keeps a record whose token is in the in-memory session map even when its disk lastActivity is old", () => {
    const { token } = createSession({ projectId: "p", flowType: "open" });
    // Overwrite the on-disk record as aged past the sweep threshold (touchSession persistence lag).
    const rec = JSON.parse(fs.readFileSync(recordPath(token), "utf8"));
    fs.writeFileSync(recordPath(token), JSON.stringify({ ...rec, createdAt: aged(), lastActivity: aged() }));
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath(token))).toBe(true);
    expect(r.removed).toBe(0);
  });

  it("keeps terminal and aged records whose tokens a lease holder lists", () => {
    seed("tok-lt", { state: "shipped" });
    seed("tok-la", { createdAt: aged(), lastActivity: aged() });
    const now = Date.now();
    seedHolder("h1", { sessions: { "tok-lt": { mode: "exclusive", lastActivity: now, joinedAt: now }, "tok-la": { mode: "shared", lastActivity: 0, joinedAt: 0 } } });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-lt"))).toBe(true);
    expect(fs.existsSync(recordPath("tok-la"))).toBe(true);
    expect(r.removed).toBe(0);
    expect(auditLines()).toHaveLength(0);
  });

  it("keeps a record listed by an off-rail holder, and that holder is still live afterwards", () => {
    seed("tok-off", { createdAt: aged(), lastActivity: aged() });
    const now = Date.now();
    seedHolder("off", {
      holderKey: "session:tok-off", token: "tok-off", offRail: true, offRailProblemId: "story-A", offRailConvertedAt: now,
      flowType: null, sessions: { "tok-off": { mode: "exclusive", flowType: null, lastActivity: aged(), joinedAt: aged() } },
    });
    const r = sweepDeadSessionRecords();
    expect(r.ran).toBe(true);
    expect(fs.existsSync(recordPath("tok-off"))).toBe(true);
    // Live: a competing acquire on the same project is refused by that off-rail holder.
    const other = acquireLease({ projectRoot: root, projectId: "p", flowType: "open", problemId: null, token: "tok-other" });
    expect(other).toMatchObject({ ok: false, reason: "project_leased" });
    expect(other.holder).toMatchObject({ offRail: true, holderKey: "session:tok-off" });
  });

  it("keeps an unparseable record and reports it skipped", () => {
    fs.mkdirSync(sessionDir(), { recursive: true });
    fs.writeFileSync(recordPath("tok-garbled"), "{ not json");
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-garbled"))).toBe(true);
    expect(r.skipped).toBe(1);
  });

  it("keeps a record missing token or projectId and reports it skipped", () => {
    fs.mkdirSync(sessionDir(), { recursive: true });
    fs.writeFileSync(recordPath("tok-noproj"), JSON.stringify({ token: "tok-noproj", state: "shipped", flowType: "story" }));
    fs.writeFileSync(recordPath("tok-notoken"), JSON.stringify({ projectId: "p", state: "shipped", flowType: "story" }));
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-noproj"))).toBe(true);
    expect(fs.existsSync(recordPath("tok-notoken"))).toBe(true);
    expect(r.skipped).toBe(2);
    expect(r.removed).toBe(0);
  });

  it("keeps a record whose filename does not match its token and reports it skipped", () => {
    fs.mkdirSync(sessionDir(), { recursive: true });
    fs.writeFileSync(recordPath("tok-name"), JSON.stringify({ token: "tok-other", projectId: "p", state: "shipped", flowType: "story" }));
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-name"))).toBe(true);
    expect(r.skipped).toBe(1);
    expect(r.removed).toBe(0);
  });

  it("returns the success shape", () => {
    seed("tok-terminal", { state: "shipped" });
    const r = sweepDeadSessionRecords();
    expect(r).toEqual({ ran: true, removed: 1, skipped: 0, failed: 0, capped: false, refused: null });
  });

  it("refuses and removes nothing while .routekit/hooks.bak exists", () => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".routekit", "hooks.bak"), { recursive: true });
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
    expect(r).toMatchObject({ ran: false, refused: "hooks_bak", removed: 0 });
    expect(String(r.reason)).toMatch(/hooks\.bak/);
  });

  it.each([
    ["active:false", JSON.stringify({ active: false })],
    ["unparseable", "{ nope"],
  ])("refuses while the guard state is %s", (_label, body) => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "guardrails-state.json"), body);
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
    expect(r).toMatchObject({ ran: false, refused: "guard_state", removed: 0 });
    expect(String(r.reason)).toMatch(/guard state/);
  });

  it("does not refuse when the guard state parses to active === true", () => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "guardrails-state.json"), JSON.stringify({ active: true }));
    expect(sweepDeadSessionRecords()).toMatchObject({ ran: true, removed: 1 });
  });

  it("refuses an active:false guard state (off-rail live) with a reason naming active === true", () => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rks", "guardrails-state.json"), JSON.stringify({ active: false }));
    const r = sweepDeadSessionRecords();
    expect(r).toMatchObject({ ran: false, refused: "guard_state", removed: 0 });
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
    expect(String(r.reason)).toMatch(/guard state/);
    expect(String(r.reason)).toContain("active === true");
    expect(String(r.reason)).not.toContain("does not read active === false");
  });

  it("refuses while an off-rail session is open in the session log", () => {
    seed("tok-terminal", { state: "shipped" });
    fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".rks", "guardrails-off-sessions.jsonl"),
      JSON.stringify({ sessionId: "s-1", problemId: "story-A", startedAt: new Date().toISOString() }) + "\n",
    );
    const r = sweepDeadSessionRecords();
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(true);
    expect(r).toMatchObject({ ran: false, refused: "open_offrail_session", removed: 0 });
    expect(String(r.reason)).toMatch(/open off-rail session/);
  });

  it("honours the per-call removal cap and a second call removes the remainder", () => {
    const extra = 7;
    for (let i = 0; i < SESSION_SWEEP_MAX_REMOVALS + extra; i++) seed(`tok-cap-${String(i).padStart(4, "0")}`, { state: "shipped" });
    const first = sweepDeadSessionRecords();
    expect(first).toMatchObject({ ran: true, removed: SESSION_SWEEP_MAX_REMOVALS, capped: true });
    const second = sweepDeadSessionRecords();
    expect(second).toMatchObject({ ran: true, removed: extra, capped: false });
    expect(fs.readdirSync(sessionDir())).toHaveLength(0);
    expect(auditLines()).toHaveLength(SESSION_SWEEP_MAX_REMOVALS + extra);
  });

  it("is a no-op reporting no_project_root when no root is set", () => {
    setProjectRoot(null);
    try {
      expect(sweepDeadSessionRecords()).toMatchObject({ ran: false, reason: "no_project_root" });
    } finally {
      setProjectRoot(root);
    }
  });

  it("counts an EACCES unlink as failed, keeps the record and writes no audit line", () => {
    seed("tok-eacces", { state: "shipped" });
    const target = recordPath("tok-eacces");
    const real = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (String(p) === target) {
        const e = new Error("EACCES: permission denied");
        e.code = "EACCES";
        throw e;
      }
      return real.call(fs, p);
    });
    let r;
    try {
      r = sweepDeadSessionRecords();
    } finally {
      spy.mockRestore();
    }
    expect(r).toMatchObject({ ran: true, failed: 1, removed: 0 });
    expect(fs.existsSync(target)).toBe(true);
    expect(auditLines()).toHaveLength(0);
  });

  it("counts an ENOENT unlink (lost race) as skipped, not removed or failed, with no audit line", () => {
    seed("tok-enoent", { state: "shipped" });
    const target = recordPath("tok-enoent");
    const real = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (String(p) === target) {
        real.call(fs, p); // another process removed it first
        const e = new Error("ENOENT: no such file or directory");
        e.code = "ENOENT";
        throw e;
      }
      return real.call(fs, p);
    });
    let r;
    try {
      r = sweepDeadSessionRecords();
    } finally {
      spy.mockRestore();
    }
    expect(r).toMatchObject({ ran: true, skipped: 1, removed: 0, failed: 0 });
    expect(auditLines()).toHaveLength(0);
  });
});

describe("leaseListedTokens", () => {
  it("lists every token in every holder record, including expired and off-rail holders, read-only", () => {
    seedHolder("live", { sessions: { "t-live": { mode: "shared", lastActivity: Date.now(), joinedAt: Date.now() } } });
    seedHolder("expired", { sessions: { "t-exp1": { mode: "shared", lastActivity: 0, joinedAt: 0 }, "t-exp2": { mode: "shared", lastActivity: 0, joinedAt: 0 } } });
    seedHolder("off", { offRail: true, offRailConvertedAt: 0, sessions: { "t-off": { mode: "exclusive", lastActivity: 0, joinedAt: 0 } } });
    const before = fs.readdirSync(leaseDir()).sort();
    const tokens = leaseListedTokens(root);
    expect(tokens).toBeInstanceOf(Set);
    expect([...tokens].sort()).toEqual(["t-exp1", "t-exp2", "t-live", "t-off"]);
    // No acquire file created, no holder removed.
    expect(fs.readdirSync(leaseDir()).sort()).toEqual(before);
  });
});

describe("isProvablyDeadRecord (positive control)", () => {
  it("is true for a terminal not-in-memory record with an empty lease set, false when lease-listed", () => {
    const rec = { token: "tok-pc", projectId: "p", flowType: "story", state: "shipped", createdAt: Date.now(), lastActivity: Date.now() };
    expect(isProvablyDeadRecord(rec, { leaseTokens: new Set(), now: Date.now() })).toBe(true);
    expect(isProvablyDeadRecord(rec, { leaseTokens: new Set(["tok-pc"]), now: Date.now() })).toBe(false);
  });
});

describe("rks_governor_init integration", () => {
  it("removes seeded dead records, reports the success shape, and never sweeps its own new session", () => {
    seed("tok-d1", { state: "shipped" });
    seed("tok-d2", { createdAt: aged(), lastActivity: aged() });
    seed("tok-d3", { flowType: "open", state: "init", problemId: null, createdAt: aged(), lastActivity: aged() });
    const out = handleGovernorInit({ projectId: "p" });
    expect(out.ok).toBe(true);
    expect(out.sessionSweep).toMatchObject({ ran: true, refused: null, removed: 3 });
    for (const t of ["tok-d1", "tok-d2", "tok-d3"]) expect(fs.existsSync(recordPath(t))).toBe(false);
    expect(fs.existsSync(recordPath(out.token))).toBe(true);
  });

  it("a thrown sweep never fails the init and is reported in the error shape", () => {
    sweepDeadSessionRecords.mockImplementationOnce(() => { throw new Error("boom"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = handleGovernorInit({ projectId: "p" });
    expect(out.ok).toBe(true);
    expect(out.sessionSweep.ran).toBe(false);
    expect(typeof out.sessionSweep.error).toBe("string");
    expect(out.sessionSweep.error.length).toBeGreaterThan(0);
    expect(out.sessionSweep).not.toHaveProperty("removed");
    expect(errSpy).toHaveBeenCalled();
  });
});

// backlog.fix.session-sweep-guard-state-polarity-inverted: the guard file is produced by the
// production guardrails-on writer (clearGuardState), never a hand-written fixture, so spec
// wording cannot re-invert the polarity unnoticed. All writes target the temp root.
describe("guard state written by the real guardrails-on writer (clearGuardState)", () => {
  const guardPath = () => path.join(root, ".rks", "guardrails-state.json");

  it("clearGuardState is exported and writes a guard file whose parsed active is true (positive control)", () => {
    expect(typeof clearGuardState).toBe("function");
    clearGuardState(root);
    expect(fs.existsSync(guardPath())).toBe(true);
    expect(JSON.parse(fs.readFileSync(guardPath(), "utf8")).active).toBe(true);
  });

  it("clearGuardState writes exactly the guardrails-on shape (content unchanged by the export)", () => {
    clearGuardState(root);
    expect(JSON.parse(fs.readFileSync(guardPath(), "utf8"))).toEqual({
      active: true, scope: null, sessionId: null, sessionType: null, reason: null, disabledTiers: [],
    });
  });

  it("sweepDeadSessionRecords runs and removes a terminal record with the real guardrails-on file", () => {
    seed("tok-terminal", { state: "shipped" });
    clearGuardState(root);
    expect(JSON.parse(fs.readFileSync(guardPath(), "utf8")).active).toBe(true);
    expect(fs.existsSync(path.join(root, ".routekit", "hooks.bak"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".rks", "guardrails-off-sessions.jsonl"))).toBe(false);
    const r = sweepDeadSessionRecords();
    expect(r).toMatchObject({ ran: true, refused: null, removed: 1 });
    expect(fs.existsSync(recordPath("tok-terminal"))).toBe(false);
  });

  it("handleGovernorInit reports sessionSweep ran true, refused null with the real guardrails-on file", () => {
    clearGuardState(root);
    expect(JSON.parse(fs.readFileSync(guardPath(), "utf8")).active).toBe(true);
    const out = handleGovernorInit({ projectId: "p" });
    expect(out.ok).toBe(true);
    expect(out.sessionSweep).toMatchObject({ ran: true, refused: null });
  });
});

describe("source shape", () => {
  it("sweepDeadSessionRecords and isProvablyDeadRecord are plain functions exported via the trailing list", () => {
    const src = fs.readFileSync(new URL("../../packages/mcp-rks/src/shared/governor-token.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/\nfunction sweepDeadSessionRecords\(/);
    expect(src).toMatch(/\nfunction isProvablyDeadRecord\(/);
    expect(src).not.toMatch(/export function sweepDeadSessionRecords/);
    expect(src).not.toMatch(/export function isProvablyDeadRecord/);
    const tail = src.slice(src.lastIndexOf("\nexport {"));
    expect(tail).toMatch(/sweepDeadSessionRecords/);
    expect(tail).toMatch(/isProvablyDeadRecord/);
  });
});
