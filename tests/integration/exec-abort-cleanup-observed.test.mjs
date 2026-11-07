/**
 * backlog.fix.exec-abort-cleanup-observed — rks_exec_abort performs and REPORTS real cleanup.
 * Drives the REAL runExecAbortTool on ISOLATED temp git fixtures (git init in a temp dir,
 * never the host repo). Every git spawn carries an explicit timeout.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTempDir, initGitRepo } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ treeOverride: null, updateFieldOverride: null }));

vi.mock("../../packages/mcp-rks/src/exec/backup.mjs", async (io) => {
  const real = await io();
  return {
    ...real,
    cleanupWorkingTree: (...a) => (h.treeOverride ? h.treeOverride(...a) : real.cleanupWorkingTree(...a)),
  };
});
vi.mock("../../packages/mcp-rks/src/dendron.mjs", async (io) => {
  const real = await io();
  return {
    ...real,
    updateField: (...a) => (h.updateFieldOverride ? h.updateFieldOverride(...a) : real.updateField(...a)),
  };
});

const { runExecAbortTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");
const SLUG = "rks/2026-abort-fixture";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function head(cwd) {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout;
}

function branchExists(cwd, name) {
  return git(cwd, ["branch", "--list", name]).stdout.length > 0;
}

function writeNote(projectRoot, storyId, phase) {
  fs.writeFileSync(
    path.join(projectRoot, "notes", `${storyId}.md`),
    `---\nid: "${storyId}"\ntitle: "fixture"\nphase: "${phase}"\n---\n\n## body\n`,
  );
}

function readPhase(projectRoot, storyId) {
  const m = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8")
    .match(/^phase:\s*["']?([a-z-]+)["']?\s*$/m);
  return m ? m[1] : null;
}

function writeRecord(projectRoot, runId, storyId, branchName) {
  const runDir = path.join(projectRoot, ".rks", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const state = { currentPhase: "applyingSteps", storyId, completedSteps: [], startedAt: new Date(0).toISOString() };
  if (branchName) state.branchName = branchName;
  const statePath = path.join(runDir, "exec-state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return statePath;
}

function setupFixture({ baseBranch = "main", onFeatureBranch = true, unmergedCommit = false } = {}) {
  const projectRoot = makeTempDir("exec-abort-cleanup");
  initGitRepo(projectRoot, { branch: baseBranch });
  git(projectRoot, ["config", "user.email", "fixture@example.com"]);
  git(projectRoot, ["config", "user.name", "fixture"]);
  const projectId = `abort-cleanup-${path.basename(projectRoot)}`;
  fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "routekit", "project.json"),
    JSON.stringify({ id: projectId, baseBranch, kgFile: "routekit/kg.yaml" }, null, 2),
  );
  fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".rks/\n");
  writeNote(projectRoot, "backlog.feat.abortme", "executing");
  git(projectRoot, ["add", "-A"]);
  git(projectRoot, ["commit", "-m", "init"]);
  git(projectRoot, ["branch", SLUG]);
  if (onFeatureBranch) git(projectRoot, ["checkout", SLUG]);
  if (unmergedCommit) {
    fs.writeFileSync(path.join(projectRoot, "work.txt"), "committed work\n");
    git(projectRoot, ["add", "work.txt"]);
    git(projectRoot, ["commit", "-m", "work on feature branch"]);
  }
  const existing = fs.existsSync(registryPath)
    ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  fs.writeFileSync(registryPath, [...existing, JSON.stringify({ id: projectId, root: projectRoot })].join("\n") + "\n");
  return { projectId, projectRoot };
}

describe("rks_exec_abort cleanup is performed and observed", { timeout: 30_000 }, () => {
  let originalRegistry = null;
  const cleanupPaths = [];

  beforeEach(() => {
    originalRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    h.treeOverride = null;
    h.updateFieldOverride = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalRegistry !== null) fs.writeFileSync(registryPath, originalRegistry);
    else if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    for (const p of cleanupPaths.splice(0)) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("AC1: checks out base and deletes the rks/ branch, reporting checkoutOk and branchDeleteOk", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_ac1", "backlog.feat.abortme", SLUG);
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(head(projectRoot)).toBe("main");
    expect(branchExists(projectRoot, SLUG)).toBe(false);
    expect(r.cleanup.checkoutOk).toBe(true);
    expect(r.cleanup.branchDeleteOk).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("AC2: checks out the CONFIGURED base branch, not a hardcoded staging", async () => {
    const { projectId, projectRoot } = setupFixture({ baseBranch: "trunk" });
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_ac2", "backlog.feat.abortme", SLUG);
    await runExecAbortTool({ projectId, reason: "test" });
    expect(head(projectRoot)).toBe("trunk");
  });

  it("AC3: a failed branch delete is not ok, names the step, carries the error and the manual command", async () => {
    const { projectId, projectRoot } = setupFixture({ onFeatureBranch: false });
    cleanupPaths.push(projectRoot);
    const wt = makeTempDir("exec-abort-cleanup-wt");
    fs.rmSync(wt, { recursive: true, force: true });
    cleanupPaths.push(wt);
    expect(git(projectRoot, ["worktree", "add", wt, SLUG]).status).toBe(0);
    writeRecord(projectRoot, "2026-run_ac3", "backlog.feat.abortme", SLUG);
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.ok).not.toBe(true);
    expect(r.cleanup.branchDeleteOk).toBe(false);
    // Names the failed step on a named field (not a key-name substring match).
    expect(r.cleanup.branch.failedStep).toBe("branch_delete");
    expect(r.failedSteps).toContain("branch_delete");
    // Carries the OBSERVED git error from the delete attempt.
    expect(r.cleanup.branch.error).toMatch(/Failed to delete branch/);
    expect(r.cleanup.branch.error).toMatch(/worktree|checked out|used by/i);
    expect(r.cleanup.branch.manualCommand).toBe(`git branch -D ${SLUG}`);
    expect(JSON.stringify(r)).toContain(`git branch -D ${SLUG}`);
    expect(branchExists(projectRoot, SLUG)).toBe(true);
  });

  it("NAC: an rks/ branch with commits not on base is kept, base is still checked out, and the result is not ok", async () => {
    const { projectId, projectRoot } = setupFixture({ unmergedCommit: true });
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_nac", "backlog.feat.abortme", SLUG);
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(branchExists(projectRoot, SLUG)).toBe(true);
    expect(head(projectRoot)).toBe("main");
    expect(r.cleanup.checkoutOk).toBe(true);
    expect(r.cleanup.branchDeleteOk).toBe(false);
    expect(r.cleanup.branch.kept).toBe(true);
    expect(r.cleanup.branch.branchName).toBe(SLUG);
    expect(r.cleanup.branch.reason).toBe("unmerged_commits");
    expect(r.cleanup.branch.unmergedCount).toBe(1);
    expect(r.cleanup.branch.manualCommand).toBe(`git branch -D ${SLUG}`);
    expect(r.ok).not.toBe(true);
  });

  it("record-present without branchName: aborts the run, skips the branch step, observes the phase reset, derives ok", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_nobranch", "backlog.feat.abortme", null);
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.abortedRun).toBe("2026-run_nobranch");
    expect(r.cleanup.branch.skipped).toBe(true);
    expect(head(projectRoot)).toBe(SLUG);
    expect(r.cleanup.workingTree.cleaned).toBe(true);
    expect(r.cleanup.stateRemoved).toBe(true);
    expect(r.cleanup.phaseReset).toBe(true);
    expect(readPhase(projectRoot, "backlog.feat.abortme")).toBe("arch-approved");
    expect(r.ok).toBe(true);
  });

  it("AC4: the cleanupWorkingTree return object is carried, and cleaned:false is not ok", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_ac4", "backlog.feat.abortme", SLUG);
    h.treeOverride = () => ({ cleaned: false, method: "git-checkout", error: "injected tree fault" });
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.cleanup.workingTree).toEqual({ cleaned: false, method: "git-checkout", error: "injected tree fault" });
    expect(r.ok).not.toBe(true);
  });

  it("AC5: a failed exec-state removal is reported and is not ok", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    const statePath = writeRecord(projectRoot, "2026-run_ac5", "backlog.feat.abortme", SLUG);
    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p, ...rest) => {
      if (String(p) === statePath) throw new Error("injected unlink fault");
      return realUnlink(p, ...rest);
    });
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.cleanup.stateRemoved).toBe(false);
    expect(r.ok).not.toBe(true);
  });

  it("AC6: run-record leg reports phaseReset observed from the note after the reset", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_ac6a", "backlog.feat.abortme", SLUG);
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(r.cleanup.phaseReset).toBe(true);
    expect(readPhase(projectRoot, "backlog.feat.abortme")).toBe("arch-approved");
  });

  it("AC6: run-record leg with a no-op updateField reports phaseReset false and is not ok", async () => {
    const { projectId, projectRoot } = setupFixture();
    cleanupPaths.push(projectRoot);
    writeRecord(projectRoot, "2026-run_ac6noop", "backlog.feat.abortme", SLUG);
    h.updateFieldOverride = () => ({ ok: true });
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(readPhase(projectRoot, "backlog.feat.abortme")).toBe("executing");
    expect(r.cleanup.phaseReset).toBe(false);
    expect(r.ok).not.toBe(true);
  });

  it("AC6: stranded-leg phase is observed from the note, not a literal", async () => {
    const { projectId, projectRoot } = setupFixture({ onFeatureBranch: false });
    cleanupPaths.push(projectRoot);
    h.updateFieldOverride = () => ({ ok: true });
    const r = await runExecAbortTool({ projectId, reason: "test" });
    expect(readPhase(projectRoot, "backlog.feat.abortme")).toBe("executing");
    expect(r.phase).not.toBe("arch-approved");
    expect(r.ok).not.toBe(true);
  });

  it("AC7: exec-state.mjs carries no require( call", () => {
    const src = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/workflow/exec-state.mjs"), "utf8");
    expect(src).not.toMatch(/\brequire\(/);
  });
});
