/**
 * Witness for backlog.fix.offrail-ship-and-phase-repair-skip-archive.
 * Real git against throwaway repos; every spawn carries a timeout.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { archiveShippedStory } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { archiveAndCommitIntegratedNote, commitAndPushNote } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const TIMEOUT = 15_000;
const g = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => fs.readFileSync(path.join(HERE, "../../packages/mcp-rks/src/server", rel), "utf8");

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); });

function initRepo({ withOrigin = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rks-archive-")));
  tmpDirs.push(root);
  g(root, ["init", "-b", "staging"]);
  g(root, ["config", "user.email", "t@t"]);
  g(root, ["config", "user.name", "t"]);
  g(root, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# t\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "-m", "init"]);
  let bare = null;
  if (withOrigin) {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-archive-bare-"));
    tmpDirs.push(bare);
    g(bare, ["init", "--bare", "-b", "staging"]);
    g(root, ["remote", "add", "origin", bare]);
    g(root, ["push", "-u", "origin", "staging"]);
  }
  return { root, bare, notesDir: path.join(root, "notes") };
}

function writeStory(notesDir, id, extra = "") {
  fs.writeFileSync(path.join(notesDir, `${id}.md`),
    `---\nid: "${id}"\ntitle: "T"\nstatus: "not-implemented"\nphase: "integrated"\n${extra}---\n\nbody\n`);
}

const archivedIdOf = (id) => id.replace(/^backlog\./, "backlog.z_implemented.");
const escapeRe = (v) => String(v).replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
const fieldRe = (field, value) => new RegExp("^" + field + ': "?' + escapeRe(value) + '"?$', "m");
const head = (root) => g(root, ["rev-parse", "HEAD"]).trim();

describe("archiveShippedStory", () => {
  it("archives a live note to backlog.z_implemented with status implemented and the new id", () => {
    // TR0
    const { root, notesDir } = initRepo({ withOrigin: false });
    const id = "backlog.fix.tr0-archive";
    writeStory(notesDir, id);
    const res = archiveShippedStory({ projectRoot: root, notesDir, problemId: id });
    const oldPath = path.join(notesDir, `${id}.md`);
    const newPath = path.join(notesDir, `${archivedIdOf(id)}.md`);
    expect(res.archived).toBe(true);
    expect(res.oldPath).toBe(oldPath);
    expect(res.newPath).toBe(newPath);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(newPath)).toBe(true);
    const text = fs.readFileSync(newPath, "utf8");
    expect(text).toMatch(fieldRe("status", "implemented"));
    expect(text).toMatch(fieldRe("id", archivedIdOf(id)));
  });

  it("writes commitId and commitBranch only when a commitSha is supplied", () => {
    // TR1
    const { root, notesDir } = initRepo({ withOrigin: false });
    const withSha = "backlog.fix.tr1-with-sha";
    const without = "backlog.fix.tr1-without-sha";
    writeStory(notesDir, withSha);
    writeStory(notesDir, without);

    const a = archiveShippedStory({ projectRoot: root, notesDir, problemId: withSha, commitSha: "abc1234def", commitBranch: "staging" });
    const b = archiveShippedStory({ projectRoot: root, notesDir, problemId: without });

    expect(a.archived).toBe(true);
    expect(b.archived).toBe(true);
    const aText = fs.readFileSync(a.newPath, "utf8");
    const bText = fs.readFileSync(b.newPath, "utf8");
    expect(aText).toMatch(fieldRe("commitId", "abc1234def"));
    expect(aText).toMatch(fieldRe("commitBranch", "staging"));
    expect(bText).not.toMatch(/^commitId:/m);
    expect(bText).not.toMatch(/^commitBranch:/m);
  });

  it("skips with already_implemented and leaves both notes byte-identical when the counterpart exists", () => {
    // TR2
    const { root, notesDir } = initRepo({ withOrigin: false });
    const id = "backlog.fix.tr2-counterpart";
    writeStory(notesDir, id);
    const counterpart = path.join(notesDir, `${archivedIdOf(id)}.md`);
    fs.writeFileSync(counterpart, `---\nid: "${archivedIdOf(id)}"\nstatus: "implemented"\n---\n\nearlier\n`);
    const liveBefore = fs.readFileSync(path.join(notesDir, `${id}.md`));
    const counterpartBefore = fs.readFileSync(counterpart);

    const res = archiveShippedStory({ projectRoot: root, notesDir, problemId: id });

    expect(res.archived).toBe(false);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("already_implemented");
    expect(fs.readFileSync(path.join(notesDir, `${id}.md`)).equals(liveBefore)).toBe(true);
    expect(fs.readFileSync(counterpart).equals(counterpartBefore)).toBe(true);
  });

  it("reports archived false with an error when the source note is missing", () => {
    // TR3
    const { root, notesDir } = initRepo({ withOrigin: false });
    const id = "backlog.fix.tr3-missing";
    const res = archiveShippedStory({ projectRoot: root, notesDir, problemId: id });
    expect(res.archived).toBe(false);
    expect(typeof res.error).toBe("string");
    expect(res.error.length).toBeGreaterThan(0);
    expect(res.oldPath).toBe(path.join(notesDir, `${id}.md`));
    expect(res.newPath).toBe(path.join(notesDir, `${archivedIdOf(id)}.md`));
    expect(fs.readdirSync(notesDir).filter((f) => f.startsWith("backlog.z_implemented."))).toEqual([]);
  });
});

describe("commitAndPushNote with multiple paths", () => {
  it("commits a rename in one pathspec-limited commit and leaves an unrelated staged path staged", () => {
    // TR4
    const { root, bare, notesDir } = initRepo();
    const id = "backlog.fix.tr4-rename";
    writeStory(notesDir, id);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "story"]);
    g(root, ["push", "origin", "staging"]);
    const before = head(root);
    const oldPath = path.join(notesDir, `${id}.md`);
    const newPath = path.join(notesDir, `${archivedIdOf(id)}.md`);
    fs.renameSync(oldPath, newPath);
    fs.writeFileSync(path.join(root, "staged-other.txt"), "staged\n");
    g(root, ["add", "--", "staged-other.txt"]);

    const res = commitAndPushNote(root, [oldPath, newPath], "staging", "chore: rename note");

    expect(res.ok).toBe(true);
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    const nameStatus = g(root, ["show", "--name-status", "--no-renames", "--format=", "HEAD"])
      .split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    expect(nameStatus).toContainEqual(["D", `notes/${id}.md`]);
    expect(nameStatus).toContainEqual(["A", `notes/${archivedIdOf(id)}.md`]);
    expect(nameStatus.length).toBe(2);
    expect(g(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)).toEqual(["staged-other.txt"]);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
  });
});

describe("archiveAndCommitIntegratedNote", () => {
  it("archives, commits both paths and pushes so origin holds only the archived note", () => {
    // TR5
    const { root, bare, notesDir } = initRepo();
    const id = "backlog.fix.tr5-offrail";
    writeStory(notesDir, id);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "story"]);
    g(root, ["push", "origin", "staging"]);
    const before = head(root);

    const res = archiveAndCommitIntegratedNote(root, id, "staging", `chore(story): advance ${id} to integrated`);

    expect(res.archive.archived).toBe(true);
    expect(res.note.ok).toBe(true);
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
    const originTree = g(bare, ["ls-tree", "-r", "--name-only", "staging"]).split("\n").filter(Boolean);
    expect(originTree).toContain(`notes/${archivedIdOf(id)}.md`);
    expect(originTree).not.toContain(`notes/${id}.md`);
    const archived = g(bare, ["show", `staging:notes/${archivedIdOf(id)}.md`]);
    expect(archived).toMatch(fieldRe("status", "implemented"));
    expect(archived).toMatch(fieldRe("phase", "integrated"));
    expect(archived).toMatch(fieldRe("id", archivedIdOf(id)));
    expect(g(root, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("makes no commit when the backlog.z_implemented counterpart already exists", () => {
    // TR6
    const { root, bare, notesDir } = initRepo();
    const id = "backlog.fix.tr6-already";
    writeStory(notesDir, id);
    fs.writeFileSync(path.join(notesDir, `${archivedIdOf(id)}.md`), `---\nid: "${archivedIdOf(id)}"\nstatus: "implemented"\n---\n\nearlier\n`);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "both"]);
    g(root, ["push", "origin", "staging"]);
    const before = head(root);

    const res = archiveAndCommitIntegratedNote(root, id, "staging", `chore(story): advance ${id} to integrated`);

    expect(res.archive.archived).toBe(false);
    expect(res.archive.skipped).toBe(true);
    expect(res.archive.reason).toBe("already_implemented");
    expect(res.note.skipped).toBe(true);
    expect(head(root)).toBe(before);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(before);
  });
});

describe("commitAndPushNote array mode independent of git config and cwd", () => {
  // backlog.fix.note-commit-multipath-drops-archived-note. Real git; every spawn goes through g (TIMEOUT).
  const seedCommittedStory = (root, notesDir, id) => {
    writeStory(notesDir, id);
    g(root, ["add", "-A"]);
    g(root, ["commit", "-m", "story"]);
    g(root, ["push", "origin", "staging"]);
  };
  const nameStatusOf = (root) => g(root, ["show", "--name-status", "--no-renames", "--format=", "HEAD"])
    .split("\n").filter(Boolean).map((l) => l.split(/\s+/));
  const originTree = (bare) => g(bare, ["ls-tree", "-r", "--name-only", "staging"]).split("\n").filter(Boolean);

  it("under status.showUntrackedFiles=no commits both halves of the rename in one commit and pushes it", () => {
    const { root, bare, notesDir } = initRepo();
    g(root, ["config", "status.showUntrackedFiles", "no"]);
    const id = "backlog.fix.nc0-untracked-no";
    seedCommittedStory(root, notesDir, id);
    const before = head(root);
    const oldPath = path.join(notesDir, `${id}.md`);
    const newPath = path.join(notesDir, `${archivedIdOf(id)}.md`);
    fs.renameSync(oldPath, newPath);

    const res = commitAndPushNote(root, [oldPath, newPath], "staging", "chore: archive note");

    expect(res.ok).toBe(true);
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    const ns = nameStatusOf(root);
    expect(ns).toContainEqual(["D", `notes/${id}.md`]);
    expect(ns).toContainEqual(["A", `notes/${archivedIdOf(id)}.md`]);
    expect(ns.length).toBe(2);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
    const tree = originTree(bare);
    expect(tree).toContain(`notes/${archivedIdOf(id)}.md`);
    expect(tree).not.toContain(`notes/${id}.md`);
  });

  it("under status.showUntrackedFiles=no archiveAndCommitIntegratedNote leaves origin holding the archived note", () => {
    const { root, bare, notesDir } = initRepo();
    g(root, ["config", "status.showUntrackedFiles", "no"]);
    const id = "backlog.fix.nc1-archive-untracked-no";
    seedCommittedStory(root, notesDir, id);

    const res = archiveAndCommitIntegratedNote(root, id, "staging", `chore(story): advance ${id} to integrated`);

    expect(res.archive.archived).toBe(true);
    expect(res.note.ok).toBe(true);
    const tree = originTree(bare);
    expect(tree).toContain(`notes/${archivedIdOf(id)}.md`);
    expect(tree).not.toContain(`notes/${id}.md`);
    expect(g(bare, ["show", `staging:notes/${archivedIdOf(id)}.md`])).toMatch(fieldRe("status", "implemented"));
  });

  it("with projectRoot below the repo root commits both halves of the rename and pushes", () => {
    const { root, bare } = initRepo();
    const sub = "proj";
    const projectRoot = path.join(root, sub);
    const subNotes = path.join(projectRoot, "notes");
    fs.mkdirSync(subNotes, { recursive: true });
    const id = "backlog.fix.nc2-subdir";
    seedCommittedStory(root, subNotes, id);
    const before = head(root);
    const oldPath = path.join(subNotes, `${id}.md`);
    const newPath = path.join(subNotes, `${archivedIdOf(id)}.md`);
    fs.renameSync(oldPath, newPath);

    const res = commitAndPushNote(projectRoot, [oldPath, newPath], "staging", "chore: archive note in a subdirectory");

    expect(res.ok).toBe(true);
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    const ns = nameStatusOf(root);
    expect(ns).toContainEqual(["D", `${sub}/notes/${id}.md`]);
    expect(ns).toContainEqual(["A", `${sub}/notes/${archivedIdOf(id)}.md`]);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(head(root));
  });

  it("skips with no commit when no requested path exists on disk or in the index", () => {
    const { root, bare, notesDir } = initRepo();
    const before = head(root);
    fs.writeFileSync(path.join(root, "staged-other.txt"), "staged\n");
    g(root, ["add", "--", "staged-other.txt"]);
    const id = "backlog.fix.nc3-absent";

    const res = commitAndPushNote(root, [path.join(notesDir, `${id}.md`), path.join(notesDir, `${archivedIdOf(id)}.md`)], "staging", "should not commit");

    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(head(root)).toBe(before);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(before);
    expect(g(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean)).toEqual(["staged-other.txt"]);
  });

  it("does not push and returns ok false naming the path when a requested on-disk path is absent from HEAD", () => {
    const { root, bare, notesDir } = initRepo();
    const id = "backlog.fix.nc4-hook-drops";
    seedCommittedStory(root, notesDir, id);
    const before = head(root);
    const originBefore = g(bare, ["rev-parse", "staging"]).trim();
    const archivedRel = `notes/${archivedIdOf(id)}.md`;
    // A repo-local pre-commit hook drops the archived path from the commit's index. git re-reads
    // the index after pre-commit, so the commit carries only the deletion. core.hooksPath is set
    // locally so a global hooksPath cannot shadow it; hooks run at the worktree top level.
    const hooksDir = path.join(root, ".git", "rks-test-hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hook, `#!/bin/sh\ngit rm --cached --quiet --ignore-unmatch -- "${archivedRel}"\nexit 0\n`);
    fs.chmodSync(hook, 0o755);
    g(root, ["config", "core.hooksPath", hooksDir]);
    const oldPath = path.join(notesDir, `${id}.md`);
    const newPath = path.join(notesDir, `${archivedIdOf(id)}.md`);
    fs.renameSync(oldPath, newPath);

    const res = commitAndPushNote(root, [oldPath, newPath], "staging", "chore: archive note");

    // Preconditions: a new commit was made, the archived note is on disk, and HEAD lacks it. If
    // these fail the setup did not produce the case under test: fix the setup, never the assertions.
    expect(g(root, ["rev-parse", "HEAD~1"]).trim()).toBe(before);
    expect(fs.existsSync(newPath)).toBe(true);
    expect(g(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n")).not.toContain(archivedRel);
    expect(res.ok).toBe(false);
    expect(res.pushed).toBe(false);
    expect(res.error).toContain(`${archivedIdOf(id)}.md`);
    expect(g(bare, ["rev-parse", "staging"]).trim()).toBe(originBefore);
  });
});

describe("guardrailsOn archive wiring", () => {
  it("archives in the phaseResult.ok block and never in the advanceSuppression branch", () => {
    // TR7: delimiter-bounded slices, never a fixed-size window.
    const src = SRC("guardrails-audit.mjs");
    const branchIdx = src.indexOf("if (advanceSuppression) {");
    const elseIdx = src.indexOf("} else {", branchIdx);
    const okIdx = src.indexOf("if (phaseResult.ok) {", elseIdx);
    const endIdx = src.indexOf("response.autoShipped = true;", okIdx);
    expect(branchIdx).toBeGreaterThan(-1);
    const suppressed = src.slice(branchIdx, elseIdx);
    const okBlock = src.slice(okIdx, endIdx);
    expect(suppressed).not.toContain("archiveAndCommitIntegratedNote(");
    expect(suppressed).not.toContain('step: "archive"');
    expect(okBlock).toContain("archiveAndCommitIntegratedNote(");
    expect(okBlock).toContain('step: "archive"');
    // ok alone is not evidence of integration: the archive call sits behind the to check.
    const guardIdx = okBlock.indexOf('if (phaseResult.to === "integrated") {');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(okBlock.indexOf("archiveAndCommitIntegratedNote(")).toBeGreaterThan(guardIdx);
    expect(okBlock.slice(0, guardIdx)).not.toContain("archiveAndCommitIntegratedNote(");
  });
});

describe("rks_story_ship archive wiring", () => {
  it("mark_implemented calls archiveShippedStory between the ship phase advance and the mark commit", () => {
    // TR12: delimiter-bounded slice of story-ship.mjs.
    const src = SRC("story-ship.mjs");
    const start = src.indexOf("advancePhase(projectRoot, problemId, 'ship', projectId)");
    const end = src.indexOf("as implemented`", start);
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, end)).toContain("archiveShippedStory(");
  });
});
