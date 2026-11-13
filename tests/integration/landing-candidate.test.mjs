// backlog.feat.landing-gate-combined-tree-test — the tree the landing gate tests is the tree that lands.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareLandingCandidate, verifyTargetUnmoved, landingGateEnabled, landingSkipRecord } from "../../packages/mcp-rks/src/exec/landing-candidate.mjs";
import { runFullSuiteGate } from "../../packages/mcp-rks/src/exec/full-suite-gate.mjs";
import { loadStoryTestFiles } from "../../packages/mcp-rks/src/shared/story-test-files.mjs";

const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
let root;
const git = (...args) => execFileSync("git", [...ID, ...args], { cwd: root, encoding: "utf8", timeout: 15_000 }).trim();
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const commit = (rel, text, msg) => { write(rel, text); git("add", rel); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "landing-candidate-"));
  git("init", "-q", "-b", "staging");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  // the module under test runs git without -c overrides, so signing is disabled repo-locally
  git("config", "commit.gpgsign", "false");
  commit("base.txt", "base\n", "base");
  git("checkout", "-q", "-b", "feature/x");
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("prepareLandingCandidate", () => {
  it("merges an advanced target cleanly and reports observed preparedSha and targetSha", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    git("checkout", "-q", "staging");
    const target = commit("b.txt", "b\n", "target");
    git("checkout", "-q", "feature/x");
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(r).toMatchObject({ ok: true, mergedTarget: true, candidateSha: candidate, targetSha: target });
    expect(r.preparedSha).toBe(git("rev-parse", "HEAD"));
    expect(fs.existsSync(path.join(root, "a.txt")) && fs.existsSync(path.join(root, "b.txt"))).toBe(true);
  });

  it("creates no merge commit when the target is already an ancestor", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(r).toMatchObject({ ok: true, mergedTarget: false, preparedSha: candidate });
    expect(git("rev-parse", "HEAD")).toBe(candidate);
  });

  it("aborts a conflicting merge and leaves the candidate untouched", () => {
    const candidate = commit("base.txt", "candidate\n", "candidate");
    git("checkout", "-q", "staging");
    commit("base.txt", "target\n", "target");
    git("checkout", "-q", "feature/x");
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(r).toMatchObject({ ok: false, reason: "landing_conflict" });
    expect(r.conflictFiles).toContain("base.txt");
    expect(git("rev-parse", "HEAD")).toBe(candidate);
    expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("an unresolvable target ref returns unresolvable_ref and changes nothing", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    const r = prepareLandingCandidate({ projectRoot: root, target: "no-such-branch" });
    expect(r).toMatchObject({ ok: false, reason: "unresolvable_ref" });
    expect(git("rev-parse", "HEAD")).toBe(candidate);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("a non-conflict merge failure reports landing_merge_failed with stderr, not landing_conflict", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    git("checkout", "-q", "staging");
    commit("b.txt", "target\n", "target adds b.txt");
    git("checkout", "-q", "feature/x");
    write("b.txt", "untracked\n"); // the merge would overwrite this untracked file
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(r).toMatchObject({ ok: false, reason: "landing_merge_failed" });
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.conflictFiles).toBeUndefined();
    expect(git("rev-parse", "HEAD")).toBe(candidate);
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("untracked\n");
  });

  it("an uncommitted change to a tracked file reports landing_merge_failed and leaves HEAD and the change untouched", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    git("checkout", "-q", "staging");
    commit("base.txt", "target\n", "target changes tracked base.txt");
    git("checkout", "-q", "feature/x");
    const dirty = Buffer.from("uncommitted local change\n");
    fs.writeFileSync(path.join(root, "base.txt"), dirty); // the merge would overwrite this local change
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(r).toMatchObject({ ok: false, reason: "landing_merge_failed" });
    expect(typeof r.stderr).toBe("string");
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(r.conflictFiles === undefined || r.conflictFiles.length === 0).toBe(true);
    expect(git("rev-parse", "HEAD")).toBe(candidate);
    expect(fs.existsSync(path.join(root, ".git", "MERGE_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "base.txt")).equals(dirty)).toBe(true);
  });

  it("an unverified abort reports landing_abort_failed with the observed HEAD", () => {
    const candidate = commit("base.txt", "candidate\n", "candidate");
    git("checkout", "-q", "staging");
    commit("base.txt", "target\n", "target");
    git("checkout", "-q", "feature/x");
    const real = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
    // reports merge --abort as failed WITHOUT running it, so MERGE_HEAD stays
    const noAbort = (cwd, args) => (args[0] === "merge" && args[1] === "--abort")
      ? { status: 1, stdout: "", stderr: "simulated abort failure" }
      : real(cwd, args);
    const r = prepareLandingCandidate({ projectRoot: root, target: "staging", git: noAbort });
    expect(r).toMatchObject({ ok: false, reason: "landing_abort_failed", mergeHeadPresent: true, headSha: candidate, abortStatus: 1 });
    git("merge", "--abort");
  });
});

describe("verifyTargetUnmoved", () => {
  it("refuses when the target moved after the test and passes when it did not", () => {
    commit("a.txt", "a\n", "candidate");
    const prepared = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    expect(verifyTargetUnmoved({ projectRoot: root, target: "staging", expectedTargetSha: prepared.targetSha })).toMatchObject({ ok: true, targetSha: prepared.targetSha });
    git("checkout", "-q", "staging");
    const moved = commit("c.txt", "c\n", "moved");
    git("checkout", "-q", "feature/x");
    expect(verifyTargetUnmoved({ projectRoot: root, target: "staging", expectedTargetSha: prepared.targetSha })).toMatchObject({
      ok: false, reason: "target_moved_after_test", expectedTargetSha: prepared.targetSha, actualTargetSha: moved,
    });
  });

  it("refuses with tested_tree_changed when HEAD is no longer the prepared tree", () => {
    commit("a.txt", "a\n", "candidate");
    const p = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    const later = commit("late.txt", "late\n", "commit after the test");
    expect(verifyTargetUnmoved({ projectRoot: root, target: "staging", expectedTargetSha: p.targetSha, preparedSha: p.preparedSha })).toEqual({
      ok: false, reason: "tested_tree_changed", preparedSha: p.preparedSha, actualHeadSha: later,
    });
  });

  it("refuses when the local target holds commits the tested tree lacks", () => {
    commit("a.txt", "a\n", "candidate");
    const p = prepareLandingCandidate({ projectRoot: root, target: "staging" });
    git("checkout", "-q", "staging");
    const localOnly = commit("l.txt", "l\n", "local-only target commit");
    git("checkout", "-q", "feature/x");
    // the tested tip is p.targetSha (as origin/<target> would be); the local branch is now ahead of it
    expect(verifyTargetUnmoved({ projectRoot: root, target: p.targetSha, expectedTargetSha: p.targetSha, localBranch: "staging" })).toMatchObject({
      ok: false, reason: "local_target_not_tested", localTargetSha: localOnly,
    });
    expect(verifyTargetUnmoved({ projectRoot: root, target: p.targetSha, expectedTargetSha: p.targetSha, localBranch: "no-such-branch" })).toMatchObject({ ok: true });
  });
});

describe("landing against origin", () => {
  it("prepares against the fetched origin tip and sees origin move after a re-fetch", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "landing-origin-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "landing-other-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", bare], { timeout: 15_000 });
      git("remote", "add", "origin", bare);
      git("push", "-q", "origin", "staging");
      commit("a.txt", "a\n", "candidate");
      execFileSync("git", ["clone", "-q", "-b", "staging", bare, other], { timeout: 15_000 });
      const og = (...a) => execFileSync("git", a, { cwd: other, encoding: "utf8", timeout: 15_000 }).trim();
      og("config", "user.name", "t");
      og("config", "user.email", "t@t");
      og("config", "commit.gpgsign", "false");
      const advance = (rel, msg) => { fs.writeFileSync(path.join(other, rel), `${rel}\n`); og("add", rel); og("commit", "-q", "-m", msg); og("push", "-q", "origin", "staging"); return og("rev-parse", "HEAD"); };
      const refspec = "+refs/heads/staging:refs/remotes/origin/staging";
      const originTip = advance("o.txt", "origin advances; local staging stays stale");
      git("fetch", "-q", "origin", refspec);
      const r = prepareLandingCandidate({ projectRoot: root, target: "origin/staging" });
      expect(r).toMatchObject({ ok: true, mergedTarget: true, targetSha: originTip });
      expect(fs.existsSync(path.join(root, "o.txt"))).toBe(true);
      expect(git("rev-parse", "staging")).not.toBe(originTip);
      expect(verifyTargetUnmoved({ projectRoot: root, target: "origin/staging", expectedTargetSha: r.targetSha, preparedSha: r.preparedSha, localBranch: "staging" })).toMatchObject({ ok: true });
      const movedTip = advance("o2.txt", "origin moves after the test");
      git("fetch", "-q", "origin", refspec);
      expect(verifyTargetUnmoved({ projectRoot: root, target: "origin/staging", expectedTargetSha: r.targetSha })).toMatchObject({
        ok: false, reason: "target_moved_after_test", actualTargetSha: movedTip,
      });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("landingGateEnabled", () => {
  it("is true only for a valid enabled fullSuiteGate config", () => {
    expect(landingGateEnabled(root)).toBe(false); // no .rks/project.json
    write(".rks/project.json", JSON.stringify({}));
    expect(landingGateEnabled(root)).toBe(false); // no fullSuiteGate key
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: false } }));
    expect(landingGateEnabled(root)).toBe(false);
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: true, timeoutMs: -1 } }));
    expect(landingGateEnabled(root)).toBe(false); // misconfigured
    const origError = console.error;
    console.error = () => {};
    try {
      write(".rks/project.json", "{ nope");
      expect(landingGateEnabled(root)).toBe(false); // unreadable
    } finally {
      console.error = origError;
    }
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: true } }));
    expect(landingGateEnabled(root)).toBe(true);
  });
});

