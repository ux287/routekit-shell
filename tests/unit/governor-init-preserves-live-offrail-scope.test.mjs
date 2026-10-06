import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER_PATH = path.join(ROOT, "packages/mcp-rks/src/server.mjs");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const INIT_PATH = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");

const SCOPE = JSON.stringify({ problemId: "backlog.fix.live-build", allowedFiles: ["packages/mcp-rks/src/server.mjs"] });

let dir;
let tok;
let init;
let server;
const scopePath = () => path.join(dir, ".rks", "active-scope.json");
const guardPath = () => path.join(dir, ".rks", "guardrails-state.json");

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-scope-"));
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  tok = await import(TOKEN_PATH);
  init = await import(INIT_PATH);
  server = await import(SERVER_PATH);
  tok.setProjectRoot(dir);
  fs.writeFileSync(scopePath(), SCOPE);
});

afterEach(() => {
  try { tok.resetToken(); } catch { /* ignore */ }
  tok.setProjectRoot(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("init-time active-scope reconciliation", () => {
  it("preserves the scope file while guardrails-state.json records a live off-rail build", () => {
    fs.writeFileSync(guardPath(), JSON.stringify({ active: false, scope: "all", sessionId: "s1", disabledTiers: ["read", "write"] }));
    init.handleGovernorInit({ projectId: "p", problemId: "backlog.fix.live-build" });
    const other = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(other.mode).toBe("new");
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: other });
    expect(r.removed).toBe(false);
    expect(fs.readFileSync(scopePath(), "utf8")).toBe(SCOPE);
  });

  it("preserves the scope file when .routekit/hooks.bak exists and guard state is absent", () => {
    fs.mkdirSync(path.join(dir, ".routekit", "hooks.bak"), { recursive: true });
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(fresh.mode).toBe("new");
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh });
    expect(r.removed).toBe(false);
    expect(fs.readFileSync(scopePath(), "utf8")).toBe(SCOPE);
  });

  it("removes the scope file when guard state is active:true and no hooks.bak exists", () => {
    fs.writeFileSync(guardPath(), JSON.stringify({ active: true }));
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(fresh.mode).toBe("new");
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(scopePath())).toBe(false);
  });

  it("treats an unparseable guardrails-state.json as live and preserves the scope file", () => {
    fs.writeFileSync(guardPath(), "{not json");
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(fresh.mode).toBe("new");
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh });
    expect(r.removed).toBe(false);
    expect(fs.readFileSync(scopePath(), "utf8")).toBe(SCOPE);
  });

  it("preserves the scope file when the caller resumes its own session", () => {
    const a = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const again = init.handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(again.mode).toBe("resumed");
    expect(again.token).toBe(a.token);
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: again });
    expect(r.removed).toBe(false);
    expect(fs.readFileSync(scopePath(), "utf8")).toBe(SCOPE);
  });

  it("still removes a genuinely orphaned scope file and reports it", () => {
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(fresh.mode).toBe("new");
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(scopePath())).toBe(false);
  });

  it("is a no-op when no scope file exists", () => {
    fs.rmSync(scopePath());
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(() => server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh })).not.toThrow();
    expect(server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh }).removed).toBe(false);
  });

  it("preserves the scope file for any init mode other than new (reset)", () => {
    const r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: { mode: "reset" } });
    expect(r.removed).toBe(false);
    expect(fs.readFileSync(scopePath(), "utf8")).toBe(SCOPE);
  });

  it("reports removed:false with a reason when the unlink throws", () => {
    fs.rmSync(scopePath());
    fs.mkdirSync(scopePath());
    const fresh = init.handleGovernorInit({ projectId: "p", flowType: "open" });
    expect(fresh.mode).toBe("new");
    let r;
    expect(() => { r = server.reconcileActiveScopeOnInit({ projectRoot: dir, initResult: fresh }); }).not.toThrow();
    expect(r.removed).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason.length).toBeGreaterThan(0);
    expect(fs.existsSync(scopePath())).toBe(true);
  });
});

describe("GOVERNOR_INIT_TOOL block structure", () => {
  const src = fs.readFileSync(SERVER_PATH, "utf8");
  const start = src.indexOf("if (tool === GOVERNOR_INIT_TOOL)");
  const end = src.indexOf("if (tool ===", start + 1);
  const block = src.slice(start, end === -1 ? undefined : end);

  it("reconciles the scope file only after handleGovernorInit", () => {
    expect(start).toBeGreaterThan(-1);
    const initAt = block.indexOf("handleGovernorInit(input)");
    const reconcileAt = block.indexOf("reconcileActiveScopeOnInit(");
    expect(initAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeGreaterThan(initAt);
    const orphanAt = block.indexOf("detectOrphanedGuardrails(");
    expect(orphanAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeGreaterThan(orphanAt);
    expect(block.slice(0, initAt)).not.toContain("unlinkSync");
  });

  it("surfaces removal in the response", () => {
    expect(block).toContain("scopeFileRemoved");
  });

  it("no longer calls the file residue of the retired guardrailsOff() flow", () => {
    expect(block).not.toContain("old guardrailsOff() flow");
    expect(block).toContain("guardrails-audit.mjs");
  });
});
