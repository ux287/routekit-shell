import { describe, it, expect, beforeEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { autoCommitChildNotes } from "../../packages/mcp-rks/src/server/refine.mjs";

function initGitRepo(dir) {
  spawnSync("git", ["init", "-b", "staging"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "init");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

function gitStatus(dir) {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  return r.stdout.trim();
}

function gitLog(dir) {
  const r = spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  return r.stdout.trim();
}

describe("autoCommitChildNotes", () => {
  let projectRoot;
  let notesDir;

  beforeEach(() => {
    projectRoot = makeTempDir("decompose-auto-commit");
    initGitRepo(projectRoot);
    notesDir = path.join(projectRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
  });

  it("commits all child note files in a single commit", async () => {
    const childIds = ["backlog.feat.parent.child-1", "backlog.feat.parent.child-2"];
    for (const id of childIds) {
      fs.writeFileSync(path.join(notesDir, `${id}.md`), `# ${id}\ncontent`);
    }

    const result = await autoCommitChildNotes(projectRoot, notesDir, childIds, "backlog.feat.parent");

    expect(result.success).toBe(true);
    expect(result.message).toContain("Committed 2 child notes");
    // Working tree should be clean
    expect(gitStatus(projectRoot)).toBe("");
    // Should be a single new commit
    const log = gitLog(projectRoot);
    expect(log.split("\n")).toHaveLength(2); // init + auto-commit
  });

  it("uses conventional commit message containing parentId", async () => {
    const childIds = ["backlog.feat.epic.child-1"];
    fs.writeFileSync(path.join(notesDir, `${childIds[0]}.md`), "# child");

    await autoCommitChildNotes(projectRoot, notesDir, childIds, "backlog.feat.epic");

    const log = gitLog(projectRoot);
    expect(log).toContain("backlog.feat.epic");
  });

  it("leaves working tree clean after commit", async () => {
    const childIds = ["backlog.feat.test.child-1"];
    fs.writeFileSync(path.join(notesDir, `${childIds[0]}.md`), "# test");

    await autoCommitChildNotes(projectRoot, notesDir, childIds, "backlog.feat.test");

    expect(gitStatus(projectRoot)).toBe("");
  });

  it("skips commit and returns success when childIds is empty", async () => {
    const result = await autoCommitChildNotes(projectRoot, notesDir, [], "backlog.feat.parent");

    expect(result.success).toBe(true);
    expect(result.message).toContain("No child notes");
    // Only the init commit
    expect(gitLog(projectRoot).split("\n")).toHaveLength(1);
  });

  it("skips commit and returns success when childIds is null", async () => {
    const result = await autoCommitChildNotes(projectRoot, notesDir, null, "backlog.feat.parent");

    expect(result.success).toBe(true);
    expect(result.message).toContain("No child notes");
  });

  it("returns {success: false} on git failure without throwing", async () => {
    // Pass a non-existent file path to trigger git add failure
    const result = await autoCommitChildNotes(projectRoot, notesDir, ["nonexistent-story"], "backlog.feat.parent");

    expect(result.success).toBe(false);
    expect(result.message).toBeDefined();
  });

  it("logs warning on commit failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await autoCommitChildNotes(projectRoot, notesDir, ["nonexistent-story"], "backlog.feat.parent");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("autoCommitChildNotes warning:"));
    warnSpy.mockRestore();
  });

  it("does not stage pre-existing modified files", async () => {
    // Create and commit an existing file
    fs.writeFileSync(path.join(projectRoot, "existing.txt"), "original");
    spawnSync("git", ["add", "existing.txt"], { cwd: projectRoot });
    spawnSync("git", ["commit", "-m", "add existing"], { cwd: projectRoot });

    // Modify the existing file (dirty tree)
    fs.writeFileSync(path.join(projectRoot, "existing.txt"), "modified");

    // Create child notes
    const childIds = ["backlog.feat.selective.child-1"];
    fs.writeFileSync(path.join(notesDir, `${childIds[0]}.md`), "# child");

    await autoCommitChildNotes(projectRoot, notesDir, childIds, "backlog.feat.selective");

    // existing.txt should still be modified (not committed)
    const status = gitStatus(projectRoot);
    expect(status).toContain("existing.txt");
  });
});
