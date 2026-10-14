import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool, runRefineApplyTool, runRksReadyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("refine workflow integration", () => {
  let projectRoot;
  
  beforeEach(() => {
    projectRoot = makeTempDir("refine_workflow_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    writeFile(path.join(projectRoot, "src", "target.mjs"), "// target file");
  });

  it("completes full refine→apply→ready workflow", async () => {
    // Start with incomplete story
    const initialContent = `---
id: workflow-test
status: not-implemented
phase: draft
---

# Workflow Test Story

## Problem

Need to fix something in src/target.mjs.
`;
    writeFile(path.join(projectRoot, "notes", "workflow-test.md"), initialContent);
    
    // Step 1: Analyze - should suggest adding targetFiles
    const analyzeResult = await runRefineTool({ projectRoot, problemId: "workflow-test" });
    expect(analyzeResult.ok).toBe(true);
    expect(analyzeResult.suggestions.some(s => s.type === "add_target_files")).toBe(true);
    
    // Step 2: Apply refinements
    const applyResult = await runRefineApplyTool({
      projectRoot,
      problemId: "workflow-test",
      refinements: [
        { type: "add_target_files", data: { files: ["src/target.mjs"] } },
        { type: "clarify_ac", data: { criteria: ["Target file is modified correctly"] } }
      ]
    });
    expect(applyResult.ok).toBe(true);
    expect(applyResult.applied.length).toBe(2);

    // Post-apply, BEFORE runRksReadyTool, story phase should be arch-approved
    // (companion to R1.3e: refine_apply on non-decompose amendments writes
    // phase=arch-approved so the Build Governor refine→re-plan flow works).
    const postApplyContent = fs.readFileSync(path.join(projectRoot, "notes", "workflow-test.md"), "utf8");
    expect(postApplyContent).toMatch(/phase:\s*"?arch-approved"?/);

    // Step 3: Validate ready
    const readyResult = await runRksReadyTool({ projectRoot, problemId: "workflow-test" });
    expect(readyResult.ok).toBe(true);
    expect(readyResult.phase).toBe("ready");
    
    // Verify final state
    const finalContent = fs.readFileSync(path.join(projectRoot, "notes", "workflow-test.md"), "utf8");
    expect(finalContent).toContain("targetFiles:");
    expect(finalContent).toContain("src/target.mjs");
    // formatWithFrontmatter quotes string values
    expect(finalContent).toMatch(/phase:\s*"?ready"?/);
    expect(finalContent).toContain("- [ ] Target file is modified correctly");
  });
});
