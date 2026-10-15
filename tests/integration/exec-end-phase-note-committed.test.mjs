/**
 * backlog.fix.exec-end-phase-write-left-uncommitted
 *
 * Witnesses that exec's exec_end phase write (executing -> executed) is committed on the
 * feature branch, that a failed note commit surfaces on the result, and that
 * rks_story_ship never reaches localMerge's checkout with its own story note dirty.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

// Neutralize credentials at MODULE scope so no live reviewer call can occur.
const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const ROOT = process.cwd();
const EXEC_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/exec.mjs"), "utf8");
const SHIP_SRC = fs.readFileSync(path.join(ROOT, "packages/mcp-rks/src/server/story-ship.mjs"), "utf8");

let dir = null;
let reviewPolicyFixture = { enabled: true };

vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(async () => ({
    record: { root: dir, id: "test-project" },
    projectJson: { branches: { working: "staging", integration: "staging", production: "main" } },
  })),
  getBranchConfig: vi.fn(() => ({ working: "staging", integration: "staging", production: "main" })),
  getWorkflowConfig: vi.fn(() => ({ autoMergeIntegration: false })),
}));
vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", () => ({ assertNotOnProtectedBranch: vi.fn() }));
vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => ({ ok: true, verdict: "pass", findings: [], summary: "ok" })),
  loadReviewPolicy: vi.fn(() => reviewPolicyFixture),
  redactReview: vi.fn((r) => r),
}));
// Spies that DELEGATE to the real implementations: AC3 asserts they are never reached,
// AC5 needs the real merge to land.
vi.mock("../../packages/mcp-rks/src/server/git/local-merge.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, localMerge: vi.fn((...a) => actual.localMerge(...a)) };
});
vi.mock("../../packages/mcp-rks/src/server/git/branch-delivery.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, deliverFeatureBranch: vi.fn((...a) => actual.deliverFeatureBranch(...a)) };
});

import { advanceExecEndPhase, commitExecEndNote } from "../../packages/mcp-rks/src/server/exec.mjs";
import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { runReview } from "../../packages/mcp-rks/src/server/review.mjs";
import { localMerge } from "../../packages/mcp-rks/src/server/git/local-merge.mjs";
import { deliverFeatureBranch } from "../../packages/mcp-rks/src/server/git/branch-delivery.mjs";

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, timeout: 15_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}
function gitOk(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const PROBLEM = "backlog.feat.sample";
const NOTE = `notes/${PROBLEM}.md`;
const OTHER_NOTE = "notes/backlog.feat.other.md";
const FEATURE = "rks/backlog-feat-sample";

const noteBody = (phase, extra = "") => `---\nid: "${PROBLEM}"\nphase: "${phase}"\n${extra}---\n\nbody\n`;

/**
 * Temp repo: `staging` holds the note at `stagingPhase` (content A, the merge base);
 * the rks/ feature branch commits the note at `executing` (content B) plus a feature file.
 */
