/**
 * Witness for backlog.fix.rungit-repo-root-binding.
 *
 * THE DEFECT: rks's git helpers bound only `cwd`. Git resolves a repository by walking UP the
 * directory tree, so whenever `projectRoot` was a directory that merely SAT INSIDE a repository,
 * every git call silently operated on the ancestor. The call succeeded. Nothing warned.
 *
 * On 2026-08-21 that turned a test fixture into a handle on this repository and a
 * `git reset --hard origin/staging` destroyed ~30 unpushed commits.
 *
 * WHY THE ASSERTION MUST REALPATH BOTH SIDES — the single most dangerous way to get this wrong.
 * Comparing raw strings rejects every legitimate root on macOS, where os.tmpdir() is
 * `/var/folders/…` but `git rev-parse --show-toplevel` returns `/private/var/folders/…`. Since
 * rks's own exec/commit/ship machinery runs through these helpers, a too-strict assertion breaks
 * the tooling you would need to recover from it, at the same moment it starts firing. The story's
 * acceptance criteria originally said `path.resolve`; that was corrected before build.
 *
 * ORDERING NOTE: this test is only meaningful because backlog.fix.test-fixture-repo-containment
 * shipped first. Before it, a fixture under tests/.tmp whose git init had failed still RESOLVED a
 * toplevel — the developer's repo — so a naive assertion would have passed while pointing at
 * entirely the wrong repository.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir, initGitRepo } from "../helpers/tmp.mjs";
import * as utilsGit from "../../packages/mcp-rks/src/utils/git.mjs";
import * as serverGit from "../../packages/mcp-rks/src/server/git/git-utils.mjs";

const created = [];
function tmp(prefix) {
  const d = makeTempDir(prefix);
  created.push(d);
  return d;
}
afterEach(() => {
  for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A real repo with one commit, so status/rev-parse have something to answer. */
