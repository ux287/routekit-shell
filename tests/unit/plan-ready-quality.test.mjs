import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

describe("plan-ready quality gates", () => {
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
    projectRoot = makeTempDir("plan-ready-quality");
    notesDir = path.join(projectRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
  });

  describe("telemetry section check", () => {
    it("warns when telemetry section is missing", async () => {
      writeStory("backlog.qa.no-telemetry", {
        id: "backlog.qa.no-telemetry",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Testing Requirements\n- [ ] Test it\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.no-telemetry",
      });

      const telemetryWarning = result.warnings.find(w => w.check === "missing_telemetry");
      expect(telemetryWarning).toBeTruthy();
      expect(telemetryWarning.message).toContain("Telemetry");
    });

    it("does not warn when telemetry section is present", async () => {
      writeStory("backlog.qa.has-telemetry", {
        id: "backlog.qa.has-telemetry",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Telemetry\n- event.start\n\n## Testing Requirements\n- [ ] Test it\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.has-telemetry",
      });

      const telemetryWarning = result.warnings.find(w => w.check === "missing_telemetry");
      expect(telemetryWarning).toBeUndefined();
    });

    it("does not warn when skipTelemetry is true", async () => {
      writeStory("backlog.qa.skip-telemetry", {
        id: "backlog.qa.skip-telemetry",
        phase: "ready",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nDocs only.\n\n## Testing Requirements\n- [ ] Test it\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.skip-telemetry",
      });

      const telemetryWarning = result.warnings.find(w => w.check === "missing_telemetry");
      expect(telemetryWarning).toBeUndefined();
    });
  });

  describe("testing requirements check", () => {
    it("blocks when testing requirements section is missing", async () => {
      writeStory("backlog.qa.no-testing", {
        id: "backlog.qa.no-testing",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nNo tests.\n\n## Telemetry\n- event.x\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.no-testing",
      });

      expect(result.ready).toBe(false);
      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeTruthy();
    });

    it("passes with testExempt: true", async () => {
      writeStory("backlog.qa.exempt", {
        id: "backlog.qa.exempt",
        phase: "ready",
        testExempt: true,
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nDocs only.\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.exempt",
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });

    it("passes with testFile in frontmatter", async () => {
      writeStory("backlog.qa.has-testfile", {
        id: "backlog.qa.has-testfile",
        phase: "ready",
        testFile: "tests/unit/my-feature.test.mjs",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nHas testFile.\n\n## Telemetry\n- event.x\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.has-testfile",
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });
  });

  describe("testing requirements quality checks", () => {
    it("warns when testing requirements has only 1 checkbox item", async () => {
      writeStory("backlog.qa.shallow-tests", {
        id: "backlog.qa.shallow-tests",
        phase: "ready",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Testing Requirements\n- [ ] Test that it works\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.shallow-tests",
      });

      const shallowWarning = result.warnings.find(w => w.check === "shallow_testing_requirements");
      expect(shallowWarning).toBeTruthy();
      expect(shallowWarning.checkboxCount).toBe(1);
    });

    it("does not warn when testing requirements has 2+ checkbox items", async () => {
      writeStory("backlog.qa.good-tests", {
        id: "backlog.qa.good-tests",
        phase: "ready",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Testing Requirements\n- [ ] Test that it works with valid input\n- [ ] Test that it throws when input is missing\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.good-tests",
      });

      const shallowWarning = result.warnings.find(w => w.check === "shallow_testing_requirements");
      expect(shallowWarning).toBeUndefined();
    });

    it("warns when testing requirements has no error-path keywords", async () => {
      writeStory("backlog.qa.no-error-tests", {
        id: "backlog.qa.no-error-tests",
        phase: "ready",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Testing Requirements\n- [ ] Test that widget is created\n- [ ] Test that widget has correct name\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.no-error-tests",
      });

      const errorWarning = result.warnings.find(w => w.check === "no_error_path_tests");
      expect(errorWarning).toBeTruthy();
    });

    it("does not warn when testing requirements mentions error-path scenarios", async () => {
      writeStory("backlog.qa.has-error-tests", {
        id: "backlog.qa.has-error-tests",
        phase: "ready",
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nSomething.\n\n## Testing Requirements\n- [ ] Test that widget is created\n- [ ] Test that widget throws when name is invalid\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.has-error-tests",
      });

      const errorWarning = result.warnings.find(w => w.check === "no_error_path_tests");
      expect(errorWarning).toBeUndefined();
    });

    it("skips quality checks when testExempt is true", async () => {
      writeStory("backlog.qa.exempt-quality", {
        id: "backlog.qa.exempt-quality",
        phase: "ready",
        testExempt: true,
        skipTelemetry: true,
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nDocs only.\n\n## Testing Requirements\n- [ ] Just one thing\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.exempt-quality",
      });

      const shallowWarning = result.warnings.find(w => w.check === "shallow_testing_requirements");
      const errorWarning = result.warnings.find(w => w.check === "no_error_path_tests");
      expect(shallowWarning).toBeUndefined();
      expect(errorWarning).toBeUndefined();
    });
  });

  describe("malformed SEARCH/REPLACE detection", () => {
    it("warns when SEARCH marker is inside code block", async () => {
      writeStory("backlog.qa.bad-search", {
        id: "backlog.qa.bad-search",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, `## Problem\nBad format.\n\n\`\`\`javascript\n// SEARCH: old code\nconst x = 1;\n\`\`\`\n\n## Testing Requirements\n- [ ] Test it\n\n## Telemetry\n- event.x\n`);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "// placeholder");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.bad-search",
      });

      const searchWarning = result.warnings.find(w => w.check === "search_replace_format");
      expect(searchWarning).toBeTruthy();
      expect(searchWarning.message).toContain("SEARCH marker");
    });

    it("does not warn when SEARCH markers are correctly outside code blocks", async () => {
      const body = `## Problem\nGood format.\n\nSEARCH:\n\`\`\`javascript\nconst x = 1;\n\`\`\`\n\nREPLACE:\n\`\`\`javascript\nconst x = 2;\n\`\`\`\n\n## Testing Requirements\n- [ ] Test it\n\n## Telemetry\n- event.x\n`;

      writeStory("backlog.qa.good-search", {
        id: "backlog.qa.good-search",
        phase: "ready",
        targetFiles: ["packages/mcp-rks/src/dendron.mjs"],
      }, body);

      const targetDir = path.join(projectRoot, "packages/mcp-rks/src");
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "dendron.mjs"), "const x = 1;");

      const result = await runPlanReadyTool({
        projectRoot,
        problemId: "backlog.qa.good-search",
      });

      const searchWarning = result.warnings.find(w => w.check === "search_replace_format");
      expect(searchWarning).toBeUndefined();
    });
  });
});
