// Integration tests for scripts/remote-lane.mjs: the script is spawned against a temp git repo and
// linked worktrees. Fixture modelled on tests/integration/mcp-rks-http-env-isolation.test.mjs.
//
// SAFETY: the primary checkout, every linked worktree, the registry and the temp HOME all live in one
// fresh temp dir. git() refuses any cwd outside it and strips inherited GIT_* keys. Every spawnSync has
// a timeout; every spawn has a setTimeout kill guard cleared on close. Script spawns use scriptEnv(),
// which removes NODE_ENV and every RKS_* / ROUTEKIT_* key so the bin's token_gate_bypass check does not
// fire under vitest, and which never sets RKS_REMOTE_ROOT or RKS_ACTOR (the script derives them).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const SCRIPT = path.join(ROOT, "scripts", "remote-lane.mjs");
const SPAWN_MS = 30_000;
const BOOT_WAIT_MS = 60_000;
const KILL_GUARD_MS = 120_000;
const SERVER_TEST_MS = BOOT_WAIT_MS + 60_000;
const PROJECT_ID = "remote-lane-script-fixture";
const ACTOR = "grokbot";
const BRANCH = `remote/${ACTOR}`;
const LISTEN_RE = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/;

const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remote-lane-script-")));
const tmpHome = path.join(tmpBase, "home");
const registryPath = path.join(tmpBase, "registry.jsonl");
const primary = path.join(tmpBase, "primary");
const wt = path.join(tmpBase, "wt-main");
const wtShort = path.join(tmpBase, "wt-short");
const children = [];

function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  env.HOME = tmpHome;
  env.XDG_CONFIG_HOME = tmpHome;
  return { ...env, ...extra };
}

/** Env for every spawn of the script, modelled on childEnv in mcp-rks-http-env-isolation.test.mjs. */
function scriptEnv(extra = {}) {
  const env = gitEnv();
  for (const k of Object.keys(env)) {
    if (k.startsWith("RKS_") || k.startsWith("ROUTEKIT_") || k === "CLAUDE_PROJECT_DIR" || k === "NODE_ENV" || k === "DENDRON_VAULT_PATH") delete env[k];
  }
  env.RKS_REGISTRY_PATH = registryPath;
  return { ...env, ...extra };
}
const SERVER_ENV = () => scriptEnv({ RKS_REMOTE_BOOT_INDEX: "skip" });

function git(cwd, args) {
  const real = fs.realpathSync(cwd);
  if (real !== tmpBase && !real.startsWith(tmpBase + path.sep)) throw new Error(`refusing git outside the temp base: ${cwd}`);
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", timeout: SPAWN_MS });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/** Run the script synchronously. cwd defaults to the temp base, never the real repo. */
const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: SPAWN_MS, cwd: tmpBase, env: scriptEnv(), ...opts });

function makeFixture() {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(path.join(primary, ".rks"), { recursive: true });
  fs.mkdirSync(path.join(primary, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(primary, "notes"), { recursive: true });
  fs.mkdirSync(path.join(primary, ".routekit", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(primary, ".routekit", "hooks", ".gitkeep"), "");
  fs.writeFileSync(path.join(primary, ".rks", "project.json"), JSON.stringify({ id: PROJECT_ID, root: primary, kgFile: "routekit/kg.yaml", notes: { vaultPath: "notes" } }, null, 2));
  fs.writeFileSync(path.join(primary, "routekit", "kg.yaml"), `project: ${PROJECT_ID}\n`);
  fs.writeFileSync(path.join(primary, "notes", "fixture.note.md"), `---\nid: "fixture.note"\ntitle: "Fixture"\n---\n\nfixture\n`);
  fs.writeFileSync(path.join(primary, ".gitignore"), ".env\n.rks/session/\n.rks/telemetry/\n.rks/state/\n");
  git(primary, ["init", "-b", "main"]);
  git(primary, ["config", "user.email", "remote-lane@test.invalid"]);
  git(primary, ["config", "user.name", "Remote Lane Test"]);
  git(primary, ["config", "commit.gpgsign", "false"]);
  git(primary, ["add", "-A"]);
  git(primary, ["commit", "-m", "fixture", "--no-verify"]);
  const common = path.resolve(primary, git(primary, ["rev-parse", "--git-common-dir"]));
  if (!fs.realpathSync(common).startsWith(tmpBase)) throw new Error("temp repo common dir escaped the temp base");
  fs.writeFileSync(registryPath, JSON.stringify({ id: PROJECT_ID, root: primary, path: primary }) + "\n");
}

const readBearer = (root) => /^RKS_REMOTE_BEARER=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1] ?? null;

/** Spawn `start` on root with the server env; resolves once the listening line appears on stderr. */
async function startServer(root) {
  const child = spawn(process.execPath, [SCRIPT, "start", "--root", root, "--actor", ACTOR], { cwd: tmpBase, env: SERVER_ENV(), stdio: ["ignore", "pipe", "pipe"] });
  const guard = setTimeout(() => child.kill("SIGKILL"), KILL_GUARD_MS);
  let output = "";
  const exited = new Promise((resolve) => child.on("close", (code, signal) => { clearTimeout(guard); resolve({ code, signal }); }));
  const entry = { child, exited, output: () => output, port: null };
  children.push(entry);
  child.stdout.on("data", (b) => { output += b.toString(); });
  child.stderr.on("data", (b) => { output += b.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(tick); reject(new Error(`server did not listen within ${BOOT_WAIT_MS}ms:\n${output}`)); }, BOOT_WAIT_MS);
    const tick = setInterval(() => {
      const m = LISTEN_RE.exec(output);
      if (m) { clearTimeout(timer); clearInterval(tick); entry.port = Number(m[1]); resolve(); }
    }, 50);
    exited.then(({ code }) => { clearTimeout(timer); clearInterval(tick); reject(new Error(`start exited (${code}) before listening:\n${output}`)); });
  });
  return entry;
}

