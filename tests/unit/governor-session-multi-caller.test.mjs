import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const LEASE_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/project-lease.mjs");

// backlog.feat.project-lease-actor-attribution: the server now enforces a readers-writer project
// lease (open = shared; story, qa, ship, ops = exclusive). Cases that held an exclusive session
// alongside another holder on ONE project are re-scoped below so each still tests its original
// property (token distinctness, non-interference, resume, concurrentSessions counting, per-token
// persistence) through open + open sessions, distinct projectIds or sequential sessions; where the
// incompatible pairing itself expresses lease behaviour it is asserted as project_leased.

let dir;
let init;
let tok;

// Fresh module instances against the same project root == an MCP server restart.
async function boot() {
  vi.resetModules();
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  tok.setProjectRoot(dir);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-multi-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  await boot();
});

afterEach(() => {
  try { tok.resetToken(); } catch { /* ignore */ }
  tok.setProjectRoot(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("caller-scoped session identity", () => {
  it("two problemId-less inits get different tokens and different session objects", () => {
    const a = init.handleGovernorInit({ projectId: "p" });
    tok.getSession(a.token).state = "sentinel-A";
    const b = init.handleGovernorInit({ projectId: "p" });
    expect(b.token).not.toBe(a.token);
    expect(tok.getSession(b.token)).not.toBe(tok.getSession(a.token));
    expect(tok.getSession(a.token).state, "B's init must not reset A's chain").toBe("sentinel-A");
  });

  it("no init returns a token another live Governor is already using", () => {
    // Shared + shared on p, and one exclusive flow per other project on the same root.
    const calls = [
      { projectId: "p" },
      { projectId: "p" },
      { projectId: "p-qa", flowType: "qa", problemId: "s1" },
      { projectId: "p-ops", flowType: "ops" },
      { projectId: "p-story", problemId: "s2" },
    ];
    const results = calls.map((c) => init.handleGovernorInit(c));
    for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(true);
    const tokens = results.map((r) => r.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const t of tokens) expect(tok.validateToken(t)).toBe(true);
    // The incompatible pairing on ONE project is the lease's to refuse, and mints no token.
    const refused = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s1" });
    expect(refused).toMatchObject({ ok: false, reason: "project_leased" });
    expect(refused).not.toHaveProperty("token");
  });

  it("a cross-flow init does not end a live session it does not own", () => {
    const qa = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    // Same project: refused by the lease, and the refusal leaves the qa session alone.
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    // Another project: a NEW session, and the qa session is still untouched.
    expect(init.handleGovernorInit({ projectId: "p-other" }).ok).toBe(true);
    expect(tok.getSession(qa.token)).toBeTruthy();
    expect(tok.validateToken(qa.token)).toBe(true);
  });

  it("an unrelated init does not re-arm guardrails for an off-rail owner", () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    expect(init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" }).reason).toBe("project_leased");
    expect(init.handleGovernorInit({ projectId: "p" }).reason).toBe("project_leased");
    expect(init.handleGovernorInit({ projectId: "p2", flowType: "qa", problemId: "story-B" }).ok).toBe(true);
    expect(init.handleGovernorInit({ projectId: "p3" }).ok).toBe(true);
    expect(fs.existsSync(bak), "hooks.bak must not be renamed back by a third party").toBe(true);
    expect(tok.getSession(owner.token).guardrailsDisabled).toBe(true);
  });

  it("resolution is not 'last session created': an older owner resumes after a newer init", () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.advanceState(a.token, "rks_refine");
    const newer = init.handleGovernorInit({ projectId: "p-other" });
    expect(newer.ok).toBe(true);
    const again = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(again.token).toBe(a.token);
    expect(again.mode).toBe("resumed");
    expect(again.state).toBe("refining");
  });

  it("an init while another session is live reports concurrentSessions; a lone init does not", () => {
    const first = init.handleGovernorInit({ projectId: "p" });
    expect(first.concurrentSessions ?? 0).toBe(0);
    const second = init.handleGovernorInit({ projectId: "p" });
    expect(second.ok).toBe(true);
    expect(second.concurrentSessions).toBeGreaterThanOrEqual(1);
  });
});

describe("persistence is per session", () => {
  it("persisting B does not destroy A's record, and ending B does not delete it", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    const b = init.handleGovernorInit({ projectId: "p-b", flowType: "qa", problemId: "story-B" });
    expect(b.ok).toBe(true);
    tok.endSession(b.token);
    await boot(); // restart: memory empty, disk intact
    expect(tok.validateToken(a.token), "A must be recoverable from disk").toBe(true);
  });
});

describe("restart recovery through rks_governor_init", () => {
  it("a matching projectId + problemId resumes the persisted session after a restart", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.advanceState(a.token, "rks_refine");
    await boot();
    const r = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(r.mode).toBe("resumed");
    expect(r.token).toBe(a.token);
    expect(r.state).toBe("refining");
  });

  it("a different problemId after restart gets a new session and leaves the persisted one recoverable", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    await boot();
    // The persisted holder survives the restart, so the same project is still leased (AC6) ...
    expect(init.handleGovernorInit({ projectId: "p", problemId: "story-B" }).reason).toBe("project_leased");
    // ... and another project's init gets its own session, leaving A recoverable.
    const other = init.handleGovernorInit({ projectId: "p-other", problemId: "story-B" });
    expect(other.ok).toBe(true);
    expect(other.token).not.toBe(a.token);
    expect(tok.validateToken(a.token)).toBe(true);
  });

  it("reset: true after restart mints a new token", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    await boot();
    const r = init.handleGovernorInit({ projectId: "p", problemId: "story-A", reset: true });
    expect(r.token).not.toBe(a.token);
    expect(r.state).toBe("init");
  });

  // Layout-neutral: finds the persisted record for a token wherever Build stores it under .rks/.
  function rewritePersisted(token, patch) {
    const rksDir = path.join(dir, ".rks");
    const stack = [rksDir];
    let hits = 0;
    while (stack.length) {
      const d = stack.pop();
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        // Lease holder records (.rks/session/lease/) also carry a token field; skip them.
        if (ent.isDirectory()) { if (ent.name !== "lease") stack.push(p); continue; }
        if (!ent.name.endsWith(".json")) continue;
        let data;
        try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        if (data?.token !== token) continue;
        fs.writeFileSync(p, JSON.stringify({ ...data, ...patch }, null, 2));
        hits++;
      }
    }
    expect(hits, `ANTI-VACUITY: no persisted record found for ${token}`).toBeGreaterThan(0);
  }

  it.each([
    ["expired", { projectId: "p", problemId: "story-A" }, { lastActivity: 1, createdAt: 1 }],
    ["terminal", { projectId: "p", flowType: "ops", problemId: "op-C" }, { state: "done" }],
  ])("a %s persisted session is NOT resumed after a restart", async (_label, input, patch) => {
    const a = init.handleGovernorInit(input);
    rewritePersisted(a.token, patch);
    await boot();
    const r = init.handleGovernorInit(input);
    expect(r.token).not.toBe(a.token);
    expect(r.mode).not.toBe("resumed");
    expect(r.state).toBe("init");
  });

  // backlog.fix.project-lease-executing-holder-and-offrail-retry (1b): the `executing` row, split out.
  // An executing record is still NOT resumed, but loadPersistedSession no longer deletes it or
  // releases its lease, so the same-story re-init from the restarted process meets that live holder
  // and is refused project_leased (it used to be admitted only through that release).
  it("an executing persisted session is NOT resumed after a restart; the same-story re-init is refused project_leased by its live holder", async () => {
    const input = { projectId: "p", problemId: "story-B" };
    const a = init.handleGovernorInit(input);
    rewritePersisted(a.token, { state: "executing" });
    await boot();
    const r = init.handleGovernorInit(input);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("project_leased");
    expect(r.holder.holderKey).toBe(`session:${a.token}`);
    expect(r).not.toHaveProperty("token");
    expect(fs.existsSync(path.join(dir, ".rks", "session", "governor", `${a.token}.json`))).toBe(true);
    const leaseDir = path.join(dir, ".rks", "session", "lease");
    const holders = fs.readdirSync(leaseDir).filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => JSON.parse(fs.readFileSync(path.join(leaseDir, n), "utf8")));
    expect(holders.some((h) => Object.keys(h.sessions || {}).includes(a.token))).toBe(true);
  });

  it("after a restart, detectOrphanedGuardrails restores hooks.bak when the only persisted record is executing (isLiveSession unchanged)", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    rewritePersisted(owner.token, { state: "executing", lastActivity: Date.now() });
    await boot();
    expect(tok.detectOrphanedGuardrails()).toBe(true);
    expect(fs.existsSync(bak)).toBe(false);
  });

  // detectOrphanedGuardrails is called by server.mjs on every rks_governor_init, never by
  // handleGovernorInit, so these cases call it directly right after the simulated restart.
  it("after a restart, detectOrphanedGuardrails leaves hooks.bak in place while a live persisted record exists", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    await boot(); // in-memory Map is empty; the persisted owner record is live
    expect(tok.detectOrphanedGuardrails()).toBe(false);
    expect(fs.existsSync(bak), "hooks.bak must survive while the owner record is live").toBe(true);
  });

  it("after a restart, detectOrphanedGuardrails restores hooks.bak once the only persisted record has aged out", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    rewritePersisted(owner.token, { lastActivity: 1, createdAt: 1 });
    await boot();
    expect(tok.detectOrphanedGuardrails()).toBe(true);
    expect(fs.existsSync(bak)).toBe(false);
  });

  // backlog.fix.offrail-hooks-bak-orphan-restore-fail-closed: the case above writes no guard
  // state, so it stays a genuine orphan. With the off-rail record present, liveness alone
  // never justifies consuming hooks.bak.
  it("after a restart, detectOrphanedGuardrails keeps hooks.bak while guard state is active=false with an open session, even once the owner record has aged out (AC1)", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    fs.writeFileSync(path.join(bak, "keep.mjs"), "// keep");
    const hooks = path.join(dir, ".routekit", "hooks");
    fs.mkdirSync(path.join(hooks, "system"), { recursive: true });
    fs.writeFileSync(path.join(hooks, "system", "live.mjs"), "// live");
    fs.writeFileSync(path.join(dir, ".rks", "guardrails-state.json"), JSON.stringify({ active: false, sessionId: "s-open" }));
    fs.writeFileSync(path.join(dir, ".rks", "guardrails-off-sessions.jsonl"), JSON.stringify({ sessionId: "s-open", startedAt: new Date().toISOString(), reason: "off-rail" }) + "\n");
    rewritePersisted(owner.token, { lastActivity: 1, createdAt: 1 });
    const before = fs.readdirSync(hooks).sort();
    await boot();
    expect(tok.detectOrphanedGuardrails()).toBe(false);
    expect(fs.existsSync(path.join(bak, "keep.mjs"))).toBe(true);
    expect(fs.readdirSync(hooks).sort()).toEqual(before);
  });

  it("setGuardrailsDisabled persists, so the flag survives a restart", async () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    await boot();
    expect(tok.validateToken(owner.token)).toBe(true);
    expect(tok.getSession(owner.token).guardrailsDisabled).toBe(true);
  });
});

