/**
 * Witness for backlog.fix.cycle-complete-ungated-hard-reset — the gate, driven for real.
 *
 * THE DEFECT, in one sentence: `runCycleComplete` computed how many unpushed commits its
 * `git reset --hard origin/<working>` was about to destroy, formatted a warning saying so, put
 * that warning on an `ok: true` payload nothing treated as a blocker, and reset anyway. On
 * 2026-08-21 it discarded ~30 unpushed commits in this repository, reached through the
 * `rks_guardrails_on` auto-ship that CLAUDE.md tells every off-rail build to finish with.
 *
 * These tests drive the real function against a real repository. The negative case asserts the
 * commits SURVIVE — anything weaker (checking only the return value) would pass against a
 * function that reported a refusal and reset anyway, which is a near-miss of the original bug.
 *
 * FIXTURE SAFETY — non-negotiable for this file specifically. `getRepoCopy` is rooted in
 * os.tmpdir(); nothing above it is a git repository, so a stray `runGit` cannot walk up into a
 * real one. Do NOT port these onto `tests/helpers/tmp.mjs` (`makeTempDir`), which creates
 * fixtures at `process.cwd()/tests/.tmp` — INSIDE this repository. Combined with rks's
 * cwd-only git binding, a fixture there whose `git init` silently failed is exactly how a test
 * acquires a handle on the developer's repo and hard-resets it. See
 * backlog.fix.test-fixture-repo-containment and backlog.fix.rungit-repo-root-binding.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getRepoCopy } from "../helpers/git-repo-template.mjs";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const out = (cwd, args) => git(cwd, args).stdout.trim();

/** Commit locally on `staging` WITHOUT pushing — this is the state the gate must protect. */
function commitLocally(repo, filename, message) {
  fs.writeFileSync(path.join(repo, filename), `${message}\n`);
  git(repo, ["add", "."]);
  const res = git(repo, ["commit", "-m", message]);
  expect(res.status, `fixture commit failed: ${res.stderr}`).toBe(0);
  return out(repo, ["rev-parse", "HEAD"]);
}

