// backlog.fix.remote-http-entry-env-leaks: the remote entry's process.env, notes location and git target
// after a full acceptance chain (rks_governor_init -> dendron_read_note -> dendron_create_note ->
// rks_governor_end), under a hostile LAUNCH env and under a hostile worktree .env. The entry runs inside
// the test-only harness tests/integration/fixtures/mcp-rks-http-env-probe.mjs, which imports the bin's
// exported main() and answers presence-only probes on stdin; the shipped bin is unchanged.
//
// SAFETY: the primary checkout, every linked worktree, the decoy repo, decoy notes dirs, decoy hooks,
// decoy git config files, the control repo and the registry all live in one fresh temp dir. git()
// refuses any cwd outside it and strips inherited GIT_* keys. Probes and assertions report key presence
// only, never values. Every spawn has a setTimeout kill guard cleared on close; every spawnSync has a
// timeout.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = path.join(ROOT, "tests/integration/fixtures/mcp-rks-http-env-probe.mjs");
const BIN = path.join(ROOT, "packages/mcp-rks/bin/mcp-rks-http.mjs");
const SPAWN_MS = 15_000;
const BOOT_WAIT_MS = 60_000;
const KILL_GUARD_MS = 180_000;
const PROBE_WAIT_MS = 10_000;
const PROJECT_ID = "http-env-fixture";
const SECRET = `bearer-${crypto.randomBytes(24).toString("hex")}`;
const ACTOR = "grokbot";
const MARK = `decoy${crypto.randomBytes(6).toString("hex")}`;
const NOTE_NAME = "fixture.env-note";
const NOTE = `---\nid: "${NOTE_NAME}"\ntitle: "Env Fixture"\n---\n\n## Body\n\nenv fixture\n`;
const INDEXED_RE = "^GIT_CONFIG_(KEY|VALUE)_\\d+$";
const SCRUB_KEYS = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
  "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_KEY_11", "GIT_CONFIG_VALUE_11",
];
const NOTES_KEYS = ["DENDRON_VAULT_PATH", "ROUTEKIT_NOTES_DIR"];
const VECTORS = ["count", "params", "global", "system"];

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rks-http-env-")));
const primary = path.join(tmpBase, "primary");
const tmpHome = path.join(tmpBase, "home");
const registryPath = path.join(tmpBase, "registry.jsonl");
const markers = path.join(tmpBase, "markers");
const decoyRepo = path.join(tmpBase, `repo-${MARK}`);
const decoyVault = path.join(tmpBase, `vault-${MARK}`);
const decoyNotesDir = path.join(tmpBase, `notes-${MARK}`);
const hooks = Object.fromEntries(VECTORS.map((v) => [v, path.join(tmpBase, `hooks-${v}-${MARK}`)]));
const cfgGlobal = path.join(tmpBase, `gitconfig-global-${MARK}`);
const cfgSystem = path.join(tmpBase, `gitconfig-system-${MARK}`);
const entries = [];

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  env.HOME = tmpHome;
  env.XDG_CONFIG_HOME = tmpHome;
  return { ...env, ...extra };
}

