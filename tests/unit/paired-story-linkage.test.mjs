import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rks-test-${prefix}-`));
}

describe("Paired story linkage", () => {
  let projectRoot;
  let notesDir;

  function writeStory(filename, frontmatter, body) {
    const fmLines = Object.entries(frontmatter).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
      if (typeof v === "boolean") return `${k}: ${v}`;
      return `${k}: "${v}"`;
    });
    const content = `---\n${fmLines.join("\n")}\n---\n\n${body}`;
    fs.writeFileSync(path.join(notesDir, `${filename}.md`), content);
  }

  beforeEach(() => {
    projectRoot = makeTempDir("paired-story");
    notesDir = path.join(projectRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
  });

  describe("plan-quality: checkTestCoverage skip", () => {
    it("warns about missing test coverage when no testStory", async () => {
      const tmpFile = path.join(projectRoot, "src", "foo.mjs");
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(tmpFile, "export function foo() {}");

      const plan = {
        steps: [{
          action: "search_replace",
          path: "src/foo.mjs",
          edits: [{ search: "export function foo() {}", replace: "export function foo() { return 1; }" }],
        }],
      };

      const result = await reviewPlan({ projectRoot, plan });
      const testWarning = result.warnings.find(w => w.check === "no_test_coverage");
      expect(testWarning).toBeTruthy();
    });

    it("skips test coverage warning when storyMeta.testStory is set", async () => {
      const tmpFile = path.join(projectRoot, "src", "foo.mjs");
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(tmpFile, "export function foo() {}");

      const plan = {
        steps: [{
          action: "search_replace",
          path: "src/foo.mjs",
          edits: [{ search: "export function foo() {}", replace: "export function foo() { return 1; }" }],
        }],
      };

      const result = await reviewPlan({
        projectRoot,
        plan,
        storyMeta: { testStory: "backlog.feat.foo.tests" },
      });
      const testWarning = result.warnings.find(w => w.check === "no_test_coverage");
      expect(testWarning).toBeUndefined();
    });
  });

  describe("plan-ready: testStory exemptions", () => {
    it("blocks when no testing requirements and no testStory", async () => {
      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      writeStory("backlog.feat.no-tests", {
        id: "backlog.feat.no-tests",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, "## Problem\nSomething.\n\n## Telemetry\n- event.start\n");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.feat.no-tests",
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeTruthy();
    });

    it("skips testing requirements check when testStory is set", async () => {
      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      writeStory("backlog.feat.has-test-story", {
        id: "backlog.feat.has-test-story",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
        testStory: "backlog.feat.has-test-story.tests",
      }, "## Problem\nSomething.\n\n## Telemetry\n- event.start\n");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.feat.has-test-story",
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });

    it("skips no_test_files warning when testStory is set", async () => {
      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      writeStory("backlog.feat.paired-no-test-files", {
        id: "backlog.feat.paired-no-test-files",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
        testStory: "backlog.feat.paired-no-test-files.tests",
      }, "## Problem\nSomething.\n\n## Telemetry\n- event.start\n");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.feat.paired-no-test-files",
      });

      const noTestFiles = result.warnings.find(w => w.check === "no_test_files");
      expect(noTestFiles).toBeUndefined();
    });
  });
});
