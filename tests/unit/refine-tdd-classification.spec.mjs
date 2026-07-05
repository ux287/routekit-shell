/**
 * Tests for TDD classification in refine.mjs
 *
 * Tests the story type inference and TDD applicability classification:
 * - Strong TDD fit: bugfix, fix, api, contract, validation, behavior
 * - Moderate TDD fit: feature, refactor
 * - Poor TDD fit: spike, exploration, ui, visual, performance, infrastructure, llm
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

function makeTempProject(storyId, storyContent, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-tdd-class-test-"));
  const notesDir = path.join(dir, "notes");
  fs.mkdirSync(notesDir, { recursive: true });

  // Write the story
  fs.writeFileSync(path.join(notesDir, `${storyId}.md`), storyContent);

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

describe("TDD classification", () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot) cleanup(projectRoot);
  });

  describe("story type inference from problemId", () => {
    it("classifies .fix. as bugfix with strong TDD fit", async () => {
      projectRoot = makeTempProject("backlog.fix.broken-auth", `---
id: backlog.fix.broken-auth
title: Fix broken auth
targetFiles:
  - "src/auth.mjs"
---
## Problem
Auth is broken.
`, { "src/auth.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.fix.broken-auth",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("bugfix");
      expect(result.analysis.tddApplicable).toBe("strong");
    });

    it("classifies .bug. as bugfix with strong TDD fit", async () => {
      projectRoot = makeTempProject("backlog.bug.login-fails", `---
id: backlog.bug.login-fails
title: Login fails
targetFiles:
  - "src/login.mjs"
---
## Problem
Login is failing.
`, { "src/login.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.bug.login-fails",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("bugfix");
      expect(result.analysis.tddApplicable).toBe("strong");
    });

    it("classifies .feat. as feature with moderate TDD fit", async () => {
      projectRoot = makeTempProject("backlog.feat.new-button", `---
id: backlog.feat.new-button
title: Add new button
targetFiles:
  - "src/button.mjs"
---
## Problem
Need a button.
`, { "src/button.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.feat.new-button",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("feature");
      expect(result.analysis.tddApplicable).toBe("moderate");
    });

    it("classifies .refactor. as refactor with moderate TDD fit", async () => {
      projectRoot = makeTempProject("backlog.refactor.cleanup", `---
id: backlog.refactor.cleanup
title: Cleanup code
targetFiles:
  - "src/utils.mjs"
---
## Problem
Code is messy.
`, { "src/utils.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.refactor.cleanup",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("refactor");
      expect(result.analysis.tddApplicable).toBe("moderate");
    });

    it("classifies .spike. as exploration with poor TDD fit", async () => {
      projectRoot = makeTempProject("backlog.spike.new-tech", `---
id: backlog.spike.new-tech
title: Explore new tech
targetFiles:
  - "src/experiment.mjs"
---
## Problem
Need to evaluate a new approach.
`, { "src/experiment.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.spike.new-tech",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("exploration");
      expect(result.analysis.tddApplicable).toBe("poor");
    });

    it("classifies .explore. as exploration with poor TDD fit", async () => {
      projectRoot = makeTempProject("backlog.explore.options", `---
id: backlog.explore.options
title: Explore options
targetFiles:
  - "src/poc.mjs"
---
## Problem
Looking at different options.
`, { "src/poc.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.explore.options",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("exploration");
      expect(result.analysis.tddApplicable).toBe("poor");
    });

    it("classifies .perf. as performance with poor TDD fit", async () => {
      projectRoot = makeTempProject("backlog.perf.optimize", `---
id: backlog.perf.optimize
title: Optimize performance
targetFiles:
  - "src/hot-path.mjs"
---
## Problem
Need to improve performance.
`, { "src/hot-path.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.perf.optimize",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("performance");
      expect(result.analysis.tddApplicable).toBe("poor");
    });

    it("classifies .infra. as infrastructure with poor TDD fit", async () => {
      projectRoot = makeTempProject("backlog.infra.setup-ci", `---
id: backlog.infra.setup-ci
title: Setup CI
targetFiles:
  - ".github/workflows/ci.yml"
---
## Problem
Need CI pipeline.
`, { ".github/workflows/ci.yml": "# ci" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.infra.setup-ci",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("infrastructure");
      expect(result.analysis.tddApplicable).toBe("poor");
    });
  });

  describe("story type inference from body content", () => {
    it("infers bugfix from body mentioning bug and fix", async () => {
      projectRoot = makeTempProject("backlog.task.auth-issue", `---
id: backlog.task.auth-issue
title: Auth Issue
targetFiles:
  - "src/auth.mjs"
---
## Problem
There's a bug in the login that needs to be fixed.
`, { "src/auth.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.auth-issue",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("bugfix");
      expect(result.analysis.tddApplicable).toBe("strong");
    });

    it("infers api from body mentioning api contract", async () => {
      projectRoot = makeTempProject("backlog.task.user-endpoint", `---
id: backlog.task.user-endpoint
title: User Endpoint
targetFiles:
  - "src/api.mjs"
---
## Problem
Need to establish an API contract for user endpoints.
`, { "src/api.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.user-endpoint",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("api");
      expect(result.analysis.tddApplicable).toBe("strong");
    });

    it("infers validation from body mentioning validate", async () => {
      projectRoot = makeTempProject("backlog.task.input-check", `---
id: backlog.task.input-check
title: Input Check
targetFiles:
  - "src/form.mjs"
---
## Problem
Need to validate user input before submission.
`, { "src/form.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.input-check",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("validation");
      expect(result.analysis.tddApplicable).toBe("strong");
    });

    it("infers refactor from body mentioning refactor", async () => {
      projectRoot = makeTempProject("backlog.task.cleanup-code", `---
id: backlog.task.cleanup-code
title: Cleanup Code
targetFiles:
  - "src/old.mjs"
---
## Problem
Need to refactor this legacy code.
`, { "src/old.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.cleanup-code",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("refactor");
      expect(result.analysis.tddApplicable).toBe("moderate");
    });

    it("infers exploration from body mentioning spike", async () => {
      projectRoot = makeTempProject("backlog.task.research", `---
id: backlog.task.research
title: Research
targetFiles:
  - "src/poc.mjs"
---
## Problem
Need to do a spike on this new framework.
`, { "src/poc.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.research",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("exploration");
      expect(result.analysis.tddApplicable).toBe("poor");
    });
  });

  describe("explicit storyType in frontmatter", () => {
    it("uses storyType from frontmatter when present", async () => {
      projectRoot = makeTempProject("backlog.task.custom", `---
id: backlog.task.custom
title: Custom Story
storyType: api
targetFiles:
  - "src/endpoint.mjs"
---
## Problem
Some work.
`, { "src/endpoint.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.task.custom",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("api");
      expect(result.analysis.tddApplicable).toBe("strong");
    });
  });

  describe("tddReason explanations", () => {
    it("provides strong TDD reason for bugfix", async () => {
      projectRoot = makeTempProject("backlog.fix.test", `---
id: backlog.fix.test
title: Test fix
targetFiles:
  - "src/test.mjs"
---
Fix it.
`, { "src/test.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.fix.test",
      });

      expect(result.analysis.tddReason).toContain("write tests first");
    });

    it("provides moderate TDD reason for feature", async () => {
      projectRoot = makeTempProject("backlog.feat.test", `---
id: backlog.feat.test
title: Test feature
targetFiles:
  - "src/test.mjs"
---
Add it.
`, { "src/test.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.feat.test",
      });

      expect(result.analysis.tddReason).toContain("may need iteration");
    });

    it("provides poor TDD reason for spike", async () => {
      projectRoot = makeTempProject("backlog.spike.test", `---
id: backlog.spike.test
title: Test spike
targetFiles:
  - "src/test.mjs"
---
Explore it.
`, { "src/test.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.spike.test",
      });

      expect(result.analysis.tddReason).toContain("defer testing");
    });
  });

  describe("default behavior", () => {
    it("defaults to feature with moderate TDD for unknown patterns", async () => {
      projectRoot = makeTempProject("backlog.misc.random-thing", `---
id: backlog.misc.random-thing
title: Random thing
targetFiles:
  - "src/thing.mjs"
---
## Problem
Just some work.
`, { "src/thing.mjs": "// code" });

      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.misc.random-thing",
      });

      expect(result.ok).toBe(true);
      expect(result.analysis.storyType).toBe("feature");
      expect(result.analysis.tddApplicable).toBe("moderate");
    });
  });
});