async function stopServer(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return entry.exited;
  entry.child.kill("SIGTERM");
  const t = setTimeout(() => entry.child.kill("SIGKILL"), 10_000);
  const r = await entry.exited;
  clearTimeout(t);
  return r;
}

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
const portOpen = (port) => new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", timeout: 2_000 }, (res) => { res.resume(); resolve(true); });
  req.on("timeout", () => { req.destroy(); resolve(false); });
  req.on("error", () => resolve(false));
  req.end();
});

let firstSetup;

beforeAll(() => {
  makeFixture();
  firstSetup = run(["setup", "--root", wt, "--actor", ACTOR], { cwd: primary });
});

afterAll(async () => {
  for (const e of children) {
    try { await stopServer(e); } catch { /* best-effort */ }
  }
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
}, 30_000);

describe("scripts/remote-lane.mjs (integration)", () => {
  it("--help exits 0 and lists every subcommand", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    for (const sub of ["setup", "check", "start", "inbox", "alias"]) expect(r.stdout).toContain(sub);
  });

  it("setup creates a linked worktree on the default remote branch", () => {
    expect(firstSetup.status, firstSetup.stderr).toBe(0);
    const list = git(primary, ["worktree", "list", "--porcelain"]);
    expect(list.split("\n")).toContain(`worktree ${wt}`);
    expect(fs.lstatSync(path.join(wt, ".git")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(primary, ".git")).isDirectory()).toBe(true);
    expect(git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(BRANCH);
    expect(path.resolve(wt, git(wt, ["rev-parse", "--git-dir"]))).not.toBe(path.resolve(wt, git(wt, ["rev-parse", "--git-common-dir"])));
    expect(git(primary, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("setup writes a bearer of at least 32 characters and never prints it", () => {
    const bearer = readBearer(wt);
    expect(bearer).not.toBeNull();
    expect(bearer.length).toBeGreaterThanOrEqual(32);
    expect(firstSetup.stdout.includes(bearer)).toBe(false);
    expect(firstSetup.stderr.includes(bearer)).toBe(false);
  });

  it("second setup leaves .env byte-identical", () => {
    const before = fs.readFileSync(path.join(wt, ".env"));
    const r = run(["setup", "--root", wt, "--actor", ACTOR], { cwd: primary });
    expect(r.status, r.stderr).toBe(0);
    expect(Buffer.compare(fs.readFileSync(path.join(wt, ".env")), before)).toBe(0);
    expect(r.stdout).toMatch(/RKS_REMOTE_BEARER.*unchanged/);
    const bearer = readBearer(wt);
    expect(r.stdout.includes(bearer) || r.stderr.includes(bearer)).toBe(false);
  });

  it("check prints ok on a set-up worktree", () => {
    const r = run(["check", "--root", wt, "--actor", ACTOR]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^check: ok$/m);
  });

  it("check reports bearer_too_short", () => {
    git(primary, ["worktree", "add", "-b", "remote/short", wtShort]);
    fs.writeFileSync(path.join(wtShort, ".env"), "RKS_REMOTE_BEARER=too-short-bearer\n");
    const r = run(["check", "--root", wtShort, "--actor", ACTOR]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("bearer_too_short");
    expect(r.stdout).not.toMatch(/^check: ok$/m);
  });

  it("check reports remote_root_primary_checkout", () => {
    const r = run(["check", "--root", primary, "--actor", ACTOR]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("remote_root_primary_checkout");
  });

  it("check --port reports 401 and 400 from a running server", async () => {
    const server = await startServer(wt);
    try {
      const r = run(["check", "--root", wt, "--actor", ACTOR, "--port", String(server.port)]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/no bearer -> 401 \(expected 401\)/);
      expect(r.stdout).toMatch(/bearer GET \/mcp, no session -> 400 \(expected 400\)/);
      expect(r.stdout.includes(readBearer(wt))).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, SERVER_TEST_MS);

  it("start refuses without spawning when check fails", () => {
    const r = run(["start", "--root", primary, "--actor", ACTOR], { env: SERVER_ENV() });
    expect(r.status).not.toBe(0);
    const output = r.stdout + r.stderr;
    expect(r.stdout).toContain("start: refused (remote_root_primary_checkout)");
    // The bin's own refusal line would mean it was spawned; the script must refuse first.
    expect(output).not.toContain("[mcp-rks-http]");
    expect(output).not.toContain("listening on");
  });

  it("start spawns mcp-rks-http and reaches listening on 127.0.0.1", async () => {
    const server = await startServer(wt);
    let stopped;
    try {
      expect(server.output()).toMatch(LISTEN_RE);
      expect(server.output()).toContain(`project ${PROJECT_ID}, actor ${ACTOR}`);
      expect(server.output().includes(readBearer(wt))).toBe(false);
      expect(await portOpen(server.port)).toBe(true);
    } finally {
      stopped = await stopServer(server);
    }
    expect(stopped.code).toBe(0);
    expect(await portOpen(server.port)).toBe(false);
  }, SERVER_TEST_MS);

  describe("inbox", () => {
    beforeAll(() => {
      fs.writeFileSync(path.join(wt, "notes", `inbox.${ACTOR}.alpha.md`), "---\nid: x\n---\n\n# Alpha\n");
      fs.writeFileSync(path.join(wt, "notes", "inbox.othery.beta.md"), "---\nid: y\n---\n\n# Beta\n");
      fs.writeFileSync(path.join(wt, "notes", "plain.topic.md"), "---\nid: z\n---\n\n# Plain\n");
      git(wt, ["add", "notes"]);
      git(wt, ["commit", "-m", "inbox fixture", "--no-verify"]);
      fs.writeFileSync(path.join(wt, "notes", `inbox.${ACTOR}.uncommitted.md`), "---\nid: u\n---\n\n# Uncommitted\n");
    });

    it("inbox lists only the actor inbox notes on the branch", () => {
      const r = run(["inbox", "--root", wt, "--actor", ACTOR]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^  inbox\\.${ACTOR}\\.alpha$`, "m"));
      expect(r.stdout).toContain(`1 note(s) for actor ${ACTOR} committed on branch ${BRANCH}`);
      expect(r.stdout).not.toContain("inbox.othery.beta");
      expect(r.stdout).not.toContain("plain.topic");
      expect(r.stdout).not.toContain("uncommitted");
      expect(r.stdout).toContain(`action: "list", branch: "${BRANCH}"`);
      expect(r.stdout).toContain(`action: "accept", branch: "${BRANCH}"`);
      expect(r.stdout).toContain(`action: "discard", branch: "${BRANCH}"`);
      expect(r.stdout).toContain("targetFilename");
    });

    it("inbox makes no commit, checkout or ledger write", () => {
      const ledgers = [wt, primary].map((d) => path.join(d, ".rks", "state", "inbox-decisions.json"));
      const snap = () => ({
        wtHead: git(wt, ["rev-parse", "HEAD"]),
        wtBranch: git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]),
        primaryHead: git(primary, ["rev-parse", "HEAD"]),
        primaryBranch: git(primary, ["rev-parse", "--abbrev-ref", "HEAD"]),
        wtStatus: git(wt, ["status", "--porcelain"]),
        primaryStatus: git(primary, ["status", "--porcelain"]),
        branches: git(primary, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
      });
      const before = snap();
      expect(before.wtStatus).toContain(`inbox.${ACTOR}.uncommitted.md`);
      const r = run(["inbox", "--root", wt, "--actor", ACTOR]);
      expect(r.status, r.stderr).toBe(0);
      expect(snap()).toEqual(before);
      for (const l of ledgers) expect(fs.existsSync(l), l).toBe(false);
    });
  });

  it("alias prints the absolute script path and writes no file", () => {
    const cwd = path.join(tmpBase, "alias-cwd");
    const home = path.join(tmpBase, "alias-home");
    fs.mkdirSync(cwd);
    fs.mkdirSync(home);
    const r = run(["alias"], { cwd, env: scriptEnv({ HOME: home, XDG_CONFIG_HOME: home }) });
    expect(r.status, r.stderr).toBe(0);
    expect(path.isAbsolute(SCRIPT)).toBe(true);
    expect(r.stdout.split("\n").some((l) => l.includes(SCRIPT))).toBe(true);
    expect(fs.readdirSync(cwd)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
