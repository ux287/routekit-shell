/**
 * Tests for story-ship.mjs — dirty-tree preflight check.
 *
 * Covers testRequirements from backlog.fix.dirty-tree-comprehensive:
 *   - runStoryShip() rejects a dirty working tree before the first git checkout
 *   - runStoryShip() preflight allows notes/ files to be dirty
 *   - runStoryShip() preflight uses getUncommittedFiles from utils/git.mjs
 *   - runStoryShip() preflight failure hints at commit/stash + notes/ auto-exclusion
 *   - runStoryShip() preflight passes on a clean tree
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const storyShipSrc = fs.readFileSync(
  path.resolve("packages/mcp-rks/src/server/story-ship.mjs"),
  "utf8"
);

// ── Source-level assertions ──────────────────────────────────────────────
// These guard the structural requirements that are hard to exercise from
// a functional test (import path, call-order, helper identity).

describe("story-ship.mjs — preflight source-level structure", () => {
  it("imports getUncommittedFiles from utils/git.mjs (not inline git status)", () => {
    // The import MUST reference utils/git.mjs — inline spawnSync('git','status')
    // for the preflight would violate the requirement.
    expect(storyShipSrc).toMatch(
      /import\s*\{[^}]*getUncommittedFiles[^}]*\}\s*from\s*['"]\.\.\/utils\/git\.mjs['"]/
    );
  });

  it("preflight call uses getUncommittedFiles and filters notes/ paths", () => {
    // The preflight block uses the helper AND applies a notes/ exclusion
    // consistent with exec.mjs semantics.
    expect(storyShipSrc).toMatch(/getUncommittedFiles\s*\(/);
    expect(storyShipSrc).toMatch(/\.startsWith\(['"]notes\/['"]\)/);
  });

  it("preflight runs BEFORE any branch-manipulating operation", () => {
    // backlog.fix.ship-delivery-implemented-twice.
    //
    // This used to look for the raw literals 'checkout' / 'merge' / 'push' occurring
    // after the preflight marker. Those literals are GONE from this file: branch
    // manipulation moved wholesale into git/branch-delivery.mjs, and the 3-branch arm
    // reaches it through localMerge. Searching for them now finds nothing and the
    // assertion reddens on a file that satisfies the requirement MORE strongly than
    // before — it no longer performs a raw git branch operation at all.
    //
    // Restated against the operations that actually follow the preflight.
    const preflightIdx = storyShipSrc.indexOf("preflight_dirty_tree");
    expect(preflightIdx).toBeGreaterThan(-1);

    // Anchors chosen for uniqueness: bare `deliverFeatureBranch` also matches its
    // import, which sits above the preflight, so an indexOf on it would resolve to the
    // wrong occurrence and invert this assertion.
    const localMergeIdx = storyShipSrc.indexOf("localMerge(projectRoot");
    const deliverIdx = storyShipSrc.indexOf("deliverFeatureBranch({");
    expect(localMergeIdx).toBeGreaterThan(preflightIdx);
    expect(deliverIdx).toBeGreaterThan(preflightIdx);

    // And this file performs no raw branch manipulation of its own any more.
    expect(storyShipSrc).not.toMatch(/spawnSync\('git',\s*\[\s*'checkout'/);
    expect(storyShipSrc).not.toMatch(/spawnSync\('git',\s*\[\s*'merge'/);
    expect(storyShipSrc).not.toMatch(/spawnSync\('git',\s*\[\s*'push'/);
  });

  // Anchor-to-anchor slice, NOT a fixed-size window. The preflight exit now
  // returns via the shared buildShipFailure helper, so `ok: false` no longer
  // sits within a fixed character budget of the marker. Bounding the block by
  // the next structural landmark instead keeps these assertions true regardless
  // of how the exit's payload is assembled.
  function preflightBlock() {
    const start = storyShipSrc.indexOf("preflight_dirty_tree");
    const end = storyShipSrc.indexOf("already_on_working_branch");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return storyShipSrc.slice(start, end);
  }

  it("preflight failure hint mentions commit/stash and notes/ auto-exclusion", () => {
    const context = preflightBlock();
    expect(context).toMatch(/commit|stash/i);
    expect(context).toMatch(/notes\//);
  });

  it("preflight returns a structured failure with dirtyFiles array", () => {
    const context = preflightBlock();
    expect(context).toMatch(/dirtyFiles/);
    // The exit routes through the shared failure-payload helper rather than
    // building its return inline — that is what stamps ok:false and the branch
    // fields. Assert the routing here; the helper's own contract is covered in
    // tests/unit/ship-failure-branch-state.test.mjs.
    expect(context).toMatch(/return\s+buildShipFailure\(/);
    expect(context).not.toMatch(/return\s*\{/);
  });
});

// ── Functional tests ─────────────────────────────────────────────────────
// Invoke runStoryShipTool against a temp git repo with a mocked project
// context. We mock the dependencies that reach out to a real GitHub/registry.

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-preflight-"));
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  // backlog.fix.ship-delivery-implemented-twice, AC 14 FIXTURE.
  //
  // The fixture used to create ONE branch. That made it unable to witness anything about
  // the review gate: `working` is mocked to "staging", which did not exist here, so
  // `git diff staging...HEAD` exited 128 with empty stdout, review.mjs read that as an
  // empty diff, and short-circuited to a PASS without calling the reviewer — WHEREVER the
  // gate sat. A witness that always short-circuits cannot tell a correct implementation
  // from the defect.
  //
  // So: create `staging` at the initial commit, then put a further commit on the feature
  // branch. `staging...HEAD` is now a real, non-empty diff.
  execSync("git init && git checkout -b staging && git add -A && git commit -m 'init'", {
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
  fs.writeFileSync(path.join(dir, "feature.md"), "# feature work\n");
  execSync("git checkout -b rks/test-branch && git add -A && git commit -m 'feature'", {
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

function gitIn(dir, args) {
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf8", timeout: 30_000 }).trim();
}

function cleanupRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDENTIAL NEUTRALIZATION — FILE-WIDE, deliberately at module scope.
//
// It must NOT be describe-scoped. `makeTempRepo` is used by every functional
// describe in this file, and the fixture now produces a REAL `staging...HEAD` diff.
// A describe-scoped neutralization therefore leaves every OTHER describe running the
// review gate with a live key: review.mjs gets a non-empty diff, calls the reviewer,
// and no integration tier sets `testTimeout` — an unbounded live billable roundtrip
// for anyone holding ANTHROPIC_API_KEY. Scoping this to one describe relocates that
// hazard rather than removing it.
//
// Only ANTHROPIC_API_KEY is load-bearing: review.mjs returns `not_configured` before
// any network call when it is absent, and the provider is hardcoded after that guard,
// so OPENAI_API_KEY / ROUTEKIT_LLM_PROVIDER cannot re-enable the reviewer.
//
// The `undefined` branch is NOT optional — idiom from
// tests/unit/agents.external-research-egress.test.mjs:54-55. On a keyless runner an
// unconditional restore assigns the STRING "undefined", which is truthy where the key
// is read, re-creating the hazard this exists to remove.
// ─────────────────────────────────────────────────────────────────────────────
let savedAnthropicKey;

beforeAll(() => {
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
});

// Mock project context + heavy dependencies so runStoryShipTool can execute
// far enough to hit (or clear) the preflight without needing GitHub.
let mockRoot = null;
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

import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";

describe("runStoryShipTool — dirty-tree preflight (functional)", () => {
  beforeEach(() => {
    mockRoot = makeTempRepo();
  });

  afterEach(() => {
    if (mockRoot) cleanupRepo(mockRoot);
    mockRoot = null;
  });

  it("rejects a dirty working tree before any git checkout", async () => {
    // Make the tree dirty with a non-notes, non-.rks file
    fs.writeFileSync(path.join(mockRoot, "src.js"), "dirty\n");

    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("preflight_dirty_tree");
    expect(Array.isArray(result.dirtyFiles)).toBe(true);
    expect(result.dirtyFiles.some(f => f.includes("src.js"))).toBe(true);

    // Verify: we're still on the feature branch — no checkout happened
    const branch = execSync("git branch --show-current", {
      cwd: mockRoot,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    expect(branch).toBe("rks/test-branch");

    // …and the return SAYS so, rather than leaving the caller to discover it.
    expect(result.worktreeBranch).toBe("rks/test-branch");
    expect(result.baseBranch).toBeTruthy();
    expect(result.branchRestored).toBe(false);
  });

  it("allows dirty notes/ files (consistent with exec.mjs exclusion)", async () => {
    fs.writeFileSync(path.join(mockRoot, "notes", "backlog.feat.test.md"), "dirty note\n");

    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    // The preflight itself passes (notes/ is excluded). Downstream steps may
    // still fail because there's no gh/remote — what matters is that the
    // failure is NOT preflight_dirty_tree.
    if (result.ok === false) {
      expect(result.failedStep).not.toBe("preflight_dirty_tree");
    }
  });

  it("provides a remediation hint mentioning commit/stash and notes/ auto-exclusion", async () => {
    fs.writeFileSync(path.join(mockRoot, "src.js"), "dirty\n");

    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    expect(result.ok).toBe(false);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toMatch(/commit|stash/i);
    expect(result.hint).toMatch(/notes\//);
  });

  it("preflight passes on a clean tree (does not block normal flow)", async () => {
    // Tree is clean from the init commit; no dirty files.
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    // Whatever happens next, the failure (if any) is NOT the preflight.
    if (result.ok === false) {
      expect(result.failedStep).not.toBe("preflight_dirty_tree");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backlog.fix.ship-delivery-implemented-twice — AC 14 SUBJECT
//
// The on-rail code review gate must run BEFORE delivery. Below it, the gate is not
// merely late — it is ELIMINATED: local-merge.mjs checks out the target and never
// checks back, so `git diff <target>...HEAD` has HEAD as its own merge-base, the diff
// is empty, and review.mjs short-circuits an empty diff to a PASS without ever calling
// the reviewer. Both halts become unreachable and the step reports a pass sourced from
// our own git checkout — R1 of design.evidence-bound-reporting-invariant.md.
//
// CREDENTIAL NEUTRALIZATION, file-wide. The fixture now produces a REAL diff, so with a
// key present the gate would make a live billable LLM roundtrip — and no integration
// tier sets `testTimeout`, so that is an unbounded hang for anyone holding
// ANTHROPIC_API_KEY. Only that one variable is load-bearing: review.mjs returns
// `not_configured` before any network call when it is absent, and the provider is
// hardcoded after that guard, so OPENAI_API_KEY / ROUTEKIT_LLM_PROVIDER cannot
// re-enable the reviewer.
//
// The `undefined` branch is NOT optional — idiom copied from
// tests/unit/agents.external-research-egress.test.mjs:54-55. On a keyless runner an
// unconditional restore assigns the STRING "undefined", which is truthy where the key is
// read, re-creating the very hazard this removes.
// ─────────────────────────────────────────────────────────────────────────────
describe("runStoryShipTool — the review gate runs BEFORE delivery (AC 14)", () => {
  // NOTE: the credential neutralization for this file is at MODULE scope, above — see
  // the banner there for why describe-scoping it is a defect, not a style choice.
  beforeEach(() => {
    mockRoot = makeTempRepo();
  });

  afterEach(() => {
    cleanupRepo(mockRoot);
    mockRoot = null;
  });

  it("SUBJECT: the reviewer is actually consulted — not short-circuited on an empty diff", async () => {
    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    const review = result.steps.find((s) => s.step === "review");
    expect(review).toBeDefined();

    // PINNED TO ONE CAUSE, deliberately. `call_failed` would also mean the reviewer ran,
    // but it is reachable with a key present and a network failure — so accepting it
    // would let a silently-failed neutralization pass. `not_configured` is producible
    // ONLY by the no-key guard, above the call-out. Fails closed.
    expect(review.reviewerUnavailable).toBe(true);
    expect(review.cause).toBe("not_configured");

    // The short-circuit sentinel must NOT be what we got. If the gate had run below
    // delivery, this is exactly what the step would carry instead.
    expect(review.summary).not.toBe("No changes to review");
  });

  it("SUBJECT: a halted review leaves the work UNLANDED", async () => {
    const before = gitIn(mockRoot, "rev-parse staging");

    const result = await runStoryShipTool({
      projectId: "test-project",
      problemId: "backlog.feat.test",
    });

    expect(result.ok).toBe(false);

    // The behavioural half: nothing landed. Had delivery run first, `staging` would
    // carry the feature commit and HEAD would have been left on `staging` by
    // local-merge.mjs's checkout.
    expect(gitIn(mockRoot, "rev-parse staging")).toBe(before);
    expect(gitIn(mockRoot, "branch --show-current")).toBe("rks/test-branch");
    expect(result.steps.some((s) => s.step === "local_merge" && s.ok)).toBe(false);
    expect(result.steps.some((s) => s.step === "push_working")).toBe(false);
  });
});
