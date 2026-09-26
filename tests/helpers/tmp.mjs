import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Root for every fixture this helper creates.
 *
 * backlog.fix.test-fixture-repo-containment: this used to be
 * `path.join(process.cwd(), "tests", ".tmp")` — INSIDE the real repository. Git resolves a
 * repository by walking UP from cwd, and rks's git helpers bind only `cwd`, so a fixture placed
 * here whose `git init` silently failed became a handle on the developer's own repo. On
 * 2026-08-21 that is how a bare `npx vitest run` executed `git reset --hard origin/staging`
 * against this working tree and destroyed ~30 unpushed commits. `.gitignore` is irrelevant:
 * ignoring a path has zero effect on repository discovery.
 *
 * Nothing above `os.tmpdir()` is a git repository, so a walk-up from here finds nothing and git
 * errors out instead of reaching a real repo. That distinction is the entire safety margin.
 *
 * A DEDICATED SUBDIRECTORY, never `os.tmpdir()` itself. The globalTeardown in
 * `tests/_helpers/with-temp-dir.mjs` sweeps this base by reading its entries and removing each
 * one — pointed at `os.tmpdir()` directly that is a recursive delete of the system temp
 * directory, and it would also destroy live fixtures belonging to parallel forks, since
 * `withTempDir` and `git-repo-template.mjs` both mkdtemp straight into `os.tmpdir()`.
 *
 * Exported so the teardown IMPORTS this exact value rather than re-deriving the same string.
 * Two literals that happen to agree is how a detector and its applier drift apart.
 */
export const TEMP_BASE = path.join(os.tmpdir(), "rks-tests");

// Created eagerly at module load so a test that reads the base without first calling
// makeTempDir() does not hit ENOENT.
ensureDir(TEMP_BASE);

export function makeTempDir(prefix = "tmp") {
  ensureDir(TEMP_BASE);
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const dir = path.join(TEMP_BASE, `${prefix}_${stamp}`);
  ensureDir(dir);
  return dir;
}

/**
 * Initialise a git repository in `dir`, THROWING if it fails.
 *
 * backlog.fix.test-fixture-repo-containment: fixture builders across this suite called
 * `git init` and discarded the exit status — one wrapped an entire init/config/checkout block in
 * a `catch` that downgraded failure to `console.warn` and CONTINUED. After a failed init the
 * subsequent commands operate on the AMBIENT repository: `git config` writes the real
 * `.git/config`, `git checkout -b` creates a real branch, `git add .` stages real files. A
 * fixture that cannot initialise must abort the test, never proceed.
 *
 * `timeout` is mandatory here and enforced by tests/unit/subprocess-timeout-convention.test.mjs
 * (which does not glob tests/helpers/, so it is on us to keep it).
 */
export function initGitRepo(dir, { branch = "main", bare = false } = {}) {
  // Any reason the fixture cannot be initialised reports the SAME way. Without this, a path that
  // already exists as a regular file throws a bare EEXIST from mkdir — a true failure, but one
  // that names neither the fixture nor the fact that git init never ran, so a caller cannot tell
  // it apart from an unrelated filesystem error.
  try {
    ensureDir(dir);
  } catch (err) {
    throw new Error(`fixture git init failed in ${dir}: could not create directory — ${err.message}`);
  }
  const args = ["init"];
  if (bare) args.push("--bare");
  args.push("-b", branch);
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0) {
    throw new Error(
      `fixture git init failed in ${dir} (status ${res.status}): ${res.stderr || res.stdout || "no output"}`,
    );
  }
  return dir;
}

export function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

