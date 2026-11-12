// backlog.feat.remote-http-entry-multi-session
// The spawned loopback entry serving many MCP sessions from one process: re-initialize without a
// restart, concurrent sessions, routing by mcp-session-id (404 / 400 / 503), slot accounting for
// rejected initializes, idle eviction, one boot per process, the unchanged bearer and Host front door,
// boot refusals for invalid session bounds, and observed shutdown reporting.
// backlog.fix.http-entry-idle-eviction-inflight: an open GET SSE stream keeps its session from idle
// eviction until the stream closes, and SIGTERM still closes a session holding one.
//
// Harness follows tests/integration/mcp-rks-http-entry.test.mjs: one fresh temp base holding the
// primary checkout, its linked worktrees, a temp HOME and a temp RKS_REGISTRY_PATH. The child env drops
// NODE_ENV, RKS_TEST_MODE and RKS_SKIP_PREFLIGHT. spawn uses a setTimeout kill guard cleared on close;
// every spawnSync passes `timeout:`. No test reads or writes the real repo .rks, notes or registry.
//
// The bin's stderr lines carry the "[mcp-rks-http] " prefix; brackets are regex specials, so these
// lines are matched as plain substrings here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const SPAWN_MS = 15_000;
const BOOT_WAIT_MS = 60_000;
const KILL_GUARD_MS = 180_000;
const PROJECT_ID = "http-multi-fixture";
const SECRET = `bearer-${crypto.randomBytes(24).toString("hex")}`; // 55 characters
const ACTOR = "grokbot";
const PREFIX = "[mcp-rks-http] ";
const RELEASED_TRUE = `${PREFIX}released uninitialized session (closed: true)`;
const RELEASED_FALSE = `${PREFIX}released uninitialized session (closed: false)`;
const EVICTED_TRUE = `${PREFIX}evicted idle session (closed: true)`;

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rks-http-multi-")));
const primary = path.join(tmpBase, "primary");
const tmpHome = path.join(tmpBase, "home");
const registryPath = path.join(tmpBase, "registry.jsonl");
const entries = [];

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  return env;
}

function git(cwd, args) {
  if (!fs.realpathSync(cwd).startsWith(tmpBase)) throw new Error(`refusing git outside the temp base: ${cwd}`);
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeFixture() {
  fs.mkdirSync(tmpHome, { recursive: true });
  const root = primary;
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".routekit", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "hooks", ".gitkeep"), "");
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${PROJECT_ID}\n`);
  fs.writeFileSync(path.join(root, "notes", "fixture.multi.md"), `---\nid: "fixture.multi"\ntitle: "Multi"\n---\n\nbody\n`);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.rks/session/\n.rks/telemetry/\n.rks/state/\n");
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "http@test.invalid"]);
  git(primary, ["config", "user.name", "Http Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "fixture", "--no-verify"]);
  const common = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
  if (!fs.realpathSync(common).startsWith(tmpBase)) throw new Error(`temp repo common dir escaped: ${common}`);
  fs.writeFileSync(registryPath, JSON.stringify({ id: PROJECT_ID, root: primary, path: primary }) + "\n");
}

let wtCounter = 0;
/** A fresh linked worktree of the temp primary, on its own branch, with the bearer .env. */
function makeWorktree() {
  wtCounter += 1;
  const wt = path.join(tmpBase, `wt-${wtCounter}`);
  git(primary, ["worktree", "add", "-b", `remote/multi-${wtCounter}`, wt]);
  fs.writeFileSync(path.join(wt, ".env"), `RKS_REMOTE_BEARER=${SECRET}\n`);
  return wt;
}

function childEnv(worktree, extra = {}) {
  const env = gitEnv();
  for (const k of Object.keys(env)) {
    if (k.startsWith("RKS_") || k.startsWith("ROUTEKIT_") || k === "CLAUDE_PROJECT_DIR" || k === "NODE_ENV" || k === "DENDRON_VAULT_PATH") delete env[k];
  }
  env.HOME = tmpHome;
  env.VITEST = env.VITEST || "true";
  env.RKS_REGISTRY_PATH = registryPath;
  env.RKS_REMOTE_ROOT = worktree;
  env.RKS_ACTOR = ACTOR;
  env.RKS_REMOTE_PORT = "0";
  env.RKS_TELEMETRY_BUFFER_SIZE = "1";
  // backlog.fix.remote-rag-query-inline-full-index-build: no real embed at boot in this harness.
  env.RKS_REMOTE_BOOT_INDEX = "skip";
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Spawn the entry and resolve once it logs its listening line. */
async function startEntry(worktree, extra = {}) {
  const child = spawn(process.execPath, [BIN], { env: childEnv(worktree, extra), cwd: tmpBase, stdio: ["ignore", "pipe", "pipe"] });
  const guard = setTimeout(() => child.kill("SIGKILL"), KILL_GUARD_MS);
  let output = "";
  const exited = new Promise((resolve) => child.on("close", (code, signal) => { clearTimeout(guard); resolve({ code, signal }); }));
  const entry = { child, exited, worktree, output: () => output, port: null, address: null };
  entries.push(entry);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`entry did not start within ${BOOT_WAIT_MS}ms:\n${output}`)), BOOT_WAIT_MS);
    const onData = (buf) => {
      output += buf.toString();
      const m = /listening on http:\/\/([^\s/]+):(\d+)\/mcp/.exec(output);
      if (m && entry.port === null) { clearTimeout(timer); entry.address = m[1]; entry.port = Number(m[2]); resolve(); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`entry exited (${code}) before listening:\n${output}`)); });
  });
  entry.url = `http://127.0.0.1:${entry.port}/mcp`;
  return entry;
}

