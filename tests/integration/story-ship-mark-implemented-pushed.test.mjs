/**
 * backlog.fix.story-ship-mark-implemented-commit-stranded-after-push
 * Drives the REAL runStoryShipTool and the REAL runCycleComplete against a temp repo with a bare
 * origin (2-branch config, working = integration = staging). The mark_implemented bookkeeping
 * commit must reach origin before cycle_complete, so cycle_complete no longer refuses on it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const STORY_ID = "backlog.feat.test";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" };
let mockRoot;

vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  loadContext: vi.fn(async () => ({
    record: { root: mockRoot, id: "test-project" },
    projectJson: { branches: { working: "staging", integration: "staging", production: "main" } },
  })),
  getBranchConfig: vi.fn(() => ({ working: "staging", integration: "staging", production: "main" })),
  getWorkflowConfig: vi.fn(() => ({ autoMergeIntegration: false })),
}));
vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", () => ({ assertNotOnProtectedBranch: vi.fn() }));
vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => ({ ok: true, verdict: "pass", findings: [] })),
  loadReviewPolicy: vi.fn(() => ({ enabled: false })),
  redactReview: vi.fn((r) => r),
}));

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Temp repo on rks/test-branch, staging pushed to a bare origin, executed story note committed. */
function makeRepoWithOrigin({ rejectMarkImplemented = false, rejectMarkCommit = false, noOrigin = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-markimpl-"));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-markimpl-origin-"));
  git(bare, ["init", "--bare", "-q", "-b", "staging"]);
  if (rejectMarkImplemented) {
    // pre-receive hook refusing any pushed commit whose subject is the mark_implemented commit
    const hook = path.join(bare, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do\n  if git log --format=%s \"$new\" -1 | grep -q 'as implemented'; then echo rejected >&2; exit 1; fi\ndone\n");
    fs.chmodSync(hook, 0o755);
  }
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  git(dir, ["init", "-q", "-b", "staging"]);
  // Repo-local identity: story-ship's own `git commit` inherits only the process env and the git
  // config, not GIT_ENV, so a runner with no global git user would fail the mark_implemented commit.
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  if (!noOrigin) {
    git(dir, ["remote", "add", "origin", bare]);
    git(dir, ["push", "-q", "origin", "staging"]);
  }
  git(dir, ["checkout", "-q", "-b", "rks/test-branch"]);
  fs.writeFileSync(path.join(dir, "notes", `${STORY_ID}.md`), `---\nid: "${STORY_ID}"\nphase: "executed"\n---\n\nbody\n`);
  fs.writeFileSync(path.join(dir, "feature.txt"), "feature\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: test feature"]);
  if (rejectMarkCommit) {
    // local commit-msg hook: the mark_implemented `git commit` exits non-zero
    const hook = path.join(dir, ".git", "hooks", "commit-msg");
    fs.writeFileSync(hook, "#!/bin/sh\nif grep -q 'as implemented' \"$1\"; then echo rejected >&2; exit 1; fi\nexit 0\n");
    fs.chmodSync(hook, 0o755);
  }
  return { dir, bare };
}

describe("rks_story_ship — mark_implemented commit reaches origin before cycle_complete", () => {
  let fixture;
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => {
    if (fixture) { fs.rmSync(fixture.dir, { recursive: true, force: true }); fs.rmSync(fixture.bare, { recursive: true, force: true }); }
    fixture = undefined;
  });

  it("happy path: cycle_complete ok, mark_implemented commit on origin/staging, nothing unpushed", async () => {
    fixture = makeRepoWithOrigin();
    mockRoot = fixture.dir;
    // the identity is repo-local, independent of the runner's global git config
    expect(git(fixture.dir, ["config", "--local", "user.email"])).toBe("test@test.com");
    expect(git(fixture.dir, ["config", "--local", "user.name"])).not.toBe("");
    const { runStoryShipTool } = await import("../../packages/mcp-rks/src/server/story-ship.mjs");
    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.steps.find((s) => s.step === "cycle_complete")?.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(git(fixture.bare, ["log", "--format=%s", "staging"])).toContain(`chore: mark ${STORY_ID} as implemented`);
    git(fixture.dir, ["fetch", "-q", "origin"]);
    expect(git(fixture.dir, ["rev-list", "--count", "origin/staging..staging"])).toBe("0");
  });

  it("a rejected bookkeeping push is its own ok:false step and the ship is not ok", async () => {
    fixture = makeRepoWithOrigin({ rejectMarkImplemented: true });
    mockRoot = fixture.dir;
    const { runStoryShipTool } = await import("../../packages/mcp-rks/src/server/story-ship.mjs");
    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.ok).toBe(false);
    const failed = result.steps.filter((s) => s.ok === false).map((s) => s.step);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed).toContain("push_bookkeeping");
    expect(result.steps.find((s) => s.step === "push_bookkeeping")?.error).toBeTruthy();
    // delivery-vs-bookkeeping: assert the NEW delivery wording, not /staging/ (already in the pre-existing text)
    expect(result.next).toContain("Delivery reached origin: staging was pushed to origin");
    expect(result.next).toContain("push_bookkeeping");
  });

  it("no push_bookkeeping step when the mark_implemented git commit exits non-zero", async () => {
    fixture = makeRepoWithOrigin({ rejectMarkCommit: true });
    mockRoot = fixture.dir;
    const { runStoryShipTool } = await import("../../packages/mcp-rks/src/server/story-ship.mjs");
    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.steps.some((s) => s.step === "push_bookkeeping")).toBe(false);
    expect(git(fixture.bare, ["log", "--format=%s", "staging"])).not.toContain("as implemented");
  });

  it("no origin remote (workingBranchIsLocal): no bookkeeping push attempted, no delivery claim", async () => {
    fixture = makeRepoWithOrigin({ noOrigin: true });
    mockRoot = fixture.dir;
    const { runStoryShipTool } = await import("../../packages/mcp-rks/src/server/story-ship.mjs");
    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.steps.some((s) => s.step === "push_bookkeeping")).toBe(false);
    expect(result.steps.some((s) => s.step === "push_working")).toBe(false);
    expect(result.next ?? "").not.toContain("Delivery reached origin");
  });
});