function git(cwd, args, extra = {}) {
  const real = fs.realpathSync(cwd);
  if (real !== tmpBase && !real.startsWith(tmpBase + path.sep)) throw new Error(`refusing git outside the temp base: ${cwd}`);
  const r = spawnSync("git", args, { cwd, env: gitEnv(extra), encoding: "utf8", timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (${r.status})`);
  return r.stdout.trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "env@test.invalid"]);
  git(dir, ["config", "user.name", "Env Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function writeProject(root) {
  fs.mkdirSync(path.join(root, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(root, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.mkdirSync(path.join(root, ".routekit", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".routekit", "hooks", ".gitkeep"), "");
  fs.writeFileSync(path.join(root, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(root, "routekit", "kg.yaml"), `project: ${PROJECT_ID}\n`);
  fs.writeFileSync(path.join(root, "notes", `${NOTE_NAME}.md`), NOTE);
  fs.writeFileSync(path.join(root, ".gitignore"), ".env\n.rks/session/\n.rks/telemetry/\n.rks/state/\n");
}

function writeHooks(vector) {
  fs.mkdirSync(hooks[vector], { recursive: true });
  for (const name of ["pre-commit", "post-commit"]) {
    const p = path.join(hooks[vector], name);
    fs.writeFileSync(p, `#!/bin/sh\necho ${name} >> "${path.join(markers, vector)}"\nexit 0\n`);
    fs.chmodSync(p, 0o755);
  }
}

function resetMarkers() {
  fs.rmSync(markers, { recursive: true, force: true });
  fs.mkdirSync(markers, { recursive: true });
}

function makeFixture() {
  fs.mkdirSync(tmpHome, { recursive: true });
  resetMarkers();
  fs.mkdirSync(decoyVault, { recursive: true });
  fs.mkdirSync(decoyNotesDir, { recursive: true });
  for (const v of VECTORS) writeHooks(v);
  fs.writeFileSync(cfgGlobal, `[core]\n\thooksPath = ${hooks.global}\n`);
  fs.writeFileSync(cfgSystem, `[core]\n\thooksPath = ${hooks.system}\n`);
  writeProject(primary);
  initRepo(primary);
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "fixture", "--no-verify"]);
  const common = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
  if (!fs.realpathSync(common).startsWith(tmpBase)) throw new Error("temp repo common dir escaped the temp base");
  initRepo(decoyRepo);
  fs.writeFileSync(path.join(decoyRepo, "decoy.txt"), "decoy\n");
  git(decoyRepo, ["add", "-A"]);
  git(decoyRepo, ["commit", "-m", "decoy", "--no-verify"]);
  fs.writeFileSync(registryPath, JSON.stringify({ id: PROJECT_ID, root: primary, path: primary }) + "\n");
}

function hostileGitEnv() {
  const gitDir = path.join(decoyRepo, ".git");
  return {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: decoyRepo,
    GIT_COMMON_DIR: gitDir,
    GIT_INDEX_FILE: path.join(gitDir, "index"),
    GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects"),
    GIT_NAMESPACE: MARK,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks.count,
    GIT_CONFIG_KEY_1: "rks.decoy",
    GIT_CONFIG_VALUE_1: MARK,
    GIT_CONFIG_KEY_11: "core.hooksPath",
    GIT_CONFIG_VALUE_11: hooks.count,
    GIT_CONFIG_PARAMETERS: `'core.hookspath'='${hooks.params}'`,
    GIT_CONFIG_GLOBAL: cfgGlobal,
    GIT_CONFIG_SYSTEM: cfgSystem,
    GIT_CONFIG_NOSYSTEM: "0",
  };
}

const hostileNotesEnv = () => ({ DENDRON_VAULT_PATH: decoyVault, ROUTEKIT_NOTES_DIR: decoyNotesDir });
const envFileText = (vars) => Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n";
const redact = (s) => s.split(SECRET).join("<bearer>");

let wtCounter = 0;
/** A fresh linked worktree of the temp primary, on its own branch, with the bearer .env (plus extra lines). */
function makeWorktree(extraEnvText = "") {
  wtCounter += 1;
  const wt = path.join(tmpBase, `wt-${wtCounter}`);
  git(primary, ["worktree", "add", "-b", `remote/env-${wtCounter}`, wt]);
  fs.writeFileSync(path.join(wt, ".env"), `RKS_REMOTE_BEARER=${SECRET}\n${extraEnvText}`);
  return wt;
}

