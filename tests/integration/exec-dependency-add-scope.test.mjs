/**
 * Witness for backlog.fix.dependency-add-contract-executable — the scope guard must not roll back a
 * plan for running the `npm install` it was TOLD to run.
 *
 * THE BUG: both of exec's scope guards build their expected-file set from `step.target || step.path`.
 * A `run_command` step (an `npm install`) has NEITHER — so the package.json and package-lock.json the
 * install writes land in `unexpectedFiles` → SCOPE VIOLATION / exec.diverged → the whole plan is
 * rolled back. The planner's own prompt tells it to emit that install step when it needs a package;
 * the escape hatch was legal to plan and fatal to execute.
 *
 * These drive the REAL guard body. Both guards (the final one in exec.mjs and the per-step one inside
 * runApplyTool) now delegate to the SAME exported `computeUnexpectedFiles` / `detectPerStepDivergence`
 * — so a real `npm install` in a tmp git repo, its real `git status` output, and the real functions
 * are the guard as it actually runs. The install is offline: a local `file:` package, no registry, no
 * network — safe in CI.
 *
 * The exemption keys on the PLAN STEP, never the filename: a plan that writes package.json WITHOUT a
 * dependency-add step still trips the guard. That narrowness is the whole point — package.json is not
 * a free pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeUnexpectedFiles,
  detectPerStepDivergence,
} from "../../packages/mcp-rks/src/server/test-runner.mjs";

const GIT_TIMEOUT = 15_000;
const NPM_TIMEOUT = 60_000;
const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
const porcelainFiles = (cwd) =>
  git(cwd, ["status", "--porcelain"]).stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

let projectRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dep-add-scope-"));
  git(projectRoot, ["init", "-b", "staging"]);
  git(projectRoot, ["config", "user.email", "t@t"]);
  git(projectRoot, ["config", "user.name", "t"]);
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }, null, 2) + "\n",
  );
  // Real projects gitignore node_modules; the guard reads `git status`, so the fixture must too, or
  // node_modules churn shows up as an unrelated "unexpected" file. (The bug under test is about the
  // MANIFEST writes, not node_modules — which never reaches the guard in a real repo.)
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), "node_modules/\n");
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-m", "init"]);

  // A local package to install — no registry, no network.
  const pkgDir = path.join(projectRoot, "vendor-pkg");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "vendor-pkg", version: "1.0.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = 1;\n");
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-m", "vendor pkg"]);
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

/** Runs a REAL `npm install ./vendor-pkg` and returns the files it left dirty in git. */
function realNpmInstall() {
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "./vendor-pkg"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: NPM_TIMEOUT,
  });
  expect(r.status, `npm install failed: ${r.stderr}`).toBe(0);
  const dirty = porcelainFiles(projectRoot).filter((f) => !f.startsWith("node_modules"));
  // POSITIVE CONTROL — npm genuinely wrote the manifest + lockfile. If it didn't, the exemption
  // tests below would be witnessing nothing.
  expect(dirty).toContain("package.json");
  expect(dirty.some((f) => f === "package-lock.json")).toBe(true);
  return dirty;
}

const DEP_ADD_STEP = { action: "run_command", command: "npm install ./vendor-pkg" };

// ══════════════════════════════════════════════════════════════════════════════════
// The exemption applies — when the plan genuinely adds a dependency
// ══════════════════════════════════════════════════════════════════════════════════

describe("a plan's npm-install writes are exempt from the scope guard", () => {
  it("FINAL guard: manifest writes are not unexpected when the plan has a dep-add step", () => {
    const modifiedFiles = realNpmInstall();
    const expectedFiles = new Set(); // a terminal dep-add step contributes no target/path

    const unexpected = computeUnexpectedFiles({
      steps: [DEP_ADD_STEP],
      modifiedFiles,
      expectedFiles,
      preCommandGeneratedFiles: new Set(),
    });

    // THE FIX: package.json / package-lock.json are exempt. Under today's source they are unexpected
    // → SCOPE VIOLATION → rollback.
    expect(unexpected).toEqual([]);
  });

  it("PER-STEP guard: same rule, driven through the real detectPerStepDivergence", () => {
    realNpmInstall();
    const result = detectPerStepDivergence(
      projectRoot,
      new Set(), // expectedFilesThrough for a terminal dep-add step
      new Set(), // preCommandGeneratedFiles
      [DEP_ADD_STEP], // the plan steps — the exemption keys on THIS
    );
    expect(result.diverged).toBe(false);
  });

  it("dep-add PLUS a file-writing step: both the file and the manifest are accounted for", () => {
    const modifiedFiles = realNpmInstall();
    fs.writeFileSync(path.join(projectRoot, "src.mjs"), "export const x = 1;\n");
    const allModified = porcelainFiles(projectRoot).filter((f) => !f.startsWith("node_modules"));

    const unexpected = computeUnexpectedFiles({
      steps: [DEP_ADD_STEP, { action: "create_file", path: "src.mjs", target: "src.mjs" }],
      modifiedFiles: allModified,
      expectedFiles: new Set(["src.mjs"]),
      preCommandGeneratedFiles: new Set(),
    });
    expect(unexpected).toEqual([]);
    // sanity: the file-writing step's target really was among the dirty files
    expect(allModified).toContain("src.mjs");
    void modifiedFiles;
  });
});

// ══════════════════════════════════════════════════════════════════════════════════
// NARROWNESS — the exemption is not a blanket filename pass
// ══════════════════════════════════════════════════════════════════════════════════

describe("package.json is NOT a free pass — the exemption keys on the plan step", () => {
  it("FINAL guard: package.json written with NO dep-add step in the plan still trips", () => {
    // Same manifest write on disk, but the plan does not declare a dependency-add.
    realNpmInstall();
    const modified = porcelainFiles(projectRoot).filter((f) => !f.startsWith("node_modules"));

    const unexpected = computeUnexpectedFiles({
      steps: [{ action: "create_file", path: "src.mjs", target: "src.mjs" }], // NO run_command install
      modifiedFiles: modified,
      expectedFiles: new Set(["src.mjs"]),
      preCommandGeneratedFiles: new Set(),
    });
    // The manifest writes are NOW a violation — nothing in the plan authorized them.
    expect(unexpected).toContain("package.json");
  });

  it("PER-STEP guard: same — no dep-add step → divergence on the manifest write", () => {
    realNpmInstall();
    const result = detectPerStepDivergence(
      projectRoot,
      new Set(),
      new Set(),
      [{ action: "create_file", path: "src.mjs", target: "src.mjs" }], // no install step
    );
    expect(result.diverged).toBe(true);
    expect(result.unexpectedFiles).toContain("package.json");
  });

  it("a dep-add step does NOT excuse an unrelated out-of-scope file", () => {
    realNpmInstall();
    fs.writeFileSync(path.join(projectRoot, "sneaky.mjs"), "// not in the plan\n");
    const modified = porcelainFiles(projectRoot).filter((f) => !f.startsWith("node_modules"));

    const unexpected = computeUnexpectedFiles({
      steps: [DEP_ADD_STEP], // has a dep-add step…
      modifiedFiles: modified,
      expectedFiles: new Set(),
      preCommandGeneratedFiles: new Set(),
    });
    // …but that only exempts the manifest, never an arbitrary file.
    expect(unexpected).toContain("sneaky.mjs");
    expect(unexpected).not.toContain("package.json");
  });
});
