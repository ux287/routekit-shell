/**
 * Witness for backlog.fix.test-fixture-repo-containment.
 *
 * THE INCIDENT, 2026-08-21: a bare `npx vitest run` executed `git reset --hard origin/staging`
 * against this repository's own working tree and destroyed ~30 unpushed commits.
 *
 * THE MECHANISM, in three parts:
 *   1. `makeTempDir` created fixtures at `process.cwd()/tests/.tmp` — INSIDE the repository. Git
 *      resolves a repository by walking UP from cwd, and rks's git helpers bind only `cwd`, so a
 *      fixture there whose `git init` had failed silently became a handle on the real repo.
 *      `.gitignore` is irrelevant: ignoring a path has zero effect on repository discovery.
 *   2. Four e2e files planted project roots directly at `repoRoot/.tmp-e2e-*`.
 *   3. `git init` exit status went unchecked in several fixture builders, and one wrapped the
 *      whole init/config/checkout block in a catch that warned and CONTINUED — after which those
 *      commands operated on the ambient repository.
 *
 * WHY os.tmpdir() IS THE FIX: nothing above it is a git repository, so a walk-up finds nothing
 * and git errors out instead of reaching a real repo. That distinction is the entire safety
 * margin, and these assertions defend it.
 *
 * The base is a DEDICATED SUBDIRECTORY, never os.tmpdir() itself: globalTeardown sweeps the base
 * by removing each of its entries, so pointing it at the system temp root would be a recursive
 * delete of everything there — including live fixtures of parallel forks, since withTempDir and
 * git-repo-template.mjs both mkdtemp straight into os.tmpdir().
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir, ensureDir, initGitRepo, TEMP_BASE } from "../helpers/tmp.mjs";
import { SWEEP_BASE } from "../_helpers/with-temp-dir.mjs";

const REPO_ROOT = process.cwd();

describe("the fixture base is outside the repository", () => {
  it("TEMP_BASE is under os.tmpdir()", () => {
    expect(fs.realpathSync(TEMP_BASE).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it("TEMP_BASE is NOT os.tmpdir() itself — the teardown sweeps it entry by entry", () => {
    // The assertion that stands between a scoped cleanup and `rm -rf /var/folders/...`.
    expect(fs.realpathSync(TEMP_BASE)).not.toBe(fs.realpathSync(os.tmpdir()));
    expect(path.dirname(TEMP_BASE)).not.toBe(TEMP_BASE);
  });

  it("TEMP_BASE is not inside the repository working tree", () => {
    // The load-bearing one. Anything under REPO_ROOT reintroduces the walk-up.
    expect(fs.realpathSync(TEMP_BASE).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  });

  it("makeTempDir returns a path under TEMP_BASE, outside the repo", () => {
    const dir = makeTempDir("containment");
    try {
      expect(dir.startsWith(TEMP_BASE)).toBe(true);
      expect(fs.realpathSync(dir).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the base exists at module load, without calling makeTempDir first", () => {
    // Isolation-safety: a case that only reads the base must not hit ENOENT.
    ensureDir(TEMP_BASE);
    expect(fs.existsSync(TEMP_BASE)).toBe(true);
    expect(fs.realpathSync(TEMP_BASE)).toBeTruthy();
  });
});

describe("the sweep target and the fixture base are ONE value", () => {
  it("SWEEP_BASE is TEMP_BASE by identity, not by coincidence", () => {
    // Two imports from two different modules. A re-derived string literal in with-temp-dir.mjs
    // would agree today and drift silently the moment TEMP_BASE changes — which is exactly how
    // this repo's duplicate-frontmatter detector and its applier came apart. Identity closes it.
    expect(SWEEP_BASE).toBe(TEMP_BASE);
  });

  it("SWEEP_BASE therefore inherits every containment guarantee above", () => {
    expect(fs.realpathSync(SWEEP_BASE)).not.toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.realpathSync(SWEEP_BASE).startsWith(fs.realpathSync(REPO_ROOT))).toBe(false);
  });
});

describe("a fixture is a real, self-contained repository", () => {
  it("git does not walk up out of a fixture — a bare dir resolves NO repository", () => {
    // The positive control for the whole story. Under the old base this same probe would have
    // resolved the developer's repository and printed its path.
    const dir = makeTempDir("walkup");
    try {
      const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
      });
      expect(res.status, `git resolved a repository from an uninitialised fixture: ${res.stdout}`).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an initialised fixture resolves ITSELF, not an ancestor", () => {
    const dir = makeTempDir("selfrepo");
    try {
      initGitRepo(dir, { branch: "staging" });
      const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
      });
      expect(res.status).toBe(0);
      expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("git init failure is loud", () => {
  it("initGitRepo THROWS rather than warning and continuing", () => {
    // Deterministic failure without chmod games: point the initialiser at a path that already
    // exists as a regular file. The old behaviour swallowed this and let the caller proceed
    // against the ambient repository.
    const dir = makeTempDir("initfail");
    const notADir = path.join(dir, "regular-file");
    try {
      fs.writeFileSync(notADir, "not a directory\n");
      expect(() => initGitRepo(notADir)).toThrow(/git init failed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the thrown error names the directory and carries git's own output", () => {
    // A failure that says only "it failed" is what let this hide for so long.
    const dir = makeTempDir("initfail-msg");
    const notADir = path.join(dir, "regular-file");
    try {
      fs.writeFileSync(notADir, "x\n");
      expect(() => initGitRepo(notADir)).toThrow(new RegExp(notADir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a successful init returns the directory", () => {
    const dir = makeTempDir("initok");
    try {
      expect(initGitRepo(dir)).toBe(dir);
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("no fixture builder points back into the repository", () => {
  // NOTE: there is deliberately no source-substring assertion on tests/helpers/tmp.mjs here.
  // The old `process.cwd()/tests/.tmp` path is quoted verbatim in that file's doc comment, which
  // explains the incident — so a `not.toContain` check would fail on the documentation rather
  // than the code. The behavioural cases above ("TEMP_BASE is not inside the repository working
  // tree", "makeTempDir returns a path under TEMP_BASE") cover the same ground and cannot be
  // tripped by prose. The e2e assertions below stay source-level because those fixtures cannot
  // be invoked from the unit tier.

  it("the four e2e fixture roots no longer sit under repoRoot", () => {
    // registryPath lines legitimately keep using repoRoot — they read the real project registry
    // and are not fixture roots, so this asserts on the fixture patterns specifically.
    for (const file of [
      "tests/e2e/dogfood-workflow.test.mjs",
      "tests/e2e/pipeline-bootstrap.test.mjs",
      "tests/e2e/plan-auto-analyze-missing-codemap.test.mjs",
      "tests/e2e/replan-resets-phase.test.mjs",
    ]) {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(src, `${file} still plants a fixture root under repoRoot`)
        .not.toMatch(/path\.join\(\s*repoRoot,\s*`\.tmp/);
    }
  });

  it("the dogfood git setup no longer swallows failure", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "tests/e2e/dogfood-workflow.test.mjs"), "utf8");
    expect(src).not.toContain("Git setup warning:");
    // And the redundant checkout is gone, replaced by naming the branch at init — that checkout
    // fails wherever git's init.defaultBranch is already `main`.
    expect(src).toContain("git init -b main");
    expect(src).not.toContain("git checkout -b main");
  });
});
