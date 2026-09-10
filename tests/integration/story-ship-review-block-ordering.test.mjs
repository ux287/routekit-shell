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

// backlog.fix.ship-delivery-implemented-twice — AC 12 and AC 14 BEHAVIOURAL.
//
// PARTIAL mock, via the importOriginal spread. A wholesale factory is a defect here,
// not a style choice: branch-delivery.mjs has a SECOND consumer that decides which arm
// runs. story-ship.mjs:169 reads `isThreeBranchTopology(branchConfig)` to set
// `workingBranchIsLocal`. A factory omitting it throws at that line; one stubbing it
// 3-branch silently routes every test in this file down an arm where
// deliverFeatureBranch is never called — and the negative assertions below would then
// pass for free, witnessing nothing. Keeping the predicate REAL is what makes
// `working === integration` ("staging"/"staging" above) select the 2-branch arm.
// Precedent: tests/integration/git-tools.pr-body.test.mjs:18.
const deliverFeatureBranchSpy = vi.fn(() => ({
  ok: true,
  mode: "two_branch_local",
  target: "staging",
  steps: [
    { kind: "local_merge", ok: true, from: "rks/test-branch", to: "staging" },
    { kind: "delete_branch", ok: true, branch: "rks/test-branch" },
    { kind: "push_working", ok: true, branch: "staging", remote: "origin" },
  ],
}));
vi.mock("../../packages/mcp-rks/src/server/git/branch-delivery.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, deliverFeatureBranch: (...args) => deliverFeatureBranchSpy(...args) };
});

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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/**
 * A repo whose `staging` branch EXISTS ON A REMOTE.
 *
 * Required to reach the 2-branch delivery arm at all, and it is not a fixture
 * convenience — it is the non-topology disjunct AC 2 requires the implementation to
 * preserve. `workingBranchIsLocal` starts as `isThreeBranchTopology(branchConfig)`,
 * which is FALSE here (working === integration === "staging"), but story-ship.mjs then
 * promotes it to TRUE when `git ls-remote --heads origin <working>` returns nothing.
 * With no remote configured that promotion always fires, the ship takes the 3-branch
 * arm, and `deliverFeatureBranch` is never called — so a negative assertion about it
 * would pass for free while witnessing nothing.
 *
 * Kept SEPARATE from makeTempRepo() rather than folded into it: the other describes in
 * this file are written against the 3-branch arm, and silently moving them to the
 * 2-branch arm would change what they exercise.
 */
function makeTempRepoWithRemote() {
  const dir = makeTempRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-block-order-remote-"));
  execSync("git init --bare", { cwd: bare, stdio: "ignore", timeout: 30_000 });
  execSync(`git remote add origin ${bare}`, { cwd: dir, stdio: "ignore", timeout: 30_000 });
  execSync("git branch staging && git push -q origin staging", {
    cwd: dir, stdio: "ignore", timeout: 30_000, env: GIT_ENV,
  });
  return { dir, bare };
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

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.ship-delivery-implemented-twice
//
// AC 12  — each rail's delivery target PINNED AS AN OBSERVED VALUE.
// AC 14  — BEHAVIOURAL: the review gate runs BEFORE delivery.
//
// WHY THE CALL-SITE ARGUMENT AND NOT A STEP PAYLOAD (DECISION 1a). Both rails pass
// `target` explicitly and then rebuild their step payloads from the SAME caller-scope
// variable — on-rail `working` at story-ship.mjs, off-rail `gitState.branch`. So a
// retarget of the argument alone leaves every payload unchanged, and an assertion on
// `steps[].to` / `steps[].branch` is an intent echo: it re-reads the caller's own
// variable and can never detect the retarget it claims to guard. The spy observes the
// argument the delivery ACTUALLY received.
//
// The negatives below are only as strong as the guarantee that the arm is traversed at
// all, so the POSITIVE CONTROL runs first: on a PASS verdict, delivery IS reached.
// Without it, "not called" would be satisfied by a ship that died anywhere earlier.
// ─────────────────────────────────────────────────────────────────────────────
describe("delivery target + gate ordering (AC 12, AC 14 BEHAVIOURAL)", () => {
  let bareRemote = null;

  beforeEach(() => {
    const made = makeTempRepoWithRemote();
    mockRoot = made.dir;
    bareRemote = made.bare;
    deliverFeatureBranchSpy.mockClear();
  });

  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(bareRemote, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    bareRemote = null;
    vi.clearAllMocks();
  });

  it("POSITIVE CONTROL: a PASS verdict reaches delivery", async () => {
    reviewPolicyFixture = { enabled: true, failOpen: false };
    reviewResultFixture = { ok: true, verdict: "pass", summary: "clean", findings: [] };

    await runStoryShipTool({ projectId: "test-project", problemId: "backlog.feat.test" });

    expect(deliverFeatureBranchSpy).toHaveBeenCalled();
  });

  it("AC 12: the on-rail delivery target is the CALLER-SUPPLIED working branch", async () => {
    reviewPolicyFixture = { enabled: true, failOpen: false };
    reviewResultFixture = { ok: true, verdict: "pass", summary: "clean", findings: [] };

    await runStoryShipTool({ projectId: "test-project", problemId: "backlog.feat.test" });

    expect(deliverFeatureBranchSpy).toHaveBeenCalledTimes(1);
    const arg = deliverFeatureBranchSpy.mock.calls[0][0];

    // The argument the delivery received — not a payload the caller rebuilt afterwards.
    expect(arg.target).toBe("staging");
    expect(arg.featureBranch).toBe("rks/test-branch");
    // And it is genuinely supplied, not defaulted inside the module: the module reads no
    // branchConfig.working of its own, so an omitted target would be undefined here.
    expect(arg.target).not.toBeUndefined();
  });

  it("AC 14 BEHAVIOURAL: a BLOCKED review leaves delivery UNCALLED", async () => {
    reviewPolicyFixture = { enabled: true, failOpen: false };
    reviewResultFixture = {
      ok: true,
      verdict: "block",
      summary: "blocking finding present",
      findings: [{ severity: "block", message: "no" }],
    };

    const result = await runStoryShipTool({ projectId: "test-project", problemId: "backlog.feat.test" });

    expect(result.ok).toBe(false);
    // THE ASSERTION FINDING C EXISTS FOR. With the gate below delivery, the work is
    // already merged and pushed by the time the halt fires — and worse, the gate cannot
    // even reach a block verdict, because local-merge checks out the target and leaves
    // `git diff <target>...HEAD` empty, which review.mjs short-circuits to a PASS.
    expect(deliverFeatureBranchSpy).not.toHaveBeenCalled();
  });

  it("AC 14 BEHAVIOURAL: an UNAVAILABLE reviewer also leaves delivery UNCALLED", async () => {
    // Fail-closed is the other route to the halt, and it must gate delivery too.
    reviewPolicyFixture = { enabled: true, failOpen: false };
    reviewResultFixture = {
      ok: false,
      verdict: "unavailable",
      reviewerUnavailable: true,
      cause: "not_configured",
      error: "reviewer not configured",
    };

    const result = await runStoryShipTool({ projectId: "test-project", problemId: "backlog.feat.test" });

    expect(result.ok).toBe(false);
    expect(deliverFeatureBranchSpy).not.toHaveBeenCalled();
  });
});
