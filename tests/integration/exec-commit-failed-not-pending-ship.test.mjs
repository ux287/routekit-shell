/**
 * backlog.fix.exec-pending-ship-reported-when-commit-failed: rks_exec never reports pending_ship
 * (requiredNext rks_story_ship) when its own commit did not land.
 *
 * Drives the REAL runExecTool (packages/mcp-rks/src/server/exec.mjs) on temp git fixtures. Harness
 * modelled on tests/integration/exec-commit-protected-paths.test.mjs: loadContext in
 * server/project.mjs is mocked so the live projects/index.jsonl is never read or written,
 * embedScopedFiles in @routekit/rag is stubbed, and guardrailsOff/guardrailsOn are stubbed so no hook
 * directory is moved. git-tools.mjs, auto-phase.mjs and "child_process" are importOriginal
 * pass-throughs that record calls and inject a fault only when a per-test flag is set.
 * Every spawnSync below carries timeout: GIT_TIMEOUT.
 *
 * testRequirement -> test mapping (TRn = the story's nth testRequirement):
 *   TR1  "commit rejected by a pre-commit hook: ..."
 *   TR2  "runGitCommit throws: ..."
 *   TR3  "commit lands: ..."
 *   TR4  "no commit attempted (non-git root): ..."
 *   TR5  "failed commit keeps the applied edit in the worktree and the rks/ branch exists"
 *   TR6  "commit-failed result is a terminal failure: ..."
 *   TR7  "failed commit: story at arch-approved, ..."
 *   TR8  "failed commit: exec-state.json currentPhase failed, ..."
 *   TR9  "failed commit keeps the backup stash ..." and "stash dropped mid-run: ..."
 *   TR10 "recovery.stashCommand then checkout of the base branch ..."
 *   TR11 "source order: ..."
 *   TR12 "stash-list read fails (child_process pass-through, per-test flag): ..."
 *   TR13 "status: 'pending_ship', occurs exactly once ..."
 *   TR15 "[process] no new reenableGuardrailsAfterExec( / guardrailsOn( / exec.complete emit / await rollback( ..."
 *   TR18 [process] every spawnSync in this file passes timeout: GIT_TIMEOUT.
 *   (TR14, TR16 and TR17 are witnessed by tests/unit/exec-failed-paused-classification.test.mjs,
 *   tests/unit/telemetry-global-mock-triage.test.mjs and the listed regression files.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTelemetryStorage } from "@routekit/telemetry";
import { makeTempDir } from "../helpers/tmp.mjs";

const h = vi.hoisted(() => ({ root: null }));
const gt = vi.hoisted(() => ({ throwMsg: null, dropStash: false, preDropList: null, resolved: [], calls: 0 }));
const ap = vi.hoisted(() => ({ calls: [] }));
const stashListFault = vi.hoisted(() => ({ on: false, root: null, stderr: "fatal: injected stash list failure", intercepted: 0 }));

vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
// Collaborator stub: exec's post-commit auto-embed would load an embedding model; it is not under test.
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const cp = await import("node:child_process");
  return {
    ...actual,
    runGitCommit: vi.fn(async (args) => {
      gt.calls += 1;
      if (gt.throwMsg) throw new Error(gt.throwMsg);
      if (gt.dropStash) {
        const list = cp.spawnSync("git", ["stash", "list", "--format=%H"], { cwd: args.projectRoot, encoding: "utf8", timeout: 15_000 });
        gt.preDropList = String(list.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
        // Drops the newest stash (the temp repo holds only this run's backup stash). A single drop by
        // ref stands in for the whole-stack wipe, which tests/unit/exec-unscoped-commit-landmine.test.mjs
        // forbids in any source or test file.
        cp.spawnSync("git", ["stash", "drop", "stash@{0}"], { cwd: args.projectRoot, encoding: "utf8", timeout: 15_000 });
      }
      const r = await actual.runGitCommit(args);
      gt.resolved.push(r);
      return r;
    }),
  };
});
vi.mock("../../packages/mcp-rks/src/workflow/auto-phase.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    advancePhase: vi.fn(async (...args) => {
      ap.calls.push(args);
      return actual.advancePhase(...args);
    }),
  };
});
// Fixture accommodation for TR4 only: exec's preCommand baseline (getUncommittedFiles, exec.mjs, not
// gated on gitRepo) runs git status and throws a git-binding error in a root with no .git, so a
// non-git run never reaches the result. For a root with no .git entry this pass-through answers []
// (there is nothing git could report); every git root is delegated to the real function unchanged.
vi.mock("../../packages/mcp-rks/src/utils/git.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...actual,
    getUncommittedFiles: (projectRoot, opts) =>
      nodeFs.existsSync(nodePath.join(projectRoot, ".git")) ? actual.getUncommittedFiles(projectRoot, opts) : [],
  };
});
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  const { realpathSync } = await import("node:fs");
  const realpath = (p) => { try { return realpathSync(p); } catch { return p; } };
  return {
    ...actual,
    spawnSync: (cmd, args, opts) => {
      if (stashListFault.on && cmd === "git" && Array.isArray(args) && args.length === 3 && args[0] === "stash" && args[1] === "list" && args[2] === "--format=%H" && opts?.cwd && realpath(opts.cwd) === realpath(stashListFault.root)) {
        stashListFault.intercepted += 1;
        return { pid: 0, status: 1, signal: null, stdout: "", stderr: stashListFault.stderr, output: [null, "", stashListFault.stderr] };
      }
      return actual.spawnSync(cmd, args, opts);
    },
  };
});

const { runExecTool, isResumablePause } = await import("../../packages/mcp-rks/src/server/exec.mjs");
const { findIncompleteRuns } = await import("../../packages/mcp-rks/src/workflow/exec-state.mjs");
const { isRuntimeArtifact } = await import("../../packages/mcp-rks/src/utils/git.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");

const GIT_TIMEOUT = 15_000;
const git = (root, args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

const STORY = "backlog.fix.commit-failed-fixture";
const APPLIED = "applied.txt";
const APPLIED_CONTENT = "applied by the plan\n";
const HOOK = [
  "#!/bin/sh",
  `if git diff --cached --name-only | grep -qx '${APPLIED}'; then`,
  "  echo 'pre-commit: fixture hook rejects the applied file' >&2",
  "  exit 1",
  "fi",
  "exit 0",
  "",
].join("\n");

const cleanup = [];

/** A temp project on staging (unless withGit is false) with the story note at phase executing. */
function makeRepo(tag, { withGit = true, hook = false, port = false, note = true } = {}) {
  const root = makeTempDir(`commit-failed-${tag}`);
  cleanup.push(root);
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/*\n!.rks/plans/\n");
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  if (note) {
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "notes", `${STORY}.md`), `---\nid: "${STORY}"\ntitle: "fixture"\nphase: "executing"\n---\n\nbody\n`);
  }
  if (withGit) {
    git(root, ["init", "-q", "-b", "staging"]);
    git(root, ["config", "user.email", "t@t"]);
    git(root, ["config", "user.name", "t"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "core.hooksPath", ".git/hooks"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "baseline"]);
    if (hook) {
      // Installed before rks_exec starts (sibling story's hooks-surface snapshot).
      fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), HOOK, { mode: 0o755 });
    }
  }
  if (port) fs.writeFileSync(path.join(root, ".dendron.port"), "3005\n");
  h.root = root;
  return root;
}

function writePlan(root, label, { problemId = STORY } = {}) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-05T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  const steps = [{ action: "create_file", path: APPLIED, content: APPLIED_CONTENT, title: "create applied file" }];
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps, ...(problemId ? { problemId } : {}) }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "commit-failed", timestamps: {}, telemetry: { outcome: "planned" } }));
  return label;
}

const exec = (label) => runExecTool({ projectId: "commit-failed", label, skipTests: true });
const stashShas = (root) => git(root, ["stash", "list", "--format=%H"]).split("\n").map((s) => s.trim()).filter(Boolean);
const noteText = (root) => fs.readFileSync(path.join(root, "notes", `${STORY}.md`), "utf8");
const emitsOf = (event, runId) => ensureTelemetryStorage().emit.mock.calls.filter((c) => c[0] === event && (runId === undefined || c[2]?.runId === runId));

/** The return object literal that contains `needle` (from its `return {` to the matching brace). */
function returnLiteralContaining(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const open = src.lastIndexOf("return {", at) + "return ".length;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, text: src.slice(open, i + 1) };
    }
  }
  return null;
}
const count = (src, needle) => src.split(needle).length - 1;