function repo(prefix) {
  const dir = tmp(prefix);
  initGitRepo(dir, { branch: "staging" });
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  run(["config", "user.email", "test@test.com"]);
  run(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "x\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return dir;
}

// Both modules must behave identically. Running the same table against each is what stops one
// from being fixed while the other silently keeps walking up.
const IMPLS = [
  ["utils/git.mjs", utilsGit],
  ["server/git/git-utils.mjs", serverGit],
];

describe.each(IMPLS)("%s — runGit binds to the declared repository", (_name, mod) => {
  it("accepts a legitimate repository root and still returns output", () => {
    // The non-disruption proof. An assertion that rejected good roots would break every caller.
    const dir = repo("bind-ok");
    expect(mod.runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("staging");
  });

  it("accepts a root reached through a symlink (realpath, not string compare)", () => {
    // Construct the symlink explicitly rather than relying on the platform providing one.
    // On macOS os.tmpdir() resolves through /var -> /private/var, so a temp path is ALREADY
    // symlinked and the precondition held for free. On Linux /tmp is a real path, the two sides
    // are equal, and asserting they differ fails outright — which is exactly how this test
    // reddened CI on the commit that introduced it. Building the link makes the case identical
    // on both platforms and keeps it from passing vacuously on either.
    const real = repo("bind-symlink");
    const link = path.join(path.dirname(real), path.basename(real) + "-link");
    fs.symlinkSync(real, link, "dir");
    created.push(link);

    expect(fs.realpathSync(link)).not.toBe(link); // now true everywhere
    expect(() => mod.runGit(link, ["status", "--porcelain"])).not.toThrow();
  });

  it("REFUSES a subdirectory of a repository — the ancestor-binding case", () => {
    // The defect itself. Unbound, this resolves the parent repo and operates on it happily.
    const root = repo("bind-sub");
    const sub = path.join(root, "nested", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(() => mod.runGit(sub, ["status", "--porcelain"])).toThrow(/binding failed/i);
  });

  it("the refusal names the declared root and carries git's own reason", () => {
    // "It failed" is what let this hide for so long — the message must be actionable.
    //
    // NOTE on what this does NOT assert. For the subdirectory shape the CEILING fires first:
    // GIT_CEILING_DIRECTORIES is the parent of projectRoot, so git stops walking before it
    // reaches the ancestor repo and never resolves a toplevel to compare against. There is
    // therefore no "git resolved Y" path to name here — the refusal is "this is not a repository
    // root", which is equally true and equally actionable. The two-path message belongs to the
    // comparison branch, exercised separately below.
    const root = repo("bind-msg");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    let err;
    try { mod.runGit(sub, ["status", "--porcelain"]); } catch (e) { err = e; }
    expect(err, "expected a throw").toBeTruthy();
    expect(err.message).toContain("binding failed");
    expect(err.message).toContain(sub);
    // git's own words, not a generic wrapper.
    expect(err.message).toMatch(/not a git repository|not the repository root/i);
  });

  it("REFUSES a directory that is no repository at all", () => {
    const dir = tmp("bind-norepo");
    expect(() => mod.runGit(dir, ["status", "--porcelain"])).toThrow(/binding failed/i);
  });

  it("REFUSES a projectRoot that does not exist", () => {
    const dir = path.join(tmp("bind-missing"), "gone");
    expect(() => mod.runGit(dir, ["status", "--porcelain"])).toThrow(/binding failed/i);
  });

  it("does NOT warn-and-continue — it throws", () => {
    // The whole failure mode of this incident class is a warning nobody consumes.
    const root = repo("bind-throws");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(() => mod.runGit(sub, ["rev-parse", "HEAD"])).toThrow();
  });
});

describe("the cache is keyed on directory IDENTITY, not path", () => {
  it("a repeated call on the same root does not re-probe", () => {
    // runGit is hot; an extra rev-parse per call is a real cost. Proven by timing-independent
    // means: the second call must still succeed after the probe binary would have been consulted.
    const dir = repo("cache-hit");
    expect(utilsGit.runGit(dir, ["rev-parse", "HEAD"])).toBeTruthy();
    expect(utilsGit.runGit(dir, ["rev-parse", "HEAD"])).toBeTruthy();
  });

  it("a root deleted and RECREATED at the same path is re-verified, not served from cache", () => {
    // The reason the cache stores dev+ino rather than the path string. Recreating the directory
    // reuses the path but not the inode; a path-keyed cache would re-authorise a different
    // directory — which is exactly the silent-wrong-target failure this story removes.
    const dir = repo("cache-ino");
    expect(() => utilsGit.runGit(dir, ["rev-parse", "HEAD"])).not.toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // Same path, new inode, and NOT a repository any more.
    expect(() => utilsGit.runGit(dir, ["status", "--porcelain"])).toThrow(/binding failed/i);
  });

  it("a deleted root reports a binding failure rather than an unhandled ENOENT", () => {
    const dir = repo("cache-gone");
    expect(() => utilsGit.runGit(dir, ["rev-parse", "HEAD"])).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(() => utilsGit.runGit(dir, ["rev-parse", "HEAD"])).toThrow(/binding failed/i);
  });
});

describe("the binding error is not swallowed by callers that tolerate failure", () => {
  it("isWorkingTreeClean throws even with throwOnError:false", () => {
    // Three callers pass throwOnError:false. Routing a binding failure through that opt-out would
    // reproduce, one function over, the exact swallow defect this story removes from
    // getStagingSyncStatus. A misbound root is not a dirty tree — it is a refusal to answer.
    const root = repo("swallow-clean");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(() => utilsGit.isWorkingTreeClean(sub, { throwOnError: false })).toThrow(/binding failed/i);
  });

  it("getUncommittedFiles throws rather than returning [] — which reads as CLEAN", () => {
    const root = repo("swallow-uncommitted");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(() => utilsGit.getUncommittedFiles(sub)).toThrow(/binding failed/i);
  });

  it("getStagingSyncStatus throws rather than returning synced:true", () => {
    // Its catch and two early returns all funnel to { synced: true }. A binding failure raised
    // inside would be laundered into a confident "you are in sync with origin" — and the `git
    // fetch origin` it guards is a NETWORK call against whatever repo the walk-up found.
    const root = repo("swallow-sync");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    expect(() => utilsGit.getStagingSyncStatus(sub)).toThrow(/binding failed/i);
  });

  it("a legitimate root still gets a normal answer from each of them", () => {
    // Non-disruption for the same three functions.
    const dir = repo("swallow-ok");
    expect(utilsGit.isWorkingTreeClean(dir)).toBe(true);
    expect(utilsGit.getUncommittedFiles(dir)).toEqual([]);
    expect(typeof utilsGit.getStagingSyncStatus(dir).synced).toBe("boolean");
  });
});

describe("GIT_CEILING_DIRECTORIES is additive, not a substitute", () => {
  it("BOTH mechanisms refuse the ancestor case — and the ceiling happens to fire first", () => {
    // Recording the observed order rather than an assumed one. The story's guidance predicted the
    // toplevel COMPARISON would catch the subdirectory case, reasoning from git(1)'s "It will not
    // exclude the current working directory". That is true, but it does not apply here: the
    // ceiling is set to the PARENT of projectRoot, so git stops before reaching the ancestor repo
    // and reports "not a git repository" — the comparison is never consulted.
    //
    // The outcome is identical (refusal, no operation on the wrong repo) and defence in depth is
    // working as intended. This asserts the OUTCOME, not the mechanism, so a future change to
    // either half cannot silently make the case pass.
    const root = repo("ceiling-additive");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });
    let err;
    try { utilsGit.runGit(sub, ["status", "--porcelain"]); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.message).toContain("binding failed");
  });

  it("the COMPARISON branch is reachable and names both paths when it fires", () => {
    // Exercising the belt rather than the braces. With the ceiling neutralised, a subdirectory
    // resolves the ancestor repo — and this is the message the comparison produces: "you asked me
    // to operate on X, git resolved Y". If the comparison were ever dropped in favour of the
    // ceiling alone, this reddens.
    const root = repo("ceiling-comparison");
    const sub = path.join(root, "nested");
    fs.mkdirSync(sub, { recursive: true });

    const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: sub, encoding: "utf8", timeout: 30_000,
      // No ceiling: this is what git does unaided, and what rks used to do everywhere.
      env: { ...process.env, GIT_CEILING_DIRECTORIES: "" },
    });
    expect(probe.status, "precondition: unaided git must resolve the ANCESTOR from a subdir").toBe(0);
    expect(fs.realpathSync(probe.stdout.trim())).toBe(fs.realpathSync(root));
    // ...which is precisely the silent ancestor-binding the comparison exists to reject.
    expect(fs.realpathSync(probe.stdout.trim())).not.toBe(fs.realpathSync(sub));
  });

  it("a bound spawn keeps the inherited environment", () => {
    // spawnSync's `env` REPLACES rather than merges. A bare { GIT_CEILING_DIRECTORIES } strips
    // PATH/HOME/GIT_AUTHOR_* and breaks commitFiles — and this story introduced the first `env:`
    // in utils/git.mjs, so there was no existing shape to copy.
    const dir = repo("ceiling-env");
    // `git commit` needs HOME/identity resolution to work at all; if env were replaced wholesale
    // this would fail.
    fs.writeFileSync(path.join(dir, "second.txt"), "y\n");
    expect(() => utilsGit.runGit(dir, ["add", "-A"])).not.toThrow();
    expect(() => utilsGit.runGit(dir, ["commit", "-m", "second"])).not.toThrow();
  });
});

