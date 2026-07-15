/**
 * Tests for plan-ready.mjs — frontmatter op:create satisfies create directive check
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runPlanReadyTool } from "../../packages/mcp-rks/src/server/plan-ready.mjs";

function makeTempProject(storyContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-plan-ready-create-test-"));
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, "backlog.test-story.md"), storyContent);
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
}

describe("plan-ready: frontmatter op:create satisfies create directive check", () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
  });

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

  it("non-existent target with op:edit and no body directive produces missing_create_directive", async () => {
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

  it("non-existent target with body CREATE FILE directive only (no frontmatter op:create) passes", async () => {
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