function makeRepo({ stagingPhase = "executing", trackNote = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rks-exec-end-note-"));
  fs.mkdirSync(path.join(d, "notes"), { recursive: true });
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.mkdirSync(path.join(d, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(d, "README.md"), "# test\n");
  fs.writeFileSync(path.join(d, "src", "other.mjs"), "export const x = 1;\n");
  fs.writeFileSync(path.join(d, OTHER_NOTE), '---\nid: "backlog.feat.other"\nphase: "draft"\n---\n');
  if (trackNote) fs.writeFileSync(path.join(d, NOTE), noteBody(stagingPhase));
  gitOk(d, ["init", "-q", "-b", "staging"]);
  // Repo-local identity: the code under test spawns git with the process env only.
  gitOk(d, ["config", "user.email", "test@test.com"]);
  gitOk(d, ["config", "user.name", "test"]);
  gitOk(d, ["add", "-A"]);
  gitOk(d, ["commit", "-q", "-m", "init"]);
  gitOk(d, ["checkout", "-q", "-b", FEATURE]);
  if (trackNote) fs.writeFileSync(path.join(d, NOTE), noteBody("executing"));
  fs.writeFileSync(path.join(d, "feature.txt"), "feature\n");
  gitOk(d, ["add", "-A"]);
  gitOk(d, ["commit", "-q", "-m", "feat: sample"]);
  return d;
}

const readNote = (d) => fs.readFileSync(path.join(d, NOTE), "utf8");
const porcelainFor = (d, p) => git(d, ["status", "--porcelain", "--", p]).stdout;

/** A recording fake git runner; `results` maps the git subcommand to an observed result. */
function fakeGit(results = {}) {
  const calls = [];
  const run = (_root, args) => {
    calls.push(args);
    return results[args[0]] || { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}
const noteCalls = (calls) => calls.filter((a) => (a[0] === "add" || a[0] === "commit") && a.includes(NOTE));

const GATE_OPEN = { shouldCommit: true, commitResult: { ok: true, commitId: "abc1234" }, phaseError: null };

beforeEach(() => {
  reviewPolicyFixture = { enabled: true };
  vi.clearAllMocks();
});
afterEach(() => {
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  dir = null;
});

describe("exec: exec_end phase write is committed on the feature branch", () => {
  it("leaves notes/<problemId>.md clean with phase executed at HEAD (AC1)", async () => {
    dir = makeRepo();
    const phaseError = await advanceExecEndPhase(dir, PROBLEM);
    expect(phaseError).toBeNull();
    expect(porcelainFor(dir, NOTE)).not.toBe(""); // the advance alone leaves it dirty

    const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN, phaseError });
    expect(out?.ok).toBe(true);
    expect(porcelainFor(dir, NOTE)).toBe("");
    expect(gitOk(dir, ["show", `HEAD:${NOTE}`])).toMatch(/phase: "?executed"?/);
    expect(gitOk(dir, ["branch", "--show-current"])).toBe(FEATURE);
  });

  it("stages only the story's own note (AC1)", async () => {
    dir = makeRepo();
    fs.writeFileSync(path.join(dir, "src", "other.mjs"), "export const x = 2;\n");
    fs.writeFileSync(path.join(dir, OTHER_NOTE), '---\nid: "backlog.feat.other"\nphase: "ready"\n---\n');
    // One of them already STAGED: the note commit must not sweep the index either.
    gitOk(dir, ["add", OTHER_NOTE]);
    await advanceExecEndPhase(dir, PROBLEM);

    const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN });
    expect(out?.ok).toBe(true);
    const committed = gitOk(dir, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    expect(committed).toEqual([NOTE]);
    expect(porcelainFor(dir, "src/other.mjs")).toMatch(/M/);
    expect(porcelainFor(dir, OTHER_NOTE)).toMatch(/M/);
    expect(git(dir, ["log", "--format=%H", "--", OTHER_NOTE]).stdout.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("commits after advanceExecEndPhase in source order, outside commitFiles (AC1)", () => {
    const advanceIdx = EXEC_SRC.indexOf("const phaseError = await advanceExecEndPhase(projectRoot, problemId)");
    const callIdx = EXEC_SRC.indexOf("await commitExecEndNote({");
    const execCommitIdx = EXEC_SRC.indexOf("commitResult = await runGitCommit({");
    expect(advanceIdx).toBeGreaterThan(-1);
    expect(execCommitIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(advanceIdx);
    expect(advanceIdx).toBeGreaterThan(execCommitIdx);
    // The call site passes the gate's inputs.
    const call = EXEC_SRC.slice(callIdx, EXEC_SRC.indexOf(")", callIdx));
    for (const k of ["shouldCommit", "commitResult", "phaseError", "problemId"]) expect(call).toContain(k);
    // The note is NOT added to commitFiles.
    const cfLine = EXEC_SRC.split("\n").find((l) => l.includes("const commitFiles ="));
    expect(cfLine).toMatch(/const commitFiles = \[\.\.\.new Set\(\[\.\.\.appliedFiles, \.\.\.installDerived\]\)\]/);
    expect(EXEC_SRC).not.toMatch(/commitFiles\.push\(/);
    expect(EXEC_SRC).toContain("files: commitFiles");
  });

  it("surfaces an observed git failure on the result (AC2)", async () => {
    dir = makeRepo();
    await advanceExecEndPhase(dir, PROBLEM);

    const addFail = fakeGit({ add: { status: 128, stdout: "", stderr: "fatal: index.lock exists" } });
    const a = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN, git: addFail.run });
    expect(a).not.toBeNull();
    expect(a.ok).toBe(false);
    expect(a.step).toBe("add");
    expect(a.error).toContain("index.lock exists");

    const commitFail = fakeGit({
      diff: { status: 1, stdout: "", stderr: "" },
      commit: { status: 1, stdout: "", stderr: "hook rejected the commit" },
    });
    const c = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN, git: commitFail.run });
    expect(c.ok).toBe(false);
    expect(c.step).toBe("commit");
    expect(typeof c.error).toBe("string");
    expect(c.error).toContain("hook rejected");
    expect(c).not.toHaveProperty("commitId");

    // Real git: a commit-msg hook refuses the note commit. Observed, not assumed.
    const hook = path.join(dir, ".git", "hooks", "commit-msg");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'note commit refused by hook' >&2\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const headBefore = gitOk(dir, ["rev-parse", "HEAD"]);
    const r = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("note commit refused by hook");
    expect(gitOk(dir, ["rev-parse", "HEAD"])).toBe(headBefore);

    // ...and exec spreads that failure onto its returned object.
    expect(EXEC_SRC).toMatch(/\.\.\.\(noteCommitError\s*\?\s*\{\s*noteCommitError/);
    expect(EXEC_SRC).toMatch(/const noteCommitError = noteCommit && noteCommit\.ok !== true \? noteCommit : null/);
  });

  it("attempts no note commit when advanceExecEndPhase returns phaseError (AC6)", async () => {
    dir = makeRepo();
    const phaseError = await advanceExecEndPhase(dir, PROBLEM, async () => ({ ok: false, error: "Invalid transition" }));
    expect(phaseError).not.toBeNull();
    const g = fakeGit();
    const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, shouldCommit: true, commitResult: { ok: true }, phaseError, git: g.run });
    expect(out).toBeNull();
    expect(g.calls).toHaveLength(0);
    // phaseError is still spread onto the exec result.
    expect(EXEC_SRC).toMatch(/\.\.\.\(phaseError\s*\?\s*\{\s*phaseError/);
  });

  it("attempts no note commit when shouldCommit is false (AC6)", async () => {
    dir = makeRepo();
    await advanceExecEndPhase(dir, PROBLEM);
    const leftByAdvance = readNote(dir);
    const g = fakeGit();
    const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, shouldCommit: false, commitResult: null, phaseError: null, git: g.run });
    expect(out).toBeNull();
    expect(noteCalls(g.calls)).toHaveLength(0);
    expect(g.calls).toHaveLength(0);
    expect(readNote(dir)).toBe(leftByAdvance);
    // With the real runner too: nothing committed.
    const head = gitOk(dir, ["rev-parse", "HEAD"]);
    await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, shouldCommit: false, commitResult: null, phaseError: null });
    expect(gitOk(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(porcelainFor(dir, NOTE)).not.toBe("");
  });

  it("attempts no note commit when exec's own code commit failed (AC6)", async () => {
    dir = makeRepo();
    await advanceExecEndPhase(dir, PROBLEM);
    for (const commitResult of [{ ok: false, error: "No changes to commit" }, null]) {
      const g = fakeGit();
      const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, shouldCommit: true, commitResult, phaseError: null, git: g.run });
      expect(out).toBeNull();
      expect(noteCalls(g.calls)).toHaveLength(0);
      expect(g.calls).toHaveLength(0);
    }
  });

  it("positive control: with the gate open the note commit IS attempted and lands (AC6)", async () => {
    dir = makeRepo();
    await advanceExecEndPhase(dir, PROBLEM);
    const g = fakeGit({ diff: { status: 1, stdout: "", stderr: "" } });
    await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN, git: g.run });
    expect(noteCalls(g.calls).map((a) => a[0])).toEqual(["add", "commit"]);

    const out = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN });
    expect(out.ok).toBe(true);
    expect(out.commitId).toMatch(/^[0-9a-f]{7}$/);
    expect(gitOk(dir, ["show", `HEAD:${NOTE}`])).toMatch(/phase: "?executed"?/);
  });
});