describe("runCycleComplete destructive gate", { timeout: 30_000 }, () => {
  let projectRoot;

  beforeEach(() => {
    // work repo on `staging` + sibling bare origin + one commit pushed. os.tmpdir()-rooted.
    ({ workDir: projectRoot } = getRepoCopy("working-with-origin"));
    // The fixture must be ON the working branch: runCycleComplete checks out `working` before the
    // gate can fire, and a checkout would make "HEAD is byte-identical" unsatisfiable for reasons
    // unrelated to the reset.
    expect(out(projectRoot, ["branch", "--show-current"])).toBe("staging");
  });

  describe("the negative case — a diverged branch is REFUSED", () => {
    it("does not reset, and the unpushed commits survive", async () => {
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      const head = commitLocally(projectRoot, "unpushed-a.txt", "local work A");

      // POSITIVE CONTROL: the branch really IS ahead of origin. Without this, a green result
      // could mean "the gate worked" or "there was nothing to discard" — indistinguishable.
      const ahead = Number(out(projectRoot, ["rev-list", "--count", "origin/staging..staging"]));
      expect(ahead, "fixture is not diverged — the test would be vacuous").toBe(1);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(false);
      expect(result.localCommitsDiscarded).toBe(1);
      expect(result.divergenceWarning).toMatch(/1 local commit\(s\).*will be lost/);
      expect(result.error).toMatch(/Refusing to hard-reset/i);
      expect(result.hint).toMatch(/discardLocalCommits: true/);

      // THE ASSERTION THAT MATTERS. The return value is secondary; the commit surviving is the fix.
      expect(out(projectRoot, ["rev-parse", "HEAD"])).toBe(head);
      expect(fs.existsSync(path.join(projectRoot, "unpushed-a.txt"))).toBe(true);
      expect(Number(out(projectRoot, ["rev-list", "--count", "origin/staging..staging"]))).toBe(1);
    });

    it("refuses regardless of how many commits are at stake", async () => {
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      commitLocally(projectRoot, "unpushed-a.txt", "local work A");
      commitLocally(projectRoot, "unpushed-b.txt", "local work B");
      const head = commitLocally(projectRoot, "unpushed-c.txt", "local work C");

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(false);
      expect(result.localCommitsDiscarded).toBe(3);
      expect(out(projectRoot, ["rev-parse", "HEAD"])).toBe(head);
    });

    it("a merged stale rks/* branch SURVIVES the refusal", async () => {
      // Pins the early-return placement. The reset at git-ship.mjs is followed by feature-branch
      // deletion and a stale `rks/*` sweep; the gate returns before both. That is intended —
      // deleting branches on the way out of a refusal would be a second destructive act performed
      // without the consent that was just withheld.
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      git(projectRoot, ["checkout", "-b", "rks/story-a"]);
      fs.writeFileSync(path.join(projectRoot, "story-a.txt"), "a");
      git(projectRoot, ["add", "."]);
      git(projectRoot, ["commit", "-m", "work on rks/story-a"]);
      git(projectRoot, ["checkout", "staging"]);
      git(projectRoot, ["merge", "rks/story-a", "--no-edit"]);

      // Merged, and staging is now ahead of origin — so the gate fires.
      expect(out(projectRoot, ["branch", "--merged", "staging"])).toContain("rks/story-a");
      expect(Number(out(projectRoot, ["rev-list", "--count", "origin/staging..staging"]))).toBeGreaterThan(0);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(false);
      expect(out(projectRoot, ["branch", "--list", "rks/*"])).toContain("rks/story-a");
    });
  });

  describe("the positive control — an in-sync branch is unaffected", () => {
    it("still resets and reports ok when the branch is not ahead", async () => {
      // The non-disruption proof. A gate that refused whenever it could not prove safety would
      // break every healthy ship, which is the over-correction direction.
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      commitLocally(projectRoot, "pushed.txt", "work that gets pushed");
      const pushRes = git(projectRoot, ["push", "origin", "staging"]);
      expect(pushRes.status, `fixture push failed: ${pushRes.stderr}`).toBe(0);
      expect(Number(out(projectRoot, ["rev-list", "--count", "origin/staging..staging"]))).toBe(0);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(result.synced).toBe(true);
      expect(result.divergenceWarning).toBeNull();
      expect(fs.existsSync(path.join(projectRoot, "pushed.txt"))).toBe(true);
    });

    it("cleanup still runs on the healthy path", async () => {
      // Complement to the survives-a-refusal case: the early return must not have disabled the
      // stale sweep outright.
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      git(projectRoot, ["checkout", "-b", "rks/story-b"]);
      fs.writeFileSync(path.join(projectRoot, "story-b.txt"), "b");
      git(projectRoot, ["add", "."]);
      git(projectRoot, ["commit", "-m", "work on rks/story-b"]);
      git(projectRoot, ["checkout", "staging"]);
      git(projectRoot, ["merge", "rks/story-b", "--no-edit"]);
      git(projectRoot, ["push", "origin", "staging"]);

      const result = await runCycleComplete({ projectRoot });

      expect(result.ok).toBe(true);
      expect(out(projectRoot, ["branch", "--list", "rks/*"])).toBe("");
    });
  });

  describe("the escape hatch — explicit opt-in still discards", () => {
    it("resets when discardLocalCommits is true, and the commits are gone", async () => {
      // The gate is consent, not prohibition. Someone who genuinely wants the old behaviour must
      // still be able to get it — and must have said so.
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      const originHead = out(projectRoot, ["rev-parse", "origin/staging"]);
      commitLocally(projectRoot, "doomed.txt", "deliberately discarded");
      expect(Number(out(projectRoot, ["rev-list", "--count", "origin/staging..staging"]))).toBe(1);

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: true });

      expect(result.ok).toBe(true);
      expect(result.divergenceWarning).toMatch(/1 local commit\(s\)/);
      expect(out(projectRoot, ["rev-parse", "HEAD"])).toBe(originHead);
      expect(fs.existsSync(path.join(projectRoot, "doomed.txt"))).toBe(false);
    });

    it("an explicit false is treated as refusal, not as absent-and-therefore-fine", async () => {
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");
      const head = commitLocally(projectRoot, "unpushed.txt", "local work");

      const result = await runCycleComplete({ projectRoot, discardLocalCommits: false });

      expect(result.ok).toBe(false);
      expect(out(projectRoot, ["rev-parse", "HEAD"])).toBe(head);
    });

    it("only a strict true opts in — a truthy non-boolean does NOT", async () => {
      // Consent must be unambiguous. A loosely-typed caller passing "false", "no", 1, or any other
      // truthy value must not be able to authorise data destruction on the user's behalf, which is
      // what `!discardLocalCommits` would have allowed.
      const { runCycleComplete } = await import("../../packages/mcp-rks/src/server/git-tools.mjs");

      for (const value of ["yes", "false", 1, {}]) {
        ({ workDir: projectRoot } = getRepoCopy("working-with-origin"));
        const head = commitLocally(projectRoot, "unpushed.txt", "local work");

        const result = await runCycleComplete({ projectRoot, discardLocalCommits: value });

        expect(result.ok, `${JSON.stringify(value)} must not opt in`).toBe(false);
        expect(out(projectRoot, ["rev-parse", "HEAD"])).toBe(head);
      }
    });
  });
});