async function stopEntry(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return entry.exited;
  entry.child.kill("SIGTERM");
  const t = setTimeout(() => entry.child.kill("SIGKILL"), 5_000);
  const r = await entry.exited;
  clearTimeout(t);
  return r;
}

/** A raw HTTP request (node:http, so Host and mcp-session-id can be set). */
function rawRequest(port, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, timeout: SPAWN_MS }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Open a standalone GET SSE stream on a session. Resolves once the response headers arrive with
 * { status, headers, close() }; close() destroys the client side of the stream.
 */
function openSseStream(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", headers: { ...AUTH, accept: "text/event-stream", "mcp-session-id": sessionId }, timeout: SPAWN_MS }, (res) => {
      res.on("data", () => {});
      res.on("error", () => {});
      resolve({ status: res.statusCode, headers: res.headers, close: () => { res.destroy(); req.destroy(); } });
    });
    req.on("timeout", () => req.destroy(new Error("sse request timeout")));
    req.on("error", (err) => reject(err));
    req.end();
  });
}

const AUTH = { authorization: `Bearer ${SECRET}` };
const INIT_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
const PING_BODY = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
// A tool call that, were it to reach an MCP server, would emit mcp.tool.* telemetry.
const TOOL_BODY = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rks_governor_init", arguments: { projectId: PROJECT_ID } } });

/** A raw initialize with the correct bearer; returns { status, sessionId, body }. */
async function rawInit(entry, headers = {}) {
  const r = await rawRequest(entry.port, { headers: { ...AUTH, ...headers }, body: INIT_BODY });
  return { status: r.status, sessionId: r.headers["mcp-session-id"] ?? null, body: r.body };
}

function rawPing(entry, sessionId, headers = {}) {
  return rawRequest(entry.port, { headers: { ...AUTH, "mcp-session-id": sessionId, ...headers }, body: PING_BODY });
}

function rawDelete(entry, sessionId) {
  return rawRequest(entry.port, { method: "DELETE", headers: { ...AUTH, "mcp-session-id": sessionId } });
}

