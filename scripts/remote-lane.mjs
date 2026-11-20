#!/usr/bin/env node
// Owner-run operations for the rks remote lane (mcp-rks-http): setup, check, start, inbox, alias.
// Does not change the remote lane: it wraps the existing bin and its exported boot checks
// (readRemoteDotenv, buildBootEnv, checkBootEnv in packages/mcp-rks/bin/mcp-rks-http.mjs).
//
//   setup --root <path> --actor <actor> [--branch <name>]
//       create the dedicated linked worktree (git worktree add, default branch remote/<actor>) when
//       <root> does not exist, and append a generated RKS_REMOTE_BEARER to <root>/.env when it has
//       none. The bearer value is never printed. Idempotent.
//   check --root <path> --actor <actor> [--port <n>]
//       offline preflight through the bin's own boot checks; with --port, probe a running server on
//       127.0.0.1 (no bearer -> expect 401; bearer GET /mcp with no session -> expect 400).
//   start --root <path> --actor <actor> [--port <n>]
//       check, then run mcp-rks-http with RKS_REMOTE_ROOT, RKS_ACTOR (and RKS_REMOTE_PORT). The bearer
//       is never passed in the child env: the bin reads it from <root>/.env.
//   inbox --root <path> --actor <actor> [--branch <name>]
//       read-only: list notes/inbox.<actor>.* at the tip of the worktree branch (git ls-tree) and print
//       the owner-side review call shapes for that branch.
//   alias
//       print a suggested shell alias line for this script. Writes nothing.
//
// Output goes through process.stdout.write: importing the bin redirects console.log to stderr.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");
export const SCRIPT_PATH = __filename;
export const HTTP_BIN = path.join(REPO_ROOT, "packages", "mcp-rks", "bin", "mcp-rks-http.mjs");
export const SUBCOMMANDS = ["setup", "check", "start", "inbox", "alias"];
const GIT_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

const USAGE = [
  `usage: remote-lane <${SUBCOMMANDS.join("|")}> [--root <worktree>] [--actor <actor>] [--branch <name>] [--port <n>]`,
  "",
  "  setup  --root <path> --actor <actor> [--branch <name>]  create the linked worktree (default branch remote/<actor>; run from the project checkout) and its .env bearer",
  "  check  --root <path> --actor <actor> [--port <n>]       offline boot preflight; with --port, probe the running server (401 / 400)",
  "  start  --root <path> --actor <actor> [--port <n>]       check, then run mcp-rks-http on 127.0.0.1 (Ctrl-C or SIGTERM stops it)",
  "  inbox  --root <path> --actor <actor> [--branch <name>]  list inbox.<actor>.* notes on the worktree branch and print the review calls",
  "  alias                                                    print a suggested shell alias line (writes nothing)",
].join("\n");

let binModule = null;
async function loadBin() {
  if (!binModule) binModule = await import(pathToFileURL(HTTP_BIN).href);
  return binModule;
}

/** The env for git subprocesses: inherited git location and config-injection keys removed. */
async function gitEnv() {
  const { scrubGitEnv } = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "mcp-rks", "src", "shared", "remote-env-scrub.mjs")).href);
  const env = { ...process.env };
  scrubGitEnv(env);
  return env;
}

async function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, env: await gitEnv(), encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

/** Parse --flag <value> pairs after the subcommand. Returns { flags } or { error }. */
export function parseFlags(args) {
  const known = new Set(["--root", "--actor", "--branch", "--port"]);
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!known.has(a)) return { error: `unknown argument: ${a}` };
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return { error: `${a} needs a value` };
    flags[a.slice(2)] = v;
    i += 1;
  }
  if (flags.port !== undefined && !/^[0-9]+$/.test(flags.port)) return { error: "--port must be a non-negative integer" };
  return { flags };
}

/** Offline preflight using the bin's own exported checks. Resolves null (ok) or { reason, message }. */
export async function preflight({ root, actor, env = process.env }) {
  const bin = await loadBin();
  const dotenvValues = bin.readRemoteDotenv(path.resolve(root));
  const bootEnv = bin.buildBootEnv({ ...env, RKS_REMOTE_ROOT: path.resolve(root), RKS_ACTOR: actor }, dotenvValues);
  return bin.checkBootEnv(bootEnv);
}

export function generateBearer() {
  return randomBytes(32).toString("hex");
}

