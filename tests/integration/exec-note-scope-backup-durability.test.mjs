/**
 * backlog.fix.exec-note-scope-and-backup-durability — cross-module coverage.
 *
 * TR4, TR22, and the cross-module ordering check behind TR1.
 *
 * THE COVERAGE GAP THIS EXISTS TO CLOSE: v0.38.2 shipped CI-green and failed in
 * the field because its tests asserted the phase write reached DISK, while the
 * sequence that destroys it — stage notes, create the branch, stash — spans
 * exec.mjs AND backup.mjs, and no test crossed that boundary. Every case here
 * imports the REAL modules; none re-implements them.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { createBackup, cleanupWorkingTree } from "../../packages/mcp-rks/src/exec/backup.mjs";
import { detectPerStepDivergence } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const GIT_TIMEOUT = 15000;
const PROBLEM_ID = "backlog.fix.demo";
const STORY_NOTE = `notes/${PROBLEM_ID}.md`;
const CHILD_NOTE = `notes/${PROBLEM_ID}.child-1.md`;
const OTHER_NOTE = "notes/backlog.feat.other.md";

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT });
}

function noteBody(phase) {
  return `---\nid: "${PROBLEM_ID}"\nphase: "${phase}"\n---\n\nbody\n`;
}

function initRepo(dir) {
  git(dir, ["init", "-b", "staging"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.mjs"), "// original\n");
  // The story note is COMMITTED at arch-approved — this is what a stash reset
  // to HEAD would revert the phase back to.
  fs.writeFileSync(path.join(dir, STORY_NOTE), noteBody("arch-approved"));
  fs.writeFileSync(path.join(dir, CHILD_NOTE), noteBody("arch-approved"));
  fs.writeFileSync(path.join(dir, OTHER_NOTE), "---\nphase: \"ready\"\n---\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
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
  initRepo(dir);
  return dir;
}

/** The exclusion set exec builds: the story note plus its dirty child notes. */
function storyNoteExclusions() {
  return new Set([STORY_NOTE, CHILD_NOTE]);
}

describe("CROSS-MODULE: the story phase survives stage → branch → backup", () => {
  it("keeps phase 'executing' on disk through the real createBackup", () => {
    const root = fixture("xmod-phase-survives");

    // The plan path writes the phase to the note.
    fs.writeFileSync(path.join(root, STORY_NOTE), noteBody("executing"));

    // exec's sequence, in order: stage the SCOPED note set, create the branch,
    // then take the backup using the REAL createBackup (not a mock).
    git(root, ["add", "--", STORY_NOTE, CHILD_NOTE]);
    git(root, ["checkout", "-b", "rks/demo", "staging"]);
    const meta = createBackup(root, PROBLEM_ID);

    // (a) the phase write survived
    const onDisk = fs.readFileSync(path.join(root, STORY_NOTE), "utf8");
    expect(onDisk).toContain('phase: "executing"');
    expect(onDisk).not.toContain('phase: "arch-approved"');

    // (b) the note is not in the backup stash
    if (meta.stashCreated) {
      const stashed = git(root, ["stash", "show", "--include-untracked", "--name-only", meta.stashSha]).stdout || "";
      expect(stashed).not.toContain(STORY_NOTE);
    }
  });

  it("stages only this story's notes, never an unrelated sibling note", () => {
    const root = fixture("xmod-staging-scope");

    fs.writeFileSync(path.join(root, STORY_NOTE), noteBody("executing"));
    fs.writeFileSync(path.join(root, CHILD_NOTE), noteBody("executing"));
    fs.writeFileSync(path.join(root, OTHER_NOTE), "---\nphase: \"ready\"\n---\nDIRTIED\n");

    // The scoped staging exec now performs.
    const toStage = Array.from(storyNoteExclusions());
    git(root, ["add", "--", ...toStage]);

    const staged = git(root, ["diff", "--cached", "--name-only"]).stdout || "";
    expect(staged).toContain(STORY_NOTE);
    expect(staged).toContain(CHILD_NOTE);
    expect(staged).not.toContain(OTHER_NOTE);
  });
});

describe("TR4 — createBackup and cleanupWorkingTree agree about notes", () => {
  it("neither reverts nor deletes a dirty story note", () => {
    const root = fixture("symmetry");
    const notePath = path.join(root, STORY_NOTE);
    fs.writeFileSync(notePath, noteBody("executing"));

    createBackup(root, PROBLEM_ID);
    expect(fs.readFileSync(notePath, "utf8")).toContain('phase: "executing"');

    cleanupWorkingTree(root);
    expect(fs.existsSync(notePath)).toBe(true);
    expect(fs.readFileSync(notePath, "utf8")).toContain('phase: "executing"');
  });
});

describe("TR22 — the exemption reaches the PER-STEP guard, not just the final one", () => {
  it("returns diverged:false for a dirty story note when the exemption is supplied", () => {
    const root = fixture("perstep-exempt");
    fs.writeFileSync(path.join(root, STORY_NOTE), noteBody("executing"));

    // Positional call, matching the existing callers this signature must not break.
    const result = detectPerStepDivergence(
      root,
      new Set(),           // expectedFilesThrough — never contains the note
      new Set(),           // preCommandGeneratedFiles
      [],                  // steps
      storyNoteExclusions(),
    );

    expect(result.diverged).toBe(false);
  });

  it("still flags a genuinely unexpected non-note file", () => {
    const root = fixture("perstep-flags");
    fs.writeFileSync(path.join(root, "src", "rogue.mjs"), "// not in the plan\n");

    const result = detectPerStepDivergence(
      root,
      new Set(),
      new Set(),
      [],
      storyNoteExclusions(),
    );

    expect(result.diverged).toBe(true);
    expect(result.unexpectedFiles).toContain("src/rogue.mjs");
  });

  it("remains backward compatible with four positional arguments", () => {
    // tests/integration/exec-dependency-add-scope.test.mjs calls this with four
    // positional args. Adding a fifth parameter must not disturb them.
    const root = fixture("perstep-backcompat");
    fs.writeFileSync(path.join(root, "src", "rogue.mjs"), "// rogue\n");

    const result = detectPerStepDivergence(root, new Set(), new Set(), []);

    expect(result.diverged).toBe(true);
    expect(result.unexpectedFiles).toContain("src/rogue.mjs");
  });
});
