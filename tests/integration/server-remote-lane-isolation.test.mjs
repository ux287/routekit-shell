// backlog.feat.remote-surface-lane-isolation — Decisions 1, 2 and 3 through the real request handler
// (createServer + InMemoryTransport, pattern from tests/integration/server-lane-gate.test.mjs).
// Every project root is a temp fixture; foreign projects are registered ONLY in a temp RKS_REGISTRY_PATH
// registry. Each case builds a fresh boot root and fresh foreign ids so loadProjectContext's cache
// (keyed projectId:overrideRoot) can never satisfy a case. ensureTelemetryStorage is replaced by a
// recorder that binds nothing, escaping the global tests/setup.mjs stub through vi.importActual.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { storageRoots } = vi.hoisted(() => ({ storageRoots: [] }));

vi.mock("@routekit/telemetry", async () => {
  const actual = await vi.importActual("@routekit/telemetry");
  return {
    ...actual,
    ensureTelemetryStorage: (root) => {
      storageRoots.push(root);
      return actual.getTelemetryCollector();
    },
  };
});

vi.mock("../../packages/mcp-rks/src/agents/runner.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAgent: vi.fn(async () => ({ ok: true, output: { stub: true } })) };
});

vi.mock("@routekit/rag", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureRagIndex: vi.fn(async () => {}),
    runRagEmbed: vi.fn(async () => ({ ok: true })),
    runRagQuery: vi.fn(async () => ({ ok: true, matches: [] })),
  };
});

const SPAWN_MS = 10_000;
const BOOT_ID = "iso-boot-fixture";
const NOTE_NAME = "fixture.iso-note";
const NOTE_BODY = "iso-note-body";
const NOTE = `---\nid: "${NOTE_NAME}"\ntitle: "Iso Fixture"\nstatus: "original"\n---\n\n## Body\n\n${NOTE_BODY}\n`;
const BENIGN_BOOT_ENV = "RKS_ISO_BOOT_SENTINEL=boot-loaded\n";
const HOSTILE_BOOT_ENV = "RKS_VIA=ide\nRKS_VIA_DEFAULT=ide\nRKS_ACTOR=intruder\nRKS_DISPATCH_RUN_ID=intruder-run\nRKS_ISO_BOOT_SENTINEL=boot-loaded\n";
const ENV_KEYS = [
  "ROUTEKIT_PROJECT_ROOT", "RKS_PROJECT_ROOT", "ROUTEKIT_PROJECT_ID", "RKS_VIA", "RKS_VIA_DEFAULT", "RKS_ACTOR",
  "RKS_DISPATCH_RUN_ID", "DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR", "RKS_REGISTRY_PATH",
  "RKS_ISO_BOOT_SENTINEL", "RKS_ISO_FOREIGN_SENTINEL",
];
const GATE_ENV = ["NODE_ENV", "RKS_SKIP_PREFLIGHT", "RKS_TEST_MODE"];

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "server-remote-lane-isolation-")));
const registryPath = path.join(tmpBase, "registry.jsonl");
fs.writeFileSync(registryPath, "");

const { runAgent } = await import("../../packages/mcp-rks/src/agents/runner.mjs");
const { runRagQuery } = await import("@routekit/rag");
const { createServer } = await import("../../packages/mcp-rks/src/server.mjs");
const { endSession, getSession } = await import("../../packages/mcp-rks/src/shared/governor-token.mjs");
const { REMOTE_IDLE_MS } = await import("../../packages/mcp-rks/src/shared/project-lease.mjs");
const { resolveRegistryPath, loadProjects } = await import("../../packages/cli/src/project/index.js");

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: SPAWN_MS });
}