/** Spawn spec for `start` (testable seam). Never carries RKS_REMOTE_BEARER: the bin reads it from <root>/.env. */
export function buildStartSpec({ root, actor, port, env = process.env }) {
  const childEnv = { ...env, RKS_REMOTE_ROOT: path.resolve(root), RKS_ACTOR: actor };
  if (port !== undefined && port !== null) childEnv.RKS_REMOTE_PORT = String(port);
  delete childEnv.RKS_REMOTE_BEARER;
  return { command: process.execPath, args: [HTTP_BIN], env: childEnv };
}

function requireFlags(flags, names, cmd) {
  const missing = names.filter((n) => typeof flags[n] !== "string" || flags[n].length === 0);
  if (missing.length) {
    err(`${cmd}: missing ${missing.map((n) => `--${n}`).join(", ")}`);
    return false;
  }
  return true;
}

/** "linked" | "primary" | "not_worktree", observed from git rev-parse in dir. */
async function worktreeKind(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"]);
  if (!r.ok) return "not_worktree";
  const [top, gitDir, commonDir] = r.stdout.split("\n");
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  if (real(path.resolve(dir, top)) !== real(dir)) return "not_worktree";
  if (real(path.resolve(dir, gitDir)) === real(path.resolve(dir, commonDir))) return "primary";
  return "linked";
}

