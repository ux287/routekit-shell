import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock dependencies before importing the module
// NOTE: vi.mock factories are hoisted — cannot reference outer variables
vi.mock("../../packages/mcp-rks/src/utils/git.mjs", () => {
  const patterns = [
    '.rks/session/', '.rks/state/', '.rks/telemetry/', '.rks/rag/',
    '.rks/runs/', '.rks/', '.dendron.port', '.dendron.ws',
    'notes/.dendron.cache.json', '.routekit/state.json', '.routekit/telemetry/',
  ];
  return {
    getCurrentBranch: vi.fn(),
    isWorkingTreeClean: vi.fn(),
    getUncommittedFiles: vi.fn(),
    commitFiles: vi.fn(),
    getStagingSyncStatus: vi.fn(),
    isRuntimeArtifact: vi.fn((f) => patterns.some(p => f === p || f.startsWith(p))),
    RKS_RUNTIME_ARTIFACT_PATTERNS: patterns,
  };
});

vi.mock("../../packages/mcp-rks/src/server/planner-utils.mjs", () => ({
  isRagIndexFresh: vi.fn(),
}));

vi.mock("../../packages/mcp-rks/src/rag/tools.mjs", () => ({
  runRagEmbed: vi.fn(),
}));

vi.mock("../../packages/mcp-rks/src/server/refine.mjs", () => ({
  runRefineTool: vi.fn(),
}));

vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({
  resolveNotesDir: vi.fn((root) => path.join(root, "notes")),
}));


import {
  runPreflightChecks,
  runReadinessGate,
  enforcePhase,
  validateGitignore,
  runAllPreflightChecks,
} from "../../packages/mcp-rks/src/server/planner-preflight.mjs";

import {
  getCurrentBranch,
  isWorkingTreeClean,
  getUncommittedFiles,
  commitFiles,
  getStagingSyncStatus,
} from "../../packages/mcp-rks/src/utils/git.mjs";