function makeProject(id, envFile) {
  const root = path.join(tmpBase, `${id}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${id}\n`);
  fs.writeFileSync(path.join(root, "notes", `${NOTE_NAME}.md`), NOTE);
  if (envFile) fs.writeFileSync(path.join(root, ".env"), envFile);
  const init = git(root, ["init", "-b", "feature/iso-test"]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  git(root, ["config", "user.email", "iso@test.invalid"]);
  git(root, ["config", "user.name", "Iso Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  const c = git(root, ["commit", "-m", "fixture", "--no-verify"]);
  if (c.status !== 0) throw new Error(`git commit failed: ${c.stderr}`);
  return root;
}

/** A fresh boot project root for this case; the lane and actor are launcher env. */
function boot({ via, envFile = BENIGN_BOOT_ENV, actor = "grokbot" }) {
  const root = makeProject(BOOT_ID, envFile);
  process.env.ROUTEKIT_PROJECT_ROOT = root;
  process.env.ROUTEKIT_PROJECT_ID = BOOT_ID;
  process.env.RKS_VIA = via;
  process.env.RKS_ACTOR = actor;
  return root;
}

/** A fresh foreign project, registered only in the temp registry, whose .env carries a unique sentinel. */
function foreign() {
  const id = `iso-foreign-${crypto.randomUUID().slice(0, 8)}`;
  const sentinel = `foreign-${crypto.randomUUID()}`;
  const root = makeProject(id, `RKS_ISO_FOREIGN_SENTINEL=${sentinel}\nRKS_VIA=ide\n`);
  fs.appendFileSync(registryPath, `${JSON.stringify({ id, root, path: root })}\n`);
  return { id, root, sentinel };
}

const liveTokens = new Set();

// Token gate armed (NODE_ENV=production, no bypass vars) for every call.
async function call(name, args) {
  const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "server-remote-lane-isolation-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  for (const k of GATE_ENV) delete process.env[k];
  process.env.NODE_ENV = "production";
  try {
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      return { res: null, text: String(err?.message ?? err), json: null, thrown: err };
    }
    const text = res?.content?.[0]?.text ?? "";
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.token && name === "rks_governor_init" && json.ok) liveTokens.add(json.token);
    return { res, text, json };
  } finally {
    for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await client.close().catch(() => {});
  }
}

async function initToken() {
  const { json, text } = await call("rks_governor_init", { projectId: BOOT_ID });
  expect(json?.ok, text).toBe(true);
  return json.token;
}

let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RKS_REGISTRY_PATH = registryPath;
  storageRoots.length = 0;
  vi.mocked(runAgent).mockClear();
  vi.mocked(runRagQuery).mockClear();
});

