/**
 * Tests for mustEditPaths extraction, buildPrompt exclusion, and post-generation filtering.
 *
 * Covers:
 * - extractMustEditPaths: op:edit frontmatter signal
 * - extractMustEditPaths: @@SEARCH block signal
 * - extractMustEditPaths: does not require file to exist on disk
 * - buildPrompt: mustEditPaths excluded from REQUIRED CREATE_FILE STEPS
 * - buildPrompt: per-path prohibition instruction present
 * - filterMustEditSteps: removes create_file for mustEdit paths
 * - filterMustEditSteps: preserves non-mustEdit paths
 * - end-to-end: story with op:edit + stray create_file step filtered out
 */

import { describe, it, expect } from "vitest";
import { extractMustEditPaths, filterMustEditSteps } from "../../packages/mcp-rks/src/server/planner.mjs";
import { buildPrompt } from "../../packages/mcp-rks/src/llm/planner.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoryWithOpEdit(filePath) {
  return `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "${filePath}"
    op: "edit"
    desc: "Modify the existing file"
---

## Problem
Some problem.

## Goal
Some goal.
`;
}

function makeStoryWithOpCreate(filePath) {
  return `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "${filePath}"
    op: "create"
    desc: "Create a new file"
---

## Problem
Some problem.
`;
}

function makeStoryWithSearchBlock(filePath) {
  return `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "${filePath}"
---

## Problem
Some problem.

### ${filePath}

@@SEARCH
export function foo() {
@@REPLACE
export function foo(x) {
@@END
`;
}

function makeStoryNoSearchNoEdit(filePath) {
  return `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "${filePath}"
    op: "create"
---

## Problem
Need a new file.
`;
}

// ---------------------------------------------------------------------------
// extractMustEditPaths
// ---------------------------------------------------------------------------

