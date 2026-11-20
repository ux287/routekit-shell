import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("decomposer child story cleanup", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "decompose-test-"));
    const notesDir = path.join(tmpDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeParentStory(opts = {}) {
    const fm = {
      id: "backlog.feat.parent",
      title: opts.title || "Parent Story",
      phase: "ready",
      targetFiles: opts.targetFiles || [
        { path: "src/foo.mjs", op: "edit", desc: "Change foo" },
      ],
      ...(opts.testRequirements ? { testRequirements: opts.testRequirements } : {}),
      ...(opts.testExempt ? { testExempt: opts.testExempt } : {}),
      ...(opts.testFile ? { testFile: opts.testFile } : {}),
      ...(opts.testStory ? { testStory: opts.testStory } : {}),
    };

    // Build 6 ACs to trigger decomposition (maxPerChild defaults to 4)
    const acs = Array.from({ length: 6 }, (_, i) => `- [ ] Acceptance criterion ${i + 1}`).join("\n");
    const yaml = await import("js-yaml");
    const fmStr = yaml.default.dump(fm, { lineWidth: -1 }).trim();
    const content = `---\n${fmStr}\n---\n## Acceptance Criteria\n\n${acs}\n`;
    await fs.writeFile(path.join(tmpDir, "notes", "backlog.feat.parent.md"), content, "utf8");
  }

  async function readChildNote(childId) {
    const content = await fs.readFile(path.join(tmpDir, "notes", `${childId}.md`), "utf8");
    const yaml = await import("js-yaml");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    return fmMatch ? yaml.default.load(fmMatch[1]) : null;
  }

  it("children do not inherit testRequirements from parent", async () => {
    await writeParentStory({
      testRequirements: ["Test req 1", "Test req 2", "Test req 3"],
    });

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);

    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.testRequirements).toBeUndefined();
    }
  });

  it("children do not inherit testExempt from parent", async () => {
    await writeParentStory({ testExempt: "true" });

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.testExempt).toBeUndefined();
    }
  });

  it("children do not inherit testFile from parent", async () => {
    await writeParentStory({ testFile: "tests/unit/parent.test.mjs" });

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.testFile).toBeUndefined();
    }
  });

  it("children do not inherit testStory from parent", async () => {
    await writeParentStory({ testStory: "backlog.feat.parent.tests" });

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.testStory).toBeUndefined();
    }
  });

  it("children are created at phase draft", async () => {
    await writeParentStory();

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.phase).toBe("draft");
    }
  });

  it("children retain targetFiles from parent (split across children)", async () => {
    const targetFiles = [
      { path: "src/foo.mjs", op: "edit", desc: "Change foo" },
      { path: "src/bar.mjs", op: "create", desc: "New bar" },
    ];
    await writeParentStory({ targetFiles });

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    // With 2+ targetFiles, files are split across children (not copied to each).
    // Verify that the union of all children's targetFiles covers all parent files.
    const allChildFiles = [];
    for (const child of result.children) {
      const fm = await readChildNote(child.id);
      expect(fm.targetFiles).toBeDefined();
      expect(fm.targetFiles.length).toBeGreaterThan(0);
      allChildFiles.push(...fm.targetFiles.map(t => t.path));
    }
    expect(allChildFiles).toContain("src/foo.mjs");
    expect(allChildFiles).toContain("src/bar.mjs");
  });

  it("children retain acceptance criteria from decomposition", async () => {
    await writeParentStory();

    const result = await runRefineApplyTool({
      projectRoot: tmpDir,
      problemId: "backlog.feat.parent",
      refinements: [{ type: "decompose" }],
    });

    expect(result.decomposed).toBe(true);
    expect(result.children.length).toBeGreaterThan(1);
    // Each child should have some ACs
    for (const child of result.children) {
      expect(child.acCount).toBeGreaterThan(0);
    }
  });
});
