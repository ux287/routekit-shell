import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start() {}
    async close() {}
    async send() {}
  },
}));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN_PATH = path.join(ROOT, "packages/mcp-rks/src/shared/governor-token.mjs");
const SERVER_PATH = path.join(ROOT, "packages/mcp-rks/src/server.mjs");
const CONTEXT_PATH = path.join(ROOT, "packages/mcp-rks/src/project-context.mjs");
const ENV_KEYS = ["ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "CLAUDE_PROJECT_DIR"];

let dirs = [];
let savedEnv;
let running = null;
let tokB = null;

function mkRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `gov-boot-${tag}-`));
  fs.mkdirSync(path.join(d, ".rks"), { recursive: true });
  dirs.push(d);
  return d;
}

function applyEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

/** Process A: persist a live session under <root>/.rks/session/governor/<token>.json. */
async function processAWritesSession(root, mutate) {
  vi.resetModules();
  const tokA = await import(TOKEN_PATH);
  tokA.setProjectRoot(root);
  const session = tokA.createSession({ projectId: "p", flowType: "open" });
  const file = path.join(root, ".rks", "session", "governor", `${session.token}.json`);
  expect(fs.existsSync(file), "process A must persist its record").toBe(true);
  if (mutate) {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(rec);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  }
  tokA.setProjectRoot(null);
  return { token: session.token, file };
}

/** Process B: fresh module graph; env applied AFTER import so only startServer() can seed. */
async function processB(env, { boot = true } = {}) {
  vi.resetModules();
  const server = await import(SERVER_PATH);
  applyEnv(env);
  if (boot) running = await server.startServer();
  tokB = await import(TOKEN_PATH);
  return tokB;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dirs = [];
});