async function connectClient(entry) {
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } });
  const client = new Client({ name: "mcp-rks-http-multi-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** Close a client, terminating its session first so its slot is freed. */
async function closeClient(c, { terminate = true } = {}) {
  if (terminate) await c.transport.terminateSession().catch(() => {});
  await c.client.close().catch(() => {});
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, text, json };
}

function readEvents(root) {
  const dir = path.join(root, ".rks", "telemetry");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith("events-") && n.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}

const toolEvents = (root) => readEvents(root).filter((e) => typeof e.type === "string" && e.type.startsWith("mcp.tool."));

async function waitFor(fn, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Count plain-substring occurrences (no regex, so the bracketed prefix needs no escaping). */
function countOf(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/**
 * Positive control for the no-event checks: a session on the same process runs rks_governor_init and
 * rks_governor_end, and their two mcp.tool.* events are observed flushed to the worktree telemetry.
 * Returns the observed tool-event count.
 */
async function telemetryPositiveControl(entry) {
  const before = toolEvents(entry.worktree).length;
  const c = await connectClient(entry);
  try {
    const init = await call(c.client, "rks_governor_init", { projectId: PROJECT_ID });
    expect(init.json?.ok, init.text).toBe(true);
    const end = await call(c.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: init.json.token });
    expect(end.json?.ok, end.text).toBe(true);
  } finally {
    await closeClient(c);
  }
  const evs = await waitFor(() => {
    const all = toolEvents(entry.worktree);
    return all.length >= before + 2 ? all : null;
  });
  expect(evs, "mcp.tool events flushed").toBeTruthy();
  expect(evs.slice(before).map((e) => e.payload?.tool).sort()).toEqual(["rks_governor_end", "rks_governor_init"]);
  return evs.length;
}

beforeAll(() => {
  makeFixture();
});

afterAll(async () => {
  for (const e of entries) {
    try { await stopEntry(e); } catch { /* best-effort */ }
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
}, 60_000);

// One default-bounds entry shared by the re-initialize, concurrent, boot-count and front-door cases.
let shared;
async function sharedEntry() {
  if (!shared) shared = await startEntry(makeWorktree());
  return shared;
}

describe("mcp-rks-http multi-session: re-initialize", () => {
  it("a second fresh client initializes against the same process after the first closes", async () => {
    const entry = await sharedEntry();
    const pid = entry.child.pid;

    const first = await connectClient(entry);
    let init1;
    try {
      init1 = await call(first.client, "rks_governor_init", { projectId: PROJECT_ID });
      expect(init1.json?.ok, init1.text).toBe(true);
      await call(first.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: init1.json.token });
    } finally {
      await closeClient(first, { terminate: false });
    }

    const second = await connectClient(entry);
    try {
      const init2 = await call(second.client, "rks_governor_init", { projectId: PROJECT_ID });
      expect(init2.json?.ok, init2.text).toBe(true);
      await call(second.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: init2.json.token });
      expect(second.transport.sessionId).toBeTruthy();
      expect(second.transport.sessionId).not.toBe(first.transport.sessionId);
    } finally {
      await closeClient(second);
    }
    // Same process, no restart.
    expect(entry.child.pid).toBe(pid);
    expect(entry.child.exitCode).toBe(null);
    expect(countOf(entry.output(), "listening on")).toBe(1);
  }, BOOT_WAIT_MS + 60_000);

  it("positive control: a single StreamableHTTPServerTransport rejects a second initialize", async () => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
    const server = new Server({ name: "single-transport-control", version: "0.0.0" }, { capabilities: {} });
    await server.connect(transport);
    const httpServer = http.createServer((req, res) => {
      transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); });
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address();
    try {
      const a = await rawRequest(port, { body: INIT_BODY });
      expect(a.status).toBe(200);
      expect(a.headers["mcp-session-id"]).toBeTruthy();
      const b = await rawRequest(port, { body: INIT_BODY });
      expect(b.status).toBe(400);
      expect(b.body).toContain("Server already initialized");
    } finally {
      await server.close().catch(() => {});
      await new Promise((resolve) => httpServer.close(resolve));
    }
  }, 30_000);
});

