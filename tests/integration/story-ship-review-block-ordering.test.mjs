/**
 * backlog.fix.ship-honesty-remediation — R1, the fix-prover.
 *
 * THE DEFECT (introduced by backlog.fix.story-ship-false-success at 2a187304):
 * the fail-open mutation ran BEFORE the `verdict === 'block'` halt. The review
 * entry is pushed into `steps` BY REFERENCE, and the block halt hands that same
 * array to buildShipFailure — so a review that FAILED, under an explicit
 * fail-open policy, carrying a BLOCKING verdict, had its `ok` flipped to true
 * and the blocked ship reported a passing review step.
 *
 * These assertions read the entry out of the RETURNED `result.steps`. A
 * source-position check ("the halt appears before the mutation") would pass
 * while proving nothing about the recorded value — the ordering matters only
 * because of the by-reference push, and only the returned array shows it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let mockRoot = null;
let reviewResultFixture = null;
let reviewPolicyFixture = null;

vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(async () => ({
    record: { root: mockRoot, id: "test-project" },
    projectJson: { branches: { working: "staging", integration: "staging", production: "main" } },
  })),
  getBranchConfig: vi.fn(() => ({ working: "staging", integration: "staging", production: "main" })),
  getWorkflowConfig: vi.fn(() => ({ autoMergeIntegration: false })),
}));

vi.mock("../../packages/mcp-rks/src/server/git-tools.mjs", () => ({
  runGitPR: vi.fn().mockResolvedValue({ ok: true, url: "https://github.com/test/pr/1", number: 1 }),
  runStagingMerge: vi.fn().mockResolvedValue({ ok: true, commitId: "abc123" }),
  runCycleComplete: vi.fn().mockResolvedValue({ ok: true, branch: "staging" }),
  runPromote: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", () => ({
  assertNotOnProtectedBranch: vi.fn(),
}));

// NOTE: localMerge is called SYNCHRONOUSLY by runStoryShipTool (no await), so
// this must return the object directly. A mockResolvedValue here hands back a
// Promise and the caller reads `.ok` off it as undefined — the ship then dies
// at local_merge and never reaches the review block under test.
vi.mock("../../packages/mcp-rks/src/server/git/local-merge.mjs", () => ({
  localMerge: vi.fn(() => ({ ok: true, commitId: "merged1" })),
}));

// The review module is dynamically imported inside runStoryShipTool.
vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => reviewResultFixture),
  loadReviewPolicy: vi.fn(() => reviewPolicyFixture),
  redactReview: vi.fn((r) => r),
}));

import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-block-order-"));
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git init && git checkout -b rks/test-branch && git add -A && git commit -m 'init'", {
    cwd: dir,
    stdio: "ignore",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  return dir;
}

function reviewStepOf(result) {
  return (result.steps || []).find(s => s.step === "review");
}

describe("R1 — a BLOCKED review is recorded honestly even under fail-open", () => {
  beforeEach(() => {
    mockRoot = makeTempRepo();
    reviewPolicyFixture = { enabled: true, failOpen: true };
    // A review that FAILED (so the fail-open mutation is eligible) AND carries a
    // BLOCKING verdict. This is the exact intersection the defect lived in.
    reviewResultFixture = {
      ok: false,
      verdict: "block",
      summary: "blocking finding present",
      findings: [{ severity: "block", message: "no" }],
      cause: "llm_failed",
      error: "reviewer returned a blocking verdict",
    };
  });

  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    vi.clearAllMocks();
  });

  it("the ship fails, and the review entry in the RETURNED steps reads ok:false", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    expect(result.ok).toBe(false);

    const review = reviewStepOf(result);
    expect(review, "review step must be present in returned steps").toBeTruthy();

    // THE ASSERTION THIS STORY EXISTS FOR. Pre-fix this was `true`: the mutation
    // ran first and flipped the by-reference entry before the halt captured it.
    expect(review.ok).toBe(false);
  });

  it("the blocked review is not marked as a fail-open degradation", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    const review = reviewStepOf(result);
    // A blocked review is a genuine stop, not a tolerated degradation. Pre-fix
    // it was stamped with both markers on its way past.
    expect(review.degraded).toBeUndefined();
    expect(review.failOpen).toBeUndefined();
  });

  it("the halt still fires under fail-open — the opt-out does not bypass a blocking verdict", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("blocked");
    expect(result.worktreeBranch).toBeTruthy();
  });
});

describe("the fail-open opt-out still works for a NON-blocking failed review", () => {
  beforeEach(() => {
    mockRoot = makeTempRepo();
    reviewPolicyFixture = { enabled: true, failOpen: true };
    reviewResultFixture = {
      ok: false,
      verdict: "warn",
      summary: "reviewer degraded",
      findings: [],
      cause: "llm_failed",
      error: "model unavailable",
    };
  });

  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    vi.clearAllMocks();
  });

  it("marks the entry degraded and ok:true, so the documented opt-out is not broken", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    const review = reviewStepOf(result);
    expect(review).toBeTruthy();
    expect(review.ok).toBe(true);
    expect(review.degraded).toBe(true);
    expect(review.failOpen).toBe(true);
  });

  it("HONESTY RIDER — the reason the review failed survives the opt-out", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    const review = reviewStepOf(result);
    // Flipping ok while erasing why would trade one false success for another.
    expect(review.verdict).not.toBe("pass");
    expect(review.cause || review.error || review.reason).toBeTruthy();
  });
});
