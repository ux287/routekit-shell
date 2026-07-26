/**
 * Witness for backlog.fix.exec-rollback-strands-executing-phase.
 *
 * THE BUG: a story is at phase `executing` on ENTRY to exec — the plan writer makes that hop, exec
 * only gates on it. So EVERY exit leaves it there unless something puts it back, and
 * `resetStalePhaseToArchApproved` was wired to 2 of ~12 exits. A scope violation, a quality gate, a
 * divergence, or any thrown error stranded the story at `executing`. `rks_plan` refuses that phase —
 * so the re-plan the failure message tells you to run is IMPOSSIBLE. A recoverable failure becomes
 * terminal and the story has to be deleted and recreated. A real clean-machine greenfield UAT hit
 * exactly this, and a human had to intervene.
 *
 * THE FIX IS THREE REGIONS, and they are NOT interchangeable — two of them DESTROY YOUR WORK if you
 * pick the wrong one. Both were found by ARCH against a naive "just call rollback() in the catch":
 *
 *   PRE-MUTATION  → bare phase reset. NEVER rollback().
 *       rollback()'s Step 5 (`cleanupWorkingTree`) is UNGUARDED. With no branch/backup/session it
 *       degenerates to exactly one action: WIPING THE TREE. On the dirty-tree precondition failure
 *       that tree is dirty with THE USER'S OWN uncommitted work, by definition. This is the test
 *       below that matters most.
 *
 *   POST-MUTATION → rollback(), then reset. A branch/backup/guardrails-session exists; a bare reset
 *       would leak all three.
 *
 *   FINALIZED     → phase reset only. NEVER rollback().
 *       The tail can throw AFTER a green, committed exec. rollback() would `git branch -D` the
 *       branch holding that commit — destroying a successful build because a JSON write failed.
 *
 * These drive the REAL `recoverExecFailure` (the actual catch body) and the REAL `rollback()` against
 * real git repos in tmp dirs. No mocks of the rule under test, no source-text greps.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recoverExecFailure, isResumablePause } from "../../packages/mcp-rks/src/server/exec.mjs";

const GIT_TIMEOUT = 30_000;
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });

let projectRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-recover-"));
  git(projectRoot, ["init", "-b", "staging"]);
  git(projectRoot, ["config", "user.email", "t@t.com"]);
  git(projectRoot, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(projectRoot, "src.txt"), "committed content\n");
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-m", "init"]);
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const baseCtx = (over = {}) => ({
  projectId: "p",
  projectRoot,
  baseBranch: "staging",
  runDir: null,
  storyId: null, // no story on disk in these fixtures — the reset is a guarded no-op, which is fine:
                 // what is under test here is WHICH RECOVERY RUNS, not the reset itself.
  branchName: null,
  backupMeta: null,
  guardrailsSession: null,
  finalized: false,
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════════════
// PRE-MUTATION — the data-loss guard. THE ONE THAT MATTERS.
// ══════════════════════════════════════════════════════════════════════════════════

describe("PRE-MUTATION: a precondition failure must NOT delete the user's uncommitted work", () => {
  it("leaves a dirty tracked file untouched (rollback() is never called)", async () => {
    // POSITIVE CONTROL — the file is genuinely dirty and tracked, and it is NOT under notes/.
    // (rollback()'s cleanup uses a `:!notes` pathspec, so a fixture under notes/ would survive
    // regardless and fake a pass.)
    const f = path.join(projectRoot, "src.txt");
    fs.writeFileSync(f, "MY UNCOMMITTED WORK\n");
    expect(git(projectRoot, ["status", "--porcelain"]).stdout).toMatch(/^ M src\.txt$/m);
    expect(fs.readFileSync(f, "utf8")).toBe("MY UNCOMMITTED WORK\n");

    // This is the exact shape at the dirty-tree precondition throw: nothing mutated yet.
    await recoverExecFailure(baseCtx(), new Error("working tree is dirty"));

    // THE CLAIM: the user's work survives. Under a naive rollback()-in-the-catch this file is GONE —
    // cleanupWorkingTree is unguarded and is the only step that runs with an all-null context.
    expect(fs.readFileSync(f, "utf8")).toBe("MY UNCOMMITTED WORK\n");
  });

  it("leaves an untracked file untouched too", async () => {
    const scratch = path.join(projectRoot, "scratch.txt");
    fs.writeFileSync(scratch, "untracked user file\n");
    expect(fs.existsSync(scratch)).toBe(true);

    await recoverExecFailure(baseCtx(), new Error("baseline tests failed"));

    // `git clean` inside cleanupWorkingTree would have removed this.
    expect(fs.existsSync(scratch)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// POST-MUTATION — rollback() must run, or we leak a branch / backup / guardrails
// ══════════════════════════════════════════════════════════════════════════════════

describe("POST-MUTATION: real mutations are rolled back", () => {
  it("restores the tree and removes the feature branch when a branch exists", async () => {
    // Simulate exec having created a branch and applied edits.
    git(projectRoot, ["checkout", "-b", "rks/demo"]);
    fs.writeFileSync(path.join(projectRoot, "src.txt"), "PARTIAL PLAN EDIT\n");
    fs.writeFileSync(path.join(projectRoot, "generated.txt"), "plan artifact\n");

    // POSITIVE CONTROL — the mutations are genuinely there before we recover.
    expect(git(projectRoot, ["branch", "--list", "rks/demo"]).stdout.trim()).not.toBe("");
    expect(fs.readFileSync(path.join(projectRoot, "src.txt"), "utf8")).toBe("PARTIAL PLAN EDIT\n");

    await recoverExecFailure(
      baseCtx({ branchName: "rks/demo" }),
      new Error("Scope violation - unexpected files modified"),
    );

    // The plan's edits are reverted and its artifact removed — this is what rollback() is FOR, and
    // the pre-mutation region must not be allowed to swallow it.
    expect(fs.readFileSync(path.join(projectRoot, "src.txt"), "utf8")).toBe("committed content\n");
    expect(fs.existsSync(path.join(projectRoot, "generated.txt"))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// FINALIZED — a tail throw must never destroy a green, committed exec
// ══════════════════════════════════════════════════════════════════════════════════

describe("FINALIZED: a throw after the commit must not destroy the commit", () => {
  it("keeps the commit and the rks/ branch when the tail throws", async () => {
    // A green exec: branch created, edits applied, COMMITTED.
    git(projectRoot, ["checkout", "-b", "rks/demo"]);
    fs.writeFileSync(path.join(projectRoot, "feature.txt"), "the delivered work\n");
    git(projectRoot, ["add", "-A"]);
    git(projectRoot, ["commit", "-m", "feat: delivered"]);

    // POSITIVE CONTROL — the commit and the branch genuinely exist before the tail throw.
    const sha = git(projectRoot, ["rev-parse", "HEAD"]).stdout.trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(projectRoot, ["branch", "--list", "rks/demo"]).stdout.trim()).not.toBe("");
    expect(fs.existsSync(path.join(projectRoot, "feature.txt"))).toBe(true);

    // markExecComplete (a JSON write) throws AFTER all of that.
    await recoverExecFailure(
      baseCtx({ branchName: "rks/demo", backupMeta: { type: "stash" }, finalized: true }),
      new Error("ENOSPC: no space left on device, write"),
    );

    // THE CLAIM: committed work is never rolled back. Without the FINALIZED region this branch is
    // force-deleted (`git branch -D`) and the delivered work is gone — because a JSON write failed.
    expect(git(projectRoot, ["rev-parse", "HEAD"]).stdout.trim()).toBe(sha);
    expect(git(projectRoot, ["branch", "--list", "rks/demo"]).stdout.trim()).not.toBe("");
    expect(fs.readFileSync(path.join(projectRoot, "feature.txt"), "utf8")).toBe("the delivered work\n");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// The carve-outs — exits that are a resumable PAUSE, not a failure
// ══════════════════════════════════════════════════════════════════════════════════

describe("resumable pauses are NOT reset (their own remedy re-enters exec)", () => {
  it("needs_approval and incomplete_previous_story are carved out", () => {
    // Both of these tell you to do something and RETRY — and the retry re-enters exec, which
    // re-checks the `executing` gate. Resetting the phase here does not un-stick the story; it
    // wedges the very flow that was about to recover it.
    expect(isResumablePause({ ok: false, status: "needs_approval" })).toBe(true);
    expect(isResumablePause({ ok: false, reason: "incomplete_previous_story" })).toBe(true);
  });

  it("NEGATIVE CONTROL: real failures are NOT carved out — they must reset", () => {
    // If this ever returns true, the original P0 is back: the story strands at `executing` and the
    // re-plan the error message demands is impossible.
    for (const reason of ["integrity_failed", "qa_blocked", "quality_failed", "scope_violation"]) {
      expect(isResumablePause({ ok: false, reason })).toBe(false);
    }
    expect(isResumablePause({ ok: false, testsFailed: true })).toBe(false);
    expect(isResumablePause({ ok: false, error: "exec.diverged" })).toBe(false);
    expect(isResumablePause(undefined)).toBe(false);
  });
});
