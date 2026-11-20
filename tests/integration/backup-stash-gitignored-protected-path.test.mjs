/**
 * backlog.fix.exec-backup-stash-fails-when-protected-path-gitignored
 *
 * createBackup's stash pathspec named every protected path (notes/.rks/.routekit) by
 * `:(exclude)<p>`. When one of them is itself gitignored with nothing tracked beneath
 * it, `git stash push -u` exits 1 ("The following paths are ignored by one of your
 * .gitignore files") AFTER saving the entry, without clearing the tree, so rollback
 * cannot restore the operator's work.
 *
 * buildStashPathspec drops the exclude ONLY for a protected path that is itself ignored
 * with nothing tracked beneath it, and keeps today's exclude everywhere else.
 *
 * Shapes covered: none (no protected path ignored), generic (`.rks/` ignored wholesale,
 * nothing tracked beneath it) and repo (this repo's partial-ignore layout). The layout of
 * an ignored protected directory with a tracked entry beneath it is descoped from this
 * story as a known unfixed case, and no test here covers it.
 *
 * Every case runs inside a temp-dir git fixture. NO test here runs a stash command
 * against the real repository. Every fixture pins core.excludesFile to a fixture-local
 * file so the developer's global gitignore cannot change which pathspec case fires.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo } from "../helpers/tmp.mjs";
import {
  createBackup,
  restoreBackup,
  buildStashPathspec,
  PROTECTED_PATHSPEC_EXCLUDES,
} from "../../packages/mcp-rks/src/exec/backup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKUP_SRC_PATH = path.join(ROOT, "packages/mcp-rks/src/exec/backup.mjs");

const GIT_TIMEOUT = 15_000;
const PROTECTED = ["notes/", ".rks/", ".routekit/"];
const IGNORED_MSG = "paths are ignored";
const WARN_PREFIX = "[rks.exec] backup pathspec warning:";
const SPAWN_PREFIX = "[rks.exec] backup stash spawn error:";

const ORIGINAL_APP = "export const v = 1;\n";
const OPERATOR_APP = "export const v = 2;\n";
const OPERATOR_NEW = "export const n = 1;\n";

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT });
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Per shape: the .gitignore, which protected files are committed (force-added where ignored), and
// which protected directories are ignored with NOTHING tracked beneath them (the actual trigger).
const SHAPES = {
  none: {
    ignore: "",
    tracked: [".rks/project.json", ".rks/plans/plan.md", "notes/story.md", ".routekit/config.json"],
    untrackedIgnoredDirs: [],
  },
  // generic shape: `.rks/` ignored wholesale, nothing tracked beneath it
  generic: {
    ignore: ".rks/\n",
    tracked: ["notes/story.md", ".routekit/config.json"],
    untrackedIgnoredDirs: [".rks"],
  },
  // this repo: notes/.dendron.cache.json ignored, .rks/* with negations
  repo: {
    ignore: "notes/.dendron.cache.json\n.rks/*\n!.rks/project.json\n!.rks/plans/\n",
    tracked: [".rks/project.json", ".rks/plans/plan.md", "notes/story.md", ".routekit/config.json"],
    untrackedIgnoredDirs: [],
  },
};

// Exact expected pathspec per shape.
const PATHSPEC_EXPECT = {
  none: [":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"],
  generic: [":/", ":(exclude)notes", ":(exclude).routekit"],
  repo: [":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"],
};

// Operator writes into every protected directory.
const OPERATOR_CONTENT = {
  ".rks/project.json": "{\"id\":\"edited\"}\n",
  "notes/story.md": "story edited\n",
  ".routekit/config.json": "{\"edited\":true}\n",
};

// Committed protected files the operator modifies, per shape (TR8: tracked case).
const TRACKED_PROTECTED_MODIFIED = {
  generic: ["notes/story.md", ".routekit/config.json"],
  repo: [".rks/project.json", "notes/story.md", ".routekit/config.json"],
};

// Operator-written file under the ignored, nothing-tracked protected dir (TR9).
const IGNORED_UNTRACKED_OPERATOR_FILE = {
  generic: ".rks/project.json",
};

const IGNORED_SHAPES = ["generic", "repo"];

// shape: "none" | "generic" | "repo"
function makeFixture(shape) {
  const dir = makeTempDir(`backup-ignored-${shape}`);
  dirs.push(dir);
  initGitRepo(dir, { branch: "main" });
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  // Fixture-local, empty excludes file: the developer's global gitignore cannot interfere.
  const excludes = path.join(dir, ".git", "fixture-excludes");
  fs.writeFileSync(excludes, "");
  const cfg = git(dir, ["config", "core.excludesFile", excludes]);
  if (cfg.status !== 0) throw new Error(`could not set core.excludesFile in ${dir}: ${cfg.stderr}`);
  write(dir, ".gitignore", SHAPES[shape].ignore);
  write(dir, "src/app.mjs", ORIGINAL_APP);
  write(dir, ".rks/project.json", "{\"id\":\"p\"}\n");
  write(dir, ".rks/plans/plan.md", "plan\n");
  write(dir, "notes/story.md", "story\n");
  write(dir, ".routekit/config.json", "{}\n");
  const add = git(dir, ["add", "-f", "--", ".gitignore", "src/app.mjs", ...SHAPES[shape].tracked]);
  if (add.status !== 0) throw new Error(`fixture add failed: ${add.stderr}`);
  const commit = git(dir, ["commit", "-m", "init"]);
  if (commit.status !== 0) throw new Error(`fixture commit failed: ${commit.stderr}`);
  write(dir, ".rks/runs/state.json", "{}\n");
  write(dir, "notes/.dendron.cache.json", "{}\n");
  return dir;
}

function dirtyOperator(dir) {
  write(dir, "src/app.mjs", OPERATOR_APP);
  write(dir, "src/new.mjs", OPERATOR_NEW);
  for (const [rel, content] of Object.entries(OPERATOR_CONTENT)) write(dir, rel, content);
}

function stashRef(dir) {
  const r = git(dir, ["rev-parse", "-q", "--verify", "refs/stash"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Changed + untracked paths recorded by the stash. NOT `git ls-tree -r <sha>`: the stash
// commit tree is the full index tree, so it lists every committed protected file.
function stashPaths(dir, sha) {
  const r = git(dir, ["stash", "show", "--include-untracked", "--name-only", sha]);
  expect(r.status).toBe(0);
  return r.stdout.split("\n").filter(Boolean);
}

// Twin fixture: the legacy pathspec is never run on a fixture that a test then asserts on.
function legacyProbe(shape) {
  const dir = makeFixture(shape);
  dirtyOperator(dir);
  const r = git(dir, ["stash", "push", "-u", "-m", "legacy-probe", "--", ":/", ...PROTECTED_PATHSPEC_EXCLUDES]);
  return { status: r.status, output: `${r.stdout || ""}${r.stderr || ""}` };
}

describe("buildStashPathspec — no protected path ignored", () => {
  it("TR1: is exported and returns the unchanged four-item pathspec with no warnings", () => {
    expect(typeof buildStashPathspec).toBe("function");
    const dir = makeFixture("none");
    const { pathspec, warnings } = buildStashPathspec(dir);
    expect(pathspec).toEqual([":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"]);
    expect(warnings).toEqual([]);
  });
});

describe("shape preconditions", () => {
  it("TR2 generic: .rks is ignored (check-ignore -q exits 0) and nothing is tracked beneath it", () => {
    const dir = makeFixture("generic");
    expect(SHAPES.generic.untrackedIgnoredDirs).toEqual([".rks"]);
    expect(git(dir, ["check-ignore", "-q", "--", ".rks"]).status).toBe(0);
    expect(git(dir, ["ls-files", "--", ".rks"]).stdout).toBe("");
  });

  it("TR4 repo: an ignored file under .rks/ and notes/.dendron.cache.json are listed as ignored", () => {
    const dir = makeFixture("repo");
    const rksIgnored = git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ".rks"]).stdout;
    expect(rksIgnored.trim()).not.toBe("");
    const notesIgnored = git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "notes"]).stdout;
    expect(notesIgnored).toContain("notes/.dendron.cache.json");
  });
});

describe("fail-before: the legacy pathspec reproduces the defect", () => {
  it("TR3 generic: legacy argv exits non-zero with 'paths are ignored' (twin fixture)", () => {
    const r = legacyProbe("generic");
    expect(r.status).not.toBe(0);
    expect(r.output).toContain(IGNORED_MSG);
  });

  it("TR5 repo: legacy outcome is recorded as a measurement, not asserted (twin fixture)", () => {
    const r = legacyProbe("repo");
    console.info(`[measurement] repo-shape legacy pathspec: status=${r.status} pathsAreIgnored=${r.output.includes(IGNORED_MSG)}`);
    expect(r.status === null || typeof r.status === "number").toBe(true);
  });
});

for (const shape of IGNORED_SHAPES) {
  describe(`createBackup with ignored protected path (${shape})`, () => {
    it("TR2/TR4: returns success and stashCreated, and clears the operator's non-protected changes", () => {
      const dir = makeFixture(shape);
      dirtyOperator(dir);
      const meta = createBackup(dir, "backlog.fix.demo");
      expect(meta.success).toBe(true);
      expect(meta.stashCreated).toBe(true);
      expect(meta.pathspecWarnings).toEqual([]);
      expect(meta.stashSpawnError).toBeNull();
      const status = git(dir, ["status", "--porcelain"]).stdout;
      expect(status).not.toContain("src/app.mjs");
      expect(status).not.toContain("src/new.mjs");
    });

    it("TR18: success true coincides with refs/stash moving and a cleared tree", () => {
      const dir = makeFixture(shape);
      dirtyOperator(dir);
      const before = stashRef(dir);
      const meta = createBackup(dir, "backlog.fix.demo");
      const after = stashRef(dir);
      expect(meta.success).toBe(true);
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
      expect(meta.stashSha).toBe(after);
      expect(fs.readFileSync(path.join(dir, "src/app.mjs"), "utf8")).toBe(ORIGINAL_APP);
      expect(fs.existsSync(path.join(dir, "src/new.mjs"))).toBe(false);
    });

    it("TR7: the stash records the operator's changes and nothing under a protected path", () => {
      const dir = makeFixture(shape);
      dirtyOperator(dir);
      const meta = createBackup(dir, "backlog.fix.demo");
      const stashed = stashPaths(dir, meta.stashSha);
      expect(stashed).toContain("src/app.mjs");
      expect(stashed).toContain("src/new.mjs");
      for (const p of stashed) {
        expect(PROTECTED.some((pre) => p.startsWith(pre)), `protected path in stash: ${p}`).toBe(false);
      }
    });

    it("TR6: restoreBackup brings the operator's tracked edit and untracked file back", () => {
      const dir = makeFixture(shape);
      dirtyOperator(dir);
      const meta = createBackup(dir, "backlog.fix.demo");
      expect(meta.stashCreated).toBe(true);
      const restored = restoreBackup(dir, meta);
      expect(restored.restored).toBe(true);
      expect(fs.readFileSync(path.join(dir, "src/app.mjs"), "utf8")).toBe(OPERATOR_APP);
      expect(fs.readFileSync(path.join(dir, "src/new.mjs"), "utf8")).toBe(OPERATOR_NEW);
    });
  });
}

for (const shape of IGNORED_SHAPES) {
  describe(`per protected directory (${shape})`, () => {
    it("TR10/TR11: pathspec: exact result, no warnings, no literal items, no item naming an ignored-untracked dir", () => {
      const dir = makeFixture(shape);
      const { pathspec, warnings } = buildStashPathspec(dir);
      expect(warnings).toEqual([]);
      expect(pathspec).toEqual(PATHSPEC_EXPECT[shape]);
      expect(pathspec.some((item) => item.includes("literal"))).toBe(false);
      for (const d of SHAPES[shape].untrackedIgnoredDirs) {
        expect(pathspec.some((item) => item.includes(d))).toBe(false);
      }
    });

    it("TR8 tracked case: every committed protected file the operator modified is still modified against HEAD", () => {
      const dir = makeFixture(shape);
      dirtyOperator(dir);
      const meta = createBackup(dir, "backlog.fix.demo");
      expect(meta.success).toBe(true);
      const modified = git(dir, ["diff", "--name-only", "HEAD"]).stdout.split("\n").filter(Boolean);
      for (const rel of TRACKED_PROTECTED_MODIFIED[shape]) {
        expect(modified, `${rel} should still be modified`).toContain(rel);
        expect(fs.readFileSync(path.join(dir, rel), "utf8")).toBe(OPERATOR_CONTENT[rel]);
      }
    });

    if (IGNORED_UNTRACKED_OPERATOR_FILE[shape]) {
      it("TR9 ignored-and-untracked case: the operator's file under the ignored dir survives byte-for-byte", () => {
        const dir = makeFixture(shape);
        dirtyOperator(dir);
        const rel = IGNORED_UNTRACKED_OPERATOR_FILE[shape];
        const meta = createBackup(dir, "backlog.fix.demo");
        expect(meta.success).toBe(true);
        expect(fs.existsSync(path.join(dir, rel))).toBe(true);
        expect(fs.readFileSync(path.join(dir, rel), "utf8")).toBe(OPERATOR_CONTENT[rel]);
      });
    }
  });
}

describe("no literal pathspec items in any shape", () => {
  for (const shape of ["none", ...IGNORED_SHAPES]) {
    it(`TR12 ${shape}: no item contains 'literal'`, () => {
      const dir = makeFixture(shape);
      const { pathspec } = buildStashPathspec(dir);
      expect(pathspec.some((item) => item.includes("literal"))).toBe(false);
    });
  }
});

describe("probe error fallback (buildStashPathspec)", () => {
  it("TR13: check-ignore error status falls back to ':(exclude)<p>' and warns naming the path and probe", () => {
    const dir = makeFixture("generic");
    const failing = () => ({ status: 128, stdout: "", stderr: "fatal: injected probe error" });
    const { pathspec, warnings } = buildStashPathspec(dir, { run: failing });
    expect(pathspec).toEqual([":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"]);
    expect(warnings.length).toBe(3);
    for (const p of ["notes", ".rks", ".routekit"]) {
      expect(warnings.some((w) => typeof w === "string" && w.includes(`'${p}'`) && w.includes("check-ignore"))).toBe(true);
    }
  });

  it("TR13: ls-files error status falls back to ':(exclude)<p>' and warns naming the path and probe", () => {
    const dir = makeFixture("generic");
    const run = (cmd, args, opts) => {
      if (args[0] === "ls-files") return { status: 128, stdout: "", stderr: "fatal: injected ls-files error" };
      return spawnSync(cmd, args, { ...opts, timeout: GIT_TIMEOUT });
    };
    const { pathspec, warnings } = buildStashPathspec(dir, { run });
    expect(pathspec).toEqual([":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("'.rks'");
    expect(warnings[0]).toContain("ls-files");
  });

  it("TR13: a probe spawn error falls back to the exclude and warns", () => {
    const dir = makeFixture("generic");
    const run = () => ({ status: null, error: new Error("spawnSync git ENOENT"), stdout: "", stderr: "" });
    const { pathspec, warnings } = buildStashPathspec(dir, { run });
    expect(pathspec).toEqual([":/", ":(exclude)notes", ":(exclude).rks", ":(exclude).routekit"]);
    expect(warnings.length).toBe(3);
    expect(warnings.every((w) => w.includes("ENOENT"))).toBe(true);
  });
});

describe("createBackup pathspecWarnings is returned and logged (R9)", () => {
  it("TR14/TR15: pathspecWarnings is empty in the no-ignore fixture and no warning line is logged", () => {
    const dir = makeFixture("none");
    dirtyOperator(dir);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta = createBackup(dir, "backlog.fix.demo");
    expect(Array.isArray(meta.pathspecWarnings)).toBe(true);
    expect(meta.pathspecWarnings).toEqual([]);
    expect(errSpy.mock.calls.some((c) => c.join(" ").startsWith(WARN_PREFIX))).toBe(false);
  });

  it("TR14/TR15: under an injected probe error, pathspecWarnings is non-empty and each is logged once with the prefix", () => {
    const dir = makeFixture("none");
    dirtyOperator(dir);
    const failing = () => ({ status: 128, stdout: "", stderr: "fatal: injected probe error" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta = createBackup(dir, "backlog.fix.demo", { pathspecRunner: failing });
    expect(meta.pathspecWarnings.length).toBeGreaterThan(0);
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith(WARN_PREFIX));
    expect(logged.length).toBe(meta.pathspecWarnings.length);
    for (const w of meta.pathspecWarnings) {
      expect(logged.filter((l) => l.includes(w)).length).toBe(1);
    }
  });
});

describe("stash spawn error is returned and logged (R9)", () => {
  it("TR16: an injected spawn error yields success false, stashCreated false, stashSpawnError set and one log line", () => {
    const dir = makeFixture("none");
    dirtyOperator(dir);
    const spawnErr = Object.assign(new Error("spawnSync git E2BIG"), { code: "E2BIG" });
    const failingStash = () => ({ status: null, error: spawnErr, stdout: "", stderr: "" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta = createBackup(dir, "backlog.fix.demo", { stashRunner: failingStash });
    expect(meta.success).toBe(false);
    expect(meta.stashCreated).toBe(false);
    expect(typeof meta.stashSpawnError).toBe("string");
    expect(meta.stashSpawnError).toContain("E2BIG");
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith(SPAWN_PREFIX));
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("E2BIG");
  });

  it("TR17: no spawn error: stashSpawnError is null and no spawn-error line is logged", () => {
    const dir = makeFixture("none");
    dirtyOperator(dir);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const meta = createBackup(dir, "backlog.fix.demo");
    expect(meta.success).toBe(true);
    expect(meta.stashSpawnError).toBeNull();
    expect(errSpy.mock.calls.some((c) => c.join(" ").startsWith(SPAWN_PREFIX))).toBe(false);
  });
});

describe("success stays observation-sourced", () => {
  it("TR18: backup.mjs derives success from the stash push exit status only", () => {
    const src = fs.readFileSync(BACKUP_SRC_PATH, "utf8");
    expect(src).toContain("const success = res.status === 0;");
  });
});
