/**
 * backlog.fix.exec-derived-files-commit
 *
 * THE DEFECT: exec's scope guard ran BEFORE the dependency install. `npm install`
 * then rewrote package-lock.json and nothing re-checked, so the lockfile was
 * recognised as derived, waved past the guard, EXCLUDED from exec's commit, and
 * then fatal to ship's preflight (`preflight_dirty_tree`). Every story adding a
 * workspace package hit it. Confirmed in the field: story_ship.failed with
 * dirtyFiles ["package-lock.json"].
 *
 * THE FIX: move the guard past the install so it audits the POST-install tree,
 * and commit the install-window delta INTERSECTED with the known manifests
 * alongside the plan's own files.
 *
 * Fixed at the producer, not the gate: widening ship's preflight to tolerate a
 * dirty lockfile would leave a manifest committed without its lockfile, which is
 * a broken commit on its own merits.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computeUnexpectedFiles,
  DEPENDENCY_MANIFEST_FILES,
} from "../../packages/mcp-rks/src/server/test-runner.mjs";

const ROOT = process.cwd();
const EXEC_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const SHIP_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/story-ship.mjs"), "utf8");

const LOCKFILE = "package-lock.json";
const MANIFEST = "packages/source-x/package.json";
const STORY_NOTE = "notes/backlog.fix.demo.md";

describe("DEPENDENCY_MANIFEST_FILES is the single source of truth", () => {
  it("is exported and names the lockfiles the install rewrites", () => {
    expect(DEPENDENCY_MANIFEST_FILES.has("package-lock.json")).toBe(true);
    expect(DEPENDENCY_MANIFEST_FILES.has("package.json")).toBe(true);
    expect(DEPENDENCY_MANIFEST_FILES.has("yarn.lock")).toBe(true);
  });

  it("exec imports the shared set rather than declaring its own copy", () => {
    expect(EXEC_SRC).toMatch(/import\s*\{[\s\S]*?DEPENDENCY_MANIFEST_FILES[\s\S]*?\}\s*from\s*["']\.\/test-runner\.mjs["']/);
    // An inline duplicate would drift from the guard's copy — the exact defect
    // the shared-rule refactor was introduced to prevent.
    expect(EXEC_SRC).not.toMatch(/const DEPENDENCY_MANIFEST_FILES\s*=\s*new Set/);
  });
});

describe("GUARD RUNS AFTER THE INSTALL — the relocation itself", () => {
  // Ordering is the whole fix. Asserted by source position because call ordering
  // inside runExecToolInner is not observable without driving a full exec; the
  // anchors are durable phrases, not fixed-size windows.
  const installIdx = EXEC_SRC.indexOf("shouldInstallDeps(appliedFiles, projectRoot)");
  const npmInstallIdx = EXEC_SRC.indexOf('spawnSync("npm", ["install"');
  const guardIdx = EXEC_SRC.indexOf("const unexpectedFiles = computeUnexpectedFiles({");
  const testLoopIdx = EXEC_SRC.indexOf("Running verification tests (attempt");

  it("the scope guard is positioned after the dependency install", () => {
    expect(installIdx).toBeGreaterThan(-1);
    expect(npmInstallIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(npmInstallIdx);
  });

  it("and still ahead of the verification test loop", () => {
    expect(testLoopIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(testLoopIdx);
  });

  it("only ONE final guard call exists — no second copy left behind", () => {
    const occurrences = EXEC_SRC.split("const unexpectedFiles = computeUnexpectedFiles({").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("RELOCATION PRESERVES ARGUMENTS — the sibling's fix must survive", () => {
  // backlog.fix.exec-note-scope-and-backup-durability added scopeExemptions to
  // this exact call. Re-writing the call at its new position instead of moving
  // it intact would silently drop that argument and revert a merged fix.
  it("the relocated guard still passes every original argument", () => {
    const call = EXEC_SRC.slice(
      EXEC_SRC.indexOf("const unexpectedFiles = computeUnexpectedFiles({"),
    ).slice(0, 600);

    expect(call).toContain("steps:");
    expect(call).toContain("modifiedFiles");
    expect(call).toContain("expectedFiles");
    expect(call).toContain("preCommandGeneratedFiles");
    // Spread BY NAME, so removing it is a visible deletion rather than a silent
    // omission of a defaulted parameter.
    expect(call).toMatch(/\.\.\.scopeExemptions/);
  });

  it("does not re-capture the baseline at the new position", () => {
    // A re-capture taken after the apply steps would exempt everything exec
    // itself dirtied — the one 'satisfying' implementation that guts the guard.
    const between = EXEC_SRC.slice(
      EXEC_SRC.indexOf('spawnSync("npm", ["install"'),
      EXEC_SRC.indexOf("const unexpectedFiles = computeUnexpectedFiles({"),
    );
    expect(between).not.toMatch(/scopeExemptions\s*=\s*new Set\(\[\.\.\.storyNoteExclusions/);
  });
});

describe("THE EXEMPTION IS THE INTERSECTED DELTA — narrow, not a filename pass", () => {
  const storyExemptions = new Set([STORY_NOTE]);

  it("exempts a lockfile the install derived, and still commits the plan's files", () => {
    const installDerived = new Set([LOCKFILE]);
    const result = computeUnexpectedFiles({
      steps: [],
      modifiedFiles: [MANIFEST, LOCKFILE, STORY_NOTE],
      expectedFiles: new Set([MANIFEST]),
      scopeExemptions: new Set([...storyExemptions, ...installDerived]),
    });
    expect(result).toEqual([]);
  });

  it("does NOT exempt an arbitrary file the install happened to dirty", () => {
    // The intersection with DEPENDENCY_MANIFEST_FILES is what keeps the sweep
    // narrow. A raw delta would wave this through.
    const installDerived = new Set([LOCKFILE]); // src/rogue.mjs deliberately absent
    const result = computeUnexpectedFiles({
      steps: [],
      modifiedFiles: [LOCKFILE, "src/rogue.mjs"],
      expectedFiles: new Set(),
      scopeExemptions: new Set([...storyExemptions, ...installDerived]),
    });
    expect(result).toEqual(["src/rogue.mjs"]);
  });

  it("still reports a lockfile when the install did NOT derive it", () => {
    // No-op case: nothing installed, so nothing is swept in.
    const result = computeUnexpectedFiles({
      steps: [],
      modifiedFiles: [LOCKFILE],
      expectedFiles: new Set(),
      scopeExemptions: new Set([...storyExemptions]),
    });
    expect(result).toEqual([LOCKFILE]);
  });

  it("keeps the sibling's story-note exemption intact alongside the new one", () => {
    const result = computeUnexpectedFiles({
      steps: [],
      modifiedFiles: [STORY_NOTE, LOCKFILE, "src/rogue.mjs"],
      expectedFiles: new Set(),
      scopeExemptions: new Set([...storyExemptions, LOCKFILE]),
    });
    expect(result).toEqual(["src/rogue.mjs"]);
  });

  it("the fresh-clone branch is covered: install fires with no dependency-add step declared", () => {
    // shouldInstallDeps also fires when node_modules is missing, where
    // planAddsDependency is false and the manifest exemption does NOT apply.
    // The derived-delta exemption must cover it regardless of plan steps.
    const result = computeUnexpectedFiles({
      steps: [],                       // no dependency-add step
      modifiedFiles: [LOCKFILE],
      expectedFiles: new Set(),
      scopeExemptions: new Set([LOCKFILE]),
    });
    expect(result).toEqual([]);
  });
});

describe("BOTH COMMIT PATHS receive the derived files", () => {
  it("the union feeds git add and the commit file list", () => {
    expect(EXEC_SRC).toMatch(/const commitFiles = \[\.\.\.new Set\(\[\.\.\.appliedFiles, \.\.\.installDerived\]\)\]/);
    expect(EXEC_SRC).toContain('runGit(projectRoot, ["add", ...commitFiles])');
    expect(EXEC_SRC).toContain("files: commitFiles");
    // Patching only one path would stage the manifest without its lockfile.
    expect(EXEC_SRC).not.toContain("files: [...appliedFiles]");
  });

  it("plan scoping is preserved — appliedFiles is still built from plan targets", () => {
    expect(EXEC_SRC).toMatch(/appliedFiles\s*=\s*applyResult\.appliedFiles/);
  });
});

describe("NEGATIVE AC — ship's preflight filter is NOT widened", () => {
  it("still filters only .rks-family paths and notes/, with no lockfile tolerance", () => {
    // Corrected citation: the .rks/ and projects/index.jsonl exclusions live in
    // utils/git.mjs behind { filterRks: true } — asserting them against
    // story-ship.mjs passes vacuously or fails outright.
    expect(SHIP_SRC).toContain("filterRks: true");
    expect(SHIP_SRC).toMatch(/!f\.startsWith\(['"]notes\/['"]\)/);
    // The fix belongs at the producer. Tolerating a dirty lockfile here would
    // let a manifest-without-lockfile commit reach the branch.
    expect(SHIP_SRC).not.toMatch(/package-lock|yarn\.lock|pnpm-lock|bun\.lockb/);
  });
});
