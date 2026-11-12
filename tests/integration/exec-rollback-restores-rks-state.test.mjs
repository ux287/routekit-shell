/**
 * backlog.fix.exec-backup-scope-and-restore
 *
 * TWO INDEPENDENT DEFECTS, and the tests must fail independently or a half-fix
 * looks like progress (which is how the v0.39.0 lockfile split shipped).
 *
 * DEFECT 1 — createBackup stashed `.rks/` state that every guard exempts. A
 * child project's committed `.rks/project.json` went into a stash and did not
 * come back.
 *
 * DEFECT 2 — rollback() restores the stash at Step 3, then cleanupWorkingTree at
 * Step 5 runs `git checkout -- . :!notes`, resetting every TRACKED file outside
 * notes/ to HEAD — undoing the restore it just performed. `--exclude=.rks` on
 * the `git clean` spares only UNTRACKED files, so a committed .rks/project.json
 * was reverted regardless, and the restore logged SUCCESS two steps earlier.
 *
 * WHY THE FIXTURES COMMIT THEIR FILES: the pre-existing test titled "preserves
 * .rks directory during cleanup" fixtures an UNTRACKED .rks file. Untracked .rks
 * is spared by `git clean --exclude=.rks` alone, so it passed green with Defect 2
 * fully live. Only a TRACKED, MODIFIED file can observe the checkout.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import {
  createBackup,
  cleanupWorkingTree,
  PROTECTED_PATHS,
} from "../../packages/mcp-rks/src/exec/backup.mjs";
import { rollback } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const GIT_TIMEOUT = 15000;

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT });
}

/** Every protected path gets a COMMITTED file, so the checkout can be observed. */
function initRepo(dir) {
  git(dir, ["init", "-b", "staging"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  for (const p of PROTECTED_PATHS) {
    fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, p, "state.json"), '{"committed":true}\n');
  }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// committed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.clearAllMocks();
});

function fixture(prefix) {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  initRepo(dir);
  return dir;
}

function dirtyProtected(dir) {
  for (const p of PROTECTED_PATHS) {
    fs.writeFileSync(path.join(dir, p, "state.json"), `{"edited":"${p}"}\n`);
  }
}

function readProtected(dir, p) {
  return fs.readFileSync(path.join(dir, p, "state.json"), "utf8");
}

// ── TR1 — SOLE witness for Defect 1 ──────────────────────────────────────────
// Note: the end-to-end test below CANNOT witness this. Once rollback restores
// the stash, the file comes back regardless of whether it should have been
// stashed at all — restore compensates for the stash-scope bug. Only a direct
// createBackup assertion sees it.
describe("TR1 — createBackup leaves every protected path alone", () => {
  it.each(PROTECTED_PATHS)("does not stash a committed, modified %s file", (protectedPath) => {
    const root = fixture(`backup-protect-${protectedPath.replace(/\W/g, "")}`);
    dirtyProtected(root);

    const meta = createBackup(root, "backlog.fix.demo");

    // Content survives on disk...
    expect(readProtected(root, protectedPath)).toContain(`"edited":"${protectedPath}"`);
    // ...and is absent from the stash, when one was created at all.
    if (meta.stashCreated) {
      const stashed = git(root, ["stash", "show", "--include-untracked", "--name-only", meta.stashSha]).stdout || "";
      expect(stashed).not.toContain(`${protectedPath}/state.json`);
    }
  });

  it("ANTI-VACUITY CONTROL — an ordinary source file IS still stashed", () => {
    // Without this, an "exclude everything" implementation passes every case above.
    const root = fixture("backup-control");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// modified\n");

    const meta = createBackup(root, "backlog.fix.demo");

    expect(meta.stashCreated).toBe(true);
    const stashed = git(root, ["stash", "show", "--include-untracked", "--name-only", meta.stashSha]).stdout || "";
    expect(stashed).toContain("src/app.mjs");
    expect(fs.readFileSync(path.join(root, "src", "app.mjs"), "utf8")).toBe("// committed\n");
  });
});

