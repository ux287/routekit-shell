import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";


// Mock LLM modules
vi.mock("../../packages/mcp-rks/src/llm/planner.mjs", () => ({
  runLlmPlanner: vi.fn(),
}));

vi.mock("../../packages/mcp-rks/src/llm/reviewer.mjs", () => ({
  isImplementationReady: vi.fn(),
  runReviewerMode: vi.fn(),
}));

// Mock planner-note-steps for truncateText
vi.mock("../../packages/mcp-rks/src/server/planner-note-steps.mjs", () => ({
  truncateText: vi.fn((text, len) => text?.slice(0, len) || ""),
}));

import {
  validatePromptReadiness,
  checkReviewerMode,
  invokeReviewerMode,
  invokeLlmPlanner,
  savePromptToRunFolder,
  processLlmResult,
  orchestrateLlmPlanning,
} from "../../packages/mcp-rks/src/server/planner-llm.mjs";

import { runLlmPlanner } from "../../packages/mcp-rks/src/llm/planner.mjs";
import { isImplementationReady, runReviewerMode } from "../../packages/mcp-rks/src/llm/reviewer.mjs";
import fs from "fs";
import path from "path";
import os from "os";

describe("planner-llm", () => {
  let tempDir;
  let originalSkipReviewerMode;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-llm-test-"));
    originalSkipReviewerMode = process.env.RKS_SKIP_REVIEWER_MODE;
    delete process.env.RKS_SKIP_REVIEWER_MODE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalSkipReviewerMode !== undefined) {
      process.env.RKS_SKIP_REVIEWER_MODE = originalSkipReviewerMode;
    } else {
      delete process.env.RKS_SKIP_REVIEWER_MODE;
    }
  });

  describe("validatePromptReadiness", () => {
    it("returns enhanced requirements when snippets present", () => {
      const result = validatePromptReadiness({
        totalSnippetChars: 1000,
        hasSnippets: true,
        hasTargetFiles: true,
        frontmatterTargets: ["src/index.js"],
        planningText: "Add feature",
        planningSource: "context",
        requirementSummary: "Summary",
        slug: "test",
        projectId: "my-project",
      });

      expect(result.enhancedRequirements).toBe("Summary");
      expect(result.warnings).toHaveLength(0);
    });

    it("adds directive when targetFiles present but no snippets", () => {
      const result = validatePromptReadiness({
        totalSnippetChars: 0,
        hasSnippets: false,
        hasTargetFiles: true,
        frontmatterTargets: ["src/index.js"],
        planningText: "Add feature",
        planningSource: "context",
        requirementSummary: "Summary",
        slug: "test",
        projectId: "my-project",
      });

      expect(result.enhancedRequirements).toContain("IMPORTANT:");
      expect(result.enhancedRequirements).toContain("search_replace actions");
      expect(result.warnings).toContain("targetFiles specified but no snippets fetched");
    });

    it("uses planningText when no requirementSummary", () => {
      const result = validatePromptReadiness({
        totalSnippetChars: 100,
        hasSnippets: true,
        hasTargetFiles: false,
        frontmatterTargets: [],
        planningText: "Full planning text",
        planningSource: "context",
        requirementSummary: null,
        slug: "test",
        projectId: "my-project",
      });

      expect(result.enhancedRequirements).toBe("Full planning text");
    });
  });

  describe("checkReviewerMode", () => {
    it("returns false when not implementation-ready", () => {
      isImplementationReady.mockReturnValue(false);

      const result = checkReviewerMode("Some planning text");

      expect(result.useReviewerMode).toBe(false);
      expect(result.debugInfo.isImplementationReady).toBe(false);
    });

    it("returns true when implementation-ready", () => {
      isImplementationReady.mockReturnValue(true);

      const result = checkReviewerMode("SEARCH:\n```\ncode\n```\nREPLACE:");

      expect(result.useReviewerMode).toBe(true);
      expect(result.debugInfo.isImplementationReady).toBe(true);
    });

    it("respects RKS_SKIP_REVIEWER_MODE env", () => {
      isImplementationReady.mockReturnValue(true);
      process.env.RKS_SKIP_REVIEWER_MODE = "1";

      const result = checkReviewerMode("SEARCH:\n```\ncode\n```\nREPLACE:");

      expect(result.useReviewerMode).toBe(false);
      expect(result.debugInfo.skipEnvSet).toBe(true);

      delete process.env.RKS_SKIP_REVIEWER_MODE;
    });
  });

  describe("invokeReviewerMode", () => {
    it("calls runReviewerMode with correct params", async () => {
      runReviewerMode.mockResolvedValue({
        status: "executable",
        validation: { editsExtracted: 3, editsValid: 3 },
        meta: { elapsedMs: 100 },
      });

      const result = await invokeReviewerMode({
        planningText: "story content",
        projectRoot: tempDir,
        frontmatterTargets: ["src/index.js"],
        runFolder: path.join(tempDir, "run"),
        slug: "test",
        projectId: "my-project",
      });

      expect(runReviewerMode).toHaveBeenCalledWith({
        storyContent: "story content",
        projectRoot: tempDir,
        targetFiles: ["src/index.js"],
        runFolder: path.join(tempDir, "run"),
        checkCompleteness: true,
      });
      expect(result.status).toBe("executable");
    });

    it("returns refinement info when stale patterns", async () => {
      runReviewerMode.mockResolvedValue({
        refinementRequired: true,
        error: "Stale patterns",
        staleEdits: ["edit1"],
      });

      const result = await invokeReviewerMode({
        planningText: "story",
        projectRoot: tempDir,
        frontmatterTargets: [],
        runFolder: path.join(tempDir, "run"),
        slug: "test",
        projectId: "my-project",
      });

      expect(result.refinementRequired).toBe(true);
      expect(result.staleEdits).toEqual(["edit1"]);
    });
  });

  describe("invokeLlmPlanner", () => {
    it("calls runLlmPlanner with correct params", async () => {
      runLlmPlanner.mockResolvedValue({
        status: "executable",
        actions: [{ action: "edit_file", path: "src/index.js" }],
      });

      const result = await invokeLlmPlanner({
        enhancedRequirements: "requirements",
        planningText: "full text",
        planningSource: "context",
        enhancedEditableTargets: [{ path: "src/index.js" }],
        contextualRefs: [],
        plannerMode: "full",
        runFolder: path.join(tempDir, "run"),
        slug: "test",
        projectId: "my-project",
      });

      expect(runLlmPlanner).toHaveBeenCalledWith({
        requirements: "requirements",
        fullRequirements: "full text",
        context: "context",
        editableTargets: [{ path: "src/index.js" }],
        contextualRefs: [],
        plannerMode: "full",
        runFolder: path.join(tempDir, "run"),
        useReplay: true,
        uncoveredCreatePaths: [],
        // Attribution wiring (backlog.fix.token-cost-telemetry-null-schema): invokeLlmPlanner
        // threads slug/projectId as llmContext so the token-usage emitter can attribute cost.
        llmContext: { problemId: "test", projectId: "my-project" },
      });
      expect(result.status).toBe("executable");
    });

    it("passes usage from runLlmPlanner through to the caller", async () => {
      const mockUsage = { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 };
      runLlmPlanner.mockResolvedValue({
        status: "executable",
        actions: [],
        usage: mockUsage,
      });

      const result = await invokeLlmPlanner({
        enhancedRequirements: "requirements",
        planningText: "full text",
        planningSource: "context",
        enhancedEditableTargets: [],
        contextualRefs: [],
        plannerMode: "full",
        runFolder: path.join(tempDir, "run"),
        slug: "test",
        projectId: "my-project",
      });

      expect(result.usage).toEqual(mockUsage);
    });

    it("passes usage: null through when runLlmPlanner returns no usage", async () => {
      runLlmPlanner.mockResolvedValue({ status: "executable", actions: [] });

      const result = await invokeLlmPlanner({
        enhancedRequirements: "requirements",
        planningText: "full text",
        planningSource: "context",
        enhancedEditableTargets: [],
        contextualRefs: [],
        plannerMode: "full",
        runFolder: path.join(tempDir, "run"),
        slug: "test",
        projectId: "my-project",
      });

      expect(result.usage).toBeUndefined();
    });

    it("does not throw when runFolder is null (supplement call pattern)", async () => {
      runLlmPlanner.mockResolvedValue({
        status: "executable",
        actions: [{ action: "create_file", path: "hooks/useFoo.ts", content: "export function useFoo() {}" }],
      });

      const result = await invokeLlmPlanner({
        enhancedRequirements: "requirements",
        planningText: "full text",
        planningSource: "context",
        enhancedEditableTargets: [],
        contextualRefs: [],
        plannerMode: "full",
        runFolder: null,
        slug: "test",
        projectId: "my-project",
        uncoveredCreatePaths: ["hooks/useFoo.ts"],
      });

      expect(runLlmPlanner).toHaveBeenCalledWith(
        expect.objectContaining({ runFolder: null, uncoveredCreatePaths: ["hooks/useFoo.ts"] })
      );
      expect(result.actions[0].action).toBe("create_file");
    });
  });

  describe("savePromptToRunFolder", () => {
    it("saves prompt to file", () => {
      const runFolder = path.join(tempDir, "run");
      fs.mkdirSync(runFolder, { recursive: true });

      savePromptToRunFolder(
        { prompt: "test prompt content" },
        runFolder,
        "test",
        "my-project"
      );

      const promptPath = path.join(runFolder, "prompt.txt");
      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.readFileSync(promptPath, "utf8")).toBe("test prompt content");
    });

    it("does nothing when no prompt", () => {
      const runFolder = path.join(tempDir, "run");
      fs.mkdirSync(runFolder, { recursive: true });

      savePromptToRunFolder(null, runFolder, "test", "my-project");
      savePromptToRunFolder({}, runFolder, "test", "my-project");

      const promptPath = path.join(runFolder, "prompt.txt");
      expect(fs.existsSync(promptPath)).toBe(false);
    });
  });

  describe("processLlmResult", () => {
    it("returns error state for null result", () => {
      const result = processLlmResult(null);

      expect(result.actions).toBeNull();
      expect(result.status).toBe("error");
      expect(result.debug).toBeNull();
    });

    it("processes actions array", () => {
      const result = processLlmResult({
        status: "executable",
        actions: [
          { action: "edit_file", path: "src/index.js", content: "code" },
          { action: "create_file", path: "src/new.js", content: "new" },
        ],
        prompt: "prompt text",
        raw: "raw response",
      });

      expect(result.status).toBe("executable");
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].order).toBe(1);
      expect(result.actions[1].order).toBe(2);
    });

    it("joins array content", () => {
      const result = processLlmResult({
        actions: [
          { action: "edit_file", path: "src/index.js", content: ["line1", "line2"] },
        ],
      });

      expect(result.actions[0].content).toBe("line1\nline2");
    });

    it("uses default status when missing", () => {
      const result = processLlmResult({
        actions: [],
      });

      expect(result.status).toBe("note_only");
    });
  });

  describe("orchestrateLlmPlanning", () => {
    it("uses reviewer mode when implementation-ready", async () => {
      isImplementationReady.mockReturnValue(true);
      runReviewerMode.mockResolvedValue({
        status: "executable",
        actions: [{ action: "edit_file", path: "src/index.js" }],
        validation: { editsExtracted: 1 },
        meta: { elapsedMs: 50 },
      });

      const result = await orchestrateLlmPlanning({
        planningText: "SEARCH:\n```\ncode\n```\nREPLACE:",
        planningSource: "context",
        requirementSummary: "summary",
        enhancedEditableTargets: [],
        contextualRefs: [],
        frontmatterTargets: ["src/index.js"],
        plannerMode: "full",
        runFolder: tempDir,
        projectRoot: tempDir,
        slug: "test",
        projectId: "my-project",
      });

      expect(runReviewerMode).toHaveBeenCalled();
      expect(runLlmPlanner).not.toHaveBeenCalled();
      expect(result.llmStatus).toBe("executable");
    });

    it("uses LLM planner when not implementation-ready", async () => {
      isImplementationReady.mockReturnValue(false);
      runLlmPlanner.mockResolvedValue({
        status: "executable",
        actions: [{ action: "edit_file", path: "src/index.js" }],
      });

      const result = await orchestrateLlmPlanning({
        planningText: "Add feature to index",
        planningSource: "context",
        requirementSummary: "summary",
        enhancedEditableTargets: [{ path: "src/index.js", ragSnippets: ["code"] }],
        contextualRefs: [],
        frontmatterTargets: ["src/index.js"],
        plannerMode: "full",
        runFolder: tempDir,
        projectRoot: tempDir,
        slug: "test",
        projectId: "my-project",
      });

      expect(runLlmPlanner).toHaveBeenCalled();
      expect(runReviewerMode).not.toHaveBeenCalled();
      expect(result.llmStatus).toBe("executable");
    });

    it("returns refinement info when reviewer mode requires it", async () => {
      isImplementationReady.mockReturnValue(true);
      runReviewerMode.mockResolvedValue({
        refinementRequired: true,
        error: "Stale patterns",
        staleEdits: ["edit1"],
      });

      const result = await orchestrateLlmPlanning({
        planningText: "SEARCH:\n```\ncode\n```\nREPLACE:",
        planningSource: "context",
        requirementSummary: "summary",
        enhancedEditableTargets: [],
        contextualRefs: [],
        frontmatterTargets: [],
        plannerMode: "full",
        runFolder: tempDir,
        projectRoot: tempDir,
        slug: "test",
        projectId: "my-project",
      });

      expect(result.refinementRequired).toBe(true);
      expect(result.llmStatus).toBe("refinement_required");
    });

    it("calculates snippet stats correctly", async () => {
      isImplementationReady.mockReturnValue(false);
      runLlmPlanner.mockResolvedValue({ status: "note_only", actions: [] });

      await orchestrateLlmPlanning({
        planningText: "text",
        planningSource: "context",
        requirementSummary: "summary",
        enhancedEditableTargets: [
          { path: "a.js", ragSnippets: ["12345", "67890"] },
          { path: "b.js", ragSnippets: ["abc"] },
        ],
        contextualRefs: [],
        frontmatterTargets: ["a.js", "b.js"],
        plannerMode: "full",
        runFolder: tempDir,
        projectRoot: tempDir,
        slug: "test",
        projectId: "my-project",
      });

      // Verify validatePromptReadiness was called with correct snippet detection
      expect(runLlmPlanner).toHaveBeenCalled();
    });
  });

  // backlog.fix.reviewer-anchor-only-targets-get-no-llm-pass — reviewer mode skips identity
  // anchors; an existing op:edit target they leave uncovered gets ONE scoped LLM pass, and the
  // returned llmStatus / llmDebug.error describe that pass. runLlmPlanner is mocked (no live LLM).
  describe("orchestrateLlmPlanning — edit-target supplement", () => {
    const REVIEWER_NO_EDITS = {
      status: "no_explicit_edits",
      actions: [],
      error: "Story has no extractable SEARCH/REPLACE blocks",
      validation: { editsExtracted: 0 },
      meta: { elapsedMs: 5 },
    };
    const REVIEWER_A_ONLY = {
      status: "executable",
      actions: [{ action: "search_replace", path: "src/a.mjs", title: "reviewer edit a", edits: [{ search: "a1", replace: "a2" }] }],
      validation: { editsExtracted: 1 },
      meta: { elapsedMs: 5 },
    };
    const srAction = (p, title = `edit ${p}`) => ({ action: "search_replace", path: p, title, edits: [{ search: "x", replace: "y" }] });

    const run = (overrides = {}) => orchestrateLlmPlanning({
      planningText: "@@SEARCH\nx\n@@REPLACE\nx\n@@END",
      planningSource: "context",
      requirementSummary: "summary",
      enhancedEditableTargets: [{ path: "src/a.mjs", liveContent: "x" }],
      contextualRefs: [],
      frontmatterTargets: ["src/a.mjs"],
      plannerMode: "full",
      runFolder: tempDir,
      projectRoot: tempDir,
      slug: "test",
      projectId: "my-project",
      ...overrides,
    });
    const MIXED = {
      enhancedEditableTargets: [
        { path: "src/a.mjs", liveContent: "a" },
        { path: "src/b.mjs", liveContent: "b" },
      ],
      frontmatterTargets: ["src/a.mjs", "src/b.mjs"],
    };

    beforeEach(() => {
      isImplementationReady.mockReturnValue(true);
    });

    it("TR1: identity-anchor-only target gets exactly one scoped LLM pass; status/error are the supplement's", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_NO_EDITS);
      const stubbed = srAction("src/a.mjs");
      runLlmPlanner.mockResolvedValue({ status: "executable", actions: [stubbed] });

      const result = await run();

      expect(runLlmPlanner).toHaveBeenCalledTimes(1);
      const input = runLlmPlanner.mock.calls[0][0];
      expect(input.editableTargets).toEqual([{ path: "src/a.mjs", liveContent: "x" }]);
      expect(input.uncoveredCreatePaths).toEqual([]);
      expect(input.runFolder).toBeNull();
      expect(result.llmActions).toHaveLength(1);
      expect(result.llmActions[0]).toMatchObject(stubbed);
      expect(result.llmStatus).toBe("executable");
      expect(result.llmStatus).not.toBe("no_explicit_edits");
      expect(result.llmDebug.error).toBeNull();
    });

    it("TR2: mixed story — reviewer action for A kept first; only the supplemental B action is merged", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_A_ONLY);
      runLlmPlanner.mockResolvedValue({
        status: "executable",
        actions: [srAction("src/a.mjs", "supp a"), srAction("src/b.mjs", "supp b"), srAction("src/c.mjs", "supp c")],
      });

      const result = await run(MIXED);

      expect(runLlmPlanner).toHaveBeenCalledTimes(1);
      expect(runLlmPlanner.mock.calls[0][0].editableTargets).toEqual([{ path: "src/b.mjs", liveContent: "b" }]);
      expect(result.llmActions).toHaveLength(2);
      expect(result.llmActions[0]).toMatchObject(REVIEWER_A_ONLY.actions[0]);
      expect(result.llmActions[1]).toMatchObject({ path: "src/b.mjs", title: "supp b" });
      expect(result.llmActions.map((a) => a.title)).not.toContain("supp a");
      expect(result.llmActions.map((a) => a.path)).not.toContain("src/c.mjs");
      expect(result.llmStatus).toBe("executable");
    });

    it("TR3: reviewer covers the only liveContent target — no supplemental call, reviewer status returned", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_A_ONLY);

      const result = await run();

      expect(runLlmPlanner).not.toHaveBeenCalled();
      expect(result.llmStatus).toBe(REVIEWER_A_ONLY.status);
      expect(result.llmActions).toHaveLength(1);
      expect(result.llmActions[0]).toMatchObject(REVIEWER_A_ONLY.actions[0]);
    });

    it("TR3: a reviewer note step does not count as coverage", async () => {
      runReviewerMode.mockResolvedValue({ status: "note_only", actions: [{ action: "note", path: "src/a.mjs", title: "n" }] });
      runLlmPlanner.mockResolvedValue({ status: "executable", actions: [srAction("src/a.mjs")] });

      await run();

      expect(runLlmPlanner).toHaveBeenCalledTimes(1);
    });

    it("TR4: supplement resolves note_only with no actions", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_NO_EDITS);
      runLlmPlanner.mockResolvedValue({ status: "note_only", actions: [] });

      const result = await run();

      expect(result.llmActions).toBeNull();
      expect(result.llmStatus).toBe("note_only");
      expect(result.llmDebug.error).toBe("edit-target supplement returned no actions for: src/a.mjs");
    });

    it("TR4: supplement resolves null", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_NO_EDITS);
      runLlmPlanner.mockResolvedValue(null);

      const result = await run();

      expect(result.llmActions).toBeNull();
      expect(result.llmStatus).toBe("error");
      expect(result.llmDebug.error).toBe("edit-target supplement returned no result");
    });

    it("TR4: supplement reports executable but only a non-target action — nothing merged, status note_only", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_NO_EDITS);
      runLlmPlanner.mockResolvedValue({ status: "executable", actions: [srAction("src/c.mjs")] });

      const result = await run();

      expect(result.llmActions).toBeNull();
      expect(result.llmStatus).toBe("note_only");
      expect(result.llmStatus).not.toBe("executable");
      expect(result.llmDebug.error).toBe("edit-target supplement returned no actions for: src/a.mjs");
    });

    it("TR4: mixed story, supplement executable with only discarded actions — reviewer actions unchanged, note_only", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_A_ONLY);
      runLlmPlanner.mockResolvedValue({ status: "executable", actions: [srAction("src/a.mjs", "supp a"), srAction("src/c.mjs")] });

      const result = await run(MIXED);

      expect(result.llmActions).toHaveLength(1);
      expect(result.llmActions[0]).toMatchObject(REVIEWER_A_ONLY.actions[0]);
      expect(result.llmStatus).toBe("note_only");
      expect(result.llmDebug.error).toBe("edit-target supplement returned no actions for: src/b.mjs");
    });

    it("TR4: no case surfaces the reviewer's no_explicit_edits text", async () => {
      const cases = [
        { status: "note_only", actions: [] },
        null,
        { status: "executable", actions: [srAction("src/c.mjs")] },
      ];
      for (const supp of cases) {
        vi.clearAllMocks();
        isImplementationReady.mockReturnValue(true);
        runReviewerMode.mockResolvedValue(REVIEWER_NO_EDITS);
        runLlmPlanner.mockResolvedValue(supp);
        const result = await run();
        expect(result.llmStatus).not.toBe("no_explicit_edits");
        expect(result.llmDebug.error).not.toBe("Story has no extractable SEARCH/REPLACE blocks");
      }
    });

    it("TR5: supplement rejects — resolves, reviewer actions unchanged, status error with the failure message", async () => {
      runReviewerMode.mockResolvedValue(REVIEWER_A_ONLY);
      runLlmPlanner.mockRejectedValue(new Error("boom"));

      const result = await run(MIXED);

      expect(result.llmActions).toHaveLength(1);
      expect(result.llmActions[0]).toMatchObject(REVIEWER_A_ONLY.actions[0]);
      expect(result.llmStatus).toBe("error");
      expect(result.llmDebug.error).toBe("edit-target supplement failed: boom");
    });
  });
});