describe("story-ship: own dirty note never reaches localMerge's checkout", () => {
  /** Own note dirty at `executed` on top of a committed `executing`; staging's copy differs. */
  function repoWithDirtyOwnNote({ stage = false } = {}) {
    dir = makeRepo({ stagingPhase: "arch-approved" });
    fs.writeFileSync(path.join(dir, NOTE), noteBody("executed", 'updated: "2"\n'));
    if (stage) gitOk(dir, ["add", NOTE]);
    return dir;
  }

  it("refuses with failedStep story_note_uncommitted, never 'would be overwritten by checkout' (AC3)", async () => {
    repoWithDirtyOwnNote();
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("story_note_uncommitted");
    expect(result.notePath).toBe(NOTE);
    expect(JSON.stringify(result)).toContain(NOTE);
    expect(result.worktreeBranch).toBe(FEATURE);
    expect(result.baseBranch).toBe("staging");
    expect(String(result.error)).not.toContain("would be overwritten by checkout");
    expect(gitOk(dir, ["branch", "--show-current"])).toBe(FEATURE);
  });

  it("refuses the same way when the own note change is STAGED (AC3)", async () => {
    repoWithDirtyOwnNote({ stage: true });
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("story_note_uncommitted");
    expect(gitOk(dir, ["branch", "--show-current"])).toBe(FEATURE);
  });

  it("makes no git write when refusing: no commit, no stash, note content unchanged (AC3)", async () => {
    repoWithDirtyOwnNote();
    const headBefore = gitOk(dir, ["rev-parse", "HEAD"]);
    const stagingBefore = gitOk(dir, ["rev-parse", "staging"]);
    const noteBefore = readNote(dir);
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.failedStep).toBe("story_note_uncommitted");
    expect(gitOk(dir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(gitOk(dir, ["rev-parse", "staging"])).toBe(stagingBefore);
    expect(gitOk(dir, ["stash", "list"])).toBe("");
    expect(readNote(dir)).toBe(noteBefore);
    expect(readNote(dir)).toContain('phase: "executed"');
  });

  it("refuses before review and delivery (AC3)", async () => {
    repoWithDirtyOwnNote();
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.failedStep).toBe("story_note_uncommitted");
    expect(runReview).not.toHaveBeenCalled();
    expect(localMerge).not.toHaveBeenCalled();
    expect(deliverFeatureBranch).not.toHaveBeenCalled();
  });

  it("emits story_ship.failed and hints to commit, not to stash (AC3)", async () => {
    repoWithDirtyOwnNote();
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.failedStep).toBe("story_note_uncommitted");
    expect(result.hint).toMatch(/commit/i);
    expect(result.hint).not.toMatch(/stash/i);
    // The emit is asserted on the refusal block's source. Observing it at runtime means
    // importing '@routekit/telemetry' (the global stub), which makes this file a consumer
    // that tests/unit/telemetry-global-mock-triage.test.mjs requires a VERDICTS entry for.
    const start = SHIP_SRC.indexOf("const ownNoteDirty = findOwnStoryNoteUncommitted(");
    const end = SHIP_SRC.indexOf("return buildShipFailure(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const emit = SHIP_SRC.slice(start, end);
    expect(emit).toMatch(/collector\.emit\('story_ship\.failed'/);
    expect(emit).toContain("failedStep: 'story_note_uncommitted'");
    expect(emit).toContain("worktreeBranch: currentBranch");
  });

  it("does not refuse an UNTRACKED own note (AC3 negative control)", async () => {
    dir = makeRepo({ trackNote: false });
    fs.writeFileSync(path.join(dir, NOTE), noteBody("executed"));
    expect(porcelainFor(dir, NOTE)).toMatch(/^\?\?/);
    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.failedStep).not.toBe("story_note_uncommitted");
    expect(result.failedStep).not.toBe("preflight_dirty_tree");
    expect(runReview).toHaveBeenCalled(); // it got past the point where the refusal sits
  });

  it("places own-note handling after the currentBranch === working short-circuit and before Step 1.5 (placement)", () => {
    const shortCircuit = SHIP_SRC.indexOf("if (currentBranch === working) {");
    const review = SHIP_SRC.indexOf("// Step 1.5: Run code review (if enabled)");
    const refusal = SHIP_SRC.indexOf("failedStep: 'story_note_uncommitted'");
    expect(shortCircuit).toBeGreaterThan(-1);
    expect(review).toBeGreaterThan(shortCircuit);
    expect(refusal).toBeGreaterThan(shortCircuit);
    expect(refusal).toBeLessThan(review);
    const block = SHIP_SRC.slice(shortCircuit, review);
    expect(block).toContain("return buildShipFailure(");
    expect(block).toContain("story_note_uncommitted");
    expect(block).not.toMatch(/spawnSync\(\s*['"]git['"]\s*,\s*\[\s*['"](commit|add|stash)['"]/);
    expect(block).not.toMatch(/['"](commit|add|stash)['"]\s*,/);
  });

  it("handles a DIFFERENT story's dirty note exactly as today (AC4)", async () => {
    dir = makeRepo();
    // Own note clean and committed at executed; another story's tracked note dirty.
    fs.writeFileSync(path.join(dir, NOTE), noteBody("executed"));
    gitOk(dir, ["add", NOTE]);
    gitOk(dir, ["commit", "-q", "-m", "chore: executed"]);
    const otherDirty = '---\nid: "backlog.feat.other"\nphase: "ready"\n---\n';
    fs.writeFileSync(path.join(dir, OTHER_NOTE), otherDirty);
    reviewPolicyFixture = { enabled: false };

    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    if (result.ok === false) {
      expect(result.failedStep).not.toBe("preflight_dirty_tree");
      expect(result.failedStep).not.toBe("story_note_uncommitted");
    }
    expect(fs.readFileSync(path.join(dir, OTHER_NOTE), "utf8")).toBe(otherDirty);
    expect(gitOk(dir, ["stash", "list"])).toBe("");
    expect(git(dir, ["log", "--all", "--format=%H", "--", OTHER_NOTE]).stdout.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("after the exec-side note commit, merges when staging's copy of the note differs (AC5)", async () => {
    // staging: note A (arch-approved) is the merge base; feature: note B (executing) committed on top.
    dir = makeRepo({ stagingPhase: "arch-approved" });
    expect(gitOk(dir, ["show", `staging:${NOTE}`])).not.toBe(gitOk(dir, ["show", `${FEATURE}:${NOTE}`]));
    const phaseError = await advanceExecEndPhase(dir, PROBLEM);
    expect(phaseError).toBeNull();
    const noteCommit = await commitExecEndNote({ projectRoot: dir, problemId: PROBLEM, ...GATE_OPEN, phaseError });
    expect(noteCommit?.ok).toBe(true);
    const featureSha = gitOk(dir, ["rev-parse", "HEAD"]);

    const result = await runStoryShipTool({ projectId: "test-project", problemId: PROBLEM });
    expect(result.failedStep).not.toBe("local_merge");
    expect(result.failedStep).not.toBe("story_note_uncommitted");
    expect(String(result.error || "")).not.toContain("would be overwritten by checkout");
    expect(localMerge).toHaveBeenCalled();
    expect(git(dir, ["merge-base", "--is-ancestor", featureSha, "staging"]).status).toBe(0);
  });
});

afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});
