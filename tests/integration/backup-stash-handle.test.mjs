/**
 * backlog.fix.exec-note-scope-and-backup-durability — the backup-handle group.
 *
 * TR17-TR21, TR23, TR24(b). `packages/mcp-rks/src/exec/backup.mjs` had ZERO test
 * coverage before this file, so every case here is new coverage.
 *
 * The defect this pins: `createBackup` parsed a `stash@{N}` reflog selector out
 * of `git stash push` stdout, which never contains one — so `stashRef` was null
 * on every call, the apply branch was dead code, and 100% of restores fell
 * through to selecting "the newest entry containing the substring 'rks.exec
 * backup'". With orphaned entries accumulating, that pops an unrelated run's
 * stash.
 *
 * Every case runs inside a temp-dir git fixture. NO test here may run a stash
 * command against the real repository (TR12).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import {
  createBackup,
  restoreBackup,
  dropBackupStash,
} from "../../packages/mcp-rks/src/exec/backup.mjs";

const GIT_TIMEOUT = 15000;

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT });
}

function initGitRepo(dir) {
  git(dir, ["init", "-b", "staging"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// original app\n");
  fs.writeFileSync(path.join(dir, "notes", "backlog.fix.demo.md"), "---\nphase: executing\n---\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

function stashList(dir) {
  return (git(dir, ["stash", "list"]).stdout || "").trim();
}

function stashCount(dir) {
  const out = stashList(dir);
  return out ? out.split("\n").length : 0;
}

/** Create an unrelated stash whose message also contains the 'rks.exec backup' substring. */
function seedForeignBackupStash(dir, label) {
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), `// foreign ${label}\n`);
  git(dir, ["stash", "push", "-m", `rks.exec backup ${label}`]);
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fixture(prefix) {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  initGitRepo(dir);
  return dir;
}

describe("createBackup — content-addressed stash handle (TR18)", () => {
  it("(a) reports stashCreated with a SHA that refs/stash resolves to", () => {
    const root = fixture("backup-handle-a");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// modified\n");

    const meta = createBackup(root);

    expect(meta.type).toBe("git-stash");
    expect(meta.stashCreated).toBe(true);
    expect(meta.stashSha).toMatch(/^[0-9a-f]{40}$/);

    const resolved = git(root, ["rev-parse", "refs/stash"]).stdout.trim();
    expect(resolved).toBe(meta.stashSha);
  });

  it("(b) reports stashCreated:false when there is nothing to stash — and success is TRUE (TR5)", () => {
    const root = fixture("backup-handle-b");
    // Only a notes file is dirty. With the notes-excluding pathspec there is
    // nothing to stash, and `git stash push` exits 0 printing "No local changes
    // to save" — so `success` cannot discriminate and MUST NOT be asserted false.
    fs.writeFileSync(path.join(root, "notes", "backlog.fix.demo.md"), "---\nphase: executed\n---\n");
    const before = stashList(root);

    const meta = createBackup(root);

    expect(meta.success).toBe(true);
    expect(meta.stashCreated).toBe(false);
    expect(meta.stashSha).toBeNull();
    expect(stashList(root)).toBe(before);
  });

  it("(c) does not throw when refs/stash does not exist at all", () => {
    const root = fixture("backup-handle-c");
    expect(stashCount(root)).toBe(0);
    expect(() => createBackup(root)).not.toThrow();
  });
});

describe("createBackup — notes-excluding pathspec, pinned by behaviour not version (TR20)", () => {
  it("leaves notes on disk while stashing tracked and untracked non-notes files", () => {
    const root = fixture("backup-pathspec");
    const notePath = path.join(root, "notes", "backlog.fix.demo.md");
    const trackedPath = path.join(root, "src", "app.mjs");
    const untrackedPath = path.join(root, "src", "generated.mjs");

    fs.writeFileSync(notePath, "---\nphase: executing\n---\nDIRTY NOTE\n");
    fs.writeFileSync(trackedPath, "// modified app\n");
    fs.writeFileSync(untrackedPath, "// untracked artifact\n");

    const meta = createBackup(root);
    expect(meta.stashCreated).toBe(true);

    // (a) the note keeps its modified content and is not in the stash
    expect(fs.readFileSync(notePath, "utf8")).toContain("DIRTY NOTE");
    const stashed = git(root, ["stash", "show", "--include-untracked", "--name-only", meta.stashSha]).stdout || "";
    expect(stashed).not.toContain("notes/backlog.fix.demo.md");

    // (b) the tracked non-notes file was reset to HEAD and IS in the stash
    expect(fs.readFileSync(trackedPath, "utf8")).toBe("// original app\n");
    expect(stashed).toContain("src/app.mjs");

    // (c) the untracked non-notes file was captured and removed from the worktree
    expect(fs.existsSync(untrackedPath)).toBe(false);
    expect(stashed).toContain("src/generated.mjs");
  });
});

