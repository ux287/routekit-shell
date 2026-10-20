#!/usr/bin/env node
/**
 * backlog.fix.mirror-ci-green-unship-doc-integrity-tests — AC8, the measurement.
 *
 * Rebuilds the topology the test suite is PUBLISHED into and runs the published unit suite
 * there, so "the mirror is green" is an observation rather than a hope.
 *
 * Four axes make a mirror a mirror, and all four are reproduced:
 *
 *   1. include/exclude  — generateIncludeArgs applies the exclude post-filter internally, so
 *                         notes/backlog.* and tests/unit/docs/** are absent BY CONSTRUCTION
 *                         rather than by a list maintained here.
 *   2. identity rewrite — normalizeExportIdentity, with from/to read from the profile.
 *   3. parentless HEAD  — one commit, no parents. NOT shallow: `--is-shallow-repository`
 *                         prints false in such a repo, which is why a shallow probe misses it.
 *   4. ENVIRONMENT      — CI is set. This is not cosmetic: tests/mcp-dendron-binding.test.mjs
 *                         is `it.skipIf(!!process.env.CI)`, so a run without CI reports a
 *                         failure the real mirror never sees. Reproducing the file set and the
 *                         git topology but not the environment measures the wrong thing.
 *
 * GREEN PREDICATE — keys on each testResults entry's SUITE STATUS, never on its
 * failed-ASSERTION count. A module-scope throw yields a suite that FAILED while reporting
 * ZERO assertions, so an assertion-count predicate scores it as passing. That exact shape
 * (canon-phase-state-machine-v2-sweep) was in the original enumeration.
 *
 * Exits non-zero when any published test fails. Usage:
 *   node scripts/measure-published-mirror.mjs [--keep] [--worktree]
 *
 *   --worktree  measure the WORKING TREE rather than HEAD. Default is HEAD, because that is
 *               what a mirror clone actually receives; --worktree exists so an in-progress fix
 *               can be measured before it is committed.
 *   --keep      leave the snapshot on disk for inspection.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  generateIncludeArgs,
  normalizeExportIdentity,
} from "../packages/mcp-rks/src/server/publish.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const WORKTREE = process.argv.includes("--worktree");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout: 300_000, ...opts });

const die = (msg, extra = "") => {
  console.error(`\n✖ ${msg}${extra ? `\n${extra}` : ""}`);
  process.exit(1);
};

const profile = yaml.load(
  fs.readFileSync(path.join(REPO_ROOT, ".routekit/publish-profiles.yaml"), "utf8"),
).profiles["rks-public"];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rks-mirror-measure-"));
const snap = path.join(tmp, "snap");
fs.mkdirSync(snap, { recursive: true });

// AXIS 1 — the real include/exclude resolution. generateIncludeArgs returns the ALREADY
// EXPANDED, already-excluded shipped set, so it is not re-expanded or re-filtered here.
const includeArgs = generateIncludeArgs(profile, REPO_ROOT);

if (WORKTREE) {
  // --worktree: measure UNCOMMITTED work. `git archive HEAD` reads the committed tree, which
  // is correct for CI but useless mid-build — an in-progress fix would still show as failing
  // until it is committed. Copying the same resolved set from the working tree measures what
  // you are actually about to ship. HEAD remains the default precisely because that is what a
  // mirror clone receives.
  let copied = 0;
  for (const rel of includeArgs) {
    const src = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    const dest = path.join(snap, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied++;
  }
  if (copied === 0) die("worktree copy produced an empty snapshot — the resolved include set matched nothing");
  console.log(`mode            : --worktree (${copied} files copied)`);
} else {
  const tar = path.join(tmp, "pub.tar");
  const ar = run("git", ["archive", "--format=tar", "-o", tar, "HEAD", ...includeArgs], { cwd: REPO_ROOT });
  // A glob-free include matching nothing hard-fails here with `fatal: pathspec ... did not
  // match any files`. That is profile/tree drift, not a portability failure.
  if (ar.status !== 0) die("git archive failed", ar.stderr);
  const un = run("tar", ["-xf", tar, "-C", snap]);
  if (un.status !== 0) die("tar extract failed", un.stderr);
  console.log("mode            : HEAD (committed tree, as a mirror clone receives it)");
}

// AXIS 2 — identity rewrite, from/to read from the profile rather than hardcoded.
normalizeExportIdentity(snap, profile.identity.from, profile.identity.to);

// AXIS 3 — parentless single-commit history.
run("git", ["init", "-q"], { cwd: snap });
run("git", ["config", "user.email", "measure@example.invalid"], { cwd: snap });
run("git", ["config", "user.name", "measure"], { cwd: snap });
run("git", ["add", "-A"], { cwd: snap });
const commit = run("git", ["commit", "-q", "-m", "published snapshot"], { cwd: snap });
if (commit.status !== 0) die("snapshot commit failed", commit.stderr);

// Dependencies made RESOLVABLE without being COMMITTED — .gitignore ships, so the symlink is
// ignored and the snapshot tree stays clean for tests that assert on it.
fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(snap, "node_modules"), "dir");

// The floor is derived by walking the SNAPSHOT'S OWN tests/unit, never written here.
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(test|spec)\.[mc]?js$/.test(e.name) ? [p] : [];
  });
const floor = walk(path.join(snap, "tests", "unit")).length + walk(path.join(snap, "tests")).filter((f) => path.dirname(f) === path.join(snap, "tests")).length;

const jsonPath = path.join(tmp, "report.json");
const r = spawnSync(
  process.execPath,
  [
    path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.config.unit.mjs",
    // defeats vitest.config.unit.mjs's `bail: 1`, so EVERY failing file is named. Without it
    // the run halts at the first failure and 187 of 188 stay invisible — which is exactly how
    // the mirror looked like it had one problem for ten days.
    "--bail=0",
    "--reporter=json",
    `--outputFile.json=${jsonPath}`,
  ],
  {
    cwd: snap,
    encoding: "utf8",
    timeout: 1_800_000,
    // AXIS 4 — reproduce the mirror's ENVIRONMENT, not just its files.
    env: { ...process.env, CI: "1" },
  },
);

// A missing or unparseable report is an EXPLICIT failure, never a defaulted success: "no
// observations" is not the same claim as "passed".
if (!fs.existsSync(jsonPath)) die(`inner run produced no JSON report (exit ${r.status})`, (r.stderr ?? "").slice(-4000));
let doc;
try {
  doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
} catch (e) {
  die(`inner JSON report is unparseable: ${e.message}`);
}

const files = Array.isArray(doc.testResults) ? doc.testResults : [];
// SUITE STATUS, not assertion count — see the header.
const failed = files.filter((f) => f.status === "failed");
const rel = (f) => f.name.split(`${snap}/`)[1] ?? f.name;

console.log(`snapshot        : ${snap}`);
console.log(`collected files : ${files.length}  (floor from snapshot tests/unit: ${floor})`);
console.log(`inner exit      : ${r.status}`);
console.log(`FAILING FILES   : ${failed.length}`);
for (const f of failed) {
  const bad = (f.assertionResults ?? []).filter((a) => a.status === "failed");
  console.log(`\n=== ${rel(f)}   (${bad.length} failing assertion${bad.length === 1 ? "" : "s"})`);
  for (const a of bad.slice(0, 4)) {
    console.log(`  × ${a.fullName}`);
    console.log(`    ${(a.failureMessages ?? []).join("\n").split("\n")[0].slice(0, 200)}`);
  }
  if (bad.length === 0) console.log("  (zero assertions — collection-time throw)");
}

if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });

// A run that collected nothing exits 0 and would otherwise read as green having proved
// nothing. The floor makes a vacuous run fail instead.
if (files.length < floor) die(`collected ${files.length} files but the snapshot contains ${floor} — a vacuous run is not a pass`);
if (failed.length > 0) die(`${failed.length} published test file(s) fail in the published topology`);
console.log("\n✓ the published suite is GREEN in the published topology");