import { isRagIndexFresh } from "../../packages/mcp-rks/src/server/planner-utils.mjs";
import { runRagEmbed } from "../../packages/mcp-rks/src/rag/tools.mjs";
import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("planner-preflight", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-preflight-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("runPreflightChecks", () => {
    const mockContext = { projectJson: { baseBranch: "staging" } };

    it("fails when on wrong branch", async () => {
      isWorkingTreeClean.mockReturnValue(true);
      getCurrentBranch.mockReturnValue("feature/test");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Plan from base branch");
      expect(result.hint).toContain("git checkout");
    });

    it("fails when behind origin", async () => {
      isWorkingTreeClean.mockReturnValue(true);
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 3, aheadBy: 0, diverged: false });

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("behind origin");
      expect(result.behindBy).toBe(3);
    });

    it("fails when working tree is dirty with non-note files", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue(["src/index.js", "package.json"]);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("uncommitted non-note file(s)");
    });

    it("auto-commits note files when only notes are dirty", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue(["notes/backlog.test.md", "notes/docs.readme.md"]);
      commitFiles.mockReturnValue(undefined);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(true);
      expect(commitFiles).toHaveBeenCalledWith(
        tempDir,
        ["notes/backlog.test.md", "notes/docs.readme.md"],
        "docs(backlog): update notes for planning"
      );
    });

    it("fails when auto-commit fails", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue(["notes/test.md"]);
      commitFiles.mockImplementation(() => {
        throw new Error("commit failed");
      });

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Failed to auto-commit");
    });

    it("auto-embeds when RAG index is stale and autoEmbed is true", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(true);
      isRagIndexFresh.mockReturnValue(false);
      runRagEmbed.mockResolvedValue(undefined);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        autoEmbed: true,
      });

      expect(result.ok).toBe(true);
      expect(result.autoEmbedded).toBe(true);
      expect(runRagEmbed).toHaveBeenCalled();
    });

    it("fails when RAG is stale and autoEmbed is false", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(true);
      isRagIndexFresh.mockReturnValue(false);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        autoEmbed: false,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("RAG index is stale");
    });

    it("passes all checks when everything is good", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(true);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(true);
      expect(result.autoEmbedded).toBe(false);
    });
  });

  describe("runReadinessGate", () => {
    it("passes when no high-priority issues", async () => {
      runRefineTool.mockResolvedValue({
        ok: true,
        suggestions: [{ priority: "low", message: "minor issue" }],
      });

      const result = await runReadinessGate({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
    });

    it("fails when high-priority issues found", async () => {
      runRefineTool.mockResolvedValue({
        ok: true,
        suggestions: [
          { priority: "high", type: "missing_target_files" },
          { priority: "high", type: "missing_acceptance_criteria" },
        ],
      });

      const result = await runReadinessGate({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(false);
      expect(result.readinessIssues).toHaveLength(2);
      expect(result.hint).toContain("rks_refine_apply");
    });

    it("passes when refine tool throws (non-blocking)", async () => {
      runRefineTool.mockRejectedValue(new Error("refine failed"));

      const result = await runReadinessGate({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
      expect(result.warning).toContain("refine failed");
    });
  });

  describe("enforcePhase", () => {
    it("passes when story file does not exist", () => {
      const result = enforcePhase({
        projectRoot: tempDir,
        problemId: "backlog.nonexistent",
      });

      expect(result.ok).toBe(true);
    });

    it("passes for ready phase", () => {
      const notesDir = path.join(tempDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.test.md"),
        "---\nphase: ready\n---\n# Test"
      );

      const result = enforcePhase({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
      expect(result.currentPhase).toBe("ready");
    });

    it("passes for planned phase", () => {
      const notesDir = path.join(tempDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.test.md"),
        "---\nphase: planned\n---\n# Test"
      );

      const result = enforcePhase({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
      expect(result.currentPhase).toBe("planned");
    });

    it("auto-promotes draft to ready", () => {
      const notesDir = path.join(tempDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      const storyPath = path.join(notesDir, "backlog.test.md");
      fs.writeFileSync(storyPath, "---\nphase: draft\n---\n# Test");

      const result = enforcePhase({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
      expect(result.autoPromoted).toBe(true);

      // Verify file was updated
      const content = fs.readFileSync(storyPath, "utf8");
      expect(content).toContain("phase: ready");
    });

    it("fails for unknown phase", () => {
      const notesDir = path.join(tempDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.test.md"),
        "---\nphase: review\n---\n# Test"
      );

      const result = enforcePhase({
        projectRoot: tempDir,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(false);
      expect(result.currentPhase).toBe("review");
      expect(result.hint).toContain("Update story phase");
    });
  });

  describe("runAllPreflightChecks", () => {
    const mockContext = { projectJson: { baseBranch: "staging" } };

    it("runs all checks in sequence", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(true);
      isRagIndexFresh.mockReturnValue(true);
      runRefineTool.mockResolvedValue({ ok: true, suggestions: [] });

      const notesDir = path.join(tempDir, "notes");
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(
        path.join(notesDir, "backlog.test.md"),
        "---\nphase: ready\n---\n# Test"
      );

      const result = await runAllPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(true);
    });

    it("stops at first failure", async () => {
      getCurrentBranch.mockReturnValue("feature/wrong");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });

      const result = await runAllPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        problemId: "backlog.test",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Plan from base branch");
      // Should not have called readiness or phase checks
      expect(runRefineTool).not.toHaveBeenCalled();
    });

    it("respects skip flags", async () => {
      // Don't set up mocks - they shouldn't be called with skip flags

      const result = await runAllPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        problemId: "backlog.test",
        skipPreflight: true,
        skipReadiness: true,
        skipPhaseCheck: true,
      });

      expect(result.ok).toBe(true);
      expect(getCurrentBranch).not.toHaveBeenCalled();
      expect(runRefineTool).not.toHaveBeenCalled();
    });

    it("skips readiness and phase when no problemId", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(true);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runAllPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
        // No problemId
      });

      expect(result.ok).toBe(true);
      expect(runRefineTool).not.toHaveBeenCalled();
    });
  });

  describe("runtime artifact filtering", () => {
    const mockContext = { projectJson: { baseBranch: "staging" } };

    it("passes when only RKS/Dendron runtime artifacts are dirty", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue([
        ".rks/session/abc.json",
        ".rks/state/governor.json",
        ".rks/telemetry/events-2026-02-22.jsonl",
        ".dendron.port",
        ".dendron.ws",
      ]);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(true);
      expect(commitFiles).not.toHaveBeenCalled();
    });

    it("passes when notes and runtime artifacts are dirty (auto-commits notes)", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue([
        "notes/backlog.feat.test.md",
        ".rks/telemetry/events-2026-02-22.jsonl",
        ".dendron.port",
      ]);
      commitFiles.mockReturnValue(undefined);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(true);
      expect(commitFiles).toHaveBeenCalledWith(
        tempDir,
        ["notes/backlog.feat.test.md"],
        "docs(backlog): update notes for planning"
      );
    });

    it("still blocks when genuine non-note files are dirty alongside artifacts", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue([
        ".rks/telemetry/events-2026-02-22.jsonl",
        ".dendron.port",
        "src/index.js",
      ]);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("1 uncommitted non-note file(s)");
    });

    it("filters .routekit/ runtime artifacts", async () => {
      getCurrentBranch.mockReturnValue("staging");
      getStagingSyncStatus.mockReturnValue({ behindBy: 0 });
      isWorkingTreeClean.mockReturnValue(false);
      getUncommittedFiles.mockReturnValue([
        ".routekit/state.json",
        ".routekit/telemetry/guardrails.log",
      ]);
      isRagIndexFresh.mockReturnValue(true);

      const result = await runPreflightChecks({
        projectRoot: tempDir,
        context: mockContext,
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("validateGitignore", () => {
    it("returns no warning when all essential entries are present", () => {
      const gitignorePath = path.join(tempDir, ".gitignore");
      fs.writeFileSync(gitignorePath, [
        ".rks/session/",
        ".rks/state/",
        ".rks/telemetry/",
        ".rks/rag/",
        ".rks/runs/",
        ".rks/",
        ".dendron.port",
        ".dendron.ws",
        "notes/.dendron.cache.json",
        ".routekit/state.json",
        ".routekit/telemetry/",
      ].join("\n"));

      const result = validateGitignore({ projectRoot: tempDir });

      expect(result.ok).toBe(true);
      expect(result.missingEntries).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });

    it("warns with specific missing entries when some patterns are absent", () => {
      const gitignorePath = path.join(tempDir, ".gitignore");
      fs.writeFileSync(gitignorePath, [
        "node_modules/",
        ".rks/rag/",
        ".dendron.port",
      ].join("\n"));

      const result = validateGitignore({ projectRoot: tempDir });

      expect(result.ok).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.missingEntries).toBeDefined();
      expect(result.missingEntries.length).toBeGreaterThan(0);
      expect(result.missingEntries).toContain(".dendron.ws");
      expect(result.missingEntries).not.toContain(".dendron.port");
    });

    it("warns about all entries when .gitignore does not exist", () => {
      const result = validateGitignore({ projectRoot: tempDir });

      expect(result.ok).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.missingEntries).toBeDefined();
      // Should warn about all 11 patterns
      expect(result.missingEntries.length).toBe(11);
    });

    it("is non-blocking — always returns ok: true", () => {
      const result = validateGitignore({ projectRoot: "/nonexistent/path/that/should/not/crash" });

      expect(result.ok).toBe(true);
    });
  });
});