describe("mcp-rks-http multi-session: concurrent sessions", () => {
  it("two concurrent clients get distinct session ids and each lands an inbox note with via remote", async () => {
    const entry = await sharedEntry();
    const wt = entry.worktree;
    const [a, b] = await Promise.all([connectClient(entry), connectClient(entry)]);
    try {
      expect(a.transport.sessionId).toBeTruthy();
      expect(b.transport.sessionId).toBeTruthy();
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);

      const [initA, initB] = await Promise.all([
        call(a.client, "rks_governor_init", { projectId: PROJECT_ID }),
        call(b.client, "rks_governor_init", { projectId: PROJECT_ID }),
      ]);
      expect(initA.json?.ok, initA.text).toBe(true);
      expect(initB.json?.ok, initB.text).toBe(true);

      // Creates run one after another: each commits to the same worktree's git index.
      const recs = [];
      for (const [c, init, slug] of [[a, initA, "alpha"], [b, initB, "beta"]]) {
        const filename = `inbox.${ACTOR}.multi-${slug}`;
        const create = await call(c.client, "dendron_create_note", { filename, title: "Inbox", content: `hello from ${slug}`, projectId: PROJECT_ID, _governorToken: init.json.token });
        expect(create.json?.ok, create.text).toBe(true);
        expect(create.json?.commitOk, create.text).toBe(true);
        recs.push({ filename });
      }
      const [endA, endB] = await Promise.all([
        call(a.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: initA.json.token }),
        call(b.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: initB.json.token }),
      ]);
      expect(endA.json?.ok, endA.text).toBe(true);
      expect(endB.json?.ok, endB.text).toBe(true);

      for (const { filename } of recs) {
        expect(fs.existsSync(path.join(wt, "notes", `${filename}.md`))).toBe(true);
        expect(fs.existsSync(path.join(primary, "notes", `${filename}.md`))).toBe(false);
        const message = git(wt, ["log", "-1", "--format=%B", "--", `notes/${filename}.md`]);
        const trailer = message.split("\n").find((l) => l.startsWith("Rks-Provenance:"));
        expect(trailer, message).toBeTruthy();
        expect(trailer).toMatch(/\bvia=remote\b/);
        expect(trailer).toMatch(new RegExp(`\\bactor=${ACTOR}\\b`));
      }
    } finally {
      await closeClient(a);
      await closeClient(b);
    }
  }, BOOT_WAIT_MS + 90_000);
});