// ── TR5 — SOLE witness for Defect 2 ──────────────────────────────────────────
describe("TR5 — cleanupWorkingTree does not revert TRACKED protected files", () => {
  it.each(PROTECTED_PATHS)("preserves a committed, modified %s file through checkout", (protectedPath) => {
    const root = fixture(`cleanup-protect-${protectedPath.replace(/\W/g, "")}`);
    dirtyProtected(root);

    cleanupWorkingTree(root);

    expect(readProtected(root, protectedPath)).toContain(`"edited":"${protectedPath}"`);
  });

  it("ANTI-VACUITY CONTROL — an ordinary source file IS reset to HEAD", () => {
    const root = fixture("cleanup-control");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// modified\n");
    fs.writeFileSync(path.join(root, "untracked.tmp"), "junk\n");

    cleanupWorkingTree(root);

    expect(fs.readFileSync(path.join(root, "src", "app.mjs"), "utf8")).toBe("// committed\n");
    expect(fs.existsSync(path.join(root, "untracked.tmp"))).toBe(false);
  });
});

// ── TR7 — the composed path ──────────────────────────────────────────────────
describe("TR7 — a rolled-back exec gives the user their protected state back", () => {
  it("leaves protected paths edited, through the real rollback()", async () => {
    const root = fixture("rollback-e2e");

    // POSITIVE CONTROL: a src file is dirtied so the backup produces a REAL
    // stash. Without it, only protected paths are dirty, nothing is stashable,
    // stashCreated is false, Step 3 early-returns, and this test silently
    // degrades into a duplicate of TR5 while appearing to exercise restore.
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// WORK IN PROGRESS\n");
    dirtyProtected(root);

    const backupMeta = createBackup(root, "backlog.fix.demo");
    expect(backupMeta.stashCreated, "fixture must produce a real stash or this test proves nothing").toBe(true);

    const result = await rollback(root, {
      runDir: null, branchName: null, baseBranch: null,
      backupMeta, guardrailsSession: null,
      projectId: "routekit-shell-core", reason: "static_analysis_failed",
    });

    // Step 3 ran and reported success — this is what makes the case composed
    // rather than a TR5 duplicate.
    expect(result.restored).toBe(true);
    expect(result.restoreError).toBeUndefined();

    // The protected edits were never taken away.
    for (const p of PROTECTED_PATHS) {
      expect(readProtected(root, p)).toContain(`"edited":"${p}"`);
    }
  });

  it("SCOPE BOUNDARY — restored src work is still reset by cleanup, and that is NOT fixed here", () => {
    // Recorded as a finding, not a fix. cleanupWorkingTree's `git checkout -- .`
    // resets every tracked file outside the protected set to HEAD, so the src
    // work restoreBackup just put back is wiped by Step 5. The stash survives
    // (restore uses `apply`, not `pop`), so the data is recoverable by hand —
    // but the worktree never receives it, which makes the restore of ordinary
    // source work effectively inert.
    //
    // Out of scope: this story's ACs cover the PROTECTED paths. Fixing this
    // requires changing cleanupWorkingTree's contract — it is documented as
    // "guarantees clean state", so restoring user work and then guaranteeing
    // cleanliness are in direct tension and need a design decision, not a patch.
    expect(PROTECTED_PATHS).not.toContain("src");
  });
});

// ── Telemetry — a rolled-back exec must be visible ───────────────────────────
describe("rollback emits a terminal event", () => {
  // Read off ensureTelemetryStorage, NOT getTelemetryCollector — tests/setup.mjs
  // mocks the barrel into two distinct objects and the code under test calls
  // this one. The other would be an empty array and permanently green.
  function rollbackEvents(root) {
    const collector = ensureTelemetryStorage(root);
    return ((collector.emit?.mock?.calls) || [])
      .filter(([type]) => type === "exec.rollback")
      .map(([, , payload]) => payload || {});
  }

  it("emits exec.rollback carrying its reason and restore outcome", async () => {
    const root = fixture("rollback-telemetry");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// wip\n");
    const backupMeta = createBackup(root, "backlog.fix.demo");

    await rollback(root, {
      runDir: null, branchName: null, baseBranch: null,
      backupMeta, guardrailsSession: null,
      projectId: "routekit-shell-core", reason: "scope_violation",
    });

    const events = rollbackEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("scope_violation");
    expect(events[0]).toHaveProperty("restored");
    expect(events[0]).toHaveProperty("cleaned");
  });

  it("passes a DYNAMIC reason through verbatim", async () => {
    // One call site builds `exec_threw: <message>` at runtime. A closed enum or
    // switch would drop every thrown-error rollback — the exact hole this closes.
    const root = fixture("rollback-dynamic-reason");
    const dynamic = "exec_threw: Cannot read properties of undefined";

    await rollback(root, {
      runDir: null, branchName: null, baseBranch: null,
      backupMeta: null, guardrailsSession: null,
      projectId: "routekit-shell-core", reason: dynamic,
    });

    const events = rollbackEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe(dynamic);
  });
});