let errSpy;
let warnSpy;
beforeEach(() => {
  h.root = null;
  gt.throwMsg = null;
  gt.dropStash = false;
  gt.preDropList = null;
  gt.resolved = [];
  gt.calls = 0;
  ap.calls = [];
  stashListFault.on = false;
  stashListFault.root = null;
  stashListFault.intercepted = 0;
  ensureTelemetryStorage().emit.mockClear();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  stashListFault.on = false;
  gt.throwMsg = null;
  gt.dropStash = false;
  errSpy?.mockRestore();
  warnSpy?.mockRestore();
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Runs exec on a hook-rejecting repo; returns { root, result }. */
async function failedRun(tag, opts = {}) {
  const root = makeRepo(tag, { hook: true, ...opts });
  const label = writePlan(root, tag);
  const result = await exec(label);
  return { root, result };
}

describe("exec commit outcome gates pending_ship", () => {
  it("commit rejected by a pre-commit hook: not pending_ship, no rks_story_ship requiredNext, commitError carries the hook output", async () => {
    const { result } = await failedRun("hook");
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.status).toBe("exec_commit_failed");
    expect(result.status).not.toBe("pending_ship");
    expect(Object.keys(result)).not.toContain("requiredNext");
    expect(result.commitAttempted).toBe(true);
    expect(result.commitId).toBeNull();
    expect(gt.calls).toBe(1);
    expect(gt.resolved).toHaveLength(1);
    expect(gt.resolved[0].ok).toBe(false);
    expect(typeof gt.resolved[0].error).toBe("string");
    expect(gt.resolved[0].error.length).toBeGreaterThan(0);
    expect(result.commitError).toBe(gt.resolved[0].error);
    expect(result).not.toHaveProperty("testsFailed");
  }, 120_000);

  it("runGitCommit throws: not pending_ship, no rks_story_ship requiredNext, commitError carries the thrown message", async () => {
    const root = makeRepo("throw");
    const label = writePlan(root, "throw");
    gt.throwMsg = "injected runGitCommit failure";
    const result = await exec(label);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(result.status).toBe("exec_commit_failed");
    expect(Object.keys(result)).not.toContain("requiredNext");
    expect(result.commitAttempted).toBe(true);
    expect(result.commitError).toContain("injected runGitCommit failure");
  }, 120_000);

  it("commit lands: pending_ship, requiredNext rks_story_ship, commitId equals rks/ branch HEAD", async () => {
    // No story note and no problemId: no exec_end note commit follows, so the rks/ HEAD is the exec commit.
    const root = makeRepo("lands", { note: false });
    const label = writePlan(root, "lands", { problemId: null });
    const result = await exec(label);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.status).toBe("pending_ship");
    expect(result.requiredNext).toContain("rks_story_ship");
    expect(result.commitAttempted).toBe(true);
    expect(result.branch).toMatch(/^rks\//);
    const head = git(root, ["rev-parse", result.branch]).trim();
    expect(result.fullCommitId).toBe(head);
    expect(head.startsWith(result.commitId)).toBe(true);
    expect(result).not.toHaveProperty("commitSkippedReason");
  }, 120_000);

  it("no commit attempted (non-git root): result says no commit was attempted and why, commitId not set", async () => {
    const root = makeRepo("nogit", { withGit: false });
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    const label = writePlan(root, "nogit");
    const result = await exec(label);
    expect(result.commitAttempted).toBe(false);
    expect(result.commitSkippedReason).toBe("not_a_git_repo");
    expect(result.commitId ?? null).toBeNull();
    expect(result.fullCommitId ?? null).toBeNull();
    expect(gt.calls).toBe(0);
  }, 120_000);

  it("failed commit keeps the applied edit in the worktree and the rks/ branch exists", async () => {
    const { root, result } = await failedRun("keep");
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    expect(fs.readFileSync(path.join(root, APPLIED), "utf8")).toBe(APPLIED_CONTENT);
    expect(result.branch).toMatch(/^rks\//);
    expect(git(root, ["branch", "--list", result.branch]).trim()).not.toBe("");
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(result.branch);
    expect(git(root, ["diff", "--cached", "--name-only"]).split("\n")).toContain(APPLIED);
    expect(result).not.toHaveProperty("rolledBack");
  }, 120_000);

  it("commit-failed result is a terminal failure: isResumablePause false, one exec.failed (reason commit_failed), no exec.paused, no exec.complete", async () => {
    const { result } = await failedRun("terminal");
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    expect(isResumablePause(result)).toBe(false);
    const all = ensureTelemetryStorage().emit.mock.calls;
    const failedEvents = all.filter((c) => c[0] === "exec.failed");
    expect(failedEvents.length).toBeGreaterThan(0);
    const runIds = new Set(failedEvents.map((c) => c[2]?.runId));
    expect(runIds.size).toBe(1);
    const runId = [...runIds][0];
    expect(runId).toBeTruthy();
    const failed = emitsOf("exec.failed", runId);
    expect(failed).toHaveLength(1);
    expect(failed[0][2].reason).toBe("commit_failed");
    expect(emitsOf("exec.paused", runId)).toHaveLength(0);
    expect(emitsOf("exec.complete", runId)).toHaveLength(0);
    expect(all.filter((c) => c[0] === "exec.complete")).toHaveLength(0);
  }, 120_000);

  it("failed commit: story at arch-approved, no requirementCoverageRecord, no exec_end advancePhase call", async () => {
    const { root, result } = await failedRun("phase");
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    const text = noteText(root);
    expect(text).toMatch(/^phase:\s*"?arch-approved"?\s*$/m);
    expect(text).not.toContain("requirementCoverageRecord");
    for (const k of ["noteCommit", "noteCommitError", "phaseError"]) expect(result).not.toHaveProperty(k);
    expect(ap.calls.filter((args) => args[2] === "exec_end")).toHaveLength(0);
  }, 120_000);

  it("failed commit: exec-state.json currentPhase failed, failedAt.step commit, run not listed by findIncompleteRuns", async () => {
    const { root, result } = await failedRun("state");
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    const state = JSON.parse(fs.readFileSync(path.join(result.runFolder, "exec-state.json"), "utf8"));
    expect(state.currentPhase).toBe("failed");
    expect(state.failedAt.step).toBe("commit");
    expect(state.failedAt.error).toBe(result.commitError);
    const listed = findIncompleteRuns(root).map((r) => path.resolve(r.runDir));
    expect(listed).not.toContain(path.resolve(result.runFolder));
  }, 120_000);

  it("failed commit keeps the backup stash and reports its sha with kept observed from git stash list; no stash created is reported as such", async () => {
    const { root, result } = await failedRun("stash-kept", { port: true });
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    expect(result.backupStash.stashCreated).toBe(true);
    const listed = stashShas(root);
    expect(result.backupStash.kept).toBe(listed.includes(result.backupStash.stashSha));
    expect(result.backupStash.kept).toBe(true);
    expect(listed).toContain(result.backupStash.stashSha);
    expect(result.message).not.toContain("no longer in git stash list");

    // No stash created (no untracked runtime artifact, clean tree): reported as such.
    const second = await failedRun("stash-none");
    expect(second.result.status, JSON.stringify(second.result)).toBe("exec_commit_failed");
    expect(second.result.backupStash).toEqual({ stashCreated: false, stashSha: null, kept: false });
  }, 240_000);

  it("stash dropped mid-run: kept false, stashSha still reported, message and hint say it is no longer in git stash list", async () => {
    const root = makeRepo("stash-dropped", { hook: true, port: true });
    const label = writePlan(root, "stash-dropped");
    gt.dropStash = true;
    const result = await exec(label);
    gt.dropStash = false;
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    const sha = result.backupStash.stashSha;
    expect(result.backupStash.stashCreated).toBe(true);
    expect(sha).toBeTruthy();
    expect(gt.preDropList).toContain(sha);
    expect(result.backupStash.kept).toBe(false);
    expect(stashShas(root)).not.toContain(sha);
    for (const field of [result.message, result.hint]) {
      expect(field).toContain(sha);
      expect(field).toContain("no longer in git stash list");
    }
  }, 120_000);

  it("recovery.stashCommand then checkout of the base branch leaves a clean base branch and a stash holding every uncommitted path", async () => {
    const { root, result } = await failedRun("recovery");
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    const observed = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter((p) => p && !p.startsWith("notes/"));
    expect(result.recovery.uncommittedPaths).toEqual(observed);
    expect(result.recovery.uncommittedPaths).toContain(APPLIED);
    expect(result.recovery.baseBranch).toBe("staging");
    for (const s of ["git stash push", "staging", "rks_plan", "rks_exec"]) expect(result.hint).toContain(s);
    expect(typeof result.recovery.stashCommand).toBe("string");
    const sh = spawnSync("sh", ["-c", result.recovery.stashCommand], { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT });
    expect(sh.status, sh.stderr).toBe(0);
    git(root, ["checkout", "staging"]);
    expect(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("staging");
    const dirty = git(root, ["status", "--porcelain"]).split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
    expect(dirty.filter((p) => !p.startsWith("notes/") && !isRuntimeArtifact(p))).toEqual([]);
    const stashed = git(root, ["stash", "show", "--name-only", "stash@{0}"]).split("\n").filter(Boolean);
    for (const p of result.recovery.uncommittedPaths) expect(stashed).toContain(p);
  }, 120_000);

  it("source order: the commit-failed return carries the guardrails spread and sits after let guardrailsRestore = null; and before advanceExecEndPhase", () => {
    expect(count(EXEC_SRC, 'status: "exec_commit_failed"')).toBe(1);
    const ret = returnLiteralContaining(EXEC_SRC, 'status: "exec_commit_failed"');
    expect(ret).not.toBeNull();
    expect(ret.text).toContain("guardrailsRestore && guardrailsRestore.ok !== true");
    const iRestore = EXEC_SRC.indexOf("let guardrailsRestore = null;");
    const iPhase = EXEC_SRC.indexOf("const phaseError = await advanceExecEndPhase(projectRoot, problemId)");
    expect(iRestore).toBeGreaterThan(-1);
    expect(iPhase).toBeGreaterThan(-1);
    expect(ret.start).toBeGreaterThan(iRestore);
    expect(ret.start).toBeLessThan(iPhase);
    // [process] TR15: the commit-failed return carries no success marker, no policy status, no testsFailed.
    expect(ret.text).not.toContain("ok: true,");
    expect(ret.text).not.toContain("command_policy_changed");
    expect(ret.text).not.toContain("pending_ship");
    expect(ret.text).not.toMatch(/testsFailed/);
    expect(ret.text).not.toContain("requiredNext");
    expect(ret.text).toMatch(/\bok:\s*false\b/);
  });

  it("[process] the change adds no reenableGuardrailsAfterExec( / guardrailsOn( / exec.complete emit / await rollback( occurrence", () => {
    // Counts measured on exec.mjs before this story: reenableGuardrailsAfterExec( is its definition
    // plus the two call sites; guardrailsOn( is the one call inside that helper; one exec.complete
    // producer; thirteen rollback awaits. This story adds none of them.
    expect(count(EXEC_SRC, "reenableGuardrailsAfterExec(")).toBe(3);
    expect(count(EXEC_SRC, "guardrailsOn(")).toBe(1);
    expect(count(EXEC_SRC, 'collector.emit("exec.complete"')).toBe(1);
    expect(count(EXEC_SRC, "await rollback(")).toBe(13);
  });

  it("stash-list read fails (child_process pass-through, per-test flag): kept null, keptError carries the injected stderr, stashSha non-null, message/hint/console.warn name the sha as could not be verified", async () => {
    const root = makeRepo("stash-unread", { hook: true, port: true });
    const label = writePlan(root, "stash-unread");
    stashListFault.intercepted = 0;
    stashListFault.root = root;
    stashListFault.on = true;
    let result;
    try {
      result = await exec(label);
    } finally {
      stashListFault.on = false;
    }
    expect(result.status, JSON.stringify(result)).toBe("exec_commit_failed");
    expect(stashListFault.intercepted).toBe(1);
    const sha = result.backupStash.stashSha;
    expect(result.backupStash.stashCreated).toBe(true);
    expect(result.backupStash.kept).toBe(null);
    expect(result.backupStash.keptError).toContain(stashListFault.stderr);
    expect(sha).toBeTruthy();
    for (const field of [result.message, result.hint]) {
      expect(field).toContain(sha);
      expect(field).toContain("could not be verified");
    }
    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(warned.some((t) => t.includes(sha) && t.includes(stashListFault.stderr))).toBe(true);
  }, 120_000);

  it("status: 'pending_ship', occurs exactly once in exec.mjs and only in the success return", () => {
    expect(count(EXEC_SRC, "status: 'pending_ship',")).toBe(1);
    const success = returnLiteralContaining(EXEC_SRC, "status: 'pending_ship',");
    expect(success).not.toBeNull();
    expect(success.text).toContain("ok: true");
    expect(success.text).toContain("requiredNext");
    const failed = returnLiteralContaining(EXEC_SRC, "exec_commit_failed");
    expect(failed.text).not.toContain("pending_ship");
  });
});
