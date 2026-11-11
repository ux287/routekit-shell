/**
 * Tests for exec orphaned-self-branch auto-cleanup (backlog.fix.exec-auto-cleanup-orphaned-branches)
 * and for the unmerged-commit guard on it (backlog.fix.cleanup-feature-branch-unmerged-guard).
 *
 * These tests verify the detection and cleanup logic using a real git repo,
 * importing cleanupFeatureBranch directly to confirm the interface expected by exec.mjs,
 * driving rollback() directly, and driving runExecTool on a git fixture for the orphan pre-clean.
 *
 * runExecTool fixture (pattern: tests/integration/exec-command-policy-integrity.test.mjs): loadContext,
 * embedScopedFiles, generateFixPlan, runRefineTool and guardrailsOff/guardrailsOn are mocked, so the live
 * projects registry is never read and no LLM call is made. Telemetry: both @routekit/telemetry specifiers
 * are escaped with vi.unmock; the REAL collector gets an in-memory storage and every event is recorded
 * through addListener.
 *
 * Every git spawn in this file goes through git()/gitRaw(), which pass an explicit timeout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("@routekit/telemetry");
vi.unmock("@routekit/telemetry/collector");

const h = vi.hoisted(() => ({ root: null }));

vi.mock("../../packages/mcp-rks/src/server/project.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  loadContext: vi.fn(async (projectId) => ({ record: { id: projectId, root: h.root }, projectJson: { baseBranch: "staging" } })),
}));
vi.mock("@routekit/rag", async (importOriginal) => ({
  ...(await importOriginal()),
  embedScopedFiles: vi.fn(async () => ({ ok: true, filesEmbedded: 0 })),
}));
vi.mock("../../packages/mcp-rks/src/server/fix-planner.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  generateFixPlan: vi.fn(async () => null),
}));
vi.mock("../../packages/mcp-rks/src/server/refine.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  runRefineTool: vi.fn(async () => ({ ok: true, suggestions: [] })),
}));
vi.mock("../../packages/mcp-rks/src/server/guardrails-audit.mjs", async (importOriginal) => ({
  ...(await importOriginal()),
  guardrailsOff: vi.fn(async () => ({ ok: true })),
  guardrailsOn: vi.fn(async () => ({ ok: true })),
}));

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getTelemetryCollector } from "@routekit/telemetry/collector";
import { makeTempDir, TEMP_BASE } from "../helpers/tmp.mjs";
import { cleanupFeatureBranch, rollback } from "../../packages/mcp-rks/src/server/test-runner.mjs";

const { runExecTool } = await import("../../packages/mcp-rks/src/server/exec.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXEC_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const TEST_RUNNER_SRC = fs.readFileSync(path.join(REPO_ROOT, "packages/mcp-rks/src/server/test-runner.mjs"), "utf8");

const GIT_TIMEOUT = 30_000;
const gitRaw = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT });
const git = (cwd, args) => {
  const r = gitRaw(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

// Telemetry: the real collector, an in-memory storage, and a listener record.
const telemetry = getTelemetryCollector();
telemetry.setStorage({ write: async () => {} });
const events = [];
telemetry.addListener((e) => events.push(e));
const eventsOf = (type) => events.filter((e) => e.type === type);

function initGitRepo(dir, baseBranch = "staging") {
  git(dir, ["init", "-q", "-b", baseBranch]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.hooksPath", ".git/hooks"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
}

/** Mirror the detection logic from exec.mjs */
function branchExists(projectRoot, branchName) {
  const result = gitRaw(projectRoot, ["branch", "--list", branchName]);
  return result.stdout.trim() !== "";
}

/** Create `branchName` off the current branch with `count` commits of its own, then return to `back`. */
function branchWithCommits(projectRoot, branchName, count, back = "staging") {
  git(projectRoot, ["checkout", "-q", "-b", branchName]);
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(projectRoot, `work-${branchName.replace(/\W/g, "_")}-${i}.txt`), `work ${i}\n`);
    git(projectRoot, ["add", "-A"]);
    git(projectRoot, ["commit", "-q", "-m", `wip ${i}`]);
  }
  git(projectRoot, ["checkout", "-q", back]);
}

