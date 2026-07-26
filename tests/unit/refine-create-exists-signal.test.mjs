/**
 * Tests for refine-create-exists-signal — verifies that a story with an
 * op:create target that already exists on disk at 300+ lines produces a
 * decompose suggestion before the planner destroys the file.
 *
 * Test requirements from story backlog.feat.refine-create-exists-signal:
 *   1. op:create target at 300+ lines on disk → decompose suggestion returned
 *   2. decompose reason matches /op:create target already exists on disk/i
 *   3. decompose reason includes the file path
 *   4. decompose reason includes the actual line count
 *   5. op:create target NOT on disk → no decompose suggestion from this check
 *   6. op:create target exists at exactly 299 lines → no decompose (boundary)
 *   7. existing op:edit large-file behavior unchanged: 300+ line edit file → decompose with /large file edit/i
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool } from "../../packages/mcp-rks/src/server/refine.mjs";

// Minimal story — 2 ACs, short body, so the only complexity signal is the
// op:create disk-existence check (no AC threshold, no body-length, no edit-count noise).
function makeStory(id, targetFilesYaml) {
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

// Array(N).fill("// line").join("\n") + "\n" → lineCount N+1 after split("\n")
// Use N=300 → lineCount=301 (≥300, triggers), N=298 → lineCount=299 (below threshold)
const LARGE_CONTENT = Array(300).fill("// line of code").join("\n") + "\n"; // lineCount=301
const BELOW_THRESHOLD = Array(298).fill("// line of code").join("\n") + "\n"; // lineCount=299

describe("refine — op:create target already exists on disk (300+ lines)", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_create_exists_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "services"));
  });

  // With the AND gate, a single op:create-already-exists signal alone does NOT trigger decompose.
  // The signal is still recorded in decomposeReasons — verify the signal text is correct there.
  // To trigger decompose we need a second signal (e.g., a large op:edit file in the same story).

  function makeStoryWithCreateAndEdit(id, createPath, editPath) {
    return `---
id: ${id}
status: not-implemented
phase: ready
testRequirements:
  - "Test passes"
targetFiles:
  - path: ${createPath}
    op: create
  - path: ${editPath}
    op: edit
---

## Acceptance Criteria
- [ ] One criterion
- [ ] Two criterion
`;
  }

  it("op:create-already-exists signal is recorded in decomposeReasons with correct text", async () => {
    writeFile(path.join(projectRoot, "services", "sqliteService.ts"), LARGE_CONTENT);
    const story = makeStory("test-create-exists-reason-text", `  - path: services/sqliteService.ts\n    op: create`);
    writeFile(path.join(projectRoot, "notes", "test-create-exists-reason-text.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-create-exists-reason-text" });
    expect(result.ok).toBe(true);
    // Signal is in decomposeReasons even though alone it doesn't trigger decompose (AND gate)
    const reasons = result.analysis?.decomposeReasons ?? [];
    expect(reasons.some(r => /op:create target already exists on disk/i.test(r))).toBe(true);
    expect(reasons.some(r => r.includes("services/sqliteService.ts"))).toBe(true);
    expect(reasons.some(r => /301 lines/.test(r))).toBe(true);
  });

  it("op:create-already-exists alone does NOT trigger decompose (AND gate — single signal)", async () => {
    writeFile(path.join(projectRoot, "services", "sqliteService.ts"), LARGE_CONTENT);
    const story = makeStory("test-create-exists-no-decompose", `  - path: services/sqliteService.ts\n    op: create`);
    writeFile(path.join(projectRoot, "notes", "test-create-exists-no-decompose.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-create-exists-no-decompose" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("op:create-already-exists + large op:edit file (2 signals) DOES trigger decompose", async () => {
    writeFile(path.join(projectRoot, "services", "sqliteService.ts"), LARGE_CONTENT);
    writeFile(path.join(projectRoot, "services", "otherService.ts"), LARGE_CONTENT);
    const story = makeStoryWithCreateAndEdit(
      "test-create-exists-with-edit",
      "services/sqliteService.ts",
      "services/otherService.ts"
    );
    writeFile(path.join(projectRoot, "notes", "test-create-exists-with-edit.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-create-exists-with-edit" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "plan_staging");
    expect(decompose).toBeDefined();
    expect(result.suggestions.find(s => s.type === "decompose")).toBeUndefined();
    expect(decompose.reason).toMatch(/op:create target already exists on disk|large file edit/i);
  });
});

describe("refine — op:create target NOT on disk (no false positive)", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_create_exists_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "services"));
  });

  it("produces no decompose suggestion when op:create target does not exist on disk", async () => {
    // File does NOT exist — this is a genuinely new file
    const story = makeStory("test-create-new-file", `  - path: services/brandNew.ts\n    op: create`);
    writeFile(path.join(projectRoot, "notes", "test-create-new-file.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-create-new-file" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });
});

describe("refine — op:create target exists at boundary line count", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_create_exists_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "services"));
  });

  it("produces no decompose suggestion when op:create target exists at exactly 299 lines (below threshold)", async () => {
    // BELOW_THRESHOLD = Array(298) → lineCount=299
    writeFile(path.join(projectRoot, "services", "smallService.ts"), BELOW_THRESHOLD);
    const story = makeStory("test-create-exists-299", `  - path: services/smallService.ts\n    op: create`);
    writeFile(path.join(projectRoot, "notes", "test-create-exists-299.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-create-exists-299" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });
});

describe("refine — large file edit signal behavior with AND gate", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_create_exists_test");
    setupProject(projectRoot);
    ensureDir(path.join(projectRoot, "services"));
  });

  it("op:edit on a 300+ line file records large file edit signal but alone does NOT decompose (AND gate)", async () => {
    writeFile(path.join(projectRoot, "services", "existingService.ts"), LARGE_CONTENT);
    const story = makeStory("test-edit-large-alone", `  - path: services/existingService.ts\n    op: edit`);
    writeFile(path.join(projectRoot, "notes", "test-edit-large-alone.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-edit-large-alone" });
    expect(result.ok).toBe(true);
    // Signal recorded
    expect(result.analysis?.decomposeReasons?.some(r => r.match(/large file edit/i))).toBe(true);
    // Alone: no decompose (AND gate)
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined();
  });

  it("op:edit on a 300+ line file + fileCount > 5 (2 signals) DOES trigger decompose with /large file edit/ reason", async () => {
    writeFile(path.join(projectRoot, "services", "existingService.ts"), LARGE_CONTENT);
    for (const f of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      writeFile(path.join(projectRoot, "services", f), "// small\n");
    }
    const files = [
      `  - path: services/existingService.ts\n    op: edit`,
      `  - path: services/a.ts\n    op: edit`,
      `  - path: services/b.ts\n    op: edit`,
      `  - path: services/c.ts\n    op: edit`,
      `  - path: services/d.ts\n    op: edit`,
      `  - path: services/e.ts\n    op: edit`,
    ].join("\n");
    const story = makeStory("test-edit-large-with-files", files);
    writeFile(path.join(projectRoot, "notes", "test-edit-large-with-files.md"), story);

    const result = await runRefineTool({ projectRoot, problemId: "test-edit-large-with-files" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "plan_staging");
    expect(decompose).toBeDefined();
    expect(result.suggestions.find(s => s.type === "decompose")).toBeUndefined();
    expect(decompose.reason).toMatch(/large file edit/i);
  });
});
