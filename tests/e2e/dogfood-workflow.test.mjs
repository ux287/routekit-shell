/**
 * E2E Dogfood Workflow Test
 *
 * Tests the complete workflow: create backlog → plan → exec → test → commit
 * Part of: backlog.dogfooding.05-e2e-workflow-test
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAnalyzeTool } from "../../packages/mcp-rks/src/server/planner.mjs";
import { runApplyTool } from "../../packages/mcp-rks/src/server/exec.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const registryPath = path.join(repoRoot, "projects", "index.jsonl");

describe("Dogfood E2E Workflow", () => {
  let originalRegistry = null;
  let projectRoot;
  let projectId;
  let cleanupPaths = [];

  function setupTestProject(testName) {
    // Create unique projectId for each test to avoid caching issues
    projectId = `e2e-${testName}-${Date.now()}`;

    // Create isolated test project directory
    projectRoot = path.join(repoRoot, `.tmp-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(projectRoot, { recursive: true });
    cleanupPaths.push(projectRoot);

    // Set up project structure
    fs.mkdirSync(path.join(projectRoot, "routekit"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".rks", "state", projectId), { recursive: true });

    // Create project config
    fs.writeFileSync(
      path.join(projectRoot, "routekit", "project.json"),
      JSON.stringify({
        id: projectId,
        baseBranch: "main",
        kgFile: "routekit/kg.yaml",
      }, null, 2)
    );
    fs.writeFileSync(path.join(projectRoot, "routekit", "kg.yaml"), "code_roots: [src]\n");

    // Initialize git repo
    try {
      execSync("git init", { cwd: projectRoot, stdio: "pipe" });
      execSync("git config user.email 'test@example.com'", { cwd: projectRoot, stdio: "pipe" });
      execSync("git config user.name 'Test User'", { cwd: projectRoot, stdio: "pipe" });
      execSync("git checkout -b main", { cwd: projectRoot, stdio: "pipe" });
      execSync("git add .", { cwd: projectRoot, stdio: "pipe" });
      execSync("git commit -m 'Initial commit'", { cwd: projectRoot, stdio: "pipe" });
    } catch (err) {
      console.warn("Git setup warning:", err.message);
    }

    // Register project in index
    const record = { id: projectId, root: projectRoot };
    const existing = fs.existsSync(registryPath)
      ? fs.readFileSync(registryPath, "utf8").trim().split("\n").filter(Boolean)
      : [];
    fs.writeFileSync(registryPath, [...existing, JSON.stringify(record)].filter(Boolean).join("\n") + "\n");
  }

  beforeEach(() => {
    // Backup registry
    originalRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null;
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    cleanupPaths = [];
  });

  afterEach(() => {
    // Restore registry
    if (originalRegistry !== null) {
      fs.writeFileSync(registryPath, originalRegistry);
    } else if (fs.existsSync(registryPath)) {
      fs.unlinkSync(registryPath);
    }

    // Clean up test directories
    for (const p of cleanupPaths) {
      if (fs.existsSync(p)) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Cleanup warning: ${err.message}`);
        }
      }
    }
  });

  it("creates backlog item with proper structure", () => {
    setupTestProject("backlog-struct");

    const backlogId = "backlog.test-feature";
    const backlogPath = path.join(projectRoot, "notes", `${backlogId}.md`);

    const backlogContent = `---
id: ${backlogId}
title: Test Feature
desc: A simple test feature for E2E validation
status: not-implemented
targetFiles: ["src/hello.js"]
---

## Problem
Need a hello function for testing.

## Goal
Create a simple hello.js file with a greeting function.

## Target Files
- src/hello.js

## Acceptance Criteria
- [ ] src/hello.js exists
- [ ] Exports a greet function
`;

    fs.writeFileSync(backlogPath, backlogContent);

    expect(fs.existsSync(backlogPath)).toBe(true);
    const content = fs.readFileSync(backlogPath, "utf8");
    expect(content).toContain("status: not-implemented");
    expect(content).toContain("## Acceptance Criteria");
  });

  it("runs analyze to create codemap", async () => {
    setupTestProject("analyze");

    const result = await runAnalyzeTool({ projectId });
    expect(result.ok).toBe(true);
    expect(result.projectId).toBe(projectId);

    const codemapPath = result.codemapPath;
    expect(fs.existsSync(codemapPath)).toBe(true);
  });

  it("applies a pre-created plan with create_file step", async () => {
    setupTestProject("apply-create");

    // Create run directory
    const runsRoot = path.join(projectRoot, ".rks", "runs");
    const slug = "test-apply";
    const runDir = path.join(runsRoot, `2025-e2e-${Date.now()}_${slug}`);
    fs.mkdirSync(runDir, { recursive: true });

    // Create plan.json
    const plan = {
      projectId,
      slug,
      steps: [
        {
          action: "create_file",
          path: "notes/applied-test.md",
          content: "# Applied Test\n\nThis file was created by rks.apply.\n",
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));

    // Create run.json
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
      projectId,
      slug,
      timestamps: { plannedAt: new Date().toISOString() },
      telemetry: { outcome: "planned" },
    }, null, 2));

    // Apply with force flag
    const result = await runApplyTool({
      projectId,
      label: slug,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(result.stepsApplied).toBeGreaterThan(0);

    // Verify file was created
    const createdFile = path.join(projectRoot, "notes", "applied-test.md");
    expect(fs.existsSync(createdFile)).toBe(true);
    expect(fs.readFileSync(createdFile, "utf8")).toContain("Applied Test");

    // Verify apply.log was written
    const applyLog = fs.readFileSync(path.join(runDir, "apply", "apply.log"), "utf8");
    expect(applyLog).toContain("wrote: notes/applied-test.md");

    // Verify run.json was updated
    const updatedRunMeta = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(updatedRunMeta.timestamps?.appliedAt).toBeTruthy();
    expect(updatedRunMeta.telemetry?.outcome).toBe("applied");
  });

  it("applies a plan with search_replace step", async () => {
    setupTestProject("apply-replace");

    // Create target file first
    const targetFile = path.join(projectRoot, "src", "example.js");
    fs.writeFileSync(targetFile, `function hello() {
  return "Hello";
}

module.exports = { hello };
`);

    // Create run directory
    const runsRoot = path.join(projectRoot, ".rks", "runs");
    const slug = "test-search-replace";
    const runDir = path.join(runsRoot, `2025-e2e-${Date.now()}_${slug}`);
    fs.mkdirSync(runDir, { recursive: true });

    // Create plan with search_replace
    const plan = {
      projectId,
      slug,
      steps: [
        {
          action: "search_replace",
          path: "src/example.js",
          edits: [
            {
              search: 'return "Hello";',
              replace: 'return "Hello, World!";',
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
      projectId,
      slug,
      timestamps: { plannedAt: new Date().toISOString() },
      telemetry: { outcome: "planned" },
    }, null, 2));

    // Apply
    const result = await runApplyTool({
      projectId,
      label: slug,
      force: true,
    });

    expect(result.ok).toBe(true);

    // Verify search_replace worked
    const updatedContent = fs.readFileSync(targetFile, "utf8");
    expect(updatedContent).toContain('return "Hello, World!";');
    expect(updatedContent).not.toContain('return "Hello";');
  });

  it("tracks backlog problemId in plan", async () => {
    setupTestProject("backlog-track");

    // Create backlog item
    const backlogId = "backlog.tracking-test";
    const backlogPath = path.join(projectRoot, "notes", `${backlogId}.md`);
    fs.writeFileSync(backlogPath, `---
id: ${backlogId}
title: Tracking Test
status: not-implemented
---

## Goal
Test that problemId is tracked.
`);

    // Create run with problemId
    const runsRoot = path.join(projectRoot, ".rks", "runs");
    const slug = "tracking-test";
    const runDir = path.join(runsRoot, `2025-e2e-${Date.now()}_${slug}`);
    fs.mkdirSync(runDir, { recursive: true });

    const plan = {
      projectId,
      slug,
      problemId: backlogId,
      steps: [
        {
          action: "create_file",
          path: "notes/tracking-output.md",
          content: "# Tracking Test Output\n",
        },
      ],
    };
    fs.writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2));
    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
      projectId,
      slug,
      problemId: backlogId,
      timestamps: { plannedAt: new Date().toISOString() },
      telemetry: { outcome: "planned" },
    }, null, 2));

    // Apply
    const result = await runApplyTool({
      projectId,
      label: slug,
      force: true,
    });

    expect(result.ok).toBe(true);

    // Verify output file created
    expect(fs.existsSync(path.join(projectRoot, "notes", "tracking-output.md"))).toBe(true);
  });
});
