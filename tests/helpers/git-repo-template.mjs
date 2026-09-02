/**
 * Shared git-repo template builder for unit tests.
 *
 * Per-test git-repo rebuilds spawn 6-12 `git` subprocesses each. This helper
 * builds each reference repo shape ONCE, then fs.cpSync-copies a fresh working
 * copy per test (single-digit ms) instead of re-spawning git.
 *
 * The one git subprocess still run per copy is `git remote set-url origin` --
 * mandatory because the `origin` remote stores an absolute path to the bare
 * repo, and a raw filesystem copy would leave every copy's origin pointing at
 * the shared template bare dir (push collisions / flaky tests).
 *
 * Variants:
 *  - 'bare-remote-clone-staging': bare origin.git + cloned work/ + main branch
 *    + staging branch with two commits, all pushed. Accepts opts.profilesContent
 *    written to .routekit/publish-profiles.yaml before commit. Templates are
 *    memoized per distinct profilesContent.
 *  - 'working-with-origin': work repo (init -b staging) + sibling bare origin +
 *    one commit pushed + a .rks/ dir.
 *  - 'working-no-origin': work repo (init -b staging) + one commit, no remote.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function git(args, cwd) {
  spawnSync("git", args, { cwd });
}

// Roots of all template + copy temp dirs, removed by disposeTemplates().
const _tempRoots = [];

function newTempBase(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  _tempRoots.push(base);
  return base;
}

// -- Template builders: each runs ONCE per memo key --------------------

function buildBareRemoteCloneStaging(profilesContent) {
  const base = newTempBase("rks-tpl-bare-remote-");
  const bareDir = path.join(base, "origin.git");
  const workDir = path.join(base, "work");

  git(["init", "--bare", "--initial-branch", "main", bareDir]);
  git(["clone", bareDir, workDir]);
  git(["config", "user.email", "test@test.com"], workDir);
  git(["config", "user.name", "Test"], workDir);

  fs.writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify({ name: "test", version: "0.1.0" }, null, 2) + "\n"
  );
  fs.mkdirSync(path.join(workDir, "notes"), { recursive: true });

  if (profilesContent) {
    const routekitDir = path.join(workDir, ".routekit");
    fs.mkdirSync(routekitDir, { recursive: true });
    fs.writeFileSync(
      path.join(routekitDir, "publish-profiles.yaml"),
      profilesContent.trim()
    );
  }

  git(["add", "."], workDir);
  git(["commit", "-m", "initial"], workDir);
  git(["push", "origin", "main"], workDir);

  git(["checkout", "-b", "staging"], workDir);
  git(["push", "-u", "origin", "staging"], workDir);

  fs.writeFileSync(path.join(workDir, "feature.txt"), "new feature\n");
  git(["add", "."], workDir);
  git(["commit", "-m", "feat: add feature"], workDir);
  git(["push", "origin", "staging"], workDir);

  return { base, bareDir, workDir };
}

function buildWorkingWithOrigin() {
  const base = newTempBase("rks-tpl-with-origin-");
  const workDir = path.join(base, "work");
  const bareDir = workDir + "-origin";
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(bareDir, { recursive: true });

  git(["init", "--bare", "-b", "staging"], bareDir);
  git(["init", "-b", "staging"], workDir);
  git(["config", "user.email", "test@test.com"], workDir);
  git(["config", "user.name", "Test"], workDir);
  fs.writeFileSync(path.join(workDir, "file.txt"), "initial");
  git(["add", "."], workDir);
  git(["commit", "-m", "init"], workDir);
  git(["remote", "add", "origin", bareDir], workDir);
  git(["push", "-u", "origin", "staging"], workDir);
  fs.mkdirSync(path.join(workDir, ".rks"), { recursive: true });

  return { base, bareDir, workDir };
}

function buildWorkingNoOrigin() {
  const base = newTempBase("rks-tpl-no-origin-");
  const workDir = path.join(base, "work");
  fs.mkdirSync(workDir, { recursive: true });

  git(["init", "-b", "staging"], workDir);
  git(["config", "user.email", "test@test.com"], workDir);
  git(["config", "user.name", "Test"], workDir);
  fs.writeFileSync(path.join(workDir, "file.txt"), "initial");
  git(["add", "."], workDir);
  git(["commit", "-m", "init"], workDir);

  return { base, workDir };
}

// -- Template memo -----------------------------------------------------

const _templates = new Map();

function templateFor(variant, profilesContent) {
  const key =
    variant === "bare-remote-clone-staging"
      ? `bare-remote-clone-staging::${profilesContent || ""}`
      : variant;
  if (_templates.has(key)) return _templates.get(key);

  let tpl;
  if (variant === "bare-remote-clone-staging") {
    tpl = buildBareRemoteCloneStaging(profilesContent);
  } else if (variant === "working-with-origin") {
    tpl = buildWorkingWithOrigin();
  } else if (variant === "working-no-origin") {
    tpl = buildWorkingNoOrigin();
  } else {
    throw new Error(`Unknown git-repo-template variant: ${variant}`);
  }
  _templates.set(key, tpl);
  return tpl;
}

/**
 * Return a fresh, isolated working copy of the given repo variant.
 *
 * @param {string} variant - 'bare-remote-clone-staging' | 'working-with-origin' | 'working-no-origin'
 * @param {object} [opts]
 * @param {string} [opts.profilesContent] - publish-profiles.yaml content (bare-remote variant only)
 * @returns {{ base: string, workDir: string, bareDir?: string }}
 */
export function getRepoCopy(variant, opts = {}) {
  const tpl = templateFor(variant, opts.profilesContent);
  const base = newTempBase("rks-repo-copy-");

  if (variant === "working-no-origin") {
    const workDir = path.join(base, "work");
    fs.cpSync(tpl.workDir, workDir, { recursive: true });
    return { base, workDir };
  }

  // Variants with an origin remote: copy work + bare together, then rewrite
  // the copy's origin URL to the copied bare dir.
  const workDir = path.join(base, "work");
  const bareDir =
    variant === "working-with-origin"
      ? workDir + "-origin"
      : path.join(base, "origin.git");

  fs.cpSync(tpl.workDir, workDir, { recursive: true });
  fs.cpSync(tpl.bareDir, bareDir, { recursive: true });

  // Mandatory: repoint origin at the copied bare dir (templates store an
  // absolute path; without this every copy pushes into the shared template).
  git(["remote", "set-url", "origin", bareDir], workDir);

  return { base, workDir, bareDir };
}

/**
 * Remove all template and copy temp dirs. Call once in a global afterAll
 * or rely on per-test cleanup of the returned `base`.
 */
export function disposeTemplates() {
  for (const root of _tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  _tempRoots.length = 0;
  _templates.clear();
}