describe("mcp-rks-http multi-session: routing", () => {
  let entry; // RKS_REMOTE_MAX_SESSIONS=1
  beforeAll(async () => {
    entry = await startEntry(makeWorktree(), { RKS_REMOTE_MAX_SESSIONS: "1" });
  }, BOOT_WAIT_MS + 5_000);
  afterAll(async () => { if (entry) await stopEntry(entry); }, 15_000);

  it("unknown mcp-session-id gets 404 and creates no session", async () => {
    const observed = await telemetryPositiveControl(entry);
    const r = await rawRequest(entry.port, { headers: { ...AUTH, "mcp-session-id": crypto.randomUUID() }, body: TOOL_BODY });
    expect(r.status).toBe(404);
    // No session was created: a valid initialize still succeeds under a cap of 1.
    const init = await rawInit(entry);
    expect(init.status, init.body).toBe(200);
    expect(init.sessionId).toBeTruthy();
    expect((await rawDelete(entry, init.sessionId)).status).toBe(200);
    await sleep(500);
    expect(toolEvents(entry.worktree).length).toBe(observed);
  }, 60_000);

  it("non-initialize request without mcp-session-id gets 400 and creates no session", async () => {
    const observed = await telemetryPositiveControl(entry);
    const r = await rawRequest(entry.port, { headers: AUTH, body: TOOL_BODY });
    expect(r.status).toBe(400);
    expect(r.headers["mcp-session-id"]).toBeUndefined();
    const init = await rawInit(entry);
    expect(init.status, init.body).toBe(200);
    expect((await rawDelete(entry, init.sessionId)).status).toBe(200);
    await sleep(500);
    expect(toolEvents(entry.worktree).length).toBe(observed);
  }, 60_000);

  it("initialize over RKS_REMOTE_MAX_SESSIONS gets 503; closing a session frees a slot", async () => {
    const capped = await startEntry(makeWorktree(), { RKS_REMOTE_MAX_SESSIONS: "2" });
    try {
      const s1 = await rawInit(capped);
      const s2 = await rawInit(capped);
      expect(s1.status).toBe(200);
      expect(s2.status).toBe(200);
      expect(s1.sessionId).not.toBe(s2.sessionId);
      const over = await rawInit(capped);
      expect(over.status).toBe(503);
      expect(over.sessionId).toBe(null);
      // Both live sessions still work; the 503 created nothing.
      expect((await rawPing(capped, s1.sessionId)).status).toBe(200);
      expect((await rawPing(capped, s2.sessionId)).status).toBe(200);
      expect((await rawDelete(capped, s1.sessionId)).status).toBe(200);
      expect((await rawPing(capped, s1.sessionId)).status).toBe(404);
      const s3 = await rawInit(capped);
      expect(s3.status, s3.body).toBe(200);
      expect(s3.sessionId).toBeTruthy();
    } finally {
      await stopEntry(capped);
    }
  }, BOOT_WAIT_MS + 30_000);

  it("rejected initializes do not occupy a session slot", async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await rawInit(entry, { host: "evil.example" });
      expect(r.status).toBe(403);
    }
    const live = await rawInit(entry);
    expect(live.status, live.body).toBe(200);
    for (let i = 0; i < 2; i += 1) {
      const r = await rawInit(entry);
      expect(r.status).toBe(503);
    }
    expect((await rawDelete(entry, live.sessionId)).status).toBe(200);
    const again = await rawInit(entry);
    expect(again.status, again.body).toBe(200);
    expect((await rawDelete(entry, again.sessionId)).status).toBe(200);
  }, 60_000);

  it("two simultaneous initializes under RKS_REMOTE_MAX_SESSIONS=1 yield exactly one session and one 503", async () => {
    // Both requests are issued before either response is awaited.
    const pa = rawInit(entry);
    const pb = rawInit(entry);
    const results = await Promise.all([pa, pb]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 503]);
    const winner = results.find((r) => r.status === 200);
    const loser = results.find((r) => r.status === 503);
    expect(winner.sessionId).toBeTruthy();
    expect(loser.sessionId).toBe(null);
    // Only one session is usable afterwards: the winner answers, and the cap is still held.
    expect((await rawPing(entry, winner.sessionId)).status).toBe(200);
    expect((await rawInit(entry)).status).toBe(503);
    expect((await rawDelete(entry, winner.sessionId)).status).toBe(200);
  }, 60_000);

  it("each 403 initialize logs released uninitialized session (closed: true)", async () => {
    const N = 3;
    const before = countOf(entry.output(), RELEASED_TRUE);
    for (let i = 0; i < N; i += 1) {
      const r = await rawInit(entry, { host: `evil-${i}.example` });
      expect(r.status).toBe(403);
      expect(r.body).toContain("Invalid Host header");
    }
    await waitFor(() => countOf(entry.output(), RELEASED_TRUE) >= before + N);
    expect(countOf(entry.output(), RELEASED_TRUE) - before).toBe(N);
    expect(entry.output()).not.toContain(RELEASED_FALSE);
  }, 60_000);

  it("idle session is evicted after RKS_REMOTE_SESSION_IDLE_MS", async () => {
    const idle = await startEntry(makeWorktree(), { RKS_REMOTE_MAX_SESSIONS: "1", RKS_REMOTE_SESSION_IDLE_MS: "1500" });
    try {
      const s = await rawInit(idle);
      expect(s.status, s.body).toBe(200);
      // While live, the slot is held.
      expect((await rawInit(idle)).status).toBe(503);
      const evicted = await waitFor(() => idle.output().includes(EVICTED_TRUE), 15_000);
      expect(evicted, idle.output()).toBe(true);
      expect((await rawPing(idle, s.sessionId)).status).toBe(404);
      const next = await rawInit(idle);
      expect(next.status, next.body).toBe(200);
    } finally {
      await stopEntry(idle);
    }
  }, BOOT_WAIT_MS + 40_000);

  it("an open GET SSE stream keeps its session past 2x RKS_REMOTE_SESSION_IDLE_MS; closing it lets eviction run", async () => {
    const idle = await startEntry(makeWorktree(), { RKS_REMOTE_MAX_SESSIONS: "1", RKS_REMOTE_SESSION_IDLE_MS: "1500" });
    let stream = null;
    try {
      const s = await rawInit(idle);
      expect(s.status, s.body).toBe(200);
      stream = await openSseStream(idle.port, s.sessionId);
      expect(stream.status).toBe(200);
      expect(stream.headers["content-type"]).toContain("text/event-stream");
      // More than 2x the idle timeout with no other request on the session.
      await sleep(3_500);
      expect(idle.output(), idle.output()).not.toContain("evicted idle session");
      expect((await rawInit(idle)).status).toBe(503);
      stream.close();
      stream = null;
      const evicted = await waitFor(() => idle.output().includes(EVICTED_TRUE), 15_000);
      expect(evicted, idle.output()).toBe(true);
      expect((await rawPing(idle, s.sessionId)).status).toBe(404);
    } finally {
      if (stream) stream.close();
      await stopEntry(idle);
    }
  }, BOOT_WAIT_MS + 40_000);

  it("exactly one mcp.server.start event after several sessions", async () => {
    // Runs after the shared entry's re-initialize and concurrent cases (4 sessions) and adds two more.
    const e = await sharedEntry();
    for (let i = 0; i < 2; i += 1) {
      const c = await connectClient(e);
      await closeClient(c);
    }
    // Sessions created on this process so far: at least three.
    const starts = await waitFor(() => {
      const s = readEvents(e.worktree).filter((ev) => ev.type === "mcp.server.start");
      return s.length ? s : null;
    });
    expect(starts, "mcp.server.start flushed").toBeTruthy();
    await sleep(300);
    expect(readEvents(e.worktree).filter((ev) => ev.type === "mcp.server.start").length).toBe(1);
  }, BOOT_WAIT_MS + 30_000);
});

