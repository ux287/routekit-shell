/**
 * Tests for decompose child targetFiles inheritance with op:create → op:edit override.
 *
 * When a parent story has op:create targets and those files already exist on disk,
 * decomposed children must inherit op:edit (not op:create) for those paths.
 * Files that don't exist on disk must still inherit op:create unchanged.
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const ENOUGH_ACS = `- [ ] AC one
- [ ] AC two
- [ ] AC three
- [ ] AC four
- [ ] AC five`;

function makeParentStory({ id, targetFiles }) {
  const fm = {
    id,
    title: `Parent story ${id}`,
    type: "feat",
    phase: "ready",
    targetFiles,
  };
  const fmStr = yaml.dump(fm, { lineWidth: -1 }).trim();
  return `---\n${fmStr}\n---\n\n## Acceptance Criteria\n\n${ENOUGH_ACS}\n`;
}

function readChildTargetFiles(projectRoot, childId) {
  const childPath = path.join(projectRoot, "notes", `${childId}.md`);
  const raw = fs.readFileSync(childPath, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  return yaml.load(fmMatch[1])?.targetFiles ?? [];
}

describe("refine decompose — child targetFiles op:create → op:edit when file exists", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_decompose_create_op_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, ".rks"));
    writeFile(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
      projectId: "test-project",
      branches: { working: "staging", integration: "staging", production: "main" },
    }));
  });

  it("op:create target that exists on disk becomes op:edit in child story", async () => {
    const existingFilePath = "services/existing.ts";
    // Create the file on disk
    ensureDir(path.join(projectRoot, path.dirname(existingFilePath)));
    writeFile(path.join(projectRoot, existingFilePath), "export {};");

    const parentId = "test-create-override-parent";
    writeFile(
      path.join(projectRoot, "notes", `${parentId}.md`),
      makeParentStory({
        id: parentId,
        targetFiles: [{ path: existingFilePath, op: "create", desc: "existing file" }],
      })
    );

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: parentId,
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    // F5: parent has no testRequirements → orphanedTests honestly empty (present, not hardcoded-away).
    expect(result.orphanedTests).toEqual([]);

    for (const child of result.children) {
      const targetFiles = readChildTargetFiles(projectRoot, child.id);
      const target = targetFiles.find(t => t.path === existingFilePath);
      expect(target).toBeDefined();
      expect(target.op).toBe("edit");
    }
  });

  it("op:create target that does NOT exist on disk remains op:create in child story", async () => {
    const newFilePath = "services/brand-new.ts";
    // Do NOT create the file — it's genuinely new

    const parentId = "test-create-stays-create-parent";
    writeFile(
      path.join(projectRoot, "notes", `${parentId}.md`),
      makeParentStory({
        id: parentId,
        targetFiles: [{ path: newFilePath, op: "create", desc: "new file" }],
      })
    );

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: parentId,
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);

    for (const child of result.children) {
      const targetFiles = readChildTargetFiles(projectRoot, child.id);
      const target = targetFiles.find(t => t.path === newFilePath);
      expect(target).toBeDefined();
      expect(target.op).toBe("create");
    }
  });

  it("op:edit targets are inherited unchanged regardless of whether the file exists", async () => {
    const editFilePath = "services/already-edit.ts";
    ensureDir(path.join(projectRoot, path.dirname(editFilePath)));
    writeFile(path.join(projectRoot, editFilePath), "export {};");

    const parentId = "test-edit-unchanged-parent";
    writeFile(
      path.join(projectRoot, "notes", `${parentId}.md`),
      makeParentStory({
        id: parentId,
        targetFiles: [{ path: editFilePath, op: "edit", desc: "existing file to edit" }],
      })
    );

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: parentId,
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);

    for (const child of result.children) {
      const targetFiles = readChildTargetFiles(projectRoot, child.id);
      const target = targetFiles.find(t => t.path === editFilePath);
      expect(target).toBeDefined();
      expect(target.op).toBe("edit");
    }
  });

  it("mixed case: existing file gets op:edit, non-existing file keeps op:create, op:edit unchanged", async () => {
    const existingFilePath = "services/exists.ts";
    const newFilePath = "services/new.ts";
    const editFilePath = "services/to-edit.ts";

    ensureDir(path.join(projectRoot, "services"));
    writeFile(path.join(projectRoot, existingFilePath), "export {};");
    writeFile(path.join(projectRoot, editFilePath), "export {};");
    // newFilePath intentionally not created

    const parentId = "test-mixed-ops-parent";
    writeFile(
      path.join(projectRoot, "notes", `${parentId}.md`),
      makeParentStory({
        id: parentId,
        targetFiles: [
          { path: existingFilePath, op: "create", desc: "file that exists on disk" },
          { path: newFilePath, op: "create", desc: "genuinely new file" },
          { path: editFilePath, op: "edit", desc: "file to edit" },
        ],
      })
    );

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: parentId,
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);

    // With 3 files, files are split across children — check union, not per-child presence.
    const allTargetFiles = result.children.flatMap(child => readChildTargetFiles(projectRoot, child.id));

    const existing = allTargetFiles.find(t => t.path === existingFilePath);
    expect(existing?.op).toBe("edit");

    const genuineNew = allTargetFiles.find(t => t.path === newFilePath);
    expect(genuineNew?.op).toBe("create");

    const editTarget = allTargetFiles.find(t => t.path === editFilePath);
    expect(editTarget?.op).toBe("edit");
  });

  it("override applies to every child in the decomposed set, not just the first", async () => {
    const existingFilePath = "services/shared.ts";
    ensureDir(path.join(projectRoot, "services"));
    writeFile(path.join(projectRoot, existingFilePath), "export {};");

    const parentId = "test-all-children-override-parent";
    // Use more ACs to force more than 2 children
    const manyACs = Array.from({ length: 9 }, (_, i) => `- [ ] AC ${i + 1}`).join("\n");
    const fm = yaml.dump({
      id: parentId,
      title: "Many ACs Parent",
      type: "feat",
      phase: "ready",
      targetFiles: [{ path: existingFilePath, op: "create", desc: "existing" }],
    }, { lineWidth: -1 }).trim();
    const content = `---\n${fm}\n---\n\n## Acceptance Criteria\n\n${manyACs}\n`;
    writeFile(path.join(projectRoot, "notes", `${parentId}.md`), content);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: parentId,
      refinements: [{ type: "decompose", priority: "medium", reason: "scope" }],
    });

    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    expect(result.children.length).toBeGreaterThanOrEqual(2);

    for (const child of result.children) {
      const targetFiles = readChildTargetFiles(projectRoot, child.id);
      const target = targetFiles.find(t => t.path === existingFilePath);
      expect(target?.op).toBe("edit");
    }
  });
});
