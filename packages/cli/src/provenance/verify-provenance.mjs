// backlog.feat.commit-provenance-ci-verifier — Node built-ins only; copied verbatim into children
// as .github/rks/verify-provenance.mjs by `routekit project upgrade`.
//
// Lists the non-merge commits in base..head and classifies each one:
//   governed      at least one Rks-Provenance trailer value beginning "v1 "
//   unverifiable  no such trailer, committed by GitHub's web-flow identity (platform merge/squash)
//   ungoverned    everything else
//
// Detection after the fact, not prevention. The trailer is text any `git commit` can forge: a
// governed result proves a commit CLAIMS rks provenance, not that rks made it. Merge commits are
// skipped (--no-merges), and commits reachable from `since` are not checked.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROVENANCE_KEY = "Rks-Provenance";
export const PLATFORM_COMMITTER_EMAIL = "noreply@github.com";
export const MODES = ["warn", "enforce"];

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function classifyCommit({ provenance, committerEmail }) {
  if (provenance.some((v) => v.startsWith("v1 "))) return "governed";
  if (committerEmail === PLATFORM_COMMITTER_EMAIL) return "unverifiable";
  return "ungoverned";
}

const ZERO_SHA = /^0{40}$/;

function resolves(cwd, rev) {
  if (!rev || ZERO_SHA.test(rev)) return false;
  try {
    git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Only the exit code depends on mode; ok is always derived from what was classified.
export function exitCodeFor(result) {
  return result.mode === "enforce" && !result.ok ? 1 : 0;
}

export function verifyRange({ cwd, base, head, since, mode = "warn" }) {
  const range = { base, head, since: since || null };
  const skip = (reason) => ({ ok: false, skipped: true, reason, mode, range, counts: null, commits: null });
  if (!resolves(cwd, base)) return skip("base_unresolvable");
  if (since && !resolves(cwd, since)) return skip("since_unresolvable");
  const revArgs = ["rev-list", "--no-merges", `${base}..${head}`];
  if (since) revArgs.push(`^${since}`);
  revArgs.push("--");
  const shas = git(cwd, revArgs).split("\n").filter(Boolean);
  const commits = shas.map((sha) => {
    const fmt = `%s%x00%ce%x00%(trailers:key=${PROVENANCE_KEY},valueonly,separator=%x01)`;
    const [subject, committerEmail, raw] = git(cwd, ["show", "-s", `--format=${fmt}`, sha]).replace(/\n$/, "").split("\0");
    const provenance = (raw || "").split("\x01").map((s) => s.trim()).filter(Boolean);
    return { sha, subject, provenance, class: classifyCommit({ provenance, committerEmail }) };
  });
  const counts = { governed: 0, ungoverned: 0, unverifiable: 0 };
  for (const c of commits) counts[c.class] += 1;
  const ok = counts.ungoverned === 0 && counts.unverifiable === 0;
  return { ok, skipped: false, reason: null, mode, range, counts, commits };
}

// ── CLI (shared by `routekit verify-provenance` and direct `node verify-provenance.mjs`) ──

/** Parse --base --head --since --mode --json (both `--k v` and `--k=v`). */
export function parseFlags(argv) {
  const flags = { base: null, head: null, since: null, mode: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    if (key === "json") {
      flags.json = eq === -1 ? true : tok.slice(eq + 1) !== "false";
      continue;
    }
    if (!["base", "head", "since", "mode"].includes(key)) continue;
    let value;
    if (eq !== -1) value = tok.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) value = argv[++i];
    else value = "";
    flags[key] = value;
  }
  return flags;
}

/** commitProvenance.since from <cwd>/.rks/project.json, or null when absent or unreadable. */
export function readSinceDefault(cwd) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".rks", "project.json"), "utf8"));
    const since = cfg && cfg.commitProvenance && cfg.commitProvenance.since;
    return typeof since === "string" && since.trim() !== "" ? since.trim() : null;
  } catch {
    return null;
  }
}

export function formatResult(result) {
  const lines = [];
  const { range } = result;
  const rangeText = `${range.base || "(none)"}..${range.head}${range.since ? ` (since ${range.since})` : ""}`;
  if (result.skipped) {
    lines.push(`rks provenance [${result.mode}]: skipped: ${result.reason}`);
    lines.push(`  range ${rangeText}: nothing was classified, so nothing was verified.`);
    return lines.join("\n");
  }
  const c = result.counts;
  lines.push(`rks provenance [${result.mode}]: ${result.ok ? "ok" : "NOT OK"} — ${result.commits.length} commit(s) in ${rangeText}`);
  lines.push(`  governed=${c.governed} ungoverned=${c.ungoverned} unverifiable=${c.unverifiable}`);
  for (const commit of result.commits) {
    if (commit.class === "governed") continue;
    lines.push(`  ${commit.class.padEnd(12)} ${commit.sha} ${commit.subject}`);
  }
  if (!result.ok) {
    lines.push("  (detection only: a commit without an Rks-Provenance v1 trailer did not go through rks, or went through a platform merge)");
  }
  return lines.join("\n");
}

/**
 * Run the verifier as a CLI. Returns the exit code; never calls process.exit itself.
 * Exit code: exitCodeFor(result) (warn always 0; enforce 1 when !ok). 2 on an invalid --mode.
 */
export function runCli(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = parseFlags(argv);
  const mode = flags.mode || "warn";
  if (!MODES.includes(mode)) {
    stderr.write(`verify-provenance: --mode must be warn or enforce (got ${JSON.stringify(flags.mode)})\n`);
    stderr.write("usage: verify-provenance --base <rev> --head <rev> [--since <sha>] [--mode warn|enforce] [--json]\n");
    return 2;
  }
  const since = flags.since || readSinceDefault(cwd);
  let result;
  try {
    result = verifyRange({ cwd, base: flags.base, head: flags.head || "HEAD", since, mode });
  } catch (e) {
    stderr.write(`verify-provenance: failed: ${e && e.message ? e.message : e}\n`);
    return mode === "enforce" ? 1 : 0;
  }
  stdout.write(flags.json ? `${JSON.stringify(result)}\n` : `${formatResult(result)}\n`);
  return exitCodeFor(result);
}

// Main guard: `node verify-provenance.mjs ...` (how a child's workflow runs the copied file).
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const code = runCli(process.argv.slice(2));
  process.stdout.write("", () => process.exit(code));
}