afterEach(() => {
  for (const t of liveTokens) { try { endSession(t); } catch { /* best-effort */ } }
  liveTokens.clear();
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// backlog.fix.remote-rag-query-inline-full-index-build: two remote sessions on one process (each its own
// createServer, as the HTTP entry's connectServer gives each session). runRagQuery is stubbed to stay
// pending, so the witness is a slow query, never a real embed.
describe("remote lane — a pending rks_rag_query does not stall another session", () => {
  async function openSession() {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({ name: "server-remote-lane-isolation-pending", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return client;
  }
  const parse = (res) => {
    const text = res?.content?.[0]?.text ?? "";
    try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
  };

  it("rks_governor_end from a second session completes within 2000 ms while the first session's rks_rag_query is pending", async () => {
    boot({ via: "remote" });
    const prev = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));
    for (const k of GATE_ENV) delete process.env[k];
    process.env.NODE_ENV = "production";
    const a = await openSession();
    const b = await openSession();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    vi.mocked(runRagQuery).mockImplementationOnce(async () => {
      await gate;
      return { ok: true, matches: [{ id: "pending-stub-match" }] };
    });
    try {
      const initA = parse(await a.callTool({ name: "rks_governor_init", arguments: { projectId: BOOT_ID } }));
      expect(initA.json?.ok, initA.text).toBe(true);
      liveTokens.add(initA.json.token);
      const initB = parse(await b.callTool({ name: "rks_governor_init", arguments: { projectId: BOOT_ID } }));
      expect(initB.json?.ok, initB.text).toBe(true);
      liveTokens.add(initB.json.token);

      let querySettled = false;
      const query = a.callTool({ name: "rks_rag_query", arguments: { projectId: BOOT_ID, q: "fixture", _governorToken: initA.json.token } })
        .finally(() => { querySettled = true; });
      // The query has reached the stubbed runRagQuery (and is held there) before the second session acts.
      const reachedAt = Date.now();
      while (vi.mocked(runRagQuery).mock.calls.length === 0 && Date.now() - reachedAt < 2_000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(runRagQuery).toHaveBeenCalledTimes(1);

      const started = Date.now();
      const end = parse(await b.callTool({ name: "rks_governor_end", arguments: { projectId: BOOT_ID, _governorToken: initB.json.token } }, undefined, { timeout: 2_000 }));
      const elapsed = Date.now() - started;
      expect(end.json?.ok, end.text).toBe(true);
      expect(elapsed).toBeLessThan(2_000);
      expect(querySettled).toBe(false);

      release();
      const q = parse(await query);
      expect(q.json?.ok, q.text).toBe(true);
      expect(q.json.matches).toEqual([{ id: "pending-stub-match" }]);
    } finally {
      release?.();
      for (const k of GATE_ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  }, 15_000);
});

describe("premise — this file never resolves the live registry", () => {
  it("resolveRegistryPath is the temp registry and it lists a freshly registered foreign project", () => {
    const f = foreign();
    expect(process.env.VITEST).toBeTruthy();
    expect(resolveRegistryPath()).toBe(registryPath);
    expect(loadProjects().some((p) => p.id === f.id && p.root === f.root)).toBe(true);
  });
});

describe("remote lane — no foreign project context before the lane gate (Decision 1)", () => {
  it("tokenless call whose projectId names a foreign project: refused, foreign .env not loaded, telemetry not bound to the foreign root but to the boot root", async () => {
    const bootRoot = boot({ via: "remote" });
    const f = foreign();
    const { json, text } = await call("rks_exhaustive_search", { projectId: f.id, pattern: "x", path: "." });
    expect(json?.reason, text).toBe("remote_tool_not_allowed");
    expect(json.lane).toBe("remote");
    expect(process.env.RKS_ISO_FOREIGN_SENTINEL).toBeUndefined();
    expect(process.env.RKS_VIA).toBe("remote");
    expect(storageRoots).not.toContain(f.root);
    expect(storageRoots).toContain(bootRoot);
  });

  it("tokenless admitted tool (dendron_read_note) naming a foreign projectId: refused remote_token_required, foreign context never loaded", async () => {
    const bootRoot = boot({ via: "remote" });
    const f = foreign();
    const { json, text } = await call("dendron_read_note", { projectId: f.id, filename: NOTE_NAME });
    expect(json?.reason, text).toBe("remote_token_required");
    expect(text).not.toContain(NOTE_BODY);
    expect(process.env.RKS_ISO_FOREIGN_SENTINEL).toBeUndefined();
    expect(storageRoots).not.toContain(f.root);
    expect(storageRoots).toContain(bootRoot);
  });

  it("args.id fallback: tokenless rks_project_get { id: <foreign> } with no projectId drives no foreign loadContext", async () => {
    const bootRoot = boot({ via: "remote" });
    const f = foreign();
    const { json, text } = await call("rks_project_get", { id: f.id });
    expect(json?.reason, text).toBe("remote_tool_not_allowed");
    expect(process.env.RKS_ISO_FOREIGN_SENTINEL).toBeUndefined();
    expect(storageRoots).not.toContain(f.root);
    expect(storageRoots).toContain(bootRoot);
  });

  it("positive control: a remote call naming the boot project still loads its context (.env sentinel set) and binds telemetry to the boot root", async () => {
    const bootRoot = boot({ via: "remote" });
    const { json, text } = await call("dendron_read_note", { projectId: BOOT_ID, filename: NOTE_NAME });
    expect(json?.reason, text).toBe("remote_token_required");
    expect(process.env.RKS_ISO_BOOT_SENTINEL).toBe("boot-loaded");
    expect(storageRoots).toContain(bootRoot);
  });

  it("positive control: in the ide lane the audit block still loads the named foreign project and binds telemetry to its root", async () => {
    boot({ via: "ide" });
    const f = foreign();
    await call("rks_exhaustive_search", { projectId: f.id, pattern: "x", path: "." });
    expect(process.env.RKS_ISO_FOREIGN_SENTINEL).toBe(f.sentinel);
    expect(storageRoots).toContain(f.root);
  });
});

describe("remote lane — the boot project's own .env cannot move lane or identity (Decision 2 through the server)", () => {
  it("after a boot call loads a .env setting RKS_VIA/RKS_VIA_DEFAULT/RKS_ACTOR/RKS_DISPATCH_RUN_ID, the process stays remote and a tokenless create is still refused", async () => {
    const bootRoot = boot({ via: "remote", envFile: HOSTILE_BOOT_ENV });
    const first = await call("dendron_read_note", { projectId: BOOT_ID, filename: NOTE_NAME });
    expect(first.json?.reason, first.text).toBe("remote_token_required");
    expect(process.env.RKS_ISO_BOOT_SENTINEL).toBe("boot-loaded"); // the .env was loaded
    expect(process.env.RKS_VIA).toBe("remote");
    expect("RKS_VIA_DEFAULT" in process.env).toBe(false);
    expect(process.env.RKS_ACTOR).toBe("grokbot");
    expect("RKS_DISPATCH_RUN_ID" in process.env).toBe(false);

    const name = "inbox.grokbot.after-boot-env";
    const second = await call("dendron_create_note", { projectId: BOOT_ID, filename: name, title: "x" });
    expect(second.json?.reason, second.text).toBe("remote_token_required");
    expect(second.text).not.toContain("_autoRouted");
    expect(fs.existsSync(path.join(bootRoot, "notes", `${name}.md`))).toBe(false);
  });
});

describe("remote lane — tokens must be remote sessions (Decision 3)", () => {
  it("a live token minted in the ide lane is refused remote_token_required in the remote lane; the note is not read and no query runs", async () => {
    boot({ via: "ide" });
    const token = await initToken();
    expect(getSession(token)?.via).toBe("ide");
    process.env.RKS_VIA = "remote";

    const read = await call("dendron_read_note", { projectId: BOOT_ID, filename: NOTE_NAME, _governorToken: token });
    expect(read.json?.reason, read.text).toBe("remote_token_required");
    expect(read.text).not.toContain(NOTE_BODY);
    const rag = await call("rks_rag_query", { projectId: BOOT_ID, q: "fixture", _governorToken: token });
    expect(rag.json?.reason, rag.text).toBe("remote_token_required");
    expect(runRagQuery).not.toHaveBeenCalled();
  });

  it("positive control: tokens minted in the remote lane are admitted for dendron_read_note and rks_rag_query", async () => {
    boot({ via: "remote" });
    const readToken = await initToken();
    expect(getSession(readToken)?.via).toBe("remote");
    const read = await call("dendron_read_note", { projectId: BOOT_ID, filename: NOTE_NAME, _governorToken: readToken });
    expect(read.json?.reason, read.text).toBeUndefined();
    expect(read.text).toContain(NOTE_BODY);

    const ragToken = await initToken();
    const rag = await call("rks_rag_query", { projectId: BOOT_ID, q: "fixture", _governorToken: ragToken });
    expect(rag.json?.reason, rag.text).toBeUndefined();
    expect(runRagQuery).toHaveBeenCalled();
  });

  it("a remote-lane rks_governor_init carrying an ide-minted token is refused remote_token_required; the ide session is not advanced or touched", async () => {
    boot({ via: "ide" });
    const token = await initToken();
    const stamp = Date.now() - 5_000;
    getSession(token).lastActivity = stamp;
    const stateBefore = getSession(token).state;
    process.env.RKS_VIA = "remote";

    const { json, text } = await call("rks_governor_init", { projectId: BOOT_ID, _governorToken: token });
    expect(json?.reason, text).toBe("remote_token_required");
    expect(getSession(token)?.state).toBe(stateBefore);
    expect(getSession(token)?.lastActivity).toBe(stamp);
  });

  it("positive control: a remote init carrying a live remote-minted token is admitted", async () => {
    boot({ via: "remote" });
    const token = await initToken();
    const { json, text } = await call("rks_governor_init", { projectId: BOOT_ID, _governorToken: token });
    // Only the lane gate is under test: what the session block does with a re-presented token is out of scope.
    expect(json?.reason, text).not.toBe("remote_token_required");
    expect(json?.lane, text).not.toBe("remote"); // a lane refusal carries lane: "remote"
  });

  it("a remote token idle past REMOTE_IDLE_MS is still refused remote_token_required", async () => {
    boot({ via: "remote" });
    const token = await initToken();
    getSession(token).lastActivity = Date.now() - REMOTE_IDLE_MS - 60_000;
    const read = await call("dendron_read_note", { projectId: BOOT_ID, filename: NOTE_NAME, _governorToken: token });
    expect(read.json?.reason, read.text).toBe("remote_token_required");
    expect(read.text).not.toContain(NOTE_BODY);
  });
});
