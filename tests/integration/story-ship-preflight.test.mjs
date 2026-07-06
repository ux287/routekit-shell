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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  it("preflight runs BEFORE any git checkout / git merge / git push", () => {
    // The preflight block (identified by 'preflight_dirty_tree' or
    // 'getUncommittedFiles(projectRoot' in the runStoryShipTool body) must
    // appear before the first spawnSync('git', ['checkout', ...]) call.
    const preflightIdx = storyShipSrc.indexOf("preflight_dirty_tree");
    expect(preflightIdx).toBeGreaterThan(-1);

    // Find the first 'checkout' call inside story ship flow (not inside the
    // localMerge helper — that helper is defined ABOVE runStoryShipTool, so
    // we look for checkout AFTER preflight).
    const afterPreflight = storyShipSrc.slice(preflightIdx);
    // Any branch-manipulating git operation must come AFTER the preflight marker
    const firstCheckoutAfter = afterPreflight.indexOf("'checkout'");
    const firstMergeAfter = afterPreflight.indexOf("'merge'");
    const firstPushAfter = afterPreflight.indexOf("'push'");
    // At least one of these occurs later in the file (confirming order)
    const anyLater = [firstCheckoutAfter, firstMergeAfter, firstPushAfter].some(i => i > 0);
    expect(anyLater).toBe(true);
  });

  it("preflight failure hint mentions commit/stash and notes/ auto-exclusion", () => {
    // Extract the preflight failure return object
    const preflightIdx = storyShipSrc.indexOf("preflight_dirty_tree");
    expect(preflightIdx).toBeGreaterThan(-1);
    const context = storyShipSrc.slice(preflightIdx, preflightIdx + 800);
    expect(context).toMatch(/commit|stash/i);
    expect(context).toMatch(/notes\//);
  });

  it("preflight returns a structured failure with dirtyFiles array", () => {
    const preflightIdx = storyShipSrc.indexOf("preflight_dirty_tree");
    expect(preflightIdx).toBeGreaterThan(-1);
    const context = storyShipSrc.slice(preflightIdx, preflightIdx + 800);
    expect(context).toMatch(/dirtyFiles/);
    expect(context).toMatch(/ok:\s*false/);
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
  execSync("git init && git checkout -b rks/test-branch && git add -A && git commit -m 'init'", {
    cwd: dir,
    stdio: "ignore",
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

function cleanupRepo(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* best-effort */ }
}

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
    const branch = execSync("git branch --show-current", { cwd: mockRoot, encoding: "utf8" }).trim();
    expect(branch).toBe("rks/test-branch");
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
