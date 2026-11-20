// backlog.feat.remote-surface-http-entry: the spawned loopback entry against a temp repo with a linked
// worktree, through the SDK StreamableHTTPClientTransport. No Cursor or Grok involvement. The child env
// has a temp HOME and a temp RKS_REGISTRY_PATH (VITEST kept), and drops NODE_ENV, RKS_TEST_MODE and
// RKS_SKIP_PREFLIGHT. spawn uses a setTimeout kill guard, cleared on close.
//
// SAFETY: the primary checkout and every linked worktree live inside one fresh temp dir. `git worktree
// add` runs only with cwd inside that temp repo, after asserting its git common dir is inside it.
// Every spawned entry is stopped (and awaited to exit) in afterAll.
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
import { RESERVED_NAMESPACES } from "@routekit/rag/utils";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const SPAWN_MS = 15_000;
const BOOT_WAIT_MS = 60_000;
const KILL_GUARD_MS = 180_000;
const PROJECT_ID = "http-entry-fixture";
const OTHER_ID = "http-entry-other";
const SECRET = `bearer-${crypto.randomBytes(24).toString("hex")}`; // 55 characters
const ACTOR = "grokbot";
const NOTE_NAME = "fixture.http-note";
const NOTE_BODY = `http-note-body-${crypto.randomUUID()}`;
const NOTE = `---\nid: "${NOTE_NAME}"\ntitle: "Http Fixture"\n---\n\n## Body\n\n${NOTE_BODY}\n`;
const HOSTILE_ENV = "RKS_VIA=ide\nRKS_VIA_DEFAULT=ide\nRKS_ACTOR=intruder\n";

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rks-http-entry-")));
const primary = path.join(tmpBase, "primary");
const otherProject = path.join(tmpBase, "other");
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