describe("loadStoryTestFiles", () => {
  // resolveNotesDir prefers DENDRON_VAULT_PATH / ROUTEKIT_NOTES_DIR over <root>/notes; clear both.
  beforeEach(() => { vi.stubEnv("DENDRON_VAULT_PATH", ""); vi.stubEnv("ROUTEKIT_NOTES_DIR", ""); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("returns null with no problemId, no note or no testFiles, and trimmed paths otherwise", () => {
    expect(loadStoryTestFiles(root, undefined)).toBeNull();
    expect(loadStoryTestFiles(root, "backlog.feat.absent")).toBeNull();
    write("notes/backlog.feat.none.md", "---\nid: backlog.feat.none\n---\n");
    expect(loadStoryTestFiles(root, "backlog.feat.none")).toBeNull();
    write("notes/backlog.feat.some.md", "---\nid: backlog.feat.some\ntestFiles:\n  - \" tests/unit/a.test.mjs \"\n  - \"\"\n---\n");
    expect(loadStoryTestFiles(root, "backlog.feat.some")).toEqual(["tests/unit/a.test.mjs"]);
  });
});

describe("landingSkipRecord", () => {
  it("with the gate on and a remote-merging arm the skip record is present and nothing is prepared; with the gate off no record", () => {
    const candidate = commit("a.txt", "a\n", "candidate");
    git("checkout", "-q", "staging");
    commit("b.txt", "b\n", "target advanced");
    git("checkout", "-q", "feature/x");
    expect(landingSkipRecord({ projectRoot: root, landsLocally: false })).toBeNull(); // no .rks/project.json
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: false } }));
    expect(landingSkipRecord({ projectRoot: root, landsLocally: false })).toBeNull(); // gate disabled
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: true } }));
    const statusBefore = git("status", "--porcelain");
    expect(landingSkipRecord({ projectRoot: root, landsLocally: false })).toEqual({
      step: "landing_candidate", skipped: true, reason: "pr_arm_merges_on_remote", followUp: "backlog.feat.landing-gate-pr-merged-tree",
    });
    expect(landingSkipRecord({ projectRoot: root, landsLocally: true })).toBeNull(); // local arms prepare instead
    expect(git("rev-parse", "HEAD")).toBe(candidate); // nothing merged into the candidate
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe(statusBefore);
  });
});