function childEnv(worktree, extra = {}) {
  const env = gitEnv();
  for (const k of Object.keys(env)) {
    if (k.startsWith("RKS_") || k.startsWith("ROUTEKIT_") || k === "CLAUDE_PROJECT_DIR" || k === "NODE_ENV" || k === "DENDRON_VAULT_PATH") delete env[k];
  }
  env.VITEST = env.VITEST || "true";
  env.RKS_REGISTRY_PATH = registryPath;
  env.RKS_REMOTE_ROOT = worktree;
  env.RKS_ACTOR = ACTOR;
  env.RKS_REMOTE_PORT = "0";
  env.RKS_TELEMETRY_BUFFER_SIZE = "1";
  // backlog.fix.remote-rag-query-inline-full-index-build: no real embed at boot in this harness.
  env.RKS_REMOTE_BOOT_INDEX = "skip";
  return { ...env, ...extra };
}

/** Spawn the probe harness (which runs the entry's main()) and resolve once it logs its listening line. */
async function startProbe(worktree, extra = {}) {
  const child = spawn(process.execPath, [PROBE], { env: childEnv(worktree, extra), cwd: tmpBase, stdio: ["pipe", "pipe", "pipe"] });
  const guard = setTimeout(() => child.kill("SIGKILL"), KILL_GUARD_MS);
  let output = "";
  let stdout = "";
  const exited = new Promise((resolve) => child.on("close", (code, signal) => { clearTimeout(guard); resolve({ code, signal }); }));
  const entry = { child, exited, worktree, output: () => output, stdout: () => stdout, port: null };
  entries.push(entry);
  child.stdout.on("data", (buf) => { stdout += buf.toString(); output += buf.toString(); });
  child.stderr.on("data", (buf) => { output += buf.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(tick); reject(new Error(`entry did not start within ${BOOT_WAIT_MS}ms:\n${redact(output)}`)); }, BOOT_WAIT_MS);
    const tick = setInterval(() => {
      const m = /listening on http:\/\/([^\s/]+):(\d+)\/mcp/.exec(output);
      if (m) { clearTimeout(timer); clearInterval(tick); entry.port = Number(m[2]); resolve(); }
    }, 50);
    exited.then(({ code }) => { clearTimeout(timer); clearInterval(tick); reject(new Error(`entry exited (${code}) before listening:\n${redact(output)}`)); });
  });
  entry.url = `http://127.0.0.1:${entry.port}/mcp`;
  return entry;
}

async function stopEntry(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return entry.exited;
  entry.child.stdin.end();
  entry.child.kill("SIGTERM");
  const t = setTimeout(() => entry.child.kill("SIGKILL"), 5_000);
  const r = await entry.exited;
  clearTimeout(t);
  return r;
}

