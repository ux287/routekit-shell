// backlog.feat.exec-plan-commit-linkage — AC6 and AC7. Harness pattern follows
// tests/integration/story-ship-telemetry-events.test.mjs (temp repo + runStoryShipTool + telemetry stub),
// but delivery is the REAL localMerge so the SHA is observed on a real delivery target.
// Every git subprocess in this file passes an explicit timeout.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTelemetryStorage } from "@routekit/telemetry";

let mockRoot = null;
let localMergeOverride = null;

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

// The REAL localMerge by default; one case replaces it to model an unobservable delivery target.
vi.mock("../../packages/mcp-rks/src/server/git/local-merge.mjs", async (orig) => {
  const actual = await orig();
  return { localMerge: (...a) => (localMergeOverride ? localMergeOverride(...a) : actual.localMerge(...a)) };
});

vi.mock("../../packages/mcp-rks/src/server/review.mjs", () => ({
  runReview: vi.fn(async () => ({ ok: true, verdict: "pass", findings: [] })),
  loadReviewPolicy: vi.fn(() => ({ enabled: false })),
  redactReview: vi.fn((r) => r),
}));

import { runStoryShipTool } from "../../packages/mcp-rks/src/server/story-ship.mjs";
import { parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const STORY_ID = "backlog.feat.test";
const ARCHIVED_ID = "backlog.z_implemented.feat.test";
const TIMEOUT = 15_000;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT }).trim();

/** staging (with the story note at executed) + rks/test-branch carrying one exec-shaped commit. */
function makeRepo({ createStaging = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-ship-commit-sha-"));
  git(dir, ["init", "-q", "-b", createStaging ? "staging" : "trunk"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  fs.writeFileSync(path.join(dir, "notes", `${STORY_ID}.md`), `---\nid: "${STORY_ID}"\nphase: "executed"\n---\n\nbody\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "rks/test-branch"]);
  fs.writeFileSync(path.join(dir, "work.mjs"), "export const x = 1;\n");
  git(dir, ["add", "work.mjs"]);
  git(dir, ["commit", "-q", "-m", `feat(exec): ${STORY_ID}`, "-m", `Story: ${STORY_ID}`]);
  return dir;
}

function eventsFor(type) {
  const calls = ensureTelemetryStorage(mockRoot).emit?.mock?.calls || [];
  return calls.filter(([t]) => t === type).map(([, , payload]) => payload || {}).filter((p) => p.storyId === STORY_ID);
}

const archivedFrontmatter = () =>
  parseFrontmatter(fs.readFileSync(path.join(mockRoot, "notes", `${ARCHIVED_ID}.md`), "utf8")).data;

describe("story_ship.success commitSha/commitBranch (AC6) and the mark-step frontmatter (AC7)", { timeout: 60_000 }, () => {
  beforeEach(() => {
    localMergeOverride = null;
    ensureTelemetryStorage("x").emit?.mockClear?.();
  });
  afterEach(() => {
    try { fs.rmSync(mockRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    mockRoot = null;
    localMergeOverride = null;
    vi.clearAllMocks();
  });

  it("commitSha equals git rev-parse of the delivery target branch after delivery; commitBranch names that branch", async () => {
    mockRoot = makeRepo();
    const featureTip = git(mockRoot, ["rev-parse", "rks/test-branch"]);

    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);

    const success = eventsFor("story_ship.success");
    expect(success).toHaveLength(1);
    const [ev] = success;
    // Delivery fast-forwarded staging to the feature tip; the mark commit then sits on top of it.
    expect(ev.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ev.commitSha).toBe(featureTip);
    expect(git(mockRoot, ["rev-parse", "staging~1"])).toBe(ev.commitSha);
    expect(ev.commitBranch).toBe("staging");
    // The emit keeps its existing fields alongside the new ones.
    expect(ev).toHaveProperty("durationMs");
    expect(ev.workingBranch).toBe("staging");
  });

  it("the mark commit writes commitId and commitBranch equal to story_ship.success commitSha/commitBranch, in the same chore: mark ... as implemented commit", async () => {
    mockRoot = makeRepo();
    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    const [ev] = eventsFor("story_ship.success");

    const fm = archivedFrontmatter();
    expect(fm.commitId).toBe(ev.commitSha);
    expect(fm.commitBranch).toBe(ev.commitBranch);

    // Same commit: HEAD on staging is the mark commit, and its tree already holds both fields.
    expect(git(mockRoot, ["log", "-1", "--format=%s", "staging"])).toBe(`chore: mark ${STORY_ID} as implemented`);
    const committed = git(mockRoot, ["show", `staging:notes/${ARCHIVED_ID}.md`]);
    expect(committed).toContain(ev.commitSha);
    expect(committed).toMatch(/commitBranch:\s*"?staging"?/);
    const touched = git(mockRoot, ["show", "--name-only", "--format=", "staging"]).split("\n").filter(Boolean);
    expect(touched).toContain(`notes/${ARCHIVED_ID}.md`);
  });

  it("commitSha is null when not observed (the delivery target cannot be resolved), and no commitId is written", async () => {
    // No staging branch exists, and the delivery step is replaced by one that reports ok
    // without creating it: the post-delivery rev-parse has nothing to observe.
    mockRoot = makeRepo({ createStaging: false });
    localMergeOverride = () => ({ ok: true });

    const result = await runStoryShipTool({ projectId: "test-project", problemId: STORY_ID });
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    const success = eventsFor("story_ship.success");
    expect(success).toHaveLength(1);
    expect(success[0].commitSha).toBeNull();
    expect(success[0].commitBranch).toBeNull();
    const fm = archivedFrontmatter();
    expect(fm).not.toHaveProperty("commitId");
    expect(fm).not.toHaveProperty("commitBranch");
    // Positive control on the observation: the branch genuinely does not resolve.
    expect(() => git(mockRoot, ["rev-parse", "--verify", "refs/heads/staging"])).toThrow();
  });
});
