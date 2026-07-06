/**
 * Tests for decompose-trigger-concern-scoring — verifies that the new
 * concern-scoring signals (editCount, hasCreateAndEdit, anyLargeEdit) in
 * refine.mjs correctly trigger decompose suggestions with descriptive reasons.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

// Minimal story content — low AC count so only the specific signal fires
function makeStory(id, targetFilesYaml, extraBody = "") {
  return `---
id: ${id}
status: not-implemented
phase: ready
testRequirements:
  - "Test passes"
targetFiles:
${targetFilesYaml}
---

## Problem

Test story.

## Acceptance Criteria
- [ ] One criterion
- [ ] Two criterion
${extraBody}
`;
}

function setupProject(projectRoot) {
  ensureDir(path.join(projectRoot, "notes"));
  ensureDir(path.join(projectRoot, ".rks"));
  writeFile(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
    projectId: "test-project",
    branches: { working: "staging", integration: "staging", production: "main" }
  }));
}

describe("refine concern-scoring — editCount signal", () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = makeTempDir("refine_concern_test");
    setupProject(projectRoot);
    // Create placeholder edit target files (6 needed to exceed op:edit-only threshold of 5)
    ensureDir(path.join(projectRoot, "src"));
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      writeFile(path.join(projectRoot, "src", `${name}.mjs`), `// ${name}\n`);
    }
  });

  it("fires when targetFiles has 6+ op:edit-only entries — decompose suggestion returned", async () => {
    // op:edit-only threshold is 5; 6 entries exceed it
    const targetYaml = ["a", "b", "c", "d", "e", "f"]
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join("\n");
    const story = makeStory("test-edit-count", targetYaml);
    writeFile(path.join(projectRoot, "notes", "test-edit-count.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-edit-count" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
    expect(decompose.reason).toMatch(/separate files being edited|multiple independent concerns/i);
  });

  it("does NOT fire when only 1 op:edit entry is present and no other threshold is met", async () => {
    const story = makeStory("test-single-edit", `  - path: src/a.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-single-edit.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-single-edit" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });
});

describe("refine concern-scoring — hasCreateAndEdit signal", () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = makeTempDir("refine_concern_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "src"));
    writeFile(path.join(projectRoot, "src", "existing.mjs"), "// existing\n");
  });

  it("does NOT fire for simple create+edit (editCount=1) — source+test is one atom", async () => {
    // hasCreateAndEdit is now threshold-gated at editCount > 3.
    // A story with 1 edit + 1 create (the canonical source+test atom) should NOT decompose.
    const story = makeStory("test-create-and-edit", `  - path: src/new.mjs\n    op: create\n  - path: src/existing.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-create-and-edit.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-create-and-edit" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("fires when targetFiles has op:create + 4 op:edit targets (editCount > 3)", async () => {
    // hasCreateAndEdit && editCount > 3 — threshold met, decompose fires.
    for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs"]) {
      writeFile(path.join(projectRoot, "src", f), "// existing\n");
    }
    const files = [
      `  - path: src/new.mjs\n    op: create`,
      `  - path: src/a.mjs\n    op: edit`,
      `  - path: src/b.mjs\n    op: edit`,
      `  - path: src/c.mjs\n    op: edit`,
      `  - path: src/d.mjs\n    op: edit`,
    ].join("\n");
    const story = makeStory("test-create-and-edit-many", files);
    writeFile(path.join(projectRoot, "notes", "test-create-and-edit-many.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-create-and-edit-many" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
    expect(decompose.reason).toMatch(/bundled create\+edit|implementation mixed with wiring/i);
  });

  it("does NOT fire when targetFiles contains only op:create entries", async () => {
    const story = makeStory("test-create-only", `  - path: src/new1.mjs\n    op: create`);
    writeFile(path.join(projectRoot, "notes", "test-create-only.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-create-only" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("does NOT fire when targetFiles contains only op:edit entries", async () => {
    const story = makeStory("test-edit-only-single", `  - path: src/existing.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-edit-only-single.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-edit-only-single" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });
});

describe("refine concern-scoring — anyLargeEdit signal", () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = makeTempDir("refine_concern_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "src"));
  });

  it("adds large file edit reason to decomposeReasons but does NOT trigger decompose alone (AND gate)", async () => {
    // With AND gate, 1 signal alone is not enough. Large file edit enters decomposeReasons
    // but estimatedComplexity stays low unless a second signal also fires.
    const bigContent = Array(300).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "big.mjs"), bigContent);
    const story = makeStory("test-large-edit", `  - path: src/big.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-large-edit.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-large-edit" });
    expect(result.ok).toBe(true);
    // Signal IS recorded
    expect(result.analysis?.decomposeReasons?.some(r => r.match(/large file edit/i))).toBe(true);
    // But alone it does NOT trigger decompose (AND gate — need 2+ signals)
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("large file edit + fileCount > 5 (2 signals) DOES trigger decompose", async () => {
    const bigContent = Array(300).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "big.mjs"), bigContent);
    for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs", "e.mjs"]) {
      writeFile(path.join(projectRoot, "src", f), "// small\n");
    }
    const files = [
      `  - path: src/big.mjs\n    op: edit`,
      `  - path: src/a.mjs\n    op: edit`,
      `  - path: src/b.mjs\n    op: edit`,
      `  - path: src/c.mjs\n    op: edit`,
      `  - path: src/d.mjs\n    op: edit`,
      `  - path: src/e.mjs\n    op: edit`,
    ].join("\n");
    const story = makeStory("test-large-edit-with-files", files);
    writeFile(path.join(projectRoot, "notes", "test-large-edit-with-files.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-large-edit-with-files" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
    expect(decompose.reason).toMatch(/large file edit/i);
  });

  it("does NOT fire when all op:edit target files are under 300 lines", async () => {
    const smallContent = Array(10).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "small.mjs"), smallContent);
    const story = makeStory("test-small-edit", `  - path: src/small.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-small-edit.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-small-edit" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("boundary: 299-line file does NOT trigger", async () => {
    // Array(298).join("\n") + "\n" produces lineCount=299 after split — below threshold
    const content299 = Array(298).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "near.mjs"), content299);
    const story = makeStory("test-boundary-299", `  - path: src/near.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-boundary-299.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-boundary-299" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("boundary: 300-line file enters decomposeReasons but alone does NOT trigger (AND gate)", async () => {
    // Large file edit IS a valid signal — it enters decomposeReasons at >= 300 lines.
    // The AND gate requires a second signal before setting estimatedComplexity = "high".
    const content300 = Array(300).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "exact300.mjs"), content300);
    const story = makeStory("test-boundary-300", `  - path: src/exact300.mjs\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-boundary-300.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-boundary-300" });
    expect(result.ok).toBe(true);
    // Signal IS recorded in decomposeReasons
    expect(result.analysis?.decomposeReasons?.some(r => r.match(/large file edit/i))).toBe(true);
    // Alone: no decompose
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });
});

describe("refine concern-scoring — valid thresholds", () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = makeTempDir("refine_concern_test");
    setupProject(projectRoot);
  });

  it("acCount > 4 alone does NOT trigger decompose (signal removed — measures thoroughness not scope)", async () => {
    const story = `---
id: test-ac-threshold
status: not-implemented
phase: ready
testRequirements:
  - "Test"
targetFiles:
  - path: src/x.mjs
    op: edit
---

## Acceptance Criteria
- [ ] AC 1
- [ ] AC 2
- [ ] AC 3
- [ ] AC 4
- [ ] AC 5
`;
    writeFile(path.join(projectRoot, "notes", "test-ac-threshold.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-ac-threshold" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("bodyLength > 2500 alone does NOT trigger decompose (signal removed — @@SEARCH blocks inflate body length)", async () => {
    const longBody = "x".repeat(2600);
    const story = `---
id: test-body-threshold
status: not-implemented
phase: ready
testRequirements:
  - "Test"
targetFiles:
  - path: src/x.mjs
    op: edit
---

${longBody}
`;
    writeFile(path.join(projectRoot, "notes", "test-body-threshold.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-body-threshold" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("fileCount > 5 threshold still triggers decompose suggestion", async () => {
    const files = ["a", "b", "c", "d", "e", "f"].map(n => `  - path: src/${n}.mjs\n    op: edit`).join("\n");
    const story = makeStory("test-file-threshold", files);
    writeFile(path.join(projectRoot, "notes", "test-file-threshold.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-file-threshold" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
  });
});

describe("refine concern-scoring — reason strings and combinations", () => {
  let projectRoot;
  beforeEach(() => {
    projectRoot = makeTempDir("refine_concern_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "src"));
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      writeFile(path.join(projectRoot, "src", `${name}.mjs`), `// ${name}\n`);
    }
  });

  it("each new signal produces a distinct reason string identifying the specific trigger", async () => {
    // editCount signal — requires 6+ op:edit-only entries (threshold is 5 for allEditOnly)
    const targetYaml = ["a", "b", "c", "d", "e", "f"]
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join("\n");
    const story = makeStory("test-distinct-reason", targetYaml);
    writeFile(path.join(projectRoot, "notes", "test-distinct-reason.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-distinct-reason" });
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
    // Reason should NOT just be the generic AC-count message
    expect(decompose.reason).not.toMatch(/^Story has \d+ acceptance criteria/);
  });

  it("when 2+ signals fire, at least one decompose suggestion is returned (AND gate satisfied)", async () => {
    // 6 op:edit files (fileCount > 5 = signal 1) + one of them is 300+ lines (large file = signal 2)
    const bigContent = Array(300).fill("// line").join("\n") + "\n";
    writeFile(path.join(projectRoot, "src", "big.mjs"), bigContent);
    const files = ["a", "b", "c", "d", "e"].map(n => `  - path: src/${n}.mjs\n    op: edit`).join("\n")
      + "\n  - path: src/big.mjs\n    op: edit";
    const story = makeStory("test-combination", files);
    writeFile(path.join(projectRoot, "notes", "test-combination.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-combination" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeDefined();
    // Reason should mention the signals that fired
    expect(decompose.reason).toMatch(/large file edit|target files/i);
  });
});