async function cmdSetup(flags) {
  if (!requireFlags(flags, ["root", "actor"], "setup")) return 2;
  const root = path.resolve(flags.root);
  const branch = flags.branch || `remote/${flags.actor}`;

  if (!fs.existsSync(root)) {
    const exists = await git(process.cwd(), ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    const args = exists.ok ? ["worktree", "add", root, branch] : ["worktree", "add", "-b", branch, root];
    const r = await git(process.cwd(), args);
    if (!r.ok) {
      err(`setup: git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
      return 1;
    }
    if ((await worktreeKind(root)) !== "linked") {
      err(`setup: ${root} was not observed as a linked worktree after git worktree add`);
      return 1;
    }
    out(`setup: created linked worktree ${root} on branch ${branch}${exists.ok ? " (existing branch)" : ""}`);
  } else {
    const kind = await worktreeKind(root);
    if (kind !== "linked") {
      err(`setup: ${root} exists and is ${kind === "primary" ? "the primary checkout" : "not the top of a git worktree"}; point --root at a new path or an existing linked worktree`);
      return 1;
    }
    const head = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    out(`setup: linked worktree ${root} already exists (branch ${head.ok ? head.stdout : "unknown"}), unchanged`);
  }

  const bin = await loadBin();
  const envPath = path.join(root, ".env");
  const existing = bin.readRemoteDotenv(root).RKS_REMOTE_BEARER;
  if (typeof existing === "string" && existing.length > 0) {
    out(`setup: ${envPath} already carries RKS_REMOTE_BEARER (${existing.length} characters, value not printed), unchanged`);
    if (existing.length < bin.MIN_BEARER_LENGTH) {
      out(`setup: that bearer is shorter than ${bin.MIN_BEARER_LENGTH} characters; check will refuse it (bearer_too_short) until you replace it`);
    }
  } else {
    let prior = "";
    try { prior = fs.readFileSync(envPath, "utf8"); } catch { prior = ""; }
    const sep = prior.length > 0 && !prior.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(envPath, `${prior}${sep}RKS_REMOTE_BEARER=${generateBearer()}\n`, { mode: 0o600 });
    const written = bin.readRemoteDotenv(root).RKS_REMOTE_BEARER;
    if (typeof written !== "string" || written.length < bin.MIN_BEARER_LENGTH) {
      err(`setup: wrote ${envPath} but could not read back a bearer of at least ${bin.MIN_BEARER_LENGTH} characters`);
      return 1;
    }
    out(`setup: wrote RKS_REMOTE_BEARER to ${envPath} (${written.length} characters, value not printed)`);
  }
  const ignored = await git(root, ["check-ignore", "-q", ".env"]);
  if (!ignored.ok) out(`setup: warning: .env is not gitignored in ${root}; do not commit it`);
  out(`setup: next: remote-lane check --root ${root} --actor ${flags.actor}`);
  return 0;
}

function probe(port, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "GET", headers, timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function cmdCheck(flags) {
  if (!requireFlags(flags, ["root", "actor"], "check")) return 2;
  const refusal = await preflight({ root: flags.root, actor: flags.actor });
  if (refusal) {
    out(`check: refused (${refusal.reason}): ${refusal.message}`);
    return 1;
  }
  out("check: ok");
  if (flags.port === undefined) return 0;
  const port = Number(flags.port);
  const bin = await loadBin();
  const bearer = bin.readRemoteDotenv(path.resolve(flags.root)).RKS_REMOTE_BEARER;
  const noBearer = await probe(port, {});
  const withBearer = await probe(port, { Authorization: `Bearer ${bearer}` });
  const show = (s) => (s === null ? "no response" : String(s));
  out(`check: probe 127.0.0.1:${port} no bearer -> ${show(noBearer)} (expected 401)`);
  out(`check: probe 127.0.0.1:${port} bearer GET /mcp, no session -> ${show(withBearer)} (expected 400)`);
  return noBearer === 401 && withBearer === 400 ? 0 : 1;
}

async function cmdStart(flags) {
  if (!requireFlags(flags, ["root", "actor"], "start")) return 2;
  const refusal = await preflight({ root: flags.root, actor: flags.actor });
  if (refusal) {
    out(`start: refused (${refusal.reason}): ${refusal.message}`);
    return 1;
  }
  const spec = buildStartSpec({ root: flags.root, actor: flags.actor, port: flags.port });
  const child = spawn(spec.command, spec.args, { env: spec.env, stdio: "inherit" });
  // Ctrl-C reaches the whole process group; a SIGTERM to this script alone is forwarded. The child is
  // sent SIGTERM in both cases (its SIGINT and SIGTERM shutdown handlers are each registered once).
  const forward = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise((resolve) => {
    child.on("error", (e) => { err(`start: could not spawn mcp-rks-http: ${e.message}`); resolve(1); });
    child.on("close", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function cmdInbox(flags) {
  if (!requireFlags(flags, ["root", "actor"], "inbox")) return 2;
  const root = path.resolve(flags.root);
  let branch = flags.branch;
  if (!branch) {
    const head = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!head.ok || head.stdout === "HEAD") {
      err(`inbox: could not resolve the branch of ${root}; pass --branch`);
      return 1;
    }
    branch = head.stdout;
  }
  const tree = await git(root, ["ls-tree", "-r", "--name-only", `refs/heads/${branch}`, "--", "notes"]);
  if (!tree.ok) {
    err(`inbox: could not list notes on branch ${branch}: ${tree.stderr}`);
    return 1;
  }
  const re = new RegExp(`^notes/(inbox\\.${escapeRe(flags.actor)}\\.[^/]+)\\.md$`);
  const notes = tree.stdout.split("\n").map((l) => re.exec(l)).filter(Boolean).map((m) => m[1]).sort();
  out(`inbox: ${notes.length} note(s) for actor ${flags.actor} committed on branch ${branch}`);
  for (const n of notes) out(`  ${n}`);
  const example = notes[0] || `inbox.${flags.actor}.<name>`;
  out("");
  out("Review from an owner session in the primary checkout, with the owner-side tool (never admitted on the remote lane):");
  out(`  list:    rks_inbox_review({ action: "list", branch: "${branch}" })`);
  out(`  accept:  rks_inbox_review({ action: "accept", branch: "${branch}", filename: "${example}", targetFilename: "<name outside inbox.>" })`);
  out(`  discard: rks_inbox_review({ action: "discard", branch: "${branch}", filename: "${example}" })`);
  out("accept copies the note into the configured working branch (it refuses unless that branch is checked out and differs from the source branch); discard only records the decision in .rks/state/inbox-decisions.json.");
  return 0;
}

function cmdAlias() {
  out(`alias remote-lane='node "${SCRIPT_PATH}"'`);
  out("# add the line above to your shell profile yourself; this script writes no file");
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    out(USAGE);
    return 0;
  }
  if (!SUBCOMMANDS.includes(cmd)) {
    err(`unknown subcommand: ${cmd}`);
    err(USAGE);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    out(USAGE);
    return 0;
  }
  const parsed = parseFlags(rest);
  if (parsed.error) {
    err(`${cmd}: ${parsed.error}`);
    return 2;
  }
  const { flags } = parsed;
  if (cmd === "setup") return cmdSetup(flags);
  if (cmd === "check") return cmdCheck(flags);
  if (cmd === "start") return cmdStart(flags);
  if (cmd === "inbox") return cmdInbox(flags);
  return cmdAlias();
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    err(`remote-lane: ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
