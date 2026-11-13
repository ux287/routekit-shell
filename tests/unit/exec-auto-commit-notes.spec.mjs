import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { getUncommittedFiles, runGit } from "../../packages/mcp-rks/src/utils/git.mjs";

function initGitRepo(dir) {
  spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "root");
  // Seed notes/ as tracked so new files show up individually in git status --porcelain
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", ".gitkeep"), "");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("exec auto-commit notes before dirty tree check", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("exec-auto-commit-notes");
    initGitRepo(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("note files are auto-committed and no longer block the dirty tree check", () => {
    // Simulate a note file created after planning (untracked/dirty)
    fs.writeFileSync(path.join(projectRoot, "notes", "backlog.feat.child-1.md"), "---\nid: test\n---\n");

    const dirtyBefore = getUncommittedFiles(projectRoot, { filterRks: false });
    expect(dirtyBefore).toContain("notes/backlog.feat.child-1.md");

    // Apply the auto-commit logic from exec.mjs
    const dirtyNotes = dirtyBefore.filter(f => f.startsWith("notes/") && f.endsWith(".md"));
    expect(dirtyNotes).toHaveLength(1);

    runGit(projectRoot, ["add", ...dirtyNotes]);
    runGit(projectRoot, ["commit", "-m", "docs(backlog): update notes before exec"]);

    const dirtyAfter = getUncommittedFiles(projectRoot, { filterRks: false });
    expect(dirtyAfter).not.toContain("notes/backlog.feat.child-1.md");
    expect(dirtyAfter).toHaveLength(0);
  });

  it("non-note dirty files remain dirty after notes are auto-committed", () => {
    fs.writeFileSync(path.join(projectRoot, "notes", "backlog.feat.child-1.md"), "---\nid: test\n---\n");
    fs.writeFileSync(path.join(projectRoot, "src.mjs"), "// dirty source file");

    const dirtyBefore = getUncommittedFiles(projectRoot, { filterRks: false });
    expect(dirtyBefore).toContain("notes/backlog.feat.child-1.md");
    expect(dirtyBefore).toContain("src.mjs");

    // Auto-commit only notes
    const dirtyNotes = dirtyBefore.filter(f => f.startsWith("notes/") && f.endsWith(".md"));
    runGit(projectRoot, ["add", ...dirtyNotes]);
    runGit(projectRoot, ["commit", "-m", "docs(backlog): update notes before exec"]);

    const dirtyAfter = getUncommittedFiles(projectRoot, { filterRks: false });
    expect(dirtyAfter).not.toContain("notes/backlog.feat.child-1.md");
    // Non-note file is still dirty — exec dirty tree check will block on it as intended
    expect(dirtyAfter).toContain("src.mjs");
  });

  it("no notes to commit — dirty tree check runs unchanged", () => {
    // Only a non-note dirty file
    fs.writeFileSync(path.join(projectRoot, "src.mjs"), "// dirty");

    const dirty = getUncommittedFiles(projectRoot, { filterRks: false });
    const dirtyNotes = dirty.filter(f => f.startsWith("notes/") && f.endsWith(".md"));

    // Nothing to auto-commit
    expect(dirtyNotes).toHaveLength(0);
    // Non-note file remains dirty
    expect(dirty).toContain("src.mjs");
  });
});
