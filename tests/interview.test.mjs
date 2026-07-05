import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  runInterview,
  getInterviewState,
  saveInterviewState,
  INTERVIEW_QUESTIONS,
  TYPE_DESCRIPTIONS,
  STACK_DESCRIPTIONS,
} from "../packages/mcp-rks/src/server/interview.mjs";

describe("interview module", () => {
  let tempDir;
  let projectRoot;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "interview-test-"));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Create a fresh project root for each test
    projectRoot = path.join(tempDir, `project-${Date.now()}`);
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  describe("getInterviewState", () => {
    it("returns needsOnboarding true for new project", () => {
      const state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBe(true);
    });

    it("returns saved state when exists", () => {
      const stateDir = path.join(projectRoot, ".routekit");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "state.json"),
        JSON.stringify({ needsOnboarding: false, custom: "value" })
      );

      const state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBe(false);
      expect(state.custom).toBe("value");
    });
  });

  describe("saveInterviewState", () => {
    it("creates .routekit directory if needed", () => {
      saveInterviewState(projectRoot, { needsOnboarding: true });
      expect(fs.existsSync(path.join(projectRoot, ".routekit"))).toBe(true);
    });

    it("persists state correctly", () => {
      saveInterviewState(projectRoot, { needsOnboarding: false, testKey: "testValue" });
      const state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBe(false);
      expect(state.testKey).toBe("testValue");
    });
  });

  describe("runInterview", () => {
    it("returns first question when no responses", async () => {
      const result = await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {},
      });

      expect(result.complete).toBe(false);
      expect(result.nextQuestion).toBeDefined();
      expect(result.nextQuestion.key).toBe("project_type");
    });

    it("returns next unanswered question", async () => {
      const result = await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {
          project_type: "web_app",
        },
      });

      expect(result.complete).toBe(false);
      expect(result.nextQuestion.key).toBe("one_liner");
    });

    it("completes when all questions answered", async () => {
      const result = await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {
          project_type: "web_app",
          one_liner: "A test project",
          tech_stack: "react_ts",
          github_setup: "skip",
        },
      });

      expect(result.complete).toBe(true);
      expect(result.notesCreated).toContain("project.overview.md");
      expect(result.welcomeMessage).toBeDefined();
    });

    it("creates project.overview.md on completion", async () => {
      await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {
          project_type: "api",
          one_liner: "An API service",
          tech_stack: "node_api",
          github_setup: "skip",
        },
      });

      const notePath = path.join(projectRoot, "notes", "project.overview.md");
      expect(fs.existsSync(notePath)).toBe(true);

      const content = fs.readFileSync(notePath, "utf8");
      expect(content).toContain("An API service");
      expect(content).toContain("A backend API service");
    });

    it("resets interview state when reset=true", async () => {
      // First complete the interview
      await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {
          project_type: "cli",
          one_liner: "A CLI tool",
          tech_stack: "node_api",
          github_setup: "skip",
        },
      });

      // Verify onboarding is complete
      let state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBeUndefined();

      // Reset
      const result = await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {},
        reset: true,
      });

      expect(result.reset).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.nextQuestion.key).toBe("project_type");

      state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBe(true);
    });

    it("clears needsOnboarding flag on completion", async () => {
      // Set up initial state
      saveInterviewState(projectRoot, { needsOnboarding: true });

      await runInterview({
        projectId: "test-project",
        projectRoot,
        responses: {
          project_type: "library",
          one_liner: "A reusable library",
          tech_stack: "react_ts",
          github_setup: "skip",
        },
      });

      const state = getInterviewState(projectRoot);
      expect(state.needsOnboarding).toBeUndefined();
    });
  });

  describe("constants", () => {
    it("INTERVIEW_QUESTIONS has all required questions", () => {
      const keys = INTERVIEW_QUESTIONS.map(q => q.key);
      expect(keys).toContain("project_type");
      expect(keys).toContain("one_liner");
      expect(keys).toContain("tech_stack");
      expect(keys).toContain("github_setup");
    });

    it("TYPE_DESCRIPTIONS covers all project types", () => {
      const projectTypeOptions = INTERVIEW_QUESTIONS.find(q => q.key === "project_type").options;
      for (const opt of projectTypeOptions) {
        expect(TYPE_DESCRIPTIONS[opt]).toBeDefined();
      }
    });

    it("STACK_DESCRIPTIONS covers all tech stacks", () => {
      const stackOptions = INTERVIEW_QUESTIONS.find(q => q.key === "tech_stack").options;
      for (const opt of stackOptions) {
        expect(STACK_DESCRIPTIONS[opt]).toBeDefined();
      }
    });
  });
});