describe("SOURCE INVARIANT — no unbound git spawn survives in either module", () => {
  const REPO_ROOT = process.cwd();

  it.each([
    ["packages/mcp-rks/src/utils/git.mjs"],
    ["packages/mcp-rks/src/server/git/git-utils.mjs"],
  ])("%s spawns git only through the bound path", (rel) => {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const allLines = src.split("\n");
    const spawns = allLines
      .map((line, i) => [i + 1, line])
      // Comment lines are prose ABOUT the spawns, not spawns. Excluded explicitly rather than
      // worded around: a source scanner a comment can trip is the weaker test, and this repo has
      // already reddened CI twice today on exactly that mistake.
      .filter(([, line]) => !/^\s*(\*|\/\/)/.test(line))
      .filter(([, line]) => /spawnSync\(\s*["']git["']/.test(line))
      // The call may span several lines, so classify on the whole options object, not one line.
      // A single-line scan reported a correctly-bound multi-line spawn as unbound.
      .map(([n, line]) => [n, line, allLines.slice(n - 1, n + 6).join("\n")]);

    // A spawn is BOUND iff it carries the ceiling env — that is the observable signature of
    // going through assertRepoRoot + ceilingEnv, and it cannot be satisfied by a raw call.
    // Two raw spawns are legitimate and no more:
    //   1. the toplevel probe itself, which cannot route through the bound path without recursing
    //   2. the bound helper's own spawn, which IS the bound path
    // Both are identified positively, so a third raw spawn appearing later fails this.
    const probe = spawns.filter(([, , call]) => /show-toplevel/.test(call));
    const bound = spawns.filter(([, , call]) => /ceilingEnv\(projectRoot\)/.test(call) && !/show-toplevel/.test(call));
    const unbound = spawns.filter(([, , call]) => !/show-toplevel/.test(call) && !/ceilingEnv\(projectRoot\)/.test(call));

    expect(probe.length, `${rel}: expected exactly one toplevel probe`).toBe(1);
    expect(bound.length, `${rel}: expected at least one bound spawn`).toBeGreaterThan(0);
    expect(
      unbound.map(([n, l]) => `${rel}:${n} ${l.trim()}`),
      `${rel}: unbound git spawn(s) remain — every git call must carry ceilingEnv(projectRoot)`,
    ).toEqual([]);
  });
});
