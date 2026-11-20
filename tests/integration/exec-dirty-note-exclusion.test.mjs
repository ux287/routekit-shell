/**
 * Tests for exec preflight dirty-note exclusion logic (backlog.fix.exec-dirty-note-blocks-build).
 *
 * These tests verify the exclusion Set construction and filtering logic directly —
 * not the full exec pipeline. The logic lives inline in runExecTool but can be
 * verified by calling getUncommittedFiles on a real git repo and applying the same
 * filter logic.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { getUncommittedFiles } from "../../packages/mcp-rks/src/utils/git.mjs";

function initGitRepo(dir) {
  spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", ".keep"), "");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// app");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

/** Mirror the exclusion logic from exec.mjs */
function buildExclusionSet(projectRoot, problemId) {
  const storyNoteExclusions = new Set();
  if (problemId) {
    storyNoteExclusions.add(`notes/${problemId}.md`);
    const allDirty = getUncommittedFiles(projectRoot);
    for (const f of allDirty) {
      if (f.startsWith(`notes/${problemId}.`) && f.endsWith(".md")) {
        storyNoteExclusions.add(f);
      }
    }
  }
  return storyNoteExclusions;
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("exec dirty-note exclusion logic", () => {
  it("does not include current story note in dirtyFiles (excluded)", () => {
    const projectRoot = makeTempDir("exec-note-exclusion");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    fs.writeFileSync(path.join(projectRoot, "notes", `${problemId}.md`), "# dirty note");

    const exclusions = buildExclusionSet(projectRoot, problemId);
    const allDirty = getUncommittedFiles(projectRoot);
    const dirtyFiles = allDirty.filter(f => !exclusions.has(f));

    expect(allDirty).toContain(`notes/${problemId}.md`);
    expect(dirtyFiles).not.toContain(`notes/${problemId}.md`);
  });

  it("excludes child story note (notes/<problemId>.child-1.md)", () => {
    const projectRoot = makeTempDir("exec-note-exclusion-child");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    const childNote = `notes/${problemId}.child-1.md`;
    fs.writeFileSync(path.join(projectRoot, childNote), "# child note");

    const exclusions = buildExclusionSet(projectRoot, problemId);
    const allDirty = getUncommittedFiles(projectRoot);
    const dirtyFiles = allDirty.filter(f => !exclusions.has(f));

    expect(allDirty).toContain(childNote);
    expect(dirtyFiles).not.toContain(childNote);
  });

  it("does NOT exclude an unrelated source file", () => {
    const projectRoot = makeTempDir("exec-note-exclusion-src");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    fs.writeFileSync(path.join(projectRoot, "src", "app.mjs"), "// modified");

    const exclusions = buildExclusionSet(projectRoot, problemId);
    const allDirty = getUncommittedFiles(projectRoot);
    const dirtyFiles = allDirty.filter(f => !exclusions.has(f));

    expect(dirtyFiles).toContain("src/app.mjs");
  });

  it("does NOT exclude an unrelated notes file", () => {
    const projectRoot = makeTempDir("exec-note-exclusion-other");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    const otherNote = "notes/backlog.feat.other-story.md";
    fs.writeFileSync(path.join(projectRoot, otherNote), "# other story");

    const exclusions = buildExclusionSet(projectRoot, problemId);
    const allDirty = getUncommittedFiles(projectRoot);
    const dirtyFiles = allDirty.filter(f => !exclusions.has(f));

    expect(dirtyFiles).toContain(otherNote);
  });

  it("excluded note files remain dirty (not auto-committed)", () => {
    const projectRoot = makeTempDir("exec-note-exclusion-no-commit");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    const noteContent = "# this should stay dirty";
    fs.writeFileSync(path.join(projectRoot, "notes", `${problemId}.md`), noteContent);

    buildExclusionSet(projectRoot, problemId);

    // File should still be dirty — exclusion logic never commits
    const stillDirty = getUncommittedFiles(projectRoot);
    expect(stillDirty).toContain(`notes/${problemId}.md`);
  });

  it("exclusions Set includes primary note path even if not yet dirty", () => {
    const projectRoot = makeTempDir("exec-note-exclusion-preset");
    dirs.push(projectRoot);
    initGitRepo(projectRoot);

    const problemId = "backlog.fix.my-story";
    // Don't create the note file — exclusion should still be seeded
    const exclusions = buildExclusionSet(projectRoot, problemId);

    expect(exclusions.has(`notes/${problemId}.md`)).toBe(true);
  });
});