afterEach(async () => {
  try { if (running?.close) await running.close(); } catch { /* ignore */ }
  running = null;
  try { tokB?.resetToken(); tokB?.setProjectRoot(null); } catch { /* ignore */ }
  tokB = null;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("governor-token project root is seeded at boot (backlog.fix.governor-token-project-root-at-boot)", () => {
  it("ROUTEKIT_PROJECT_ROOT: a record persisted by process A validates in process B after startServer()", async () => {
    const root = mkRoot("rk");
    const { token } = await processAWritesSession(root);
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(true);
  });

  it("RKS_PROJECT_ROOT alone also seeds the root", async () => {
    const root = mkRoot("rks");
    const { token } = await processAWritesSession(root);
    const tok = await processB({ RKS_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(true);
  });

  it("ROUTEKIT_PROJECT_ROOT takes precedence over RKS_PROJECT_ROOT", async () => {
    const withRecord = mkRoot("with");
    const empty = mkRoot("empty");
    const { token } = await processAWritesSession(withRecord);
    let tok = await processB({ ROUTEKIT_PROJECT_ROOT: empty, RKS_PROJECT_ROOT: withRecord, CLAUDE_PROJECT_DIR: empty });
    expect(tok.validateToken(token)).toBe(false);
    await running.close(); running = null;
    tok = await processB({ ROUTEKIT_PROJECT_ROOT: withRecord, RKS_PROJECT_ROOT: empty, CLAUDE_PROJECT_DIR: empty });
    expect(tok.validateToken(token)).toBe(true);
  });

  it("with neither env var set, the root stays unset: no CLAUDE_PROJECT_DIR or cwd fallback", async () => {
    const root = mkRoot("none");
    const { token, file } = await processAWritesSession(root);
    const tok = await processB({ CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(false);
    expect(fs.existsSync(file), "an unconsulted record is left in place").toBe(true);
  });

  it("a nonexistent ROUTEKIT_PROJECT_ROOT is not used and not created", async () => {
    const root = mkRoot("real");
    const ghost = path.join(os.tmpdir(), `gov-boot-ghost-${process.pid}-${Date.now()}`);
    const { token } = await processAWritesSession(root);
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: ghost, CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(false);
    expect(fs.existsSync(ghost)).toBe(false);
  });

  it("ROUTEKIT_PROJECT_ROOT nonexistent with RKS_PROJECT_ROOT existing: no fall-through, no boot seed", async () => {
    const root = mkRoot("nofall");
    const ghost = path.join(os.tmpdir(), `gov-boot-nofall-ghost-${process.pid}-${Date.now()}`);
    const { token, file } = await processAWritesSession(root);
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: ghost, RKS_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(false);
    expect(fs.existsSync(file), "an unconsulted record is left in place").toBe(true);
    expect(fs.existsSync(ghost)).toBe(false);
  });

  it("importing server.mjs without calling startServer() does not seed the root", async () => {
    const root = mkRoot("import");
    const { token } = await processAWritesSession(root);
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root }, { boot: false });
    expect(tok.validateToken(token)).toBe(false);
  });

  // backlog.fix.project-lease-executing-holder-and-offrail-retry (1b): a fresh `executing` record is
  // still rejected but its file is KEPT (the lease decides its holder's liveness); an executing record
  // older than MAX_AGE_MS is removed like any other dead record.
  it.each([
    ["expired", (r) => { r.lastActivity = 1; r.createdAt = 1; }, false],
    ["executing", (r) => { r.state = "executing"; }, true],
    ["executing and expired", (r) => { r.state = "executing"; r.lastActivity = 1; r.createdAt = 1; }, false],
    ["terminal (open/failed)", (r) => { r.flowType = "open"; r.state = "failed"; }, false],
  ])("a %s persisted record is still rejected and its file removed", async (_label, mutate, kept) => {
    const root = mkRoot("dead");
    const { token, file } = await processAWritesSession(root, mutate);
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: root, CLAUDE_PROJECT_DIR: root });
    expect(tok.validateToken(token)).toBe(false);
    expect(fs.existsSync(file)).toBe(kept);
  });

  it("a later setProjectRoot (as rks_governor_init calls it) overrides the boot seed", async () => {
    const bootRoot = mkRoot("boot");
    const initRoot = mkRoot("init");
    const tok = await processB({ ROUTEKIT_PROJECT_ROOT: bootRoot, CLAUDE_PROJECT_DIR: bootRoot });
    tok.setProjectRoot(initRoot);
    const s = tok.createSession({ projectId: "p", flowType: "open" });
    expect(fs.existsSync(path.join(initRoot, ".rks", "session", "governor", `${s.token}.json`))).toBe(true);
    expect(fs.existsSync(path.join(bootRoot, ".rks", "session", "governor", `${s.token}.json`))).toBe(false);
  });
});

describe("project-context envProjectRoot is exported with its existing resolution", () => {
  it("takes the first non-empty of ROUTEKIT_PROJECT_ROOT / RKS_PROJECT_ROOT and returns null when that candidate does not exist (no fall-through)", async () => {
    const a = mkRoot("ctxa");
    const b = mkRoot("ctxb");
    vi.resetModules();
    const ctx = await import(CONTEXT_PATH);
    expect(typeof ctx.envProjectRoot).toBe("function");
    applyEnv({ ROUTEKIT_PROJECT_ROOT: a, RKS_PROJECT_ROOT: b });
    expect(ctx.envProjectRoot()).toBe(path.resolve(a));
    applyEnv({ RKS_PROJECT_ROOT: b });
    expect(ctx.envProjectRoot()).toBe(path.resolve(b));
    applyEnv({ ROUTEKIT_PROJECT_ROOT: "", RKS_PROJECT_ROOT: b });
    expect(ctx.envProjectRoot()).toBe(path.resolve(b));
    applyEnv({ ROUTEKIT_PROJECT_ROOT: path.join(a, "does-not-exist") });
    expect(ctx.envProjectRoot()).toBe(null);
    applyEnv({ ROUTEKIT_PROJECT_ROOT: path.join(a, "does-not-exist"), RKS_PROJECT_ROOT: b });
    expect(ctx.envProjectRoot()).toBe(null);
    applyEnv({});
    expect(ctx.envProjectRoot()).toBe(null);
  });
});