const tip = (root, ref) => git(root, ["rev-parse", ref]).trim();
const currentBranch = (root) => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
const revList = (root, range) => git(root, ["rev-list", range]).split("\n").filter(Boolean);

const dirs = [];
let errSpy;
beforeEach(() => {
  events.length = 0;
  h.root = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy?.mockRestore();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshRepo(tag) {
  const projectRoot = makeTempDir(tag);
  dirs.push(projectRoot);
  initGitRepo(projectRoot, "staging");
  return projectRoot;
}

describe("exec orphaned-branch detection", () => {
  it("detects orphaned branch via git branch --list", () => {
    const projectRoot = freshRepo("exec-orphan-detect");

    const branchName = "rks/my-story";
    git(projectRoot, ["checkout", "-q", "-b", branchName]);
    git(projectRoot, ["checkout", "-q", "staging"]);

    expect(branchExists(projectRoot, branchName)).toBe(true);
  });

  it("returns false for non-existent branch", () => {
    const projectRoot = freshRepo("exec-orphan-noexist");

    expect(branchExists(projectRoot, "rks/ghost-branch")).toBe(false);
  });
});

describe("cleanupFeatureBranch (imported from test-runner.mjs)", () => {
  it("is a synchronous function (not async) — no await needed in exec.mjs", () => {
    expect(typeof cleanupFeatureBranch).toBe("function");
    // constructor.name would be "AsyncFunction" if async — must be plain "Function"
    expect(cleanupFeatureBranch.constructor.name).toBe("Function");
  });

  it("returns { checkoutOk, branchDeleteOk } when cleaning up an existing branch", () => {
    // backlog.fix.cleanup-feature-branch-unmerged-guard: the branch carries a commit absent from base,
    // so the helper now REFUSES instead of force-deleting it. The result shape is unchanged.
    const projectRoot = freshRepo("exec-orphan-cleanup");

    const branchName = "rks/cleanup-test";
    branchWithCommits(projectRoot, branchName, 1);

    const result = cleanupFeatureBranch(projectRoot, branchName, "staging");

    expect(result).toHaveProperty("checkoutOk");
    expect(result).toHaveProperty("branchDeleteOk");
    expect(result.checkoutOk).toBe(true);
    expect(result.branchDeleteOk).toBe(false);
    expect(result.refused).toBe(true);
    expect(branchExists(projectRoot, branchName)).toBe(true);
  });

  it("branch no longer exists after cleanup", () => {
    const projectRoot = freshRepo("exec-orphan-cleanup-gone");

    const branchName = "rks/to-delete";
    git(projectRoot, ["checkout", "-q", "-b", branchName]);
    git(projectRoot, ["checkout", "-q", "staging"]);

    cleanupFeatureBranch(projectRoot, branchName, "staging");

    expect(branchExists(projectRoot, branchName)).toBe(false);
  });

  it("exec proceeds to create fresh branch after orphaned branch is cleaned", () => {
    const projectRoot = freshRepo("exec-orphan-retry");

    const branchName = "rks/retry-story";

    // Simulate interrupted prior build: the branch exists and its partial work was merged into base,
    // so deleting it destroys no commit (an unmerged branch is refused — see the guard tests below).
    branchWithCommits(projectRoot, branchName, 1);
    git(projectRoot, ["merge", "-q", "--ff-only", branchName]);

    expect(branchExists(projectRoot, branchName)).toBe(true);

    // Run cleanup (mirrors exec.mjs orphaned-branch cleanup step)
    const cleanup = cleanupFeatureBranch(projectRoot, branchName, "staging");
    expect(cleanup.checkoutOk).toBe(true);
    expect(cleanup.branchDeleteOk).toBe(true);
    expect(branchExists(projectRoot, branchName)).toBe(false);

    // Now exec can create a fresh branch without error
    const createResult = gitRaw(projectRoot, ["checkout", "-b", branchName, "staging"]);
    expect(createResult.status).toBe(0);
    expect(branchExists(projectRoot, branchName)).toBe(true);
  });
});

// ── backlog.fix.cleanup-feature-branch-unmerged-guard: the helper guard ───────────

describe("cleanupFeatureBranch refuses to delete a branch with unmerged commits", () => {
  it("one unmerged commit: refused, reported, branch kept, base checked out", () => {
    const root = freshRepo("guard-one");
    const branchName = "rks/one";
    branchWithCommits(root, branchName, 1);
    const sha = tip(root, branchName);
    git(root, ["checkout", "-q", branchName]); // the helper must check base out itself

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(result.refused).toBe(true);
    expect(result.reason).toBe("unmerged_commits");
    expect(result.branchDeleteOk).toBe(false);
    expect(result.unmergedCount).toBe(1);
    expect(result.unmergedCommits).toContain(sha);
    expect(result.ok).not.toBe(true);
    expect(git(root, ["branch", "--list", branchName]).trim()).not.toBe("");
    expect(tip(root, branchName)).toBe(sha);
    expect(currentBranch(root)).toBe("staging");
  });

  it("three unmerged commits: true count, every listed SHA from rev-list base..branch", () => {
    const root = freshRepo("guard-three");
    const branchName = "rks/three";
    branchWithCommits(root, branchName, 3);
    const listed = revList(root, `staging..${branchName}`);
    expect(listed).toHaveLength(3); // positive control

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(result.unmergedCount).toBe(3);
    expect(result.unmergedCommits.length).toBeLessThanOrEqual(result.unmergedCount);
    for (const sha of result.unmergedCommits) expect(listed).toContain(sha);
    expect(branchExists(root, branchName)).toBe(true);
  });

  it("the refusal adds an errors entry naming the branch, the base and the count", () => {
    const root = freshRepo("guard-errors");
    const branchName = "rks/errs";
    branchWithCommits(root, branchName, 2);

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(Array.isArray(result.errors)).toBe(true);
    const entry = result.errors.find((e) => e.includes(branchName) && e.includes("staging") && /\b2\b/.test(e));
    expect(entry, JSON.stringify(result.errors)).toBeDefined();
  });

  it("an unresolvable base fails closed: unmerged_check_failed, branch kept", () => {
    const root = freshRepo("guard-nobase");
    const branchName = "rks/nobase";
    git(root, ["checkout", "-q", "-b", branchName]);
    git(root, ["checkout", "-q", "staging"]);

    const result = cleanupFeatureBranch(root, branchName, "no-such-base");

    expect(result.refused).toBe(true);
    expect(result.reason).toBe("unmerged_check_failed");
    expect(typeof result.unmergedCheckError).toBe("string");
    expect(result.unmergedCheckError.length).toBeGreaterThan(0);
    expect(result.ok).not.toBe(true);
    expect(result.branchDeleteOk).toBe(false);
    expect(git(root, ["branch", "--list", branchName]).trim()).not.toBe("");
  });

  it("a branch whose commits were merged into base is deleted (ok true, no refused flag)", () => {
    const root = freshRepo("guard-merged");
    const branchName = "rks/merged";
    branchWithCommits(root, branchName, 2);
    git(root, ["merge", "-q", "--no-ff", "--no-edit", branchName]);
    expect(revList(root, `staging..${branchName}`)).toHaveLength(0); // positive control

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(result.branchDeleteOk).toBe(true);
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("refused");
    expect(branchExists(root, branchName)).toBe(false);
  });

  it("a branch with no commits of its own is deleted with every step flag true", () => {
    const root = freshRepo("guard-empty");
    const branchName = "rks/empty";
    git(root, ["checkout", "-q", "-b", branchName]);
    git(root, ["checkout", "-q", "staging"]);

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(result.checkoutOk).toBe(true);
    expect(result.worktreeRemoveOk).toBe(true);
    expect(result.branchDeleteOk).toBe(true);
    expect(result.ok).toBe(true);
    expect(branchExists(root, branchName)).toBe(false);
  });

  it("a failed branch -D (branch checked out in a linked worktree) gives branchDeleteOk false and ok not true", () => {
    const root = freshRepo("guard-worktree");
    const branchName = "rks/linked";
    git(root, ["branch", branchName]);
    const wt = path.join(TEMP_BASE, `guard-wt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(wt);
    git(root, ["worktree", "add", "-q", wt, branchName]);

    const result = cleanupFeatureBranch(root, branchName, "staging");

    expect(result.refused).toBeUndefined();
    expect(result.branchDeleteOk).toBe(false);
    expect(result.ok).not.toBe(true);
    expect(branchExists(root, branchName)).toBe(true);
  });
});

// ── rollback(): branchCleaned observed, branchRetained reported ──────────────────

describe("rollback() reports a branch the helper retained", () => {
  const rollbackOn = (root, branchName, reason = "test_failure") =>
    rollback(root, { runDir: null, branchName, baseBranch: "staging", backupMeta: null, guardrailsSession: null, projectId: "orphan", reason });

  it("an unmerged branch: branchCleaned false, branchRetained set, branch kept", async () => {
    const root = freshRepo("rb-unmerged");
    const branchName = "rks/rb-unmerged";
    branchWithCommits(root, branchName, 1);
    const sha = tip(root, branchName);

    const result = await rollbackOn(root, branchName);

    expect(result.branchCleaned).toBe(false);
    expect(result.branchRetained).toEqual({ branchName, reason: "unmerged_commits", unmergedCount: 1, unmergedCommits: [sha] });
    expect(tip(root, branchName)).toBe(sha);
  });

  it("an unmerged branch: exec.rollback telemetry carries branchCleaned false and branchRetained", async () => {
    const root = freshRepo("rb-telemetry");
    const branchName = "rks/rb-telemetry";
    branchWithCommits(root, branchName, 1);

    const result = await rollbackOn(root, branchName);

    const rb = eventsOf("exec.rollback");
    expect(rb).toHaveLength(1);
    expect(rb[0].payload.branchCleaned).toBe(false);
    expect(rb[0].payload.branchRetained).toEqual(result.branchRetained);
    expect(rb[0].payload.branchRetained.branchName).toBe(branchName);
  });

  it("a delete that fails for another reason (linked worktree) gives branchCleaned false", async () => {
    const root = freshRepo("rb-worktree");
    const branchName = "rks/rb-linked";
    git(root, ["branch", branchName]);
    const wt = path.join(TEMP_BASE, `rb-wt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(wt);
    git(root, ["worktree", "add", "-q", wt, branchName]);

    const result = await rollbackOn(root, branchName);

    expect(result.branchCleaned).toBe(false);
    expect(branchExists(root, branchName)).toBe(true);
  });

  it("a branch with no unmerged commits is deleted: branchCleaned true, receipt branchRetained null", async () => {
    const root = freshRepo("rb-clean");
    const branchName = "rks/rb-clean";
    git(root, ["branch", branchName]);

    const result = await rollbackOn(root, branchName);

    expect(result.branchCleaned).toBe(true);
    expect(result.branchRetained ?? null).toBeNull();
    expect(result.intervention.branchRetained).toBe(null);
    expect(branchExists(root, branchName)).toBe(false);
  });

  it("an unmerged branch: the receipt and its durable record carry branchRetained", async () => {
    const root = freshRepo("rb-receipt");
    const branchName = "rks/rb-receipt";
    branchWithCommits(root, branchName, 1);

    const result = await rollbackOn(root, branchName);

    expect(result.intervention.branchRetained.branchName).toBe(branchName);
    expect(result.intervention.branchRetained.reason).toBe("unmerged_commits");
    expect(result.intervention.branchRetained.unmergedCount).toBe(1);
    const lines = fs.readFileSync(path.join(root, ".rks", "state", "interventions.jsonl"), "utf8").split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.branchRetained).toEqual(result.intervention.branchRetained);
  });

  it("an unmerged branch: one console line names the branch, the reason and the count", async () => {
    const root = freshRepo("rb-console");
    const branchName = "rks/rb-console";
    branchWithCommits(root, branchName, 1);

    await rollbackOn(root, branchName);

    const lines = errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(branchName) && l.includes("unmerged_commits"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/\b1\b/);
  });
});

// ── runExecTool orphan pre-clean ──────────────────────────────────────────────────

/** A temp repo on staging with .rks/ ignored, and a plan for `label` in .rks/runs. */
function makeExecRepo(tag) {
  const root = path.join(TEMP_BASE, `orphan-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  dirs.push(root);
  fs.writeFileSync(path.join(root, "other.txt"), "one\n");
  fs.writeFileSync(path.join(root, ".gitignore"), ".rks/\n");
  git(root, ["init", "-q", "-b", "staging"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  h.root = root;
  return root;
}

function writePlan(root, label) {
  const runDir = path.join(root, ".rks", "runs", `2026-11-05T00-00-00-000Z_${label}`);
  fs.mkdirSync(runDir, { recursive: true });
  const steps = [{ action: "create_file", path: "plan-created.txt", content: "created\n", title: "create the plan file" }];
  fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify({ slug: label, status: "executable", steps }, null, 2));
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({ projectId: "orphan", timestamps: {}, telemetry: { outcome: "planned" } }));
  return runDir;
}

const readExecState = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, "exec-state.json"), "utf8"));

describe("runExecTool orphan pre-clean refuses an orphan with unmerged commits", () => {
  async function runOnUnmergedOrphan(tag) {
    const root = makeExecRepo(tag);
    const label = tag;
    const branchName = `rks/${label}`;
    branchWithCommits(root, branchName, 1);
    const sha = tip(root, branchName);
    const runDir = writePlan(root, label);
    const err = await runExecTool({ projectId: "orphan", label, skipTests: true }).then(() => null, (e) => e);
    return { root, branchName, sha, runDir, err };
  }

  it("refuses with the branch and count, never suggests git branch -D, keeps the commit, records orphaned_branch_unmerged", async () => {
    const { root, branchName, sha, runDir, err } = await runOnUnmergedOrphan("refuse");

    expect(err, "runExecTool must refuse").not.toBeNull();
    const msg = String(err.message);
    expect(msg).toContain(branchName);
    expect(msg).toMatch(/\b1 commit/);
    expect(msg).not.toContain("git branch -D");
    expect(branchExists(root, branchName)).toBe(true);
    expect(tip(root, branchName)).toBe(sha);
    expect(readExecState(runDir).failedAt?.step).toBe("orphaned_branch_unmerged");
  }, 120_000);

  it("does not record the refused branch as cleaned in telemetry or exec state", async () => {
    const { branchName, runDir, err } = await runOnUnmergedOrphan("notcleaned");

    expect(err).not.toBeNull();
    const cleanedUnmarked = eventsOf("exec.orphaned_branch_cleaned").filter((e) => e.payload?.refused !== true);
    expect(cleanedUnmarked).toHaveLength(0);
    // Positive control: the refusal IS in telemetry, as a refusal.
    const refused = eventsOf("exec.orphaned_branch_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0].payload.refused).toBe(true);
    expect(refused[0].payload.unmergedCount).toBe(1);
    expect(readExecState(runDir).orphanedBranchCleaned).not.toBe(branchName);
  }, 120_000);

  it("the Region 2 rollback reports the retained branch on exec.rollback, and the commit survives", async () => {
    const { root, branchName, sha, err } = await runOnUnmergedOrphan("region2");

    expect(err).not.toBeNull();
    const rb = eventsOf("exec.rollback").filter((e) => e.payload?.branchName === branchName);
    expect(rb.length, JSON.stringify(eventsOf("exec.rollback").map((e) => e.payload))).toBeGreaterThanOrEqual(1);
    const p = rb[rb.length - 1].payload;
    expect(p.branchCleaned).toBe(false);
    expect(p.branchRetained.branchName).toBe(branchName);
    expect(p.branchRetained.reason).toBe("unmerged_commits");
    expect(branchExists(root, branchName)).toBe(true);
    expect(tip(root, branchName)).toBe(sha);
  }, 120_000);
});

describe("runExecTool orphan pre-clean still deletes a disposable orphan", () => {
  it("deletes an orphan with no commits of its own and creates rks/<slug> fresh from base", async () => {
    const root = makeExecRepo("disposable");
    const label = "disposable";
    const branchName = `rks/${label}`;
    git(root, ["branch", branchName]);
    const base = tip(root, "staging");
    const runDir = writePlan(root, label);

    const result = await runExecTool({ projectId: "orphan", label, skipTests: true }).then((r) => r, (e) => ({ thrown: e }));

    const state = readExecState(runDir);
    expect(["orphaned_branch_cleanup", "orphaned_branch_unmerged"]).not.toContain(state.failedAt?.step);
    if (result.thrown) expect(String(result.thrown.message)).not.toMatch(/orphaned branch/i);
    expect(state.orphanedBranchCleaned).toBe(branchName);
    expect(eventsOf("exec.orphaned_branch_cleaned")).toHaveLength(1);
    expect(eventsOf("exec.orphaned_branch_refused")).toHaveLength(0);
    // The fresh branch was created from the base branch.
    expect(state.branchName).toBe(branchName);
    expect(gitRaw(root, ["merge-base", "--is-ancestor", base, branchName]).status).toBe(0);
  }, 120_000);
});

// ── Structural: branchRetained forwarding in exec.mjs, JSDoc, stale comment ───────

/** From `start`, the `return { ... };` object literal that follows (brace-matched). */
function returnLiteralAfter(src, start) {
  const ret = src.indexOf("return {", start);
  if (ret < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", ret); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(ret, i + 1), end: i + 1 };
    }
  }
  return null;
}

describe("exec.mjs forwards branchRetained at every cherry-picking rollback site", () => {
  it("each of the seven cherry-picking responses carries branchRetained from rb?.branchRetained ?? null", () => {
    const sites = [...EXEC_SRC.matchAll(/const rb = await rollback\(/g)].map((m) => m.index);
    expect(sites.length).toBeGreaterThan(7); // positive control: full forwarders exist too
    const cherry = [];
    for (const idx of sites) {
      const lit = returnLiteralAfter(EXEC_SRC, idx);
      expect(lit, `no response after rollback at offset ${idx}`).not.toBeNull();
      if (/\brollback:\s*rb\b/.test(lit.text)) continue; // forwards the whole result
      const reason = EXEC_SRC.slice(idx, EXEC_SRC.indexOf("\n", idx)).match(/reason:\s*'([^']+)'/)?.[1];
      const between = EXEC_SRC.slice(idx, lit.end);
      const direct = /\bbranchRetained:\s*rb\?\.branchRetained\s*\?\?\s*null\b/.test(lit.text);
      const viaLocal = /\bbranchRetained\s*=\s*rb\?\.branchRetained\s*\?\?\s*null\b/.test(between) && /[\s,{]branchRetained\s*,/.test(lit.text);
      cherry.push({ reason, ok: direct || viaLocal });
    }
    expect(cherry).toHaveLength(7);
    expect(cherry.map((c) => c.reason).sort()).toEqual([
      "command_policy_changed", "command_policy_changed", "command_policy_changed",
      "per_step_divergence", "scope_violation", "static_analysis_failed", "test_file_modified",
    ]);
    for (const c of cherry) expect(c.ok, `site ${c.reason} does not forward branchRetained`).toBe(true);
  });

  it("JSDoc @returns name the new fields, and the stale constant-ok comment is gone", () => {
    const jsdocBefore = (marker) => {
      const at = TEST_RUNNER_SRC.indexOf(marker);
      expect(at).toBeGreaterThan(0);
      const open = TEST_RUNNER_SRC.lastIndexOf("/**", at);
      return TEST_RUNNER_SRC.slice(open, at).match(/@returns[^\n]*/)?.[0] ?? "";
    };
    const cfb = jsdocBefore("export const cleanupFeatureBranch");
    for (const f of ["refused", "unmergedCount", "unmergedCommits"]) expect(cfb).toContain(f);
    expect(jsdocBefore("export async function rollback(")).toContain("branchRetained");
    expect(EXEC_SRC).not.toContain("ok` is a constant");
  });
});