describe("extractMustEditPaths", () => {
  describe("op:edit frontmatter signal", () => {
    it("includes path when targetFile has op:edit", () => {
      const content = makeStoryWithOpEdit("src/server/foo.mjs");
      const paths = extractMustEditPaths(content);
      expect(paths).toContain("src/server/foo.mjs");
    });

    it("does not include path when targetFile has op:create", () => {
      const content = makeStoryWithOpCreate("src/server/new-file.mjs");
      const paths = extractMustEditPaths(content);
      expect(paths).not.toContain("src/server/new-file.mjs");
    });

    it("extracts path even when the file does not exist on disk", () => {
      // Use a definitely-nonexistent path
      const fakePath = "src/totally-nonexistent-xyzzy/ghost.mjs";
      const content = makeStoryWithOpEdit(fakePath);
      const paths = extractMustEditPaths(content);
      expect(paths).toContain(fakePath);
    });

    it("handles multiple targetFiles, only returns op:edit ones", () => {
      const content = `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/edit-me.mjs"
    op: "edit"
  - path: "src/create-me.mjs"
    op: "create"
  - path: "tests/edit-test.mjs"
    op: "edit"
---

## Problem
Multiple targets.
`;
      const paths = extractMustEditPaths(content);
      expect(paths).toContain("src/edit-me.mjs");
      expect(paths).toContain("tests/edit-test.mjs");
      expect(paths).not.toContain("src/create-me.mjs");
    });
  });

  describe("@@SEARCH block signal", () => {
    it("includes path when story body contains @@SEARCH block under that path heading", () => {
      const content = makeStoryWithSearchBlock("packages/mcp-rks/src/server/exec.mjs");
      const paths = extractMustEditPaths(content);
      expect(paths).toContain("packages/mcp-rks/src/server/exec.mjs");
    });

    it("does not include path when no @@SEARCH block is present", () => {
      const content = makeStoryNoSearchNoEdit("src/brand-new-file.mjs");
      const paths = extractMustEditPaths(content);
      expect(paths).not.toContain("src/brand-new-file.mjs");
    });

    it("extracts @@SEARCH path even when the file does not exist on disk", () => {
      const fakePath = "src/nonexistent-with-search-block/ghost.mjs";
      const content = makeStoryWithSearchBlock(fakePath);
      const paths = extractMustEditPaths(content);
      expect(paths).toContain(fakePath);
    });
  });

  describe("combined signals", () => {
    it("includes path when both op:edit and @@SEARCH are present (no duplicates)", () => {
      const content = `---
id: backlog.test-story
title: Test Story
phase: ready
targetFiles:
  - path: "src/combined.mjs"
    op: "edit"
---

## Problem
Test.

### src/combined.mjs

@@SEARCH
existing code
@@REPLACE
new code
@@END
`;
      const paths = extractMustEditPaths(content);
      const combined = paths.filter(p => p === "src/combined.mjs");
      expect(combined.length).toBe(1); // deduplicated
    });

    it("returns empty array for content with no op:edit and no @@SEARCH", () => {
      const content = makeStoryNoSearchNoEdit("src/totally-new-file.mjs");
      const paths = extractMustEditPaths(content);
      expect(paths).toHaveLength(0);
    });

    it("returns empty array for empty content", () => {
      expect(extractMustEditPaths("")).toHaveLength(0);
      expect(extractMustEditPaths(null)).toHaveLength(0);
      expect(extractMustEditPaths(undefined)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — mustEditPaths parameter
// ---------------------------------------------------------------------------

describe("buildPrompt with mustEditPaths", () => {
  it("excludes mustEditPaths from REQUIRED CREATE_FILE STEPS block", () => {
    const mustEditPath = "src/existing-file.mjs";
    const createPath = "src/new-file.mjs";
    const prompt = buildPrompt({
      requirements: "Fix the existing file",
      uncoveredCreatePaths: [mustEditPath, createPath],
      mustEditPaths: [mustEditPath],
    });
    // mustEditPath should NOT appear in the REQUIRED CREATE_FILE STEPS
    // but createPath should
    const reqBlock = prompt.match(/REQUIRED CREATE_FILE STEPS[\s\S]*?(?=\n\n|\nContext:|$)/)?.[0] || "";
    expect(reqBlock).not.toContain(mustEditPath);
    expect(reqBlock).toContain(createPath);
  });

  it("includes per-path prohibition instruction for mustEditPaths", () => {
    const mustEditPath = "packages/mcp-rks/src/server/planner.mjs";
    const prompt = buildPrompt({
      requirements: "Update planner",
      mustEditPaths: [mustEditPath],
    });
    // The critical block should mention the path
    expect(prompt).toContain(mustEditPath);
    // And should include prohibition language
    expect(prompt).toMatch(/create_file IS FORBIDDEN|MUST USE search_replace/i);
  });

  it("mustEditPaths take precedence over uncoveredCreatePaths (mustEdit wins)", () => {
    const conflictPath = "src/ambiguous.mjs";
    const prompt = buildPrompt({
      requirements: "Ambiguous file",
      uncoveredCreatePaths: [conflictPath],
      mustEditPaths: [conflictPath],
    });
    // The path should appear in the prohibition block, NOT in REQUIRED CREATE_FILE STEPS
    const reqCreateBlock = prompt.match(/REQUIRED CREATE_FILE STEPS[\s\S]*?(?=\nContext:|$)/)?.[0] || "";
    expect(reqCreateBlock).not.toContain(conflictPath);
    // But it should be in the prohibition block
    expect(prompt).toContain(conflictPath);
  });

  it("generates prompt without prohibition block when mustEditPaths is empty and no liveContent", () => {
    const prompt = buildPrompt({
      requirements: "Create new file",
      mustEditPaths: [],
    });
    // Should not have the prohibition block (no paths to prohibit)
    expect(prompt).not.toMatch(/MUST USE search_replace — create_file IS FORBIDDEN/);
  });
});

// ---------------------------------------------------------------------------
// filterMustEditSteps
// ---------------------------------------------------------------------------

describe("filterMustEditSteps", () => {
  it("removes create_file step for a mustEdit path", () => {
    const steps = [
      { action: "create_file", path: "src/existing.mjs", content: "// wrong" },
      { action: "search_replace", path: "src/existing.mjs", edits: [{ search: "old", replace: "new" }] },
    ];
    const result = filterMustEditSteps(steps, ["src/existing.mjs"]);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("search_replace");
  });

  it("preserves non-mustEdit create_file steps (op:create paths pass through)", () => {
    const steps = [
      { action: "create_file", path: "src/brand-new.mjs", content: "// new file" },
      { action: "search_replace", path: "src/existing.mjs", edits: [] },
    ];
    const result = filterMustEditSteps(steps, ["src/existing.mjs"]);
    expect(result).toHaveLength(2);
    const createStep = result.find(s => s.action === "create_file");
    expect(createStep).toBeDefined();
    expect(createStep.path).toBe("src/brand-new.mjs");
  });

  it("returns steps unchanged when mustEditPaths is empty", () => {
    const steps = [
      { action: "create_file", path: "src/any.mjs", content: "content" },
    ];
    const result = filterMustEditSteps(steps, []);
    expect(result).toHaveLength(1);
  });

  it("returns steps unchanged when mustEditPaths is undefined", () => {
    const steps = [
      { action: "create_file", path: "src/any.mjs", content: "content" },
    ];
    const result = filterMustEditSteps(steps, undefined);
    expect(result).toHaveLength(1);
  });

  it("handles empty steps array", () => {
    const result = filterMustEditSteps([], ["src/foo.mjs"]);
    expect(result).toHaveLength(0);
  });

  it("preserves all non-create_file steps regardless of mustEditPaths", () => {
    const steps = [
      { action: "search_replace", path: "src/edit.mjs", edits: [] },
      { action: "run_command", command: "npm test" },
      { action: "note", title: "A note" },
    ];
    const result = filterMustEditSteps(steps, ["src/edit.mjs"]);
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: extraction + filtering combined
// ---------------------------------------------------------------------------

describe("end-to-end: op:edit story with stray create_file step", () => {
  it("story with op:edit target: extractMustEditPaths + filterMustEditSteps removes stray create_file", () => {
    const storyContent = makeStoryWithOpEdit("packages/mcp-rks/src/server/exec.mjs");
    const mustEditPaths = extractMustEditPaths(storyContent);

    // Simulate LLM returning a stray create_file for the op:edit target
    const llmSteps = [
      { action: "create_file", path: "packages/mcp-rks/src/server/exec.mjs", content: "// wrong" },
      { action: "create_file", path: "tests/unit/exec.test.mjs", content: "// test" },
    ];

    const filtered = filterMustEditSteps(llmSteps, mustEditPaths);

    // create_file for op:edit path removed
    const execStep = filtered.find(s => s.path === "packages/mcp-rks/src/server/exec.mjs");
    expect(execStep).toBeUndefined();

    // create_file for non-mustEdit test file preserved
    const testStep = filtered.find(s => s.path === "tests/unit/exec.test.mjs");
    expect(testStep).toBeDefined();
    expect(testStep.action).toBe("create_file");
  });

  it("story with no op:edit and no @@SEARCH: extractMustEditPaths returns empty, no steps filtered", () => {
    const storyContent = makeStoryNoSearchNoEdit("src/new-module.mjs");
    const mustEditPaths = extractMustEditPaths(storyContent);
    expect(mustEditPaths).toHaveLength(0);

    const llmSteps = [
      { action: "create_file", path: "src/new-module.mjs", content: "// new" },
    ];
    const filtered = filterMustEditSteps(llmSteps, mustEditPaths);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].action).toBe("create_file");
  });
});
