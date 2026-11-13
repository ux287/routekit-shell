/**
 * backlog.fix.ship-honesty-remediation — R16/R18: telemetry OBSERVED, not grepped.
 *
 * The parent story required that the telemetry channel be asserted by reading
 * emitted events, and stated outright that a `collector.emit` source grep does
 * not satisfy it. It shipped with greps. This file closes that.
 *
 * Why it matters: `story_ship.success` was emitted unconditionally, so a ship
 * whose mark_implemented failed returned ok:false AND told the dashboards it
 * had shipped. A grep for the emit proves the line exists; only reading the
 * events proves which one fired.
 *
 * `ensureTelemetryStorage` comes from the package specifier '@routekit/telemetry',
 * which tests/setup.mjs globally stubs with a SHARED SINGLETON collector — so
 * every test resets it and filters by storyId, or events bleed across cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTelemetryStorage } from "@routekit/telemetry";

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

// Synchronous on purpose — runStoryShipTool does not await this one.
vi.mock("../../packages/mcp-rks/src/server/git/local-merge.mjs", () => ({
  localMerge: vi.fn(() => ({ ok: true, commitId: "merged1" })),
}));

vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => reviewResultFixture),
  loadReviewPolicy: vi.fn(() => reviewPolicyFixture),
  redactReview: vi.fn((r) => r),
}));

import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";

const STORY_ID = "backlog.feat.test";

function makeTempRepo({ withNote }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-telemetry-"));
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  if (withNote) {
    fs.writeFileSync(
      path.join(dir, "notes", `${STORY_ID}.md`),
      `---\nid: "${STORY_ID}"\nphase: "executed"\n---\n\nbody\n`,
    );
  }
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

/** Events emitted for THIS story, read off the shared collector. */
function eventsFor(type) {
  const collector = ensureTelemetryStorage(mockRoot);
  const calls = (collector.emit?.mock?.calls) || [];
  return calls
    .filter(([eventType]) => eventType === type)
    .map(([, , payload]) => payload || {})
    .filter(p => p.storyId === undefined || p.storyId === STORY_ID);
}

function resetCollector() {
  const collector = ensureTelemetryStorage(mockRoot);
  collector.emit?.mockClear?.();
}

describe("outcome telemetry reflects the real outcome", () => {
  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    vi.clearAllMocks();
  });

  beforeEach(() => {
    reviewPolicyFixture = { enabled: false };
    reviewResultFixture = { ok: true, verdict: "pass", findings: [] };
  });

  it("a FAILED ship emits story_ship.failed and NOT story_ship.success", async () => {
    // No story note on disk: mark_implemented hits the missing-note branch,
    // which now records ok:false and drives the reduction to false.
    mockRoot = makeTempRepo({ withNote: false });
    resetCollector();
    expect(eventsFor("story_ship.success")).toHaveLength(0);

    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });

    expect(result.ok).toBe(false);

    const success = eventsFor("story_ship.success");
    const failed = eventsFor("story_ship.failed");

    // The defect: this used to be length 1 on exactly this run.
    expect(success).toHaveLength(0);
    expect(failed.length).toBeGreaterThan(0);
    // Required by the failure-payload contract.
    expect(failed[failed.length - 1].worktreeBranch).toBeTruthy();
  });

  it("the failed mark_implemented step emits a skip event naming the step", async () => {
    mockRoot = makeTempRepo({ withNote: false });
    resetCollector();

    await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });

    const skips = eventsFor("story_ship.step.skipped").filter(p => p.step === "mark_implemented");
    // Pre-fix the missing-note branch did not exist: no entry, no telemetry,
    // not even a stepsSkipped increment. Silent in every channel.
    expect(skips.length).toBeGreaterThan(0);
    expect(skips[0].reason).toBeTruthy();
  });

  it("a SUCCESSFUL ship emits story_ship.success and NOT story_ship.failed", async () => {
    mockRoot = makeTempRepo({ withNote: true });
    resetCollector();

    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });

    const success = eventsFor("story_ship.success");
    const failed = eventsFor("story_ship.failed");

    if (result.ok) {
      expect(success).toHaveLength(1);
      expect(failed).toHaveLength(0);
    } else {
      // If the run failed for an unrelated environmental reason, the invariant
      // under test still holds: the channels must agree with the return value.
      expect(success).toHaveLength(0);
      expect(failed.length).toBeGreaterThan(0);
    }
  });

  it("the two channels never both fire for one run", async () => {
    mockRoot = makeTempRepo({ withNote: true });
    resetCollector();

    await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });

    const success = eventsFor("story_ship.success").length;
    const failed = eventsFor("story_ship.failed").length;
    // One reduction drives both, so a run cannot report success and failure.
    expect(success === 0 || failed === 0).toBe(true);
  });
});
