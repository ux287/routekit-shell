import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");

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
    const calls = [
      { projectId: "p" },
      { projectId: "p" },
      { projectId: "p", flowType: "qa", problemId: "s1" },
      { projectId: "p", flowType: "ops" },
      { projectId: "p", problemId: "s2" },
    ];
    const tokens = calls.map((c) => init.handleGovernorInit(c).token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const t of tokens) expect(tok.validateToken(t)).toBe(true);
  });

  it("a cross-flow init does not end a live session it does not own", () => {
    const qa = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    init.handleGovernorInit({ projectId: "p" });
    expect(tok.getSession(qa.token)).toBeTruthy();
    expect(tok.validateToken(qa.token)).toBe(true);
  });

  it("an unrelated init does not re-arm guardrails for an off-rail owner", () => {
    const owner = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.setGuardrailsDisabled(owner.token, true);
    const bak = path.join(dir, ".routekit", "hooks.bak");
    fs.mkdirSync(bak, { recursive: true });
    init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
    init.handleGovernorInit({ projectId: "p" });
    expect(fs.existsSync(bak), "hooks.bak must not be renamed back by a third party").toBe(true);
    expect(tok.getSession(owner.token).guardrailsDisabled).toBe(true);
  });

  it("resolution is not 'last session created': an older owner resumes after a newer init", () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    tok.advanceState(a.token, "rks_refine");
    init.handleGovernorInit({ projectId: "p" });
    const again = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    expect(again.token).toBe(a.token);
    expect(again.mode).toBe("resumed");
    expect(again.state).toBe("refining");
  });

  it("an init while another session is live reports concurrentSessions; a lone init does not", () => {
    const first = init.handleGovernorInit({ projectId: "p" });
    expect(first.concurrentSessions ?? 0).toBe(0);
    const second = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(second.concurrentSessions).toBeGreaterThanOrEqual(1);
  });
});

describe("persistence is per session", () => {
  it("persisting B does not destroy A's record, and ending B does not delete it", async () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
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
    const other = init.handleGovernorInit({ projectId: "p", problemId: "story-B" });
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
        if (ent.isDirectory()) { stack.push(p); continue; }
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
    ["executing", { projectId: "p", problemId: "story-B" }, { state: "executing" }],
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
    const a = init.handleGovernorInit({ projectId: "p" });
    // Positive control: while A is fresh it IS counted, so the zero below is not vacuous.
    const control = init.handleGovernorInit({ projectId: "p", flowType: "ops" });
    expect(control.concurrentSessions).toBeGreaterThanOrEqual(1);
    tok.endSession(control.token);
    const s = tok.getSession(a.token);
    const old = Date.now() - 31 * 60 * 1000;
    s.lastActivity = old;
    s.createdAt = old;
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(b.concurrentSessions ?? 0).toBe(0);
  });

  it("a session in a terminal state for its flow is not counted in concurrentSessions", () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "ops", problemId: "op-C" });
    const control = init.handleGovernorInit({ projectId: "p" });
    expect(control.concurrentSessions).toBeGreaterThanOrEqual(1);
    tok.endSession(control.token);
    tok.getSession(a.token).state = "done";
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(b.concurrentSessions ?? 0).toBe(0);
  });

  it("after a restart, a live peer that exists only on disk is still counted in concurrentSessions", async () => {
    init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    await boot(); // A is now only a persisted record
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "s" });
    expect(b.concurrentSessions).toBeGreaterThanOrEqual(1);
  });

  it("two sessions persist two distinct records", () => {
    const a = init.handleGovernorInit({ projectId: "p", problemId: "story-A" });
    const b = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
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

  it("no mutex, semaphore or lock primitive is introduced", () => {
    for (const src of [INIT_SRC, TOKEN_SRC]) {
      expect(src).not.toMatch(/mutex/i);
      expect(src).not.toMatch(/semaphore/i);
    }
  });
});