describe("landing gate on the combined tree", () => {
  it("a semantic conflict between disjoint files blocks the gate only on the combined tree", () => {
    write(".rks/project.json", JSON.stringify({ fullSuiteGate: { enabled: true } }));
    git("add", ".rks/project.json");
    git("commit", "-q", "-m", "gate");
    commit("uses.txt", "needs=OLD\n", "candidate uses OLD");
    git("checkout", "-q", "staging");
    commit("defines.txt", "NEW\n", "target renames OLD to NEW");
    git("checkout", "-q", "feature/x");
    // runner inspects the worktree it is run on: it fails only when defines.txt (target) and uses.txt (candidate) disagree
    const runTests = (cwd) => {
      const defs = fs.existsSync(path.join(cwd, "defines.txt")) ? fs.readFileSync(path.join(cwd, "defines.txt"), "utf8").trim() : "OLD";
      const failing = defs === "OLD" ? [] : ["uses.test::needs OLD"];
      return { passed: failing.length === 0, exitCode: failing.length ? 1 : 0, output: "", testResults: { available: true, source: "vitest_json", failing, passed: failing.length ? [] : ["uses.test::needs OLD"], skipped: [] } };
    };
    expect(runFullSuiteGate(root, { runTests }).blocked).toBe(false);
    expect(prepareLandingCandidate({ projectRoot: root, target: "staging" }).ok).toBe(true);
    expect(runFullSuiteGate(root, { runTests }).blocked).toBe(true);
  });
});
