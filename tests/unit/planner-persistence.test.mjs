import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "js-yaml";


// Mock project.mjs
vi.mock("../../packages/mcp-rks/src/server/project.mjs", () => ({
  ensureDir: vi.fn((dir) => fs.mkdirSync(dir, { recursive: true })),
}));

import {
  buildProblemYaml,
  buildPlanYaml,
  buildRunRecord,
  persistRunFiles,
  updateRunRecord,
} from "../../packages/mcp-rks/src/server/planner-persistence.mjs";

describe("planner-persistence", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-persistence-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("buildProblemYaml", () => {
    it("builds basic problem yaml", () => {
      const result = buildProblemYaml({
        problemId: "backlog.test",
        slug: "test-feature",
        planSummary: "Add test feature",
        projectRoot: "/project",
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(result.id).toBe("backlog.test");
      expect(result.source).toBe("note");
      expect(result.goal).toBe("Add test feature");
      expect(result.meta.projectId).toBe("my-project");
      expect(result.meta.slug).toBe("test-feature");
    });

    it("uses slug as id when no problemId", () => {
      const result = buildProblemYaml({
        slug: "test-feature",
        planSummary: "Add test feature",
        projectRoot: "/project",
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(result.id).toBe("test-feature");
      expect(result.source).toBe("task");
    });

    it("falls back to requirementSummary for goal", () => {
      const result = buildProblemYaml({
        slug: "test",
        requirementSummary: "Fallback summary",
        projectRoot: "/project",
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(result.goal).toBe("Fallback summary");
    });

    it("includes problem path in scope", () => {
      const result = buildProblemYaml({
        slug: "test",
        problemPath: "/project/notes/backlog.test.md",
        projectRoot: "/project",
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(result.scope).toContain("notes/backlog.test.md");
    });

    it("includes RAG code paths in scope", () => {
      const result = buildProblemYaml({
        slug: "test",
        projectRoot: "/project",
        projectId: "my-project",
        ragCodePreview: [
          { path: "src/index.js" },
          { path: "src/utils.js" },
        ],
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      expect(result.scope).toContain("src/index.js");
      expect(result.scope).toContain("src/utils.js");
    });
  });

  describe("buildPlanYaml", () => {
    const mockPlan = {
      problemId: "backlog.test",
      problemPath: "/project/notes/backlog.test.md",
      planSummary: "Test summary",
      generatedAt: "2025-01-01T00:00:00.000Z",
      status: "executable",
      guardrail: { id: "test-guardrail" },
      ragContextSummary: { notesHitCount: 3, codeHitCount: 5, kgHitCount: 1 },
      steps: [
        { action: "edit_file", path: "src/index.js", content: "code" },
        { action: "create_file", path: "src/new.js", content: "new code" },
      ],
    };

    it("builds plan yaml from plan object", () => {
      const result = buildPlanYaml({
        slug: "test-feature",
        projectId: "my-project",
        plan: mockPlan,
        planStatus: "executable",
      });

      expect(result.id).toBe("test-feature");
      expect(result.projectId).toBe("my-project");
      expect(result.problemId).toBe("backlog.test");
      expect(result.summary).toBe("Test summary");
      expect(result.status).toBe("executable");
      expect(result.guardrail).toEqual({ id: "test-guardrail" });
      expect(result.rag).toEqual({ notesHitCount: 3, codeHitCount: 5, kgHitCount: 1 });
    });

    it("maps steps correctly", () => {
      const result = buildPlanYaml({
        slug: "test",
        projectId: "my-project",
        plan: mockPlan,
        planStatus: "executable",
      });

      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].id).toBe("step-1");
      expect(result.steps[0].action).toBe("edit_file");
      expect(result.steps[0].target).toBe("src/index.js");
      expect(result.steps[1].id).toBe("step-2");
      expect(result.steps[1].order).toBe(2);
    });

    it("uses step id if provided", () => {
      const planWithIds = {
        ...mockPlan,
        steps: [
          { id: "custom-id", action: "edit_file", path: "src/index.js" },
        ],
      };

      const result = buildPlanYaml({
        slug: "test",
        projectId: "my-project",
        plan: planWithIds,
        planStatus: "executable",
      });

      expect(result.steps[0].id).toBe("custom-id");
    });
  });

  describe("buildRunRecord", () => {
    const mockPlan = {
      problemId: "backlog.test",
      problemPath: "/project/notes/backlog.test.md",
      planSummary: "Test summary",
      generatedAt: "2025-01-01T00:00:00.000Z",
      status: "executable",
      ragContextSummary: { notesHitCount: 3, codeHitCount: 5, kgHitCount: 1 },
    };

    it("builds run record", () => {
      const result = buildRunRecord({
        projectId: "my-project",
        runFolder: "/project/.rks/runs/2025-01-01_test-feature",
        slug: "test-feature",
        plan: mockPlan,
        planStatus: "executable",
        paths: {
          problemPath: "/project/.rks/runs/2025-01-01_test-feature/problem.yaml",
          planYamlPath: "/project/.rks/runs/2025-01-01_test-feature/plan.yaml",
          planJsonPath: "/project/.rks/runs/2025-01-01_test-feature/plan.json",
          validateReportPath: "/project/.rks/runs/2025-01-01_test-feature/validate/report.md",
          applyLogPath: "/project/.rks/runs/2025-01-01_test-feature/apply/apply.log",
          learnPath: "/project/.rks/runs/2025-01-01_test-feature/learn.md",
        },
      });

      expect(result.projectId).toBe("my-project");
      expect(result.runId).toBe("2025-01-01_test-feature");
      expect(result.slug).toBe("test-feature");
      expect(result.status).toBe("executable");
      expect(result.timestamps.plannedAt).toBe("2025-01-01T00:00:00.000Z");
      expect(result.timestamps.validatedAt).toBeNull();
      expect(result.telemetry.ragNotes).toBe(3);
      expect(result.telemetry.outcome).toBe("planned");
    });
  });

  describe("persistRunFiles", () => {
    const mockPlan = {
      projectId: "my-project",
      problemId: "backlog.test",
      problemPath: null,
      planSummary: "Test summary",
      generatedAt: "2025-01-01T00:00:00.000Z",
      status: "executable",
      ragContextSummary: { notesHitCount: 3, codeHitCount: 5, kgHitCount: 1 },
      steps: [{ action: "edit_file", path: "src/index.js", content: "code" }],
    };

    it("creates all run files", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const problemYaml = buildProblemYaml({
        problemId: "backlog.test",
        slug: "test",
        planSummary: "Test",
        projectRoot: tempDir,
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      const planYaml = buildPlanYaml({
        slug: "test",
        projectId: "my-project",
        plan: mockPlan,
        planStatus: "executable",
      });

      const paths = persistRunFiles({
        runFolder,
        plan: mockPlan,
        problemYaml,
        planYaml,
        slug: "test",
        projectId: "my-project",
      });

      // Verify files exist
      expect(fs.existsSync(paths.planJsonPath)).toBe(true);
      expect(fs.existsSync(paths.planYamlPath)).toBe(true);
      expect(fs.existsSync(paths.problemPath)).toBe(true);
      expect(fs.existsSync(paths.validateReportPath)).toBe(true);
      expect(fs.existsSync(paths.learnPath)).toBe(true);
      expect(fs.existsSync(paths.runJsonPath)).toBe(true);
    });

    it("creates valid JSON files", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const problemYaml = buildProblemYaml({
        slug: "test",
        projectRoot: tempDir,
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      const planYaml = buildPlanYaml({
        slug: "test",
        projectId: "my-project",
        plan: mockPlan,
        planStatus: "executable",
      });

      const paths = persistRunFiles({
        runFolder,
        plan: mockPlan,
        problemYaml,
        planYaml,
        slug: "test",
      });

      // Verify JSON is valid
      const planJson = JSON.parse(fs.readFileSync(paths.planJsonPath, "utf8"));
      expect(planJson.projectId).toBe("my-project");

      const runJson = JSON.parse(fs.readFileSync(paths.runJsonPath, "utf8"));
      expect(runJson.slug).toBe("test");
    });

    it("creates valid YAML files", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const problemYaml = buildProblemYaml({
        problemId: "backlog.test",
        slug: "test",
        projectRoot: tempDir,
        projectId: "my-project",
        generatedAt: "2025-01-01T00:00:00.000Z",
      });

      const planYamlObj = buildPlanYaml({
        slug: "test",
        projectId: "my-project",
        plan: mockPlan,
        planStatus: "executable",
      });

      const paths = persistRunFiles({
        runFolder,
        plan: mockPlan,
        problemYaml,
        planYaml: planYamlObj,
        slug: "test",
      });

      // Verify YAML is valid
      const problemContent = yaml.load(fs.readFileSync(paths.problemPath, "utf8"));
      expect(problemContent.id).toBe("backlog.test");

      const planContent = yaml.load(fs.readFileSync(paths.planYamlPath, "utf8"));
      expect(planContent.id).toBe("test");
    });

    it("creates scaffold markdown files", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const paths = persistRunFiles({
        runFolder,
        plan: mockPlan,
        problemYaml: {},
        planYaml: {},
        slug: "test",
      });

      const reportContent = fs.readFileSync(paths.validateReportPath, "utf8");
      expect(reportContent).toContain("# Validation Report");

      const learnContent = fs.readFileSync(paths.learnPath, "utf8");
      expect(learnContent).toContain("# Learnings");
    });

    it("does not overwrite existing scaffold files", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(path.join(runFolder, "validate"), { recursive: true });

      // Create existing files
      const existingReport = "# Existing Report\n\nHas content";
      fs.writeFileSync(path.join(runFolder, "validate", "report.md"), existingReport);

      const paths = persistRunFiles({
        runFolder,
        plan: mockPlan,
        problemYaml: {},
        planYaml: {},
        slug: "test",
      });

      const reportContent = fs.readFileSync(paths.validateReportPath, "utf8");
      expect(reportContent).toBe(existingReport);
    });
  });

  describe("updateRunRecord", () => {
    it("updates run record fields", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const initial = {
        projectId: "my-project",
        slug: "test",
        status: "planned",
        timestamps: { plannedAt: "2025-01-01T00:00:00.000Z", validatedAt: null },
        telemetry: { outcome: "planned" },
      };
      fs.writeFileSync(
        path.join(runFolder, "run.json"),
        JSON.stringify(initial)
      );

      const updated = updateRunRecord(runFolder, {
        status: "validated",
        timestamps: { validatedAt: "2025-01-01T01:00:00.000Z" },
      });

      expect(updated.status).toBe("validated");
      expect(updated.timestamps.plannedAt).toBe("2025-01-01T00:00:00.000Z");
      expect(updated.timestamps.validatedAt).toBe("2025-01-01T01:00:00.000Z");
    });

    it("merges nested telemetry updates", () => {
      const runFolder = path.join(tempDir, "2025-01-01_test");
      fs.mkdirSync(runFolder, { recursive: true });

      const initial = {
        slug: "test",
        telemetry: { outcome: "planned", exitCode: null },
      };
      fs.writeFileSync(
        path.join(runFolder, "run.json"),
        JSON.stringify(initial)
      );

      const updated = updateRunRecord(runFolder, {
        telemetry: { outcome: "applied", exitCode: 0 },
      });

      expect(updated.telemetry.outcome).toBe("applied");
      expect(updated.telemetry.exitCode).toBe(0);
    });

    it("throws when run.json does not exist", () => {
      const runFolder = path.join(tempDir, "nonexistent");

      expect(() => updateRunRecord(runFolder, { status: "validated" })).toThrow(
        "Run record not found"
      );
    });
  });
});