let probeCounter = 0;
/** Ask the harness which keys are present. The reply carries booleans only. */
async function probeEnv(entry, keys, patterns = []) {
  probeCounter += 1;
  const id = `p${probeCounter}`;
  entry.child.stdin.write(`${JSON.stringify({ id, keys, patterns })}\n`);
  const prefix = `ENV_PROBE {"id":"${id}"`;
  const end = Date.now() + PROBE_WAIT_MS;
  for (;;) {
    const line = entry.stdout().split("\n").find((l) => l.startsWith(prefix));
    if (line) return JSON.parse(line.slice("ENV_PROBE ".length));
    if (Date.now() > end) throw new Error(`no probe reply for ${id}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text ?? "";
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, text, json };
}

/** init -> read -> create -> end on one client; records the worktree HEAD, branch and commit files around it. */
async function runChain(entry, slug) {
  const wt = entry.worktree;
  const rec = { wt, filename: `inbox.${ACTOR}.${slug}` };
  rec.headBefore = git(wt, ["rev-parse", "HEAD"]);
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: { Authorization: `Bearer ${SECRET}` } } });
  const client = new Client({ name: "mcp-rks-http-env-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    rec.init = await call(client, "rks_governor_init", { projectId: PROJECT_ID });
    const token = rec.init.json?.token;
    rec.read = await call(client, "dendron_read_note", { filename: NOTE_NAME, projectId: PROJECT_ID, _governorToken: token });
    rec.create = await call(client, "dendron_create_note", { filename: rec.filename, title: "Inbox", content: `hello from ${slug}`, projectId: PROJECT_ID, _governorToken: token });
    rec.end = await call(client, "rks_governor_end", { projectId: PROJECT_ID, _governorToken: token });
  } finally {
    await client.close().catch(() => {});
  }
  rec.headAfter = git(wt, ["rev-parse", "HEAD"]);
  rec.branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  rec.commitFiles = git(wt, ["show", "--name-only", "--format=", "HEAD"]);
  return rec;
}

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

function decoySnapshot() {
  return {
    head: git(decoyRepo, ["rev-parse", "HEAD"]),
    branch: git(decoyRepo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: git(decoyRepo, ["status", "--porcelain"]),
    objects: treeDigest(path.join(decoyRepo, ".git", "objects")),
    refs: treeDigest(path.join(decoyRepo, ".git", "refs")),
  };
}

const PROBE_KEYS = ["RKS_REMOTE_BEARER", "RKS_ENV_PROBE_LAUNCH", "RKS_ENV_PROBE_SENTINEL", ...SCRUB_KEYS, ...NOTES_KEYS];

beforeAll(() => {
  makeFixture();
});

afterAll(async () => {
  for (const e of entries) {
    try { await stopEntry(e); } catch { /* best-effort */ }
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
}, 30_000);

describe("mcp-rks-http env isolation: decoy positive controls", () => {
  const fired = {};
  let gitDirSeen = null;
  beforeAll(() => {
    const control = path.join(tmpBase, "control");
    initRepo(control);
    const vectorEnv = {
      count: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks.count },
      params: { GIT_CONFIG_PARAMETERS: `'core.hookspath'='${hooks.params}'` },
      global: { GIT_CONFIG_GLOBAL: cfgGlobal },
      system: { GIT_CONFIG_SYSTEM: cfgSystem },
    };
    for (const v of VECTORS) {
      git(control, ["commit", "--allow-empty", "-m", `control-${v}`], vectorEnv[v]);
      fired[v] = fs.existsSync(path.join(markers, v));
    }
    gitDirSeen = git(control, ["rev-parse", "--absolute-git-dir"], { GIT_DIR: path.join(decoyRepo, ".git") });
    resetMarkers();
  });

  it("each config-injection vector fires its decoy hook on a git commit in a temp control repo, and a decoy GIT_DIR redirects git", () => {
    for (const v of VECTORS) expect(fired[v], v).toBe(true);
    expect(fs.realpathSync(gitDirSeen) === fs.realpathSync(path.join(decoyRepo, ".git"))).toBe(true);
  });

  it("DENDRON_VAULT_PATH and ROUTEKIT_NOTES_DIR each redirect resolveNotesDir away from <root>/notes", async () => {
    const { resolveNotesDir } = await import(pathToFileURL(path.join(ROOT, "packages/mcp-rks/src/dendron.mjs")).href);
    const saved = { DENDRON_VAULT_PATH: process.env.DENDRON_VAULT_PATH, ROUTEKIT_NOTES_DIR: process.env.ROUTEKIT_NOTES_DIR };
    try {
      delete process.env.ROUTEKIT_NOTES_DIR;
      process.env.DENDRON_VAULT_PATH = decoyVault;
      expect(path.resolve(resolveNotesDir(primary)) === decoyVault).toBe(true);
      delete process.env.DENDRON_VAULT_PATH;
      process.env.ROUTEKIT_NOTES_DIR = decoyNotesDir;
      expect(path.resolve(resolveNotesDir(primary)) === decoyNotesDir).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

for (const mode of ["launch", "dotenv"]) {
  const title = mode === "launch" ? "hostile launch env" : "hostile worktree .env";
  describe(`mcp-rks-http env isolation: ${title}`, () => {
    let entry;
    let rec;
    let before;
    let reply;
    beforeAll(async () => {
      resetMarkers();
      const hostile = { ...hostileGitEnv(), ...hostileNotesEnv() };
      const wt = mode === "launch" ? makeWorktree() : makeWorktree(envFileText({ ...hostile, RKS_ENV_PROBE_SENTINEL: "1" }));
      before = decoySnapshot();
      entry = await startProbe(wt, mode === "launch" ? { ...hostile, RKS_ENV_PROBE_LAUNCH: "1" } : {});
      rec = await runChain(entry, mode);
      reply = await probeEnv(entry, PROBE_KEYS, [INDEXED_RE]);
    }, BOOT_WAIT_MS + 60_000);
    afterAll(async () => { if (entry) await stopEntry(entry); }, 15_000);

    it("RKS_REMOTE_BEARER is absent from the entry's process.env after the chain; the positive-control sentinel is present", () => {
      expect(rec.init.json?.ok, "init ok").toBe(true);
      expect(rec.create.json?.ok, "create ok").toBe(true);
      expect(rec.end.json?.ok, "end ok").toBe(true);
      expect(reply.present[mode === "launch" ? "RKS_ENV_PROBE_LAUNCH" : "RKS_ENV_PROBE_SENTINEL"]).toBe(true);
      expect(reply.present.RKS_REMOTE_BEARER).toBe(false);
    });

    it("every git location, config-injection and indexed GIT_CONFIG_KEY_n/VALUE_n key, DENDRON_VAULT_PATH and ROUTEKIT_NOTES_DIR are absent after the chain", () => {
      expect([...SCRUB_KEYS, ...NOTES_KEYS].filter((k) => reply.present[k] !== false)).toEqual([]);
      expect(reply.patternPresent[INDEXED_RE]).toBe(false);
    });

    it("the inbox note lands under RKS_REMOTE_ROOT/notes and is committed on the worktree branch; the decoy notes dirs stay empty", () => {
      expect(fs.existsSync(path.join(rec.wt, "notes", `${rec.filename}.md`))).toBe(true);
      expect(rec.create.json?.commitOk).toBe(true);
      expect(rec.headAfter !== rec.headBefore).toBe(true);
      expect(rec.branch.startsWith("remote/env-")).toBe(true);
      expect(rec.commitFiles).toBe(`notes/${rec.filename}.md`);
      expect(fs.readdirSync(decoyVault)).toEqual([]);
      expect(fs.readdirSync(decoyNotesDir)).toEqual([]);
    });

    it("the decoy repo's HEAD, branch, status, objects and refs are unchanged and no decoy hook fired", () => {
      expect(decoySnapshot()).toEqual(before);
      expect(fs.readdirSync(markers)).toEqual([]);
    });

    it("probe replies carry booleans only and the entry output names neither the bearer nor any decoy value", () => {
      for (const v of [...Object.values(reply.present), ...Object.values(reply.patternPresent)]) expect(typeof v).toBe("boolean");
      const out = entry.output();
      expect(out.includes(SECRET)).toBe(false);
      expect(out.includes(MARK)).toBe(false);
    });
  });
}

describe("mcp-rks-http env isolation: boot worktree check", () => {
  it("checkBootEnv admits a valid linked worktree while process.env carries hostile git config-injection values that break an unscrubbed git rev-parse", async () => {
    const wt = makeWorktree();
    const hostile = { GIT_CONFIG_PARAMETERS: "bogus", GIT_CONFIG_COUNT: "1", GIT_OBJECT_DIRECTORY: path.join(tmpBase, `missing-objects-${MARK}`) };
    const control = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: wt, env: gitEnv(hostile), encoding: "utf8", timeout: SPAWN_MS });
    expect(control.status === 0).toBe(false);
    const { checkBootEnv } = await import(pathToFileURL(BIN).href);
    const saved = {};
    for (const k of Object.keys(hostile)) saved[k] = process.env[k];
    try {
      Object.assign(process.env, hostile);
      const refusal = checkBootEnv({ RKS_REMOTE_ROOT: wt, RKS_REMOTE_BEARER: SECRET, RKS_ACTOR: ACTOR });
      expect(refusal?.reason ?? null).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 30_000);
});