describe("mcp-rks-http multi-session: front door", () => {
  it("401 before routing even with a live or unknown mcp-session-id", async () => {
    const entry = await sharedEntry();
    const c = await connectClient(entry);
    try {
      const live = c.transport.sessionId;
      expect(live).toBeTruthy();
      const wrong = SECRET.slice(0, -1) + (SECRET.endsWith("0") ? "1" : "0");
      for (const sid of [live, crypto.randomUUID()]) {
        for (const bearer of [{}, { authorization: `Bearer ${wrong}` }]) {
          for (const body of [PING_BODY, INIT_BODY]) {
            const r = await rawRequest(entry.port, { headers: { ...bearer, "mcp-session-id": sid }, body });
            expect(r.status, JSON.stringify({ sid, bearer })).toBe(401);
            expect(r.headers["www-authenticate"]).toBe("Bearer");
          }
        }
      }
      // The live session keeps working for the correct bearer.
      const init = await call(c.client, "rks_governor_init", { projectId: PROJECT_ID });
      expect(init.json?.ok, init.text).toBe(true);
      await call(c.client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: init.json.token });
    } finally {
      await closeClient(c);
    }
    expect(entry.output()).not.toContain(SECRET);
  }, 60_000);

  it("403 for a disallowed Host on a new-session initialize and on an existing session", async () => {
    const entry = await sharedEntry();
    const fresh = await rawInit(entry, { host: "evil.example" });
    expect(fresh.status).toBe(403);
    expect(fresh.body).toContain("Invalid Host header");
    const s = await rawInit(entry);
    expect(s.status, s.body).toBe(200);
    try {
      const r = await rawPing(entry, s.sessionId, { host: `evil.example:${entry.port}` });
      expect(r.status).toBe(403);
      expect(r.body).toContain("Invalid Host header");
      // The existing session is untouched by the refused request.
      expect((await rawPing(entry, s.sessionId)).status).toBe(200);
    } finally {
      await rawDelete(entry, s.sessionId);
    }
  }, 60_000);
});

