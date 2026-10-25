import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { assertCleanWorkingTree } from "../../packages/mcp-rks/src/utils/git.mjs";

function initGitRepo(dir) {
  spawnSync("git", ["init", "-b", "staging"], { cwd: dir, timeout: 120_000 });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, timeout: 120_000 });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: 120_000 });
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  // Commit a placeholder in notes/ so the directory is tracked — otherwise git
  // reports the whole dir as "notes/" (untracked) instead of individual files
  fs.writeFileSync(path.join(dir, "notes", ".keep"), "");
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// app");
  spawnSync("git", ["add", "-A"], { cwd: dir, timeout: 120_000 });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, timeout: 120_000 });
}

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRepo() {
  const dir = makeTempDir("assert-clean");
  dirs.push(dir);
  initGitRepo(dir);
  return dir;
}

describe("assertCleanWorkingTree", () => {
  it("does not throw on a clean repo", () => {
    const dir = makeRepo();
    expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_test' })).not.toThrow();
  });

  it("throws McpError when an unrelated source file is dirty", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// dirty");
    expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_test' })).toThrow("working tree is not clean");
  });

  it("error message includes toolName", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// dirty");
    expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_rag_init' })).toThrow("rks_rag_init:");
  });

  describe("excludeNotesFor", () => {
    it("does not throw when only the story note is dirty", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "notes", "backlog.fix.my-story.md"), "# note");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_exec', excludeNotesFor: 'backlog.fix.my-story' })).not.toThrow();
    });

    it("does not throw when only a child story note is dirty", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "notes", "backlog.fix.my-story.child-1.md"), "# child");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_exec', excludeNotesFor: 'backlog.fix.my-story' })).not.toThrow();
    });

    it("throws when an unrelated notes file is dirty", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "notes", "backlog.feat.other-story.md"), "# other");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_exec', excludeNotesFor: 'backlog.fix.my-story' })).toThrow("working tree is not clean");
    });

    it("throws when an unrelated source file is dirty even with excludeNotesFor", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// dirty");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_exec', excludeNotesFor: 'backlog.fix.my-story' })).toThrow("working tree is not clean");
    });
  });

  describe("notesOk (rag_embed mode)", () => {
    it("does not throw when only notes/ files are dirty", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "notes", "any-note.md"), "# note");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_rag_embed', notesOk: true })).not.toThrow();
    });

    it("throws when non-notes files are dirty", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// dirty");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_rag_embed', notesOk: true })).toThrow("working tree is not clean");
    });
  });

  describe("no options (rks_rag_init / rks_project_init mode)", () => {
    it("throws when any file is dirty including notes", () => {
      const dir = makeRepo();
      fs.writeFileSync(path.join(dir, "notes", "some-note.md"), "# note");
      expect(() => assertCleanWorkingTree(dir, { toolName: 'rks_rag_init' })).toThrow("working tree is not clean");
    });
  });
});
