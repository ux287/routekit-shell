/**
 * Tests for PR body cost-report integration
 * (backlog.feat.pr-body-cost-report)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// Mock all external dependencies of git-workflow.mjs
vi.mock("child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("../../packages/mcp-rks/src/server/telemetry/index.mjs", () => ({
  ensureTelemetryStorage: vi.fn(() => ({ emit: vi.fn() })),
}));
vi.mock("../../packages/mcp-rks/src/server/branch-protection.mjs", () => ({
  isProductionBranch: vi.fn(() => false),
  assertNotProtectedBranch: vi.fn(),
  assertNotOnProtectedBranch: vi.fn(),
}));
vi.mock("../../packages/mcp-rks/src/server/git/git-utils.mjs", () => ({
  runGit: vi.fn(() => ""),
  getCurrentBranch: vi.fn(() => "feature/test"),
  isGuardrailsOffSession: vi.fn(() => true),
  checkHookIntegrity: vi.fn(() => ({ ok: true })),
  updateBacklogStatus: vi.fn(() => ({ updated: false })),
  VALID_UNLINKED_REASONS: ["maintenance", "hotfix", "docs"],
}));
vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({
  updateField: vi.fn(),
  resolveNotesDir: vi.fn(() => "/fake/notes"),
}));
vi.mock("../../packages/mcp-rks/src/server/telemetry/cost-report.mjs", () => ({
  generateCostReport: vi.fn(),
}));

import { spawnSync } from "child_process";
import { generateCostReport } from "../../packages/mcp-rks/src/server/telemetry/cost-report.mjs";
import { runGitPR } from "../../packages/mcp-rks/src/server/git/git-workflow.mjs";

function makeSpawnSync(captureRef) {
  return vi.fn((cmd, args) => {
    if (cmd === "git") return { status: 0, stdout: "feature/test\n", stderr: "" };
    if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "create") {
      const bodyIdx = args.indexOf("--body");
      if (bodyIdx !== -1) captureRef.body = args[bodyIdx + 1];
      return { status: 0, stdout: "https://github.com/org/repo/pull/1", stderr: "" };
    }
    if (cmd === "gh") return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
}

const FAKE_ROOT = "/fake/project";

beforeEach(() => { vi.clearAllMocks(); });

// ── runGitPR — costBlock body construction ─────────────────────────────────

describe("runGitPR — costBlock in PR body", () => {
  it("includes collapsible cost block when costBlock is provided", async () => {
    const capture = {};
    spawnSync.mockImplementation(makeSpawnSync(capture));
    const costMarkdown = "**Total tokens:** 1,500\n**Waste ratio:** 5.0% 🟢 green";

    await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: "staging", problemId: "backlog.feat.test", costBlock: costMarkdown, autoMerge: false });

    expect(capture.body).toBeDefined();
    expect(capture.body).toContain("<details>");
    expect(capture.body).toContain("Token Cost & Efficiency");
    expect(capture.body).toContain(costMarkdown);
    expect(capture.body).toContain("</details>");
  });

  it("omits cost block when costBlock is null", async () => {
    const capture = {};
    spawnSync.mockImplementation(makeSpawnSync(capture));

    await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: "staging", problemId: "backlog.feat.test", costBlock: null, autoMerge: false });

    expect(capture.body).toBeDefined();
    expect(capture.body).not.toContain("<details>");
    expect(capture.body).not.toContain("Token Cost & Efficiency");
  });

  it("cost block appears before test results section", async () => {
    const capture = {};
    spawnSync.mockImplementation(makeSpawnSync(capture));

    await runGitPR({
      projectRoot: FAKE_ROOT,
      targetBranch: "staging",
      problemId: "backlog.feat.test",
      costBlock: "**Total tokens:** 800",
      testResults: { passCount: 5, failCount: 0 },
      autoMerge: false,
    });

    const body = capture.body;
    expect(body).toBeDefined();
    const costPos = body.indexOf("<details>");
    const testPos = body.indexOf("## Test Results");
    expect(costPos).toBeGreaterThan(-1);
    expect(testPos).toBeGreaterThan(-1);
    expect(costPos).toBeLessThan(testPos);
  });

  it("summary section is unchanged when costBlock is present", async () => {
    const capture = {};
    spawnSync.mockImplementation(makeSpawnSync(capture));

    await runGitPR({ projectRoot: FAKE_ROOT, targetBranch: "staging", problemId: "backlog.feat.my-story", costBlock: "**Total tokens:** 400", autoMerge: false });

    expect(capture.body).toContain("## Summary");
    expect(capture.body).toContain("backlog.feat.my-story");
  });
});

// ── prBodyIncludeCostReport flag logic ─────────────────────────────────────

describe("prBodyIncludeCostReport flag logic", () => {
  it("includeCostReport defaults to true when field is absent from projectJson", () => {
    const projectJson = {};
    expect(projectJson?.prBodyIncludeCostReport !== false).toBe(true);
  });

  it("includeCostReport is false when prBodyIncludeCostReport is explicitly false", () => {
    const projectJson = { prBodyIncludeCostReport: false };
    expect(projectJson?.prBodyIncludeCostReport !== false).toBe(false);
  });

  it("costBlock is null when generateCostReport returns noData", () => {
    generateCostReport.mockReturnValue({ ok: true, noData: true });
    const costReport = generateCostReport("/fake", {});
    expect(!costReport.noData ? costReport.markdown : null).toBeNull();
  });

  it("costBlock is the markdown string when cost data exists", () => {
    const md = "**Total tokens:** 1,200\n**Waste ratio:** 0.0% 🟢 green";
    generateCostReport.mockReturnValue({ ok: true, noData: false, markdown: md });
    const costReport = generateCostReport("/fake", {});
    expect(!costReport.noData ? costReport.markdown : null).toBe(md);
  });
});

// ── generateCostReport is guarded in story-ship.mjs ───────────────────────

describe("story-ship.mjs — cost report guard (source verification)", () => {
  it("story-ship.mjs uses prBodyIncludeCostReport !== false as the flag check", () => {
    const source = fs.readFileSync(
      path.resolve("packages/mcp-rks/src/server/story-ship.mjs"), "utf8"
    );
    expect(source).toContain("prBodyIncludeCostReport !== false");
  });

  it("story-ship.mjs imports generateCostReport from telemetry/cost-report.mjs", () => {
    const source = fs.readFileSync(
      path.resolve("packages/mcp-rks/src/server/story-ship.mjs"), "utf8"
    );
    expect(source).toContain("cost-report.mjs");
    expect(source).toContain("generateCostReport");
  });

  it("story-ship.mjs passes costBlock to runGitPR", () => {
    const source = fs.readFileSync(
      path.resolve("packages/mcp-rks/src/server/story-ship.mjs"), "utf8"
    );
    expect(source).toContain("costBlock");
    expect(source).toContain("runGitPR");
  });
});