describe("restoreBackup — restores THIS run's stash, keyed on the SHA (TR17)", () => {
  it("(a) restores nothing when no stash was created, even with a foreign 'rks.exec backup' entry present", () => {
    const root = fixture("restore-none");
    seedForeignBackupStash(root, "foreign-run");
    const countBefore = stashCount(root);
    const appBefore = fs.readFileSync(path.join(root, "src", "app.mjs"), "utf8");

    const result = restoreBackup(root, { type: "git-stash", stashCreated: false, stashSha: null });

    expect(result.restored).toBe(false);
    expect(result.error).toBeTruthy();
    expect(stashCount(root)).toBe(countBefore);
    // the foreign stash's content must NOT have landed in the worktree
    expect(fs.readFileSync(path.join(root, "src", "app.mjs"), "utf8")).toBe(appBefore);
    expect(fs.readFileSync(path.join(root, "src", "app.mjs"), "utf8")).not.toContain("foreign-run");
  });

  it("(b) DECISIVE: real stashed work comes back byte-for-byte", () => {
    const root = fixture("restore-real");
    const trackedPath = path.join(root, "src", "app.mjs");
    const known = "// WORK IN PROGRESS — must survive rollback\nexport const x = 42;\n";
    fs.writeFileSync(trackedPath, known);

    const meta = createBackup(root);
    expect(meta.stashCreated).toBe(true);
    // createBackup reverted the file — this is the state a rollback starts from
    expect(fs.readFileSync(trackedPath, "utf8")).toBe("// original app\n");

    const result = restoreBackup(root, meta);

    expect(result.restored).toBe(true);
    expect(fs.readFileSync(trackedPath, "utf8")).toBe(known);
  });

  it("(c) restores THIS run's content, not a newer foreign 'rks.exec backup' entry", () => {
    const root = fixture("restore-wrong-target");
    const trackedPath = path.join(root, "src", "app.mjs");
    const mine = "// MINE\n";
    fs.writeFileSync(trackedPath, mine);

    const meta = createBackup(root);
    expect(meta.stashCreated).toBe(true);

    // A newer entry that ALSO matches the old substring selector, created after ours.
    seedForeignBackupStash(root, "newer-foreign");

    const result = restoreBackup(root, meta);

    expect(result.restored).toBe(true);
    const restored = fs.readFileSync(trackedPath, "utf8");
    expect(restored).toBe(mine);
    expect(restored).not.toContain("newer-foreign");
  });
});

describe("dropBackupStash — SHA equality only (TR19)", () => {
  it("(a) drops exactly this run's stash and leaves pre-existing entries intact", () => {
    const root = fixture("drop-exact");
    seedForeignBackupStash(root, "older-foreign");
    const foreignSha = git(root, ["rev-parse", "refs/stash"]).stdout.trim();

    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// mine\n");
    const meta = createBackup(root);
    expect(meta.stashCreated).toBe(true);

    const result = dropBackupStash(root, meta);

    expect(result.dropped).toBe(true);
    const listed = git(root, ["stash", "list", "--format=%H"]).stdout || "";
    expect(listed).not.toContain(meta.stashSha);
    expect(listed).toContain(foreignSha);
  });

  it("(b) leaves a NEWER unrelated 'rks.exec backup' entry present", () => {
    const root = fixture("drop-newer-foreign");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// mine\n");
    const meta = createBackup(root);

    seedForeignBackupStash(root, "newer-foreign");
    const newerSha = git(root, ["rev-parse", "refs/stash"]).stdout.trim();

    dropBackupStash(root, meta);

    const listed = git(root, ["stash", "list", "--format=%H"]).stdout || "";
    expect(listed).toContain(newerSha);
    expect(listed).not.toContain(meta.stashSha);
  });

  it("(c) touches nothing when no stash was created", () => {
    const root = fixture("drop-noop");
    seedForeignBackupStash(root, "untouched");
    const before = stashList(root);

    const result = dropBackupStash(root, { type: "git-stash", stashCreated: false, stashSha: null });

    expect(result.dropped).toBe(false);
    expect(stashList(root)).toBe(before);
  });
});

describe("restore failures report a real error (TR21)", () => {
  it("returns a populated error, not undefined, when apply fails", () => {
    const root = fixture("restore-error");
    const trackedPath = path.join(root, "src", "app.mjs");

    fs.writeFileSync(trackedPath, "// stashed change\n");
    const meta = createBackup(root);
    expect(meta.stashCreated).toBe(true);

    // Conflicting local change: apply cannot overwrite it.
    fs.writeFileSync(trackedPath, "// conflicting local change\n");

    const result = restoreBackup(root, meta);

    expect(result.restored).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
    expect(result.error).not.toBe("undefined");
  });
});

describe("stash message carries story attribution (TR23)", () => {
  it("includes the problemId in the stash commit subject", () => {
    const root = fixture("stash-attribution");
    fs.writeFileSync(path.join(root, "src", "app.mjs"), "// modified\n");

    const meta = createBackup(root, "backlog.fix.demo");

    expect(meta.stashCreated).toBe(true);
    const subject = git(root, ["log", "-1", "--format=%s", meta.stashSha]).stdout || "";
    expect(subject).toContain("backlog.fix.demo");
  });
});

describe("NEGATIVE AC — no substring-selected stash mutation (TR24b)", () => {
  it("backup.mjs does not select a stash for pop or drop by matching the backup substring", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "packages/mcp-rks/src/exec/backup.mjs"),
      "utf8",
    );
    // The old defect: lines.find(l => l.includes("rks.exec backup")) feeding a pop.
    expect(src).not.toMatch(/\.find\s*\([^)]*includes\s*\(\s*["'`]rks\.exec backup/);
    expect(src).not.toContain('stash", "pop"');
    // Selection must be SHA equality against the stash list.
    expect(src).toContain("--format=%gd %H");
  });
});
