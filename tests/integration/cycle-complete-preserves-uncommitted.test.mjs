/**
 * Witness for backlog.fix.cycle-complete-discards-uncommitted-changes — driven for real.
 *
 * THE DEFECT: `runCycleComplete` ran `git reset --hard origin/<working>` whenever the working
 * branch was not local-only. Its only gate (backlog.fix.cycle-complete-ungated-hard-reset) counted
 * unpushed COMMITS; it never looked at the working tree. After a push, local equals origin, the
 * gate does not fire, and the reset rewrites every modified tracked file back to HEAD. That is how
 * `rks_guardrails_on` discarded a `package-lock.json` edit it had itself reported as
 * `unstagedOutOfScope`.
 *
 * THE FIX: sync non-destructively when not ahead (skip when equal, `merge --ff-only` when behind),
 * and over a dirty tracked tree refuse the ahead-path reset unless `discardUncommitted === true`.
 * `preservedPaths` / `dirtyPaths` are reported from OBSERVED `git status`, never from intent.
 *
 * FIXTURE SAFETY: every repository here comes from `getRepoCopy("working-with-origin")`, rooted in
 * os.tmpdir() — a work repo on `staging` with tracked `file.txt` (content `initial`) pushed to a
 * sibling bare origin. Nothing in this file runs git against this repository. Every spawn carries
 * an explicit timeout.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepoCopy } from "../helpers/git-repo-template.mjs";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
const out = (cwd, args) => git(cwd, args).stdout.trim();
const load = async () => (await import("../../packages/mcp-rks/src/server/git-tools.mjs")).runCycleComplete;

const head = (repo) => out(repo, ["rev-parse", "HEAD"]);
const originHead = (repo) => out(repo, ["rev-parse", "origin/staging"]);
const readFile = (repo, rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const writeFile = (repo, rel, body) => fs.writeFileSync(path.join(repo, rel), body);

/** Commit and expect success — a silently failed fixture step would make a test vacuous. */
function commit(repo, rel, body, message) {
  writeFile(repo, rel, body);
  expect(git(repo, ["add", rel]).status).toBe(0);
  const res = git(repo, ["commit", "-q", "-m", message]);
  expect(res.status, `fixture commit failed: ${res.stderr}`).toBe(0);
}

/**
 * Advance origin/staging by one commit, then move local staging back one commit, so local is
 * behind by exactly one and ahead by zero. The worktree is clean afterwards.
 */
function makeBehind(repo, rel, body) {
  commit(repo, rel, body, `origin-only change to ${rel}`);
  expect(git(repo, ["push", "-q", "origin", "staging"]).status).toBe(0);
  expect(git(repo, ["reset", "-q", "--hard", "HEAD~1"]).status).toBe(0);
  expect(out(repo, ["rev-list", "--left-right", "--count", "staging...origin/staging"]).split(/\s+/))
    .toEqual(["0", "1"]);
}

/** Commit locally WITHOUT pushing — local becomes ahead of origin by one. */
function makeAhead(repo) {
  commit(repo, "unpushed.txt", "local work\n", "local unpushed work");
  expect(Number(out(repo, ["rev-list", "--count", "origin/staging..staging"]))).toBe(1);
}

/**
 * Independent observation of the tracked dirty set: `git status --porcelain`, `??` lines
 * excluded, path taken from column 4. Deliberately NOT the implementation's parser.
 */
function observedTrackedDirty(repo) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8", timeout: 15_000 });
  return res.stdout.split("\n")
    .filter((l) => l.length > 0 && !l.startsWith("??"))
    .map((l) => l.slice(3))
    .sort();
}