describe("liveness and persistence layout", () => {
  it("a session aged past MAX_AGE_MS is not counted in concurrentSessions", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const a = init.handleGovernorInit({ projectId: "p" });
      // Positive control: while A is fresh it IS counted, so the zero below is not vacuous.
      const control = init.handleGovernorInit({ projectId: "p" });
      expect(control.concurrentSessions).toBeGreaterThanOrEqual(1);
      tok.endSession(control.token);
      expect(tok.getSession(a.token)).toBeTruthy();
      // Age everything A holds (session and lease) past MAX_AGE_MS: the clock moves, nothing is edited.
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
      expect(b.ok).toBe(true);
      expect(b.concurrentSessions ?? 0).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session in a terminal state for its flow is not counted in concurrentSessions", () => {
    const a = init.handleGovernorInit({ projectId: "p" });
    const control = init.handleGovernorInit({ projectId: "p" });
    expect(control.concurrentSessions).toBeGreaterThanOrEqual(1);
    tok.endSession(control.token);
    tok.getSession(a.token).state = "review"; // terminal for the open flow
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(b.ok).toBe(true);
    expect(b.concurrentSessions ?? 0).toBe(0);
  });

  it("after a restart, a live peer that exists only on disk is still counted in concurrentSessions", async () => {
    init.handleGovernorInit({ projectId: "p" });
    await boot(); // A is now only a persisted record
    const b = init.handleGovernorInit({ projectId: "p" });
    expect(b.ok).toBe(true);
    expect(b.concurrentSessions).toBeGreaterThanOrEqual(1);
  });

  // backlog.fix.project-lease-executing-holder-and-offrail-retry: isLiveSession is unchanged, so a
  // persisted executing record is still not counted (the case above is the positive control).
  it("after a restart, a peer whose only record is executing is NOT counted in concurrentSessions", async () => {
    const a = init.handleGovernorInit({ projectId: "p" });
    const gfile = path.join(dir, ".rks", "session", "governor", `${a.token}.json`);
    const rec = JSON.parse(fs.readFileSync(gfile, "utf8"));
    fs.writeFileSync(gfile, JSON.stringify({ ...rec, state: "executing", lastActivity: Date.now() }, null, 2));
    await boot();
    const b = init.handleGovernorInit({ projectId: "p" });
    expect(b.ok).toBe(true);
    expect(b.concurrentSessions ?? 0).toBe(0);
  });

  it("two sessions persist two distinct records", () => {
    const a = init.handleGovernorInit({ projectId: "p" });
    const b = init.handleGovernorInit({ projectId: "p" });
    const gdir = path.join(dir, ".rks", "session", "governor");
    expect(fs.readdirSync(gdir).sort()).toEqual([`${a.token}.json`, `${b.token}.json`].sort());
  });

  it("persists one record per token under .rks/session/governor/ and never writes the legacy slot", () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(fs.existsSync(path.join(dir, ".rks", "session", "governor", `${a.token}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".rks", "governor-session.json"))).toBe(false);
  });
});

describe("source constraints", () => {
  const INIT_SRC = fs.readFileSync(INIT_PATH, "utf8");
  const TOKEN_SRC = fs.readFileSync(TOKEN_PATH, "utf8");

  it("handleGovernorInit no longer resolves the session under decision via getToken()", () => {
    expect(INIT_SRC).not.toMatch(/getToken\s*\(/);
  });

  // backlog.feat.project-lease-actor-attribution: KEPT and RE-SCOPED, not retired. The strict-lease
  // decision supersedes the original no-locking intent, but confining the locking primitive to ONE
  // module is still worth pinning.
  it("the session-identity modules carry no lock primitive; the lease guard lives only in project-lease.mjs", () => {
    for (const src of [INIT_SRC, TOKEN_SRC]) {
      expect(src).not.toMatch(/mutex/i);
      expect(src).not.toMatch(/semaphore/i);
      expect(src).not.toContain("wx");
    }
    // backlog.feat.project-lease-kernel-held-acquire: the guard is a kernel-held node:sqlite lock,
    // no longer an exclusive-create ("wx") file.
    const leaseSrc = fs.readFileSync(LEASE_PATH, "utf8");
    expect(leaseSrc).toContain("BEGIN EXCLUSIVE");
    expect(leaseSrc).not.toContain('"wx"');
  });
});