function writeProject(root, id) {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".routekit", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "hooks", ".gitkeep"), "");
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${id}\n`);
  fs.writeFileSync(path.join(root, "notes", `${NOTE_NAME}.md`), NOTE);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.rks/session/\n.rks/telemetry/\n.rks/state/\n");
}

function makeFixture() {
  fs.mkdirSync(tmpHome, { recursive: true });
  writeProject(primary, PROJECT_ID);
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "http@test.invalid"]);
  git(primary, ["config", "user.name", "Http Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "fixture", "--no-verify"]);
  const common = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
  if (!fs.realpathSync(common).startsWith(tmpBase)) throw new Error(`temp repo common dir escaped: ${common}`);
  writeProject(otherProject, OTHER_ID);
  // The registry maps the SAME project id to the primary checkout (the root hazard), plus another project.
  fs.writeFileSync(registryPath, [
    JSON.stringify({ id: PROJECT_ID, root: primary, path: primary }),
    JSON.stringify({ id: OTHER_ID, root: otherProject, path: otherProject }),
  ].join("\n") + "\n");
}

let wtCounter = 0;
/** A fresh linked worktree of the temp primary, on its own branch, with the bearer .env. */
function makeWorktree(extraEnv = "") {
  wtCounter += 1;
  const wt = path.join(tmpBase, `wt-${wtCounter}`);
  git(primary, ["worktree", "add", "-b", `remote/inbox-${wtCounter}`, wt]);
  fs.writeFileSync(path.join(wt, ".env"), `RKS_REMOTE_BEARER=${SECRET}\n${extraEnv}`);
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
      if (m) { clearTimeout(timer); entry.address = m[1]; entry.port = Number(m[2]); resolve(); }
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

/** A raw HTTP request (node:http, so the Host header can be set). */
function rawRequest(port, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, timeout: SPAWN_MS }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const INIT_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });

async function connectClient(entry) {
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } });
  const client = new Client({ name: "mcp-rks-http-entry-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
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

async function waitFor(fn, ms = 8_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
}

/** sha256 of every file under dir (relative path -> digest), for byte-identical comparisons. */
function treeDigest(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function primarySnapshot() {
  return {
    rks: treeDigest(path.join(primary, ".rks")),
    notes: treeDigest(path.join(primary, "notes")),
    head: git(primary, ["rev-parse", "HEAD"]),
    branch: git(primary, ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: git(primary, ["status", "--porcelain"]),
  };
}

function otherSnapshot() {
  return { rks: treeDigest(path.join(otherProject, ".rks")), notes: treeDigest(path.join(otherProject, "notes")) };
}

/** Runs init -> read -> create -> end and records server-side state at each step. */
// `extra(client)`, when given, runs on the chain's own client after rks_governor_end and before that
// client closes; its result is recorded as rec.extra.
async function runChain(entry, slug, extra) {
  const wt = entry.worktree;
  const client = await connectClient(entry);
  const rec = { wt, filename: `inbox.${ACTOR}.${slug}` };
  try {
    rec.init = await call(client, "rks_governor_init", { projectId: PROJECT_ID });
    const token = rec.init.json?.token;
    rec.token = token;
    rec.sessionFile = token ? path.join(wt, ".rks", "session", "governor", `${token}.json`) : null;
    rec.sessionAfterInit = rec.sessionFile && fs.existsSync(rec.sessionFile) ? JSON.parse(fs.readFileSync(rec.sessionFile, "utf8")) : null;
    rec.leasesAfterInit = listDir(path.join(wt, ".rks", "session", "lease")).map((f) => JSON.parse(fs.readFileSync(path.join(wt, ".rks", "session", "lease", f), "utf8")));
    rec.read = await call(client, "dendron_read_note", { filename: NOTE_NAME, projectId: PROJECT_ID, _governorToken: token });
    rec.create = await call(client, "dendron_create_note", { filename: rec.filename, title: "Inbox", content: `hello from ${slug}`, projectId: PROJECT_ID, _governorToken: token });
    rec.end = await call(client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: token });
    rec.sessionExistsAfterEnd = rec.sessionFile ? fs.existsSync(rec.sessionFile) : null;
    rec.leasesAfterEnd = listDir(path.join(wt, ".rks", "session", "lease"));
    if (extra) rec.extra = await extra(client);
  } finally {
    await client.close().catch(() => {});
  }
  rec.commitMessage = git(wt, ["log", "-1", "--format=%B"]);
  rec.commitFiles = git(wt, ["show", "--name-only", "--format=", "HEAD"]);
  return rec;
}

beforeAll(() => {
  makeFixture();
});

afterAll(async () => {
  for (const e of entries) {
    try { await stopEntry(e); } catch { /* best-effort */ }
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
}, 30_000);

describe("mcp-rks-http front door", () => {
  let entry;
  beforeAll(async () => {
    entry = await startEntry(makeWorktree());
  }, BOOT_WAIT_MS + 5_000);
  afterAll(async () => { if (entry) await stopEntry(entry); }, 15_000);

  it("answers 401 with no header, a wrong bearer and a different-length bearer; no session record, no mcp.tool.* event", async () => {
    const wrongSame = SECRET.slice(0, -1) + (SECRET.endsWith("0") ? "1" : "0");
    expect(wrongSame.length).toBe(SECRET.length);
    for (const headers of [{}, { authorization: `Bearer ${wrongSame}` }, { authorization: `Bearer ${SECRET}x` }, { authorization: `Bearer ${SECRET.slice(0, 20)}` }, { authorization: `Basic ${SECRET}` }]) {
      const r = await rawRequest(entry.port, { headers, body: INIT_BODY });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body).not.toContain("jsonrpc");
    }
    const sessionDir = path.join(entry.worktree, ".rks", "session", "governor");
    expect(listDir(sessionDir)).toEqual([]);

    // Positive control on the same process: an authenticated session IS recorded, and the
    // telemetry buffer (flushed once storage binds) carries mcp.tool.* only for that call.
    const client = await connectClient(entry);
    try {
      const init = await call(client, "rks_governor_init", { projectId: PROJECT_ID });
      expect(init.json?.ok, init.text).toBe(true);
      expect(listDir(sessionDir).length).toBe(1);
      await call(client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: init.json.token });
    } finally {
      await client.close().catch(() => {});
    }
    const toolEvents = await waitFor(() => {
      const evs = readEvents(entry.worktree).filter((e) => e.type.startsWith("mcp.tool."));
      return evs.length >= 2 ? evs : null;
    });
    expect(toolEvents, "mcp.tool events flushed").toBeTruthy();
    expect(toolEvents.map((e) => e.payload?.tool).sort()).toEqual(["rks_governor_end", "rks_governor_init"]);
    expect(entry.output()).not.toContain(SECRET);
  }, 60_000);

  it("rejects a correct-bearer request whose Host header is outside the allowed hosts", async () => {
    const before = readEvents(entry.worktree).length;
    for (const host of ["evil.example", `evil.example:${entry.port}`, "127.0.0.1", `127.0.0.1:${entry.port + 1}`]) {
      const r = await rawRequest(entry.port, { headers: { authorization: `Bearer ${SECRET}`, host }, body: INIT_BODY });
      expect(r.status, host).toBe(403);
      expect(r.body, host).toContain("Invalid Host header");
    }
    await new Promise((r) => setTimeout(r, 300));
    const after = readEvents(entry.worktree);
    expect(after.slice(before).filter((e) => e.type.startsWith("mcp.tool."))).toEqual([]);
  }, 30_000);

  it("listens on 127.0.0.1", () => {
    expect(entry.address).toBe("127.0.0.1");
    const lsof = spawnSync("lsof", ["-nP", "-a", "-p", String(entry.child.pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: SPAWN_MS });
    if (!lsof.error) {
      expect(lsof.stdout).toContain(`127.0.0.1:${entry.port}`);
      expect(lsof.stdout).not.toMatch(/\*:\d+|0\.0\.0\.0:/);
    }
  });
});

describe("mcp-rks-http acceptance chain (registry maps the project id to the primary checkout)", () => {
  let entry;
  let before;
  let rec;
  beforeAll(async () => {
    const wt = makeWorktree();
    before = primarySnapshot();
    entry = await startEntry(wt);
    rec = await runChain(entry, "hello");
  }, BOOT_WAIT_MS + 60_000);
  afterAll(async () => { if (entry) await stopEntry(entry); }, 15_000);

  it("init, read, create and end all return ok", () => {
    expect(rec.init.json?.ok, rec.init.text).toBe(true);
    expect(rec.read.res.isError, rec.read.text).toBeFalsy();
    expect(rec.read.json?.ok, rec.read.text).not.toBe(false);
    expect(rec.create.json?.ok, rec.create.text).toBe(true);
    expect(rec.create.json?.commitOk, rec.create.text).toBe(true);
    expect(rec.end.json?.ok, rec.end.text).toBe(true);
  });

  it("dendron_read_note returns the existing note's content", () => {
    expect(rec.read.text).toContain(NOTE_BODY);
  });

  it("the created note exists under RKS_REMOTE_ROOT/notes and not in the primary, whose HEAD and status are unchanged", () => {
    expect(fs.existsSync(path.join(rec.wt, "notes", `${rec.filename}.md`))).toBe(true);
    expect(fs.existsSync(path.join(primary, "notes", `${rec.filename}.md`))).toBe(false);
    const after = primarySnapshot();
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe(before.status);
  });

  it("the note commit on the worktree branch carries an Rks-Provenance trailer with via=remote and the pinned actor", () => {
    expect(rec.commitFiles).toBe(`notes/${rec.filename}.md`);
    const trailer = rec.commitMessage.split("\n").find((l) => l.startsWith("Rks-Provenance:"));
    expect(trailer, rec.commitMessage).toBeTruthy();
    expect(trailer).toMatch(/\bvia=remote\b/);
    expect(trailer).toMatch(new RegExp(`\\bactor=${ACTOR}\\b`));
  });

  it("the session record is created under RKS_REMOTE_ROOT with via remote and is ended after rks_governor_end", () => {
    expect(rec.sessionAfterInit, "session record after init").toBeTruthy();
    expect(rec.sessionAfterInit.via).toBe("remote");
    expect(rec.sessionAfterInit.actor).toBe(ACTOR);
    expect(rec.sessionAfterInit.projectId).toBe(PROJECT_ID);
    expect(rec.sessionExistsAfterEnd).toBe(false);
  });

  it("lease.acquired with via remote is recorded and the lease is released after rks_governor_end", async () => {
    expect(rec.leasesAfterInit.length).toBe(1);
    expect(rec.leasesAfterEnd).toEqual([]);
    const evs = await waitFor(() => {
      const all = readEvents(rec.wt);
      return all.some((e) => e.type === "lease.released") ? all : null;
    });
    expect(evs, "lease events flushed").toBeTruthy();
    const acquired = evs.filter((e) => e.type === "lease.acquired");
    expect(acquired.length).toBe(1);
    expect(acquired[0].payload.via).toBe("remote");
    expect(acquired[0].payload.actor).toBe(ACTOR);
    expect(evs.filter((e) => e.type === "lease.released").length).toBe(1);
  });

  it("the created inbox note is excluded from RAG embedding by the inbox. reserved namespace", () => {
    expect(RESERVED_NAMESPACES).toContain("inbox.");
    const rel = path.relative(path.join(rec.wt, "notes"), path.join(rec.wt, "notes", `${rec.filename}.md`));
    expect(RESERVED_NAMESPACES.some((ns) => rel.startsWith(ns))).toBe(true);
    expect(rec.create.json?.ragEmbedWarning).toBeUndefined();
  });

  it("root pinning: session, lease and note land under RKS_REMOTE_ROOT; the primary .rks and notes trees are byte-identical", () => {
    expect(rec.sessionFile.startsWith(path.join(rec.wt, ".rks"))).toBe(true);
    const after = primarySnapshot();
    expect(after.rks).toEqual(before.rks);
    expect(after.notes).toEqual(before.notes);
    expect(fs.existsSync(path.join(primary, ".rks", "session"))).toBe(false);
    expect(fs.existsSync(path.join(primary, ".rks", "telemetry"))).toBe(false);
  });
});

describe("mcp-rks-http pinning", () => {
  it("ignores a conflicting launch-env ROUTEKIT_PROJECT_ID", async () => {
    const wt = makeWorktree();
    const beforePrimary = primarySnapshot();
    const beforeOther = otherSnapshot();
    const entry = await startEntry(wt, { ROUTEKIT_PROJECT_ID: OTHER_ID, ROUTEKIT_PROJECT_ROOT: otherProject, RKS_VIA: "ide" });
    try {
      // The other project's id is refused by the remote lane pin.
      const rec = await runChain(entry, "conflict", (client) => call(client, "rks_governor_init", { projectId: OTHER_ID }));
      expect(rec.init.json?.ok, rec.init.text).toBe(true);
      expect(rec.create.json?.ok, rec.create.text).toBe(true);
      expect(rec.end.json?.ok, rec.end.text).toBe(true);
      expect(rec.sessionAfterInit?.projectId).toBe(PROJECT_ID);
      expect(rec.sessionAfterInit?.via).toBe("remote");
      expect(fs.existsSync(path.join(wt, "notes", `${rec.filename}.md`))).toBe(true);
      const afterPrimary = primarySnapshot();
      expect(afterPrimary.rks).toEqual(beforePrimary.rks);
      expect(afterPrimary.notes).toEqual(beforePrimary.notes);
      expect(afterPrimary.status).toBe(beforePrimary.status);
      expect(otherSnapshot()).toEqual(beforeOther);
      expect(rec.extra.json?.reason, rec.extra.text).toBe("remote_project_mismatch");
    } finally {
      await stopEntry(entry);
    }
  }, BOOT_WAIT_MS + 60_000);

  it("keeps lane remote and the launch actor despite a hostile worktree .env", async () => {
    const wt = makeWorktree(HOSTILE_ENV);
    const entry = await startEntry(wt);
    try {
      const rec = await runChain(entry, "hostile");
      expect(rec.init.json?.ok, rec.init.text).toBe(true);
      expect(rec.sessionAfterInit?.via).toBe("remote");
      expect(rec.sessionAfterInit?.actor).toBe(ACTOR);
      expect(rec.create.json?.ok, rec.create.text).toBe(true);
      const trailer = rec.commitMessage.split("\n").find((l) => l.startsWith("Rks-Provenance:"));
      expect(trailer).toMatch(/\bvia=remote\b/);
      expect(trailer).toMatch(new RegExp(`\\bactor=${ACTOR}\\b`));
      expect(trailer).not.toContain("intruder");
    } finally {
      await stopEntry(entry);
    }
  }, BOOT_WAIT_MS + 60_000);
});

describe("mcp-rks-http remote lane refusals", () => {
  let entry;
  let client;
  beforeAll(async () => {
    entry = await startEntry(makeWorktree());
    client = await connectClient(entry);
  }, BOOT_WAIT_MS + 5_000);
  afterAll(async () => {
    await client?.close().catch(() => {});
    if (entry) await stopEntry(entry);
  }, 15_000);

  function laneRefusals() {
    return readEvents(entry.worktree).filter((e) => e.type === "lane.refused");
  }

  it("refuses rks_exhaustive_search with remote_tool_not_allowed", async () => {
    const r = await call(client, "rks_exhaustive_search", { projectId: PROJECT_ID, pattern: "x", path: "." });
    expect(r.json?.reason, r.text).toBe("remote_tool_not_allowed");
    const evs = await waitFor(() => {
      const found = laneRefusals().filter((e) => e.payload?.tool === "rks_exhaustive_search");
      return found.length ? found : null;
    });
    expect(evs, "lane.refused flushed").toBeTruthy();
    expect(evs[0].payload).toMatchObject({ lane: "remote", reason: "remote_tool_not_allowed" });
  }, 30_000);

  it("refuses a tokenless dendron_create_note with remote_token_required", async () => {
    const filename = `inbox.${ACTOR}.tokenless`;
    const r = await call(client, "dendron_create_note", { projectId: PROJECT_ID, filename, title: "x" });
    expect(r.json?.reason, r.text).toBe("remote_token_required");
    expect(fs.existsSync(path.join(entry.worktree, "notes", `${filename}.md`))).toBe(false);
    const evs = await waitFor(() => {
      const found = laneRefusals().filter((e) => e.payload?.tool === "dendron_create_note");
      return found.length ? found : null;
    });
    expect(evs, "lane.refused flushed").toBeTruthy();
    expect(evs[0].payload).toMatchObject({ lane: "remote", reason: "remote_token_required" });
  }, 30_000);
});
