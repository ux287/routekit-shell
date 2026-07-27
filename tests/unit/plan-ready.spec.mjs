/**
 * Tests for plan-ready.mjs validation
 *
 * Tests the story readiness gate including:
 * - Testing Requirements detection
 * - testFile frontmatter recognition
 * - testExempt escape hatch
 * - Phase validation
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

function makeTempProject(storyContent, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-ready-test-"));
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });

  // Write the story
  fs.writeFileSync(path.join(notesDir, "backlog.test-story.md"), storyContent);

  // Write any additional files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
}

describe("plan-ready validation", () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
  });

  describe("Testing Requirements check", () => {
    it("rejects story without Testing Requirements or testFile", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - "src/foo.mjs"
---
## Problem
Some problem.

## Goal
Some goal.

## Acceptance Criteria
- [ ] Done
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      expect(result.ready).toBe(false);
      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeTruthy();
    });

    it("accepts story with Testing Requirements section", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - "src/foo.mjs"
---
## Problem
Some problem.

## Goal
Some goal.

## Acceptance Criteria
- [ ] Done

## Testing Requirements
- [ ] Unit test for foo
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });

    it("accepts story with testFile frontmatter", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - "src/foo.mjs"
testFile: tests/unit/foo.spec.mjs
---
## Problem
Some problem.

## Goal
Some goal.

## Acceptance Criteria
- [ ] Done
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });

    it("accepts story with testExempt: true", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - "src/foo.mjs"
testExempt: true
---
## Problem
Doc-only change.

## Goal
Update docs.

## Acceptance Criteria
- [ ] Done
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      const testIssue = result.issues.find(i => i.check === "missing_testing_requirements");
      expect(testIssue).toBeUndefined();
    });
  });

  describe("phase validation", () => {
    it("rejects draft phase", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: draft
targetFiles:
  - "src/foo.mjs"
testFile: tests/foo.spec.mjs
---
## Problem
Problem.
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      expect(result.ready).toBe(false);
      const phaseIssue = result.issues.find(i => i.check === "phase_status");
      expect(phaseIssue).toBeTruthy();
      expect(phaseIssue.currentPhase).toBe("draft");
    });

    it("accepts ready phase", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - "src/foo.mjs"
testFile: tests/foo.spec.mjs
---
## Problem
Problem.
`, { "src/foo.mjs": "// code" });

      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });

      const phaseIssue = result.issues.find(i => i.check === "phase_status");
      expect(phaseIssue).toBeUndefined();
    });
  });

  describe("story not found", () => {
    it("returns error for missing story", async () => {
      projectRoot = makeTempProject("", {});
      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.nonexistent",
        projectRoot,
      });

      expect(result.ready).toBe(false);
      expect(result.issues[0].check).toBe("story_exists");
    });
  });

  describe("frontmatter op:create satisfies create directive check", () => {
    it("story with op:create in frontmatter targetFiles and no body directive passes", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "create"
testRequirements:
  - "Test that new-file.mjs is created correctly"
---
## Problem
Need a new file.

## Telemetry
None.
`);
      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });
      const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
      expect(createIssues).toHaveLength(0);
    });

    it("story with op:create in frontmatter AND body CREATE FILE directive passes (no regression)", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "create"
testRequirements:
  - "Test that new-file.mjs is created correctly"
---
## Problem
Need a new file.

// CREATE FILE: src/new-file.mjs

## Telemetry
None.
`);
      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });
      const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
      expect(createIssues).toHaveLength(0);
    });

    it("non-existent target with no op:create and no body directive produces missing_create_directive", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "edit"
testRequirements:
  - "Test something"
---
## Problem
Something.

## Telemetry
None.
`);
      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });
      const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
      expect(createIssues.length).toBeGreaterThan(0);
    });

    it("non-existent target with body CREATE FILE directive only (no frontmatter op) passes", async () => {
      projectRoot = makeTempProject(`---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/new-file.mjs"
    op: "edit"
testRequirements:
  - "Test something"
---
## Problem
Something.

// CREATE FILE: src/new-file.mjs

## Telemetry
None.
`);
      const result = await runPlanReadyTool({
        projectId: "test",
        problemId: "backlog.test-story",
        projectRoot,
      });
      const createIssues = result.issues.filter(i => i.check === "missing_create_directive");
      expect(createIssues).toHaveLength(0);
    });
  });

  describe("multi_file_blocked — acknowledge_multi_file suggestion", () => {
    function makeMultiFileStory(multiFileAcknowledged) {
      const extra = multiFileAcknowledged ? "\nmultiFileAcknowledged: true" : "";
      return `---
id: backlog.test-story
title: Test Story
phase: ready${extra}
targetFiles:
  - path: "src/a.mjs"
    op: "edit"
  - path: "src/b.mjs"
    op: "edit"
  - path: "src/c.mjs"
    op: "edit"
testRequirements:
  - "Test something"
---
## Problem
Something.

## Telemetry
None.
`;
    }

    it("multi_file_blocked is an issue when multiFileAcknowledged is absent", async () => {
      projectRoot = makeTempProject(makeMultiFileStory(false));
      const result = await runPlanReadyTool({
        projectId: "test", problemId: "backlog.test-story", projectRoot,
      });
      const blocked = result.issues.find(i => i.check === "multi_file_blocked");
      expect(blocked).toBeDefined();
    });

    it("multi_file_blocked suggestion mentions acknowledge_multi_file", async () => {
      projectRoot = makeTempProject(makeMultiFileStory(false));
      const result = await runPlanReadyTool({
        projectId: "test", problemId: "backlog.test-story", projectRoot,
      });
      const blocked = result.issues.find(i => i.check === "multi_file_blocked");
      expect(blocked.suggestion).toContain("acknowledge_multi_file");
    });

    it("multi_file_blocked is a warning (not issue) when multiFileAcknowledged is true", async () => {
      projectRoot = makeTempProject(makeMultiFileStory(true));
      const result = await runPlanReadyTool({
        projectId: "test", problemId: "backlog.test-story", projectRoot,
      });
      const blockedIssue = result.issues.find(i => i.check === "multi_file_blocked");
      const multiWarn = result.warnings.find(w => w.check === "multi_file_story");
      expect(blockedIssue).toBeUndefined();
      expect(multiWarn).toBeDefined();
    });
  });
});