describe("mcp-rks-http multi-session: boot and shutdown", () => {
  function spawnRefusal(extra) {
    const wt = makeWorktree();
    return spawnSync(process.execPath, [BIN], { env: childEnv(wt, extra), cwd: tmpBase, encoding: "utf8", timeout: SPAWN_MS });
  }

  it("invalid RKS_REMOTE_MAX_SESSIONS refuses boot with a named reason and no listen", () => {
    for (const value of ["0", "-1", "abc", "1.5"]) {
      const r = spawnRefusal({ RKS_REMOTE_MAX_SESSIONS: value });
      expect(r.error, value).toBeUndefined();
      expect(r.status, value).not.toBe(0);
      const line = r.stderr.split("\n").find((l) => l.includes("refusing to boot ("));
      expect(line, `${value}: ${r.stderr}`).toBeTruthy();
      expect(line).toContain("refusing to boot (remote_max_sessions_invalid)");
      expect(line).toContain("RKS_REMOTE_MAX_SESSIONS");
      expect(r.stderr).not.toContain("listening on");
    }
  }, 120_000);

  it("invalid RKS_REMOTE_SESSION_IDLE_MS refuses boot with a named reason and no listen", () => {
    for (const value of ["0", "-1", "abc"]) {
      const r = spawnRefusal({ RKS_REMOTE_SESSION_IDLE_MS: value });
      expect(r.error, value).toBeUndefined();
      expect(r.status, value).not.toBe(0);
      const line = r.stderr.split("\n").find((l) => l.includes("refusing to boot ("));
      expect(line, `${value}: ${r.stderr}`).toBeTruthy();
      expect(line).toContain("refusing to boot (remote_session_idle_ms_invalid)");
      expect(line).toContain("RKS_REMOTE_SESSION_IDLE_MS");
      expect(r.stderr).not.toContain("listening on");
    }
  }, 120_000);

  it("SIGTERM with two live sessions logs shutdown sessions=2 closed=2 failed=0 fallback=false and exits 0", async () => {
    const entry = await startEntry(makeWorktree());
    const a = await connectClient(entry);
    const b = await connectClient(entry);
    try {
      expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
      const r = await stopEntry(entry);
      expect(r.code, entry.output()).toBe(0);
      expect(entry.output()).toContain(`${PREFIX}shutdown sessions=2 closed=2 failed=0 fallback=false`);
      expect(entry.output()).not.toContain("shutdown fallback fired");
    } finally {
      await a.client.close().catch(() => {});
      await b.client.close().catch(() => {});
    }
  }, BOOT_WAIT_MS + 30_000);

  it("SIGTERM with a session holding an open GET SSE stream closes it and exits 0", async () => {
    const entry = await startEntry(makeWorktree());
    let stream = null;
    try {
      const s = await rawInit(entry);
      expect(s.status, s.body).toBe(200);
      stream = await openSseStream(entry.port, s.sessionId);
      expect(stream.status).toBe(200);
      const r = await stopEntry(entry);
      expect(r.code, entry.output()).toBe(0);
      expect(entry.output()).toContain(`${PREFIX}shutdown sessions=1 closed=1 failed=0 fallback=false`);
      expect(entry.output()).not.toContain("shutdown fallback fired");
    } finally {
      if (stream) stream.close();
    }
  }, BOOT_WAIT_MS + 30_000);

  // backlog.fix.remote-rag-query-inline-full-index-build. The bin's boot-index log lines, as plain substrings.
  const BOOT_INDEX_START = `${PREFIX}boot index: start`;
  const BOOT_INDEX_END = `${PREFIX}boot index: done`;
  const LISTENING = `${PREFIX}listening on`;

  it("boot with no index logs the boot index start and end lines before the listening line", async () => {
    const wt = makeWorktree();
    expect(fs.existsSync(path.join(wt, "notes", "fixture.multi.md"))).toBe(true);
    expect(fs.existsSync(path.join(wt, ".rks", "rag"))).toBe(false);
    // Knob unset (the real boot-index path); stub embeddings so no model download under the temp HOME.
    const entry = await startEntry(wt, { RKS_REMOTE_BOOT_INDEX: undefined, RKS_RAG_EMBEDDINGS_MODE: "stub" });
    try {
      const out = entry.output();
      const startAt = out.indexOf(BOOT_INDEX_START);
      const endAt = out.indexOf(BOOT_INDEX_END);
      const listenAt = out.indexOf(LISTENING);
      expect(startAt, out).toBeGreaterThan(-1);
      expect(endAt, out).toBeGreaterThan(startAt);
      expect(listenAt, out).toBeGreaterThan(endAt);
      expect(countOf(out, BOOT_INDEX_START)).toBe(1);
      expect(out).not.toContain("boot_index_failed");
      // The build left an index in the pinned worktree.
      expect(fs.readdirSync(path.join(wt, ".rks", "rag")).length).toBeGreaterThan(0);
    } finally {
      await stopEntry(entry);
    }
  }, BOOT_WAIT_MS + 30_000);

  it("boot with an index present logs no boot index start line", async () => {
    const wt = makeWorktree();
    const ragDir = path.join(wt, ".rks", "rag");
    fs.mkdirSync(ragDir, { recursive: true });
    fs.writeFileSync(path.join(ragDir, "present-marker"), "index present\n");
    const entry = await startEntry(wt, { RKS_REMOTE_BOOT_INDEX: undefined, RKS_RAG_EMBEDDINGS_MODE: "stub" });
    try {
      const out = entry.output();
      expect(out, out).toContain(LISTENING);
      expect(out).not.toContain(BOOT_INDEX_START);
      expect(out).not.toContain(BOOT_INDEX_END);
      expect(fs.readdirSync(ragDir)).toEqual(["present-marker"]);
    } finally {
      await stopEntry(entry);
    }
  }, BOOT_WAIT_MS + 30_000);

  it("RKS_REMOTE_BOOT_INDEX=skip logs no boot index start line", async () => {
    const wt = makeWorktree();
    expect(fs.existsSync(path.join(wt, ".rks", "rag"))).toBe(false);
    const entry = await startEntry(wt, { RKS_REMOTE_BOOT_INDEX: "skip" });
    try {
      const out = entry.output();
      expect(out, out).toContain(LISTENING);
      expect(out).not.toContain(BOOT_INDEX_START);
      expect(out).not.toContain(BOOT_INDEX_END);
      // No index was built: the worktree still has none.
      const ragDir = path.join(wt, ".rks", "rag");
      expect(fs.existsSync(ragDir) ? fs.readdirSync(ragDir) : []).toEqual([]);
    } finally {
      await stopEntry(entry);
    }
  }, BOOT_WAIT_MS + 30_000);

  it("--help describes multi-session behavior", () => {
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", timeout: SPAWN_MS });
    expect(r.status).toBe(0);
    const help = r.stdout + r.stderr;
    expect(help).toContain("Multi-session");
    expect(help).toContain("mcp-session-id");
    expect(help).toContain("RKS_REMOTE_MAX_SESSIONS");
    expect(help).toContain("RKS_REMOTE_SESSION_IDLE_MS");
    expect(help).not.toContain("one MCP session");
    expect(help).not.toContain("per process lifetime");
    const src = fs.readFileSync(BIN, "utf8");
    expect(src).not.toContain("one MCP session");
    expect(src).not.toContain("per process lifetime");
  }, 30_000);

  it("the http entry test source carries no single-session-per-process claim", () => {
    const entrySrc = fs.readFileSync(path.join(ROOT, "tests/integration/mcp-rks-http-entry.test.mjs"), "utf8");
    expect(entrySrc).toContain("async function runChain(");
    expect(entrySrc).not.toContain("One stateful transport per process");
    expect(entrySrc).not.toContain("one MCP session");
    expect(entrySrc).not.toContain("per process lifetime");
  });
});
