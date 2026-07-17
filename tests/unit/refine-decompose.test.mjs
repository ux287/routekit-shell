import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool, runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("refine decompose handling", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_decompose_test");
    ensureDir(path.join(projectRoot, "notes"));
    // Create a minimal .rks/project.json so tools don't error
    ensureDir(path.join(projectRoot, ".rks"));
    writeFile(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
      projectId: "test-project",
      branches: { working: "staging", integration: "staging", production: "main" }
    }));
  });

  it("refine suggests decompose for stories with many target files (fileCount > 5)", async () => {
    // AC count was removed as a signal — use fileCount > 5 to trigger decompose instead.
    const storyContent = `---
id: test-complex-story
status: not-implemented
targetFiles:
  - path: src/a.mjs
    op: edit
  - path: src/b.mjs
    op: edit
  - path: src/c.mjs
    op: edit
  - path: src/d.mjs
    op: edit
  - path: src/e.mjs
    op: edit
  - path: src/f.mjs
    op: edit
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
- [ ] Fourth criterion
- [ ] Fifth criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-complex-story.md"), storyContent);

    const result = await runRefineTool({ projectRoot, problemId: "test-complex-story" });

    expect(result.ok).toBe(true);
    // Size/tractability signals now surface plan-staging guidance, NOT a sibling decompose
    // (backlog.feat.reconcile-story-sizing-po-arch-planner / design.story-sizing-contract.md §3b).
    const decomposeSuggestion = result.suggestions.find(s => s.type === "plan_staging");
    expect(decomposeSuggestion).toBeDefined();
    expect(decomposeSuggestion.priority).toBe("medium");
    expect(result.suggestions.find(s => s.type === "decompose")).toBeUndefined();
  });

  it("refine_apply processes decompose suggestion and returns decomposed children", async () => {
    const storyContent = `---
id: test-decompose-parent
title: "Test Decompose Parent"
status: not-implemented
type: feat
phase: ready
targetFiles:
  - src/a.mjs
  - src/b.mjs
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
- [ ] Fourth criterion
- [ ] Fifth criterion
- [ ] Sixth criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-decompose-parent.md"), storyContent);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-decompose-parent",
      refinements: [{ type: "decompose", priority: "medium", reason: "too many ACs" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    expect(result.children.length).toBeGreaterThan(1);
    expect(result.orphanedTests).toEqual([]);
  });

  it("decomposed children have correct IDs and parent reference", async () => {
    const storyContent = `---
id: test-parent-ids
title: "Test Parent IDs"
status: not-implemented
type: feat
phase: ready
targetFiles:
  - src/a.mjs
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
- [ ] Fourth criterion
- [ ] Fifth criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-parent-ids.md"), storyContent);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-parent-ids",
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.decomposed).toBe(true);
    for (const child of result.children) {
      // Semantic slugs derived from AC text (PR #902), or child-N fallback
      expect(child.id).toMatch(/^test-parent-ids\.(child-\d+|[a-z][a-z0-9-]*)$/);
      // Verify child file exists
      const childPath = path.join(projectRoot, "notes", `${child.id}.md`);
      expect(fs.existsSync(childPath)).toBe(true);
      const childContent = fs.readFileSync(childPath, "utf8");
      expect(childContent).toContain("parent: \"test-parent-ids\"");
    }
  });

  it("parent story phase set to decomposed after decompose", async () => {
    const storyContent = `---
id: test-parent-phase
title: "Test Parent Phase"
status: not-implemented
type: feat
phase: ready
targetFiles:
  - src/a.mjs
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
- [ ] Fourth criterion
- [ ] Fifth criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-parent-phase.md"), storyContent);

    await runRefineApplyTool({
      projectRoot,
      problemId: "test-parent-phase",
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    const parentContent = fs.readFileSync(
      path.join(projectRoot, "notes", "test-parent-phase.md"), "utf8"
    );
    expect(parentContent).toContain('phase: "decomposed"');
    expect(parentContent).toContain("childStories:");
  });

  it("refine_apply skips decompose when AC count is within threshold", async () => {
    const storyContent = `---
id: test-small-story
title: "Small Story"
status: not-implemented
type: feat
phase: ready
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-small-story.md"), storyContent);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-small-story",
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBeFalsy();
  });

  it("decompose takes priority over other suggestion types in mixed list", async () => {
    const storyContent = `---
id: test-mixed-suggestions
title: "Mixed Suggestions"
status: not-implemented
type: feat
phase: ready
targetFiles:
  - src/a.mjs
---

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
- [ ] Third criterion
- [ ] Fourth criterion
- [ ] Fifth criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-mixed-suggestions.md"), storyContent);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-mixed-suggestions",
      refinements: [
        { type: "verify_search_patterns", priority: "high", reason: "check patterns" },
        { type: "decompose", priority: "medium", reason: "too many ACs" },
      ],
    });

    expect(result.decomposed).toBe(true);
    // decompose should have fired, producing children
    expect(result.children.length).toBeGreaterThan(1);
  });
});