describe("runCycleComplete preserves uncommitted tracked changes it does not own", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    ({ workDir: projectRoot } = getRepoCopy("working-with-origin"));
    expect(out(projectRoot, ["branch", "--show-current"])).toBe("staging");
    expect(readFile(projectRoot, "file.txt")).toBe("initial");
  });

  describe("equal to origin — no sync is needed, so nothing may be discarded", () => {
    it("REPRODUCTION — a modified tracked file survives and is reported as preserved", async () => {
      const runCycleComplete = await load();
      writeFile(projectRoot, "file.txt", "UNOWNED EDIT\n");
      expect(head(projectRoot)).toBe(originHead(projectRoot));

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(readFile(projectRoot, "file.txt")).toBe("UNOWNED EDIT\n");
      expect(out(projectRoot, ["status", "--porcelain"])).toMatch(/^M file\.txt$|^ M file\.txt$/m);
      expect(result.preservedPaths).toContain("file.txt");
    });

    it("a STAGED but uncommitted change survives in the index and is reported", async () => {
      const runCycleComplete = await load();
      writeFile(projectRoot, "file.txt", "STAGED EDIT\n");
      expect(git(projectRoot, ["add", "file.txt"]).status).toBe(0);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(out(projectRoot, ["diff", "--cached", "--name-only"])).toBe("file.txt");
      expect(out(projectRoot, ["diff", "--cached"])).toMatch(/\+STAGED EDIT/);
      expect(result.preservedPaths).toContain("file.txt");
    });

    it("a clean tree — HEAD unchanged, synced, no warning, preservedPaths is []", async () => {
      const runCycleComplete = await load();
      const before = head(projectRoot);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(result.synced).toBe(true);
      expect(result.divergenceWarning).toBeNull();
      expect(result.preservedPaths).toEqual([]);
      expect(head(projectRoot)).toBe(before);
    });
  });

  describe("behind origin — fast-forward only", () => {
    it("a NON-conflicting dirty file survives the fast-forward and is reported", async () => {
      const runCycleComplete = await load();
      makeBehind(projectRoot, "other.txt", "from origin\n");
      writeFile(projectRoot, "file.txt", "LOCAL EDIT\n");

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(head(projectRoot)).toBe(originHead(projectRoot));
      expect(readFile(projectRoot, "other.txt")).toBe("from origin\n");
      expect(readFile(projectRoot, "file.txt")).toBe("LOCAL EDIT\n");
      expect(result.preservedPaths).toContain("file.txt");
    });

    it("a CONFLICTING dirty file — refusal carries git's own error, nothing is discarded", async () => {
      const runCycleComplete = await load();
      makeBehind(projectRoot, "file.txt", "from origin\n");
      writeFile(projectRoot, "file.txt", "CONFLICTING LOCAL EDIT\n");
      writeFile(projectRoot, "stray-untracked.txt", "untracked\n");
      const before = head(projectRoot);
      const observed = observedTrackedDirty(projectRoot);
      expect(observed).toEqual(["file.txt"]);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(false);
      expect(Array.isArray(result.dirtyPaths)).toBe(true);
      expect([...result.dirtyPaths].sort()).toEqual(observed);
      expect(result.dirtyPaths).not.toContain("stray-untracked.txt");
      // git's own ff-only refusal text, which names the file — not a synthesized message.
      expect(result.error).toMatch(/would be overwritten by merge/);
      expect(result.error).toMatch(/file\.txt/);
      if (result.hint !== undefined) expect(result.hint).not.toContain("discardUncommitted");
      expect(head(projectRoot)).toBe(before);
      expect(readFile(projectRoot, "file.txt")).toBe("CONFLICTING LOCAL EDIT\n");
    });

    it("a merge --ff-only failure on a CLEAN tracked tree is git's error, not attributed to dirty paths", async () => {
      const runCycleComplete = await load();
      makeBehind(projectRoot, "new.txt", "from-origin");
      writeFile(projectRoot, "new.txt", "local-untracked");
      // Preconditions: tracked tree clean, 0 ahead / 1 behind — the ff-only merge is reached.
      expect(out(projectRoot, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
      expect(out(projectRoot, ["rev-list", "--left-right", "--count", "staging...origin/staging"]).split(/\s+/))
        .toEqual(["0", "1"]);
      const before = head(projectRoot);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/would be overwritten by merge/);
      expect(result.error).toMatch(/new\.txt/);
      expect(result.dirtyPaths).toEqual([]);
      expect(result.error).not.toMatch(/uncommitted|local changes/i);
      expect(head(projectRoot)).toBe(before);
      expect(readFile(projectRoot, "new.txt")).toBe("local-untracked");
    });
  });

  describe("ahead of origin — the reset needs separate consent for uncommitted work", () => {
    it("discardLocalCommits true + a dirty tracked file refuses; commit and edit both survive", async () => {
      const runCycleComplete = await load();
      makeAhead(projectRoot);
      writeFile(projectRoot, "file.txt", "UNOWNED EDIT\n");
      writeFile(projectRoot, "stray-untracked.txt", "untracked\n");
      const before = head(projectRoot);
      const observed = observedTrackedDirty(projectRoot);
      expect(observed).toEqual(["file.txt"]);

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: true });

      expect(result.ok).toBe(false);
      expect(Array.isArray(result.dirtyPaths)).toBe(true);
      expect([...result.dirtyPaths].sort()).toEqual(observed);
      expect(result.dirtyPaths).not.toContain("stray-untracked.txt");
      expect(result.hint).toMatch(/file\.txt/);
      expect(result.hint).toMatch(/commit|stash/i);
      expect(result.hint).not.toContain("discardUncommitted");
      expect(head(projectRoot)).toBe(before);
      expect(readFile(projectRoot, "file.txt")).toBe("UNOWNED EDIT\n");
      expect(readFile(projectRoot, "stray-untracked.txt")).toBe("untracked\n");
    });

    it("BOTH opt-ins true — the reset runs and restores origin content (explicit double consent)", async () => {
      const runCycleComplete = await load();
      makeAhead(projectRoot);
      writeFile(projectRoot, "file.txt", "UNOWNED EDIT\n");
      writeFile(projectRoot, "stray-untracked.txt", "untracked\n");
      // Dirty BEFORE the call…
      expect(observedTrackedDirty(projectRoot)).toEqual(["file.txt"]);

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: true, discardUncommitted: true });

      expect(result.ok).toBe(true);
      expect(head(projectRoot)).toBe(originHead(projectRoot));
      expect(readFile(projectRoot, "file.txt")).toBe("initial");
      // …clean AFTER it: preservedPaths comes from the post-sync observation, so it is [].
      expect(observedTrackedDirty(projectRoot)).toEqual([]);
      expect(result.preservedPaths).toEqual([]);
      // An untracked file present throughout is never "preserved" and is untouched.
      expect(result.preservedPaths).not.toContain("stray-untracked.txt");
      expect(readFile(projectRoot, "stray-untracked.txt")).toBe("untracked\n");
    });

    it("discardUncommitted consent is strict === true", async () => {
      const runCycleComplete = await load();
      makeAhead(projectRoot);
      writeFile(projectRoot, "file.txt", "UNOWNED EDIT\n");
      const before = head(projectRoot);

      for (const discardUncommitted of ["yes", 1, {}]) {
        const result = await runCycleComplete({ projectRoot, discardLocalCommits: true, discardUncommitted });
        expect(result.ok, `discardUncommitted=${JSON.stringify(discardUncommitted)}`).toBe(false);
        expect(result.dirtyPaths).toEqual(["file.txt"]);
        if (result.hint !== undefined) expect(result.hint).not.toContain("discardUncommitted");
        expect(head(projectRoot)).toBe(before);
        expect(readFile(projectRoot, "file.txt")).toBe("UNOWNED EDIT\n");
      }
    });

    it("a dirty-tree refusal is non-destructive to branches — a merged rks/* branch survives", async () => {
      const runCycleComplete = await load();
      expect(git(projectRoot, ["branch", "rks/stale-merged"]).status).toBe(0);
      makeAhead(projectRoot);
      writeFile(projectRoot, "file.txt", "UNOWNED EDIT\n");
      // Positive control: the branch really is merged, so a completed cycle WOULD delete it.
      expect(out(projectRoot, ["branch", "--merged", "staging"])).toMatch(/rks\/stale-merged/);

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: true });

      expect(result.ok).toBe(false);
      expect(result.dirtyPaths).toEqual(["file.txt"]);
      expect(out(projectRoot, ["branch", "--list", "rks/*"])).toMatch(/rks\/stale-merged/);
    });
  });

  describe("untracked files are unaffected", () => {
    it("equal to origin — an untracked file survives and does not cause a refusal", async () => {
      const runCycleComplete = await load();
      writeFile(projectRoot, "untracked.txt", "keep me\n");

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(result.preservedPaths).toEqual([]);
      expect(readFile(projectRoot, "untracked.txt")).toBe("keep me\n");
    });

    it("ahead + discardLocalCommits true — an untracked file alone does not refuse, and survives", async () => {
      const runCycleComplete = await load();
      makeAhead(projectRoot);
      writeFile(projectRoot, "untracked.txt", "keep me\n");

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: true });

      expect(result.ok).toBe(true);
      expect(head(projectRoot)).toBe(originHead(projectRoot));
      expect(result.preservedPaths).toEqual([]);
      expect(readFile(projectRoot, "untracked.txt")).toBe("keep me\n");
    });
  });
});
