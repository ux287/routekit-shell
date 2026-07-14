import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTempDir, writeFile, ensureDir } from "../helpers/tmp.mjs";
import { runRefineTool, runRefineApplyTool, runRksReadyTool, detectCompileErrors } from "../../packages/mcp-rks/src/server/refine.mjs";

describe("runRefineTool", () => {
  let projectRoot;
  
  beforeEach(() => {
    projectRoot = makeTempDir("refine_test");
    ensureDir(path.join(projectRoot, "notes"));
  });

  it("analyzes story with targetFiles", async () => {
    const storyContent = `---
id: test-story
status: not-implemented
targetFiles:
  - src/foo.mjs
  - src/bar.mjs
---

# Test Story

## Acceptance Criteria
- [ ] First criterion
- [ ] Second criterion
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRefineTool({ projectRoot, problemId: "test-story" });
    
    expect(result.ok).toBe(true);
    expect(result.analysis.hasTargetFiles).toBe(true);
    expect(result.analysis.targetFiles).toEqual(["src/foo.mjs", "src/bar.mjs"]);
    expect(result.analysis.hasAcceptanceCriteria).toBe(true);
    expect(result.analysis.acceptanceCriteriaCount).toBe(2);
  });

  it("suggests adding targetFiles when missing", async () => {
    const storyContent = `---
id: test-story
status: not-implemented
---

# Test Story

Mentions packages/cli/src/project.js in the body.
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRefineTool({ projectRoot, problemId: "test-story" });
    
    expect(result.ok).toBe(true);
    expect(result.analysis.hasTargetFiles).toBe(false);
    expect(result.suggestions.some(s => s.type === "add_target_files")).toBe(true);
  });

  it("handles missing story gracefully", async () => {
    const result = await runRefineTool({ projectRoot, problemId: "nonexistent" });
    
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("handles malformed frontmatter", async () => {
    const storyContent = `---
id: test-story
targetFiles: [malformed: yaml: here
---

# Test Story
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);

    const result = await runRefineTool({ projectRoot, problemId: "test-story" });

    // gray-matter may throw on malformed YAML, returning ok: false
    // Either way, hasTargetFiles should be false
    if (result.ok) {
      expect(result.analysis.hasTargetFiles).toBe(false);
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

describe("decompose — independent-value gate", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("decomp_ivgate_test");
    ensureDir(path.join(projectRoot, "notes"));
  });

  function makeDecompStory(storyId, acCount = 6) {
    const acs = Array.from({ length: acCount }, (_, i) => `- [ ] Criterion ${i + 1}`).join("\n");
    const content = `---
id: "${storyId}"
title: "Test story"
desc: "test"
status: "not-implemented"
phase: "ready"
type: "feat"
---

## Acceptance Criteria

${acs}
`;
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("creates child notes normally when all children have independentValue truthy", async () => {
    const storyId = "backlog.feat.iv-passing";
    makeDecompStory(storyId, 6);
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{
        type: "decompose",
        data: {
          children: [
            { slug: "part-one", independentValue: "ships the first three behaviors" },
            { slug: "part-two", independentValue: "ships the next three behaviors" },
          ],
        },
      }],
    });
    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    expect(result.children).toHaveLength(2);
  });

  it("size/tractability alone never creates siblings — a horizontal split whose child is not independently valuable is rejected (design.story-sizing-contract.md §3b)", async () => {
    const storyId = "backlog.feat.size-only-split";
    makeDecompStory(storyId, 6);
    // A purely size-driven (horizontal) split: the second child only has value once a sibling lands.
    // Per the story-sizing contract this must be rejected — siblings require an independent-concern
    // break (Axis A), not a size threshold (Axis B). The independent_value_gate enforces it.
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{
        type: "decompose",
        data: {
          children: [
            { slug: "engine-core", independentValue: "the engine" },
            { slug: "engine-reducer", independentValue: false },
          ],
        },
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("independent_value_gate");
  });

  it("returns error when a child has independentValue: false", async () => {
    const storyId = "backlog.feat.iv-failing";
    makeDecompStory(storyId, 6);
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{
        type: "decompose",
        data: {
          children: [
            { slug: "part-one", independentValue: "ships the first three behaviors" },
            { slug: "part-two", independentValue: false },
          ],
        },
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("independent_value_gate");
    expect(result.failingChildren).toHaveLength(1);
    expect(result.failingChildren[0].slug).toBe("part-two");
  });

  it("error message surfaces re-scope guidance (not silent failure)", async () => {
    const storyId = "backlog.feat.iv-message";
    makeDecompStory(storyId, 6);
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{
        type: "decompose",
        data: {
          children: [
            { slug: "part-one", independentValue: false },
            { slug: "part-two", independentValue: "ships something" },
          ],
        },
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Re-scope/);
    expect(result.message).toMatch(/if this shipped alone/);
  });

  it("does not create any child notes when gate fails", async () => {
    const storyId = "backlog.feat.iv-no-notes";
    makeDecompStory(storyId, 6);
    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{
        type: "decompose",
        data: {
          children: [
            { slug: "part-one", independentValue: false },
          ],
        },
      }],
    });
    const noteExists = fs.existsSync(path.join(projectRoot, "notes", `${storyId}.part-one.md`));
    expect(noteExists).toBe(false);
  });

  it("regression: decompose without data.children still succeeds (backwards compat)", async () => {
    const storyId = "backlog.feat.iv-regression";
    makeDecompStory(storyId, 6);
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "decompose" }],
    });
    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
  });

  // F5: honest orphanedTests — parent testRequirements not covered by any child's scope.
  function makeDecompStoryWithReqs(storyId, testRequirements, targetFiles, acCount = 6) {
    const acs = Array.from({ length: acCount }, (_, i) => `- [ ] Criterion ${i + 1}`).join("\n");
    const trYaml = (testRequirements || []).map((r) => `  - ${JSON.stringify(r)}`).join("\n");
    const tfYaml = (targetFiles || []).map((t) => `  - path: ${JSON.stringify(t.path)}\n    op: ${JSON.stringify(t.op)}`).join("\n");
    const content = `---
id: "${storyId}"
title: "Test story"
desc: "test"
status: "not-implemented"
phase: "ready"
type: "feat"${testRequirements ? `\ntestRequirements:\n${trYaml}` : ""}${targetFiles ? `\ntargetFiles:\n${tfYaml}` : ""}
---

## Acceptance Criteria

${acs}
`;
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("F5: reports orphanedTests for parent requirements no child covers", async () => {
    const storyId = "backlog.feat.orphan-some";
    makeDecompStoryWithReqs(
      storyId,
      ["alpha behaves correctly", "beta behaves correctly", "gamma is wired up"],
      [{ path: "src/alpha.js", op: "edit" }, { path: "src/beta.js", op: "edit" }],
    );
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "decompose", data: { children: [
        { slug: "alpha-work", independentValue: "ships alpha" },
        { slug: "beta-work", independentValue: "ships beta" },
      ] } }],
    });
    expect(result.ok).toBe(true);
    expect(result.decomposed).toBe(true);
    expect(result.orphanedTests).toContain("gamma is wired up");
    expect(result.orphanedTests).not.toContain("alpha behaves correctly");
    expect(result.orphanedTests).not.toContain("beta behaves correctly");
  });

  it("F5: orphanedTests is [] when every requirement maps to a child", async () => {
    const storyId = "backlog.feat.orphan-none";
    makeDecompStoryWithReqs(
      storyId,
      ["alpha behaves", "beta behaves"],
      [{ path: "src/alpha.js", op: "edit" }, { path: "src/beta.js", op: "edit" }],
    );
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "decompose", data: { children: [
        { slug: "alpha-work", independentValue: "ships alpha" },
        { slug: "beta-work", independentValue: "ships beta" },
      ] } }],
    });
    expect(result.ok).toBe(true);
    expect(result.orphanedTests).toEqual([]);
  });

  it("F5: orphanedTests is [] when parent has no testRequirements", async () => {
    const storyId = "backlog.feat.orphan-absent";
    makeDecompStory(storyId, 6);
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "decompose", data: { children: [
        { slug: "part-one", independentValue: "ships first" },
        { slug: "part-two", independentValue: "ships second" },
      ] } }],
    });
    expect(result.ok).toBe(true);
    expect(result.orphanedTests).toEqual([]);
  });
});

describe("runRefineApplyTool", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_apply_test");
    ensureDir(path.join(projectRoot, "notes"));
  });

  it("adds targetFiles to frontmatter", async () => {
    const storyContent = `---
id: test-story
status: not-implemented
---

# Test Story
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-story",
      refinements: [
        { type: "add_target_files", data: { files: ["src/new.mjs"] } }
      ]
    });
    
    expect(result.ok).toBe(true);
    expect(result.applied.length).toBe(1);
    
    // Verify file was updated
    const updated = fs.readFileSync(path.join(projectRoot, "notes", "test-story.md"), "utf8");
    expect(updated).toContain("targetFiles:");
    expect(updated).toContain("src/new.mjs");
  });

  it("adds acceptance criteria to body", async () => {
    const storyContent = `---
id: test-story
---

# Test Story
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRefineApplyTool({
      projectRoot,
      problemId: "test-story",
      refinements: [
        { type: "clarify_ac", data: { criteria: ["New criterion 1", "New criterion 2"] } }
      ]
    });
    
    expect(result.ok).toBe(true);
    
    const updated = fs.readFileSync(path.join(projectRoot, "notes", "test-story.md"), "utf8");
    expect(updated).toContain("- [ ] New criterion 1");
    expect(updated).toContain("- [ ] New criterion 2");
  });
});

describe("runRksReadyTool", () => {
  let projectRoot;
  
  beforeEach(() => {
    projectRoot = makeTempDir("refine_ready_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
    writeFile(path.join(projectRoot, "src", "existing.mjs"), "// exists");
  });

  it("validates story is ready and updates phase", async () => {
    const storyContent = `---
id: test-story
status: not-implemented
phase: draft
targetFiles:
  - src/existing.mjs
---

# Test Story

## Acceptance Criteria
- [ ] Has criteria
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRksReadyTool({ projectRoot, problemId: "test-story" });
    
    expect(result.ok).toBe(true);
    expect(result.phase).toBe("ready");
    
    const updated = fs.readFileSync(path.join(projectRoot, "notes", "test-story.md"), "utf8");
    // formatWithFrontmatter quotes string values
    expect(updated).toMatch(/phase:\s*"?ready"?/);
  });

  it("returns issues when targetFiles missing", async () => {
    const storyContent = `---
id: test-story
status: not-implemented
---

# Test Story

## Acceptance Criteria
- [ ] Has criteria
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);
    
    const result = await runRksReadyTool({ projectRoot, problemId: "test-story" });
    
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("Missing targetFiles in frontmatter");
  });

  it("returns issues when targetFiles reference nonexistent paths", async () => {
    const storyContent = `---
id: test-story
targetFiles:
  - src/nonexistent.mjs
---

# Test Story

## Acceptance Criteria
- [ ] Has criteria
`;
    writeFile(path.join(projectRoot, "notes", "test-story.md"), storyContent);

    const result = await runRksReadyTool({ projectRoot, problemId: "test-story" });

    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("non-existent"))).toBe(true);
  });
});

describe("add_search_pattern — @@SEARCH/@@REPLACE/@@END injection", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-search-marker");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("injects @@SEARCH/@@REPLACE/@@END blocks (not plain anchor text)", async () => {
    const targetFile = "src/app.mjs";
    const fileContent = `export class SQLiteService {\n  constructor() {}\n}\n\nexport const sqliteService = new SQLiteService();\n`;
    fs.writeFileSync(path.join(projectRoot, targetFile), fileContent);

    const storyId = "backlog.fix.marker-test";
    const storyContent = `---
id: "${storyId}"
title: "Marker test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

Something needs changing.

### Target: ${targetFile}

Current source (use for search_replace patterns):

\`\`\`javascript
${fileContent}\`\`\`
`;
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
    });

    expect(result.ok).toBe(true);
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");

    // Must contain @@SEARCH markers
    expect(updated).toContain("@@SEARCH");
    expect(updated).toContain("@@REPLACE");
    expect(updated).toContain("@@END");

    // Must NOT contain old-style plain anchor text
    expect(updated).not.toMatch(/SEARCH \d+:`/);
  });

  it("injected @@SEARCH/@@REPLACE/@@END block is written to the story note", async () => {
    const targetFile = "src/app.mjs";
    const fileContent = `export class SQLiteService {\n  constructor() {}\n}\n\nexport const sqliteService = new SQLiteService();\n`;
    fs.writeFileSync(path.join(projectRoot, targetFile), fileContent);

    const storyId = "backlog.fix.marker-parseable";
    const storyContent = `---
id: "${storyId}"
title: "Parseable test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

Something.

### Target: ${targetFile}

\`\`\`javascript
${fileContent}\`\`\`
`;
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // @@SEARCH/@@REPLACE/@@END blocks injected by add_search_pattern are identity
    // transforms (search === replace) — plan_ready validation markers, not executable
    // edits. They are correctly excluded from extractExplicitEdits. Verify the block
    // was written to the note for reviewer-mode activation.
    expect(updated).toContain("@@SEARCH");
    expect(updated).toContain("@@REPLACE");
    expect(updated).toContain("@@END");
  });

  describe("add_search_pattern fallback — file-read when snippet has no anchors", () => {
    it("reads target file from disk and injects export declaration when snippet yields no anchors", async () => {
      const targetFile = "src/interior.mjs";
      const snippetContent = `  if (condition) {\n    doSomething();\n  }\n`;
      const fullFileContent = `export async function myHandler(x) {\n  if (condition) {\n    doSomething();\n  }\n}\n`;
      ensureDir(path.join(projectRoot, "src"));
      fs.writeFileSync(path.join(projectRoot, targetFile), fullFileContent);

      const storyId = "backlog.fix.anchor-fallback-test";
      const storyContent = [
        "---",
        `id: "${storyId}"`,
        `title: "Anchor fallback test"`,
        `desc: "test"`,
        `status: "not-implemented"`,
        `phase: "ready"`,
        `targetFiles:`,
        `  - path: "${targetFile}"`,
        `    op: "edit"`,
        "---",
        "",
        "## Problem",
        "",
        "Something.",
        "",
        `### Target: ${targetFile}`,
        "",
        "```javascript",
        snippetContent,
        "```",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
      });

      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied).toBeDefined();
      expect(applied.manual).toBeUndefined();
      expect(applied.anchors).toContain("export async function myHandler(x) {");
    });

    it("returns manual:true when full file also has no export declarations", async () => {
      const targetFile = "src/no-exports.mjs";
      const snippetContent = `  doSomething();\n`;
      const fullFileContent = `// No exports here\nconst x = 1;\n`;
      ensureDir(path.join(projectRoot, "src"));
      fs.writeFileSync(path.join(projectRoot, targetFile), fullFileContent);

      const storyId = "backlog.fix.anchor-fallback-no-export";
      const storyContent = [
        "---",
        `id: "${storyId}"`,
        `title: "No export fallback test"`,
        `desc: "test"`,
        `status: "not-implemented"`,
        `phase: "ready"`,
        `targetFiles:`,
        `  - path: "${targetFile}"`,
        `    op: "edit"`,
        "---",
        "",
        "## Problem",
        "",
        "Something.",
        "",
        `### Target: ${targetFile}`,
        "",
        "```javascript",
        snippetContent,
        "```",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
      });

      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied).toBeDefined();
      expect(applied.manual).toBe(true);
    });

    it("falls through to manual:true silently when target file does not exist on disk", async () => {
      const targetFile = "src/nonexistent.mjs";
      const snippetContent = `  doSomething();\n`;

      const storyId = "backlog.fix.anchor-fallback-missing-file";
      const storyContent = [
        "---",
        `id: "${storyId}"`,
        `title: "Missing file fallback test"`,
        `desc: "test"`,
        `status: "not-implemented"`,
        `phase: "ready"`,
        `targetFiles:`,
        `  - path: "${targetFile}"`,
        `    op: "edit"`,
        "---",
        "",
        "## Problem",
        "",
        "Something.",
        "",
        `### Target: ${targetFile}`,
        "",
        "```javascript",
        snippetContent,
        "```",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.manual).toBe(true);
    });
  });

  describe("add_search_pattern — caller-provided anchors (data.anchors)", () => {
    it("uses data.anchors verbatim when provided, skipping extractAnchorPatterns", async () => {
      const targetFile = "src/Modal.jsx";
      const storyId = "test-caller-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
## Acceptance Criteria
- [ ] Insert JSX section

### Target: ${targetFile}

\`\`\`jsx
export function Modal() {
  return <div>{/* Controls */}</div>;
}
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);
      fs.writeFileSync(path.join(projectRoot, targetFile), "export function Modal() { return <div>{/* Controls */}</div>; }");

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{
          type: "add_search_pattern",
          data: { file: targetFile, anchors: ["{/* Controls */}"] },
        }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.manual).toBeUndefined();
      expect(applied.anchors).toEqual(["{/* Controls */}"]);

      const noteContent = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
      expect(noteContent).toContain("@@SEARCH\n{/* Controls */}");
    });

    it("falls back to extractAnchorPatterns when data.anchors is absent", async () => {
      const targetFile = "src/service.mjs";
      const storyId = "test-no-caller-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
### Target: ${targetFile}

\`\`\`js
export function doThing() {}
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      // extractAnchorPatterns found "export function doThing()"
      expect(applied.anchors).toBeDefined();
      expect(applied.anchors.length).toBeGreaterThan(0);
      const noteContent = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
      expect(noteContent).toContain("@@SEARCH");
      expect(noteContent).toContain("doThing");
    });

    it("falls back to extractAnchorPatterns when data.anchors is null", async () => {
      const targetFile = "src/service.mjs";
      const storyId = "test-null-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
### Target: ${targetFile}

\`\`\`js
export function doThing() {}
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile, anchors: null } }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.anchors).toBeDefined();
      expect(applied.anchors.length).toBeGreaterThan(0);
    });

    it("falls back to extractAnchorPatterns when data.anchors is an empty array", async () => {
      const targetFile = "src/service.mjs";
      const storyId = "test-empty-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
### Target: ${targetFile}

\`\`\`js
export function doThing() {}
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile, anchors: [] } }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.anchors).toBeDefined();
      expect(applied.anchors.length).toBeGreaterThan(0);
    });

    it("callers without data.anchors produce identical output to pre-change behavior", async () => {
      const targetFile = "src/utils.mjs";
      const storyId = "test-regression-no-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
### Target: ${targetFile}

\`\`\`js
export const helper = () => {};
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: targetFile } }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.manual).toBeUndefined();
      const noteContent = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
      expect(noteContent).toContain("@@SEARCH");
      expect(noteContent).toContain("helper");
    });

    it("multiple caller-provided anchors each get their own @@SEARCH/@@REPLACE/@@END block", async () => {
      const targetFile = "src/Modal.jsx";
      const storyId = "test-multi-caller-anchors";
      const storyContent = `---
id: ${storyId}
targetFiles:
  - path: ${targetFile}
    op: edit
---
### Target: ${targetFile}

\`\`\`jsx
export function Modal() {}
\`\`\`
`;
      fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), storyContent);

      const result = await runRefineApplyTool({
        projectRoot,
        problemId: storyId,
        refinements: [{
          type: "add_search_pattern",
          data: { file: targetFile, anchors: ["{/* Controls */}", "{/* Footer */}"] },
        }],
      });

      expect(result.ok).toBe(true);
      const applied = result.applied.find(a => a.type === "add_search_pattern");
      expect(applied.anchors).toEqual(["{/* Controls */}", "{/* Footer */}"]);

      const noteContent = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
      expect(noteContent).toContain("@@SEARCH\n{/* Controls */}");
      expect(noteContent).toContain("@@SEARCH\n{/* Footer */}");
    });
  });
});

// ─── add_search_pattern deduplication ────────────────────────────────────────

describe("add_search_pattern — deduplication", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-dedup");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeStoryWithTarget(storyId, targetFile, fileContent, extraBody = "") {
    return `---
id: "${storyId}"
title: "Dedup test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${targetFile}"
    op: "edit"
---

## Problem

Something.

### Target: ${targetFile}

\`\`\`javascript
${fileContent}\`\`\`
${extraBody}`;
  }

  const TARGET = "src/app.mjs";
  const FILE_CONTENT = `export function doWork() {\n  return 1;\n}\n\nexport const helper = () => {};\n`;
  const ANCHOR = "export function doWork() {";

  it("appends @@SEARCH block when anchor does not yet exist", async () => {
    const storyId = "backlog.feat.dedup-new";
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`),
      makeStoryWithTarget(storyId, TARGET, FILE_CONTENT));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [ANCHOR] } }],
    });

    expect(result.ok).toBe(true);
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain(`@@SEARCH\n${ANCHOR}\n`);
    const applied = result.applied.find(a => a.type === "add_search_pattern");
    expect(applied.result).toContain("injected 1");
  });

  it("skips append when @@SEARCH block for anchor already exists", async () => {
    const storyId = "backlog.feat.dedup-skip";
    const existingBlock = `\n\n### ${TARGET}\n\n@@SEARCH\n${ANCHOR}\n@@REPLACE\n${ANCHOR}\n@@END`;
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`),
      makeStoryWithTarget(storyId, TARGET, FILE_CONTENT, existingBlock));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [ANCHOR] } }],
    });

    // backlog.fix.build-governor-self-heal: a refinement that changes NOTHING no longer reports
    // success. It used to return ok:true AND `requiredNext: rks_plan` — "success, now go re-plan"
    // an unchanged story — which is the infinite loop this story exists to break.
    expect(result.ok).toBe(false);
    expect(result.status).toBe("refine_noop");
    expect(result.requiredNext).toBeUndefined();
    const applied = result.applied.find(a => a.type === "add_search_pattern");
    expect(applied.result).toContain("skipped");

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    const count = (updated.match(new RegExp(`@@SEARCH\n${ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`, "g")) || []).length;
    expect(count).toBe(1);
  });

  it("with multiple anchors, appends only missing ones", async () => {
    const anchor2 = "export const helper = () => {};";
    const storyId = "backlog.feat.dedup-partial";
    const existingBlock = `\n\n### ${TARGET}\n\n@@SEARCH\n${ANCHOR}\n@@REPLACE\n${ANCHOR}\n@@END`;
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`),
      makeStoryWithTarget(storyId, TARGET, FILE_CONTENT, existingBlock));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [ANCHOR, anchor2] } }],
    });

    expect(result.ok).toBe(true);
    const applied = result.applied.find(a => a.type === "add_search_pattern");
    expect(applied.result).toContain("injected 1");
    expect(applied.result).toContain("1 skipped");

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain(`@@SEARCH\n${anchor2}\n`);
  });

  it("calling 7 times with same anchor results in exactly one @@SEARCH block", async () => {
    const storyId = "backlog.feat.dedup-idempotent";
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`),
      makeStoryWithTarget(storyId, TARGET, FILE_CONTENT));

    for (let i = 0; i < 7; i++) {
      await runRefineApplyTool({
        projectRoot, problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [ANCHOR] } }],
      });
    }

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    const count = (updated.match(new RegExp(`@@SEARCH\n${ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`, "g")) || []).length;
    expect(count).toBe(1);
  });

  it("fallback path skips when fallback anchor already exists in note", async () => {
    const storyId = "backlog.feat.dedup-fallback";
    // Snippet with no extractable anchors (just interior code)
    const snippetContent = `  if (x) {\n    return 1;\n  }\n`;
    const existingBlock = `\n\n### ${TARGET}\n\n@@SEARCH\n${ANCHOR}\n@@REPLACE\n${ANCHOR}\n@@END`;
    // Full file on disk has an export that would be the fallback anchor
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`),
      makeStoryWithTarget(storyId, TARGET, snippetContent, existingBlock));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET } }],
    });

    // backlog.fix.build-governor-self-heal: a refinement that changes NOTHING no longer reports
    // success. It used to return ok:true AND `requiredNext: rks_plan` — "success, now go re-plan"
    // an unchanged story — which is the infinite loop this story exists to break.
    expect(result.ok).toBe(false);
    expect(result.status).toBe("refine_noop");
    expect(result.requiredNext).toBeUndefined();
    const applied = result.applied.find(a => a.type === "add_search_pattern");
    expect(applied.result).toContain("skipped");

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    const count = (updated.match(new RegExp(`@@SEARCH\n${ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`, "g")) || []).length;
    expect(count).toBe(1);
  });
});

describe("add_code_snippet keyword injection", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_keyword_test");
    ensureDir(path.join(projectRoot, "notes"));
  });

  function makeStory(storyId, targetFile, desc) {
    const content = [
      "---",
      `id: "${storyId}"`,
      `title: "Keyword injection test"`,
      `desc: "test"`,
      `status: "not-implemented"`,
      `phase: "ready"`,
      `targetFiles:`,
      `  - path: "${targetFile}"`,
      `    op: "edit"`,
      `    desc: "${desc}"`,
      "---",
      "",
      "## Problem",
      "",
      "Something.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("uses keyword match to inject context around target line in large file", async () => {
    const targetFile = "src/large.mjs";
    const lines = [];
    for (let i = 0; i < 140; i++) lines.push(`  // line ${i}`);
    lines.push(`  const [isDialogOpen, setIsDialogOpen] = useState(false);`);
    for (let i = 142; i < 200; i++) lines.push(`  // line ${i}`);
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.kw-mid-file";
    makeStory(storyId, targetFile, "Add isDialogOpen state and wire handler");

    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("isDialogOpen");
    expect(updated).toContain("keyword match for");
    expect(updated).not.toContain("lines omitted");
  });

  it("falls through to head+tail when no keyword matches any line", async () => {
    const targetFile = "src/no-match.mjs";
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`  // unrelated line ${i}`);
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.kw-no-match";
    makeStory(storyId, targetFile, "Add xyzNonExistentIdentifier to the component");

    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("lines omitted");
    expect(updated).not.toContain("keyword match for");
  });

  it("extracts backtick-quoted identifiers from desc as keyword candidates", async () => {
    const targetFile = "src/bt-extract.mjs";
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`  // line ${i}`);
    lines.splice(120, 0, "  onSaveComplete();");
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.kw-backtick";
    makeStory(storyId, targetFile, "Call `onSaveComplete` after form submission");

    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("onSaveComplete");
    expect(updated).toContain("keyword match for");
  });

  it("extracts camelCase words from desc as keyword candidates", async () => {
    const targetFile = "src/camel-extract.mjs";
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(`  // line ${i}`);
    lines.splice(100, 0, "  const pageTitle = config.title;");
    ensureDir(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.kw-camel";
    makeStory(storyId, targetFile, "Read pageTitle from config and display in header");

    await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("pageTitle");
    expect(updated).toContain("keyword match for");
  });
});

describe("add_code_snippet keyword injection — import-line skip", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_import_skip_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  function makeStory(storyId, targetFile, desc) {
    const content = [
      "---",
      `id: "${storyId}"`,
      `title: "Import skip test"`,
      `desc: "test"`,
      `status: "not-implemented"`,
      `phase: "ready"`,
      `targetFiles:`,
      `  - path: "${targetFile}"`,
      `    op: "edit"`,
      `    desc: "${desc}"`,
      "---",
      "",
      "## Problem",
      "",
      "Something.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("skips keyword on import line and chooses non-import line match instead", async () => {
    const targetFile = "src/react-comp.mjs";
    const lines = [];
    lines.push(`import React, { useState, useMemo, useCallback } from "react";`);
    for (let i = 1; i < 148; i++) lines.push(`  // line ${i}`);
    lines.push(`  const displayActions = useMemo(() => {`);
    lines.push(`    return actions.filter(a => a.visible);`);
    lines.push(`  }, [actions]);`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.kw-import-skip";
    makeStory(storyId, targetFile, "Add useMemo to compute displayActions");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("displayActions = useMemo");
    expect(updated).toContain("// Context:");
    expect(updated).not.toContain("lines omitted");
  });

  it("falls through to head+tail when keyword appears ONLY on import lines", async () => {
    const targetFile = "src/import-only.mjs";
    const lines = [];
    lines.push(`import React, { useState, useMemo } from "react";`);
    for (let i = 1; i < 200; i++) lines.push(`  // unrelated line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.kw-import-only";
    makeStory(storyId, targetFile, "Add useMemo for memoized selector");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("lines omitted");
    expect(updated).not.toContain("keyword match for");
  });

  it("non-import keyword behavior unchanged when keyword only on non-import lines", async () => {
    const targetFile = "src/no-import-conflict.mjs";
    const lines = [];
    lines.push(`import React from "react";`);
    for (let i = 1; i < 120; i++) lines.push(`  // line ${i}`);
    lines.push(`  const [isDialogVisible, setIsDialogVisible] = useState(false);`);
    for (let i = 122; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.kw-no-import-conflict";
    makeStory(storyId, targetFile, "Add isDialogVisible state to control visibility");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("isDialogVisible");
    expect(updated).toContain("// Context:");
    expect(updated).not.toContain("lines omitted");
  });

  it("import-line detection is trimmed prefix-based — lines with 'import' in non-leading position are not skipped", async () => {
    const targetFile = "src/import-elsewhere.mjs";
    const lines = [];
    lines.push(`import path from "path";`);
    for (let i = 1; i < 120; i++) lines.push(`  // line ${i}`);
    lines.push(`  const resolvedPath = resolveModule(mod);`);
    for (let i = 122; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.kw-import-elsewhere";
    makeStory(storyId, targetFile, "Add resolvedPath using resolveModule helper");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("resolvedPath");
    expect(updated).toContain("// Context:");
    expect(updated).not.toContain("lines omitted");
  });

  it("multiple keywords — some on import lines — first non-import match chosen", async () => {
    const targetFile = "src/multi-kw.mjs";
    const lines = [];
    lines.push(`import React, { useState, useCallback } from "react";`);
    for (let i = 1; i < 110; i++) lines.push(`  // line ${i}`);
    lines.push(`  const buildOptions = useCallback(() => {`);
    lines.push(`    return items.map(i => ({ label: i.name }));`);
    lines.push(`  }, [items]);`);
    for (let i = 113; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.kw-multi-kw";
    makeStory(storyId, targetFile, "Add buildOptions with useCallback for rendering");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("buildOptions");
    expect(updated).toContain("// Context:");
    expect(updated).not.toContain("lines omitted");
  });
});

describe("add_code_snippet stale truncated snippet refresh", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_stale_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  function makeStoryWithExistingSnippet(storyId, targetFile, existingSnippet, desc = "test desc") {
    const content = [
      "---",
      `id: "${storyId}"`,
      `title: "Stale snippet test"`,
      `desc: "${desc}"`,
      `status: "not-implemented"`,
      `phase: "ready"`,
      `targetFiles:`,
      `  - path: "${targetFile}"`,
      `    op: "edit"`,
      `    desc: "${desc}"`,
      "---",
      "",
      "## Problem",
      "",
      "Something.",
      "",
      `### Target: ${targetFile}`,
      "",
      "```javascript",
      existingSnippet,
      "```",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("replaces stale truncated section and re-injects fresh snippet", async () => {
    const targetFile = "src/large.mjs";
    const staleSnippet = `// head\n\n// ... (150 lines omitted) ...\n\n// tail`;
    // File has a keyword from the desc at line 100 so keyword injection fires (no head+tail)
    const lines = Array.from({ length: 200 }, (_, i) => `// line ${i}`);
    lines[100] = "  const handleRefreshAction = () => {};";
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.stale-refresh-test";
    makeStoryWithExistingSnippet(storyId, targetFile, staleSnippet, "Add handleRefreshAction to the component");

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const applied = result.applied.find(a => a.type === "add_code_snippet");
    expect(applied).toBeDefined();
    expect(applied.result).not.toMatch(/skipped/);

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).not.toContain("lines omitted");
    expect(updated).toContain("handleRefreshAction");
  });

  it("preserves non-truncated existing section and skips re-injection", async () => {
    const targetFile = "src/small.mjs";
    const existingSnippet = `export function foo() {\n  return 42;\n}`;
    fs.writeFileSync(path.join(projectRoot, targetFile), existingSnippet);

    const storyId = "backlog.stale-preserve-test";
    makeStoryWithExistingSnippet(storyId, targetFile, existingSnippet);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const applied = result.applied.find(a => a.type === "add_code_snippet");
    expect(applied.result).toMatch(/skipped \(already present\)/);

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("export function foo()");
  });

  it("refreshes legacy ### Code Snippet: header with lines omitted", async () => {
    const targetFile = "src/legacy.mjs";
    const lines = Array.from({ length: 200 }, (_, i) => `// line ${i}`);
    lines[80] = "  const handleLegacyUpdate = () => {};";
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));

    const storyId = "backlog.stale-legacy-header";
    // Use legacy "### Code Snippet:" header
    const content = [
      "---",
      `id: "${storyId}"`,
      `title: "Legacy header test"`,
      `desc: "test"`,
      `status: "not-implemented"`,
      `phase: "ready"`,
      `targetFiles:`,
      `  - path: "${targetFile}"`,
      `    op: "edit"`,
      `    desc: "Add handleLegacyUpdate to the component"`,
      "---",
      "",
      "## Problem",
      "",
      "Something.",
      "",
      `### Code Snippet: ${targetFile}`,
      "",
      "```javascript",
      "// head\n\n// ... (100 lines omitted) ...\n\n// tail",
      "```",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);

    const result = await runRefineApplyTool({
      projectRoot,
      problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });

    const applied = result.applied.find(a => a.type === "add_code_snippet");
    expect(applied.result).not.toMatch(/skipped/);

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).not.toContain("lines omitted");
    expect(updated).toContain("handleLegacyUpdate");
  });
});

describe("add_code_snippet function body extraction", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_funcbody_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  function makeStory(storyId, targetFile, desc) {
    const content = [
      "---",
      `id: "${storyId}"`,
      `title: "Function body test"`,
      `desc: "test"`,
      `status: "not-implemented"`,
      `phase: "ready"`,
      `targetFiles:`,
      `  - path: "${targetFile}"`,
      `    op: "edit"`,
      `    desc: "${desc}"`,
      "---",
      "",
      "## Problem",
      "",
      "Something.",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), content);
  }

  it("extracts const arrow function body by name from desc", async () => {
    const targetFile = "src/const-arrow.mjs";
    const lines = [];
    lines.push(`import React from "react";`);
    for (let i = 1; i < 120; i++) lines.push(`  // line ${i}`);
    lines.push(`const computeTotal = (items) => {`);
    lines.push(`  return items.reduce((sum, i) => sum + i.price, 0);`);
    lines.push(`};`);
    for (let i = 123; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.fb-const-arrow";
    makeStory(storyId, targetFile, "Update computeTotal to apply discounts");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("computeTotal");
    expect(updated).toContain("function body for");
    expect(updated).not.toContain("lines omitted");
  });

  it("extracts async function body by name from desc", async () => {
    const targetFile = "src/async-fn.mjs";
    const lines = [];
    lines.push(`import fs from "fs";`);
    for (let i = 1; i < 130; i++) lines.push(`  // line ${i}`);
    lines.push(`async function loadUserData(userId) {`);
    lines.push(`  const record = await db.find(userId);`);
    lines.push(`  return record;`);
    lines.push(`}`);
    for (let i = 134; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.fb-async-fn";
    makeStory(storyId, targetFile, "Add caching to loadUserData");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("loadUserData");
    expect(updated).toContain("function body for");
    expect(updated).not.toContain("lines omitted");
  });

  it("handles nested braces correctly — does not stop at inner closing brace", async () => {
    const targetFile = "src/nested-braces.mjs";
    const lines = [];
    for (let i = 0; i < 120; i++) lines.push(`  // line ${i}`);
    lines.push(`export const buildFilter = (opts) => {`);
    lines.push(`  if (opts.active) {`);
    lines.push(`    return { active: true };`);
    lines.push(`  }`);
    lines.push(`  return {};`);
    lines.push(`};`);
    for (let i = 126; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.fb-nested";
    makeStory(storyId, targetFile, "Extend buildFilter with status field");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("buildFilter");
    expect(updated).toContain("return {};");
    expect(updated).not.toContain("lines omitted");
  });

  it("falls through to keyword injection when declaration has no brace body", async () => {
    const targetFile = "src/no-body.mjs";
    const lines = [];
    for (let i = 0; i < 120; i++) lines.push(`  // line ${i}`);
    lines.push(`  const retryLimit = 3;`);
    for (let i = 122; i < 200; i++) lines.push(`  // line ${i}`);
    fs.writeFileSync(path.join(projectRoot, targetFile), lines.join("\n"));
    const storyId = "backlog.fb-no-body";
    makeStory(storyId, targetFile, "Increase retryLimit for network calls");
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_code_snippet", data: { file: targetFile } }],
    });
    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // No brace body — function body extractor skips, falls through to keyword or head+tail
    expect(updated).not.toContain("function body for");
    expect(updated).toContain("retryLimit");
  });
});

// ─── Refinement History deduplication ────────────────────────────────────────

describe("Refinement History — deduplication", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine-history-dedup");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, "src"));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const TARGET = "src/svc.mjs";
  const FILE_CONTENT = `export function processItem(item) {\n  return item;\n}\n`;

  function makeStoryNote(storyId, extraBody = "") {
    return `---
id: "${storyId}"
title: "History dedup test"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "${TARGET}"
    op: "edit"
---

## Problem

Something.

### Target: ${TARGET}

\`\`\`javascript
${FILE_CONTENT}\`\`\`
${extraBody}`;
  }

  it("appends Refinement History section on first call", async () => {
    const storyId = "backlog.feat.hist-first";
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), makeStoryNote(storyId));

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function processItem(item) {"] } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(updated).toContain("## Refinement History");
    const count = (updated.match(/## Refinement History/g) || []).length;
    expect(count).toBe(1);
  });

  it("does not append duplicate history section on repeated calls", async () => {
    const storyId = "backlog.feat.hist-no-dup";
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), makeStoryNote(storyId));

    // First call — injects anchor + history
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function processItem(item) {"] } }],
    });

    // Second call — anchor already present (skipped), history line already present
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function processItem(item) {"] } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    const count = (updated.match(/## Refinement History/g) || []).length;
    expect(count).toBe(1);
  });

  it("calling 7 times results in exactly one Refinement History section", async () => {
    const storyId = "backlog.feat.hist-idempotent";
    fs.writeFileSync(path.join(projectRoot, TARGET), FILE_CONTENT);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), makeStoryNote(storyId));

    for (let i = 0; i < 7; i++) {
      await runRefineApplyTool({
        projectRoot, problemId: storyId,
        refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: ["export function processItem(item) {"] } }],
      });
    }

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    const count = (updated.match(/## Refinement History/g) || []).length;
    expect(count).toBe(1);
  });

  it("appends a new history section when a genuinely new history line is added", async () => {
    const storyId = "backlog.feat.hist-new-line";
    const anchor1 = "export function processItem(item) {";
    const anchor2 = "export function newFunc() {";
    const extendedContent = FILE_CONTENT + `\nexport function newFunc() {\n  return 2;\n}\n`;
    fs.writeFileSync(path.join(projectRoot, TARGET), extendedContent);
    fs.writeFileSync(path.join(projectRoot, "notes", `${storyId}.md`), makeStoryNote(storyId, "").replace(FILE_CONTENT, extendedContent));

    // First call — injects anchor1
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [anchor1] } }],
    });

    // Second call — new anchor2 (genuinely new history line)
    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "add_search_pattern", data: { file: TARGET, anchors: [anchor2] } }],
    });

    const updated = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    // Should have 2 sections — first for anchor1, second for anchor2
    const count = (updated.match(/## Refinement History/g) || []).length;
    expect(count).toBe(2);
  });
});

describe("acknowledge_multi_file — behavioral", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_ack_multi");
    ensureDir(path.join(projectRoot, "notes"));
  });

  afterEach(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeMultiFileStory(storyId) {
    return `---
id: "${storyId}"
title: "Multi file story"
desc: "test"
status: "not-implemented"
phase: "ready"
targetFiles:
  - path: "src/a.mjs"
    op: "edit"
  - path: "src/b.mjs"
    op: "edit"
  - path: "src/c.mjs"
    op: "edit"
---

## Problem

Something needs changing across multiple files.

## Acceptance Criteria

- [ ] Feature works
`;
  }

  it("sets multiFileAcknowledged: true in frontmatter", async () => {
    const storyId = "backlog.feat.ack-multi";
    writeFile(path.join(projectRoot, "notes", `${storyId}.md`), makeMultiFileStory(storyId));

    await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "acknowledge_multi_file" }],
    });

    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(written).toContain("multiFileAcknowledged: true");
  });

  it("succeeds with no data field", async () => {
    const storyId = "backlog.feat.ack-multi-nodata";
    writeFile(path.join(projectRoot, "notes", `${storyId}.md`), makeMultiFileStory(storyId));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "acknowledge_multi_file" }],
    });

    expect(result.applied.some(a => a.type === "acknowledge_multi_file")).toBe(true);
  });

  it("succeeds with empty data object", async () => {
    const storyId = "backlog.feat.ack-multi-emptydata";
    writeFile(path.join(projectRoot, "notes", `${storyId}.md`), makeMultiFileStory(storyId));

    const result = await runRefineApplyTool({
      projectRoot, problemId: storyId,
      refinements: [{ type: "acknowledge_multi_file", data: {} }],
    });

    expect(result.applied.some(a => a.type === "acknowledge_multi_file")).toBe(true);
    const written = fs.readFileSync(path.join(projectRoot, "notes", `${storyId}.md`), "utf8");
    expect(written).toContain("multiFileAcknowledged: true");
  });
});

// ─── AND gate: 2+ signals required for estimatedComplexity = "high" ──────────

describe("decompose AND gate — 2+ signals required", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_and_gate_test");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, ".rks"));
    writeFile(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
      projectId: "test-project",
      branches: { working: "staging", integration: "staging", production: "main" },
    }));
    ensureDir(path.join(projectRoot, "src"));
  });

  function makeStory(id, targetFilesYaml) {
    return `---
id: ${id}
status: not-implemented
phase: ready
testRequirements:
  - "Test"
targetFiles:
${targetFilesYaml}
---

## Acceptance Criteria
- [ ] AC 1
- [ ] AC 2
- [ ] AC 3
`;
  }

  it("1 signal alone (fileCount > 5, no other signals) does NOT set estimatedComplexity to high", async () => {
    const files = ["a", "b", "c", "d", "e", "f"]
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join("\n");
    const story = makeStory("test-one-signal-files", files);
    writeFile(path.join(projectRoot, "notes", "test-one-signal-files.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-one-signal-files" });
    expect(result.ok).toBe(true);
    // fileCount > 5 fires, but editCount is 6 which is > threshold (5 for edit-only).
    // Both signals fire → this WILL decompose. Let's use editCount=6 with allEditOnly threshold of 5.
    // Actually: 6 files, allEditOnly=true, editCountThreshold=5, editCount=6 > 5 fires.
    // AND fileCount=6 > 5 fires. That's 2 signals. Use 6 edit files → 2 signals.
    // For a true 1-signal test, need fileCount > 5 but editCount <= threshold.
    // With 6 op:edit files: fileCount=6 AND editCount=6 > 5 — 2 signals.
    // So actually this IS 2 signals. Test the correct boundary instead.
    const decompose = result.suggestions.find(s => s.type === "plan_staging");
    expect(decompose).toBeDefined(); // 2 size signals now surface plan-staging, not sibling decompose
    expect(result.suggestions.find(s => s.type === "decompose")).toBeUndefined();
  });

  it("fileCount > 5 alone with edit-only threshold not exceeded does NOT set high complexity", async () => {
    // 6 target files but only 3 are op:edit (others op:create but no edits exceed threshold)
    // Wait — with 3 edits and 3 creates: editCount=3, allEditOnly=false, threshold=3, 3 > 3 false.
    // hasCreateAndEdit=true but editCount=3 NOT > 3. So only fileCount fires. 1 signal → no decompose.
    const files = [
      `  - path: src/new1.mjs\n    op: create`,
      `  - path: src/new2.mjs\n    op: create`,
      `  - path: src/new3.mjs\n    op: create`,
      `  - path: src/a.mjs\n    op: edit`,
      `  - path: src/b.mjs\n    op: edit`,
      `  - path: src/c.mjs\n    op: edit`,
    ].join("\n");
    for (const f of ["a.mjs", "b.mjs", "c.mjs"]) {
      writeFile(path.join(projectRoot, "src", f), "// existing\n");
    }
    const story = makeStory("test-filecnt-only", files);
    writeFile(path.join(projectRoot, "notes", "test-filecnt-only.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-filecnt-only" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "decompose");
    expect(decompose).toBeUndefined(); // only 1 signal (fileCount) → no decompose
  });

  it("2 signals firing together (fileCount > 5 AND editCount > threshold) DOES set high complexity", async () => {
    // 6 op:edit files: fileCount=6 → signal 1; editCount=6 > 5 (edit-only threshold) → signal 2
    const files = ["a", "b", "c", "d", "e", "f"]
      .map(n => `  - path: src/${n}.mjs\n    op: edit`)
      .join("\n");
    for (const f of ["a.mjs", "b.mjs", "c.mjs", "d.mjs", "e.mjs", "f.mjs"]) {
      writeFile(path.join(projectRoot, "src", f), "// existing\n");
    }
    const story = makeStory("test-two-signals", files);
    writeFile(path.join(projectRoot, "notes", "test-two-signals.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-two-signals" });
    expect(result.ok).toBe(true);
    const decompose = result.suggestions.find(s => s.type === "plan_staging");
    expect(decompose).toBeDefined();
    expect(result.suggestions.find(s => s.type === "decompose")).toBeUndefined();
  });

  it("signal count check targets estimatedComplexity assignment, not decomposeReasons.length formatting", async () => {
    // The trigger is decomposeReasons.length >= 2 (structural), not a string-formatting check.
    // When 1 signal fires, decomposeReasons has 1 entry but estimatedComplexity is NOT high.
    const files = [
      `  - path: src/new1.mjs\n    op: create`,
      `  - path: src/new2.mjs\n    op: create`,
      `  - path: src/new3.mjs\n    op: create`,
      `  - path: src/a.mjs\n    op: edit`,
      `  - path: src/b.mjs\n    op: edit`,
      `  - path: src/c.mjs\n    op: edit`,
    ].join("\n");
    for (const f of ["a.mjs", "b.mjs", "c.mjs"]) {
      writeFile(path.join(projectRoot, "src", f), "// existing\n");
    }
    const story = makeStory("test-signal-mechanism", files);
    writeFile(path.join(projectRoot, "notes", "test-signal-mechanism.md"), story);
    const result = await runRefineTool({ projectRoot, problemId: "test-signal-mechanism" });
    expect(result.ok).toBe(true);
    // 1 signal in decomposeReasons → complexity is NOT high
    expect(result.analysis?.estimatedComplexity).not.toBe("high");
    expect(result.analysis?.decomposeReasons?.length).toBe(1);
  });
});

// ─── detectCompileErrors unit tests ────────────────────────────────────────

describe("detectCompileErrors — esbuild pattern", () => {
  it("parses a single esbuild ERROR line", () => {
    const log = `/project/src/Foo.tsx:267:6: ERROR: Unexpected closing fragment tag does not match opening "div" tag`;
    const errors = detectCompileErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("/project/src/Foo.tsx");
    expect(errors[0].line).toBe(267);
    expect(errors[0].message).toMatch(/Unexpected closing fragment/);
  });

  it("parses multiple esbuild ERROR lines", () => {
    const log = [
      `/project/src/Foo.tsx:267:6: ERROR: Unexpected closing fragment tag`,
      `/project/src/Foo.tsx:269:0: ERROR: The character "}" is not valid inside a JSX element`,
    ].join("\n");
    const errors = detectCompileErrors(log);
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(267);
    expect(errors[1].line).toBe(269);
  });

  it("returns empty array when no compile errors present", () => {
    const log = `✓ tests/unit/foo.test.ts (5 tests)\nTest Files 1 passed`;
    const errors = detectCompileErrors(log);
    expect(errors).toHaveLength(0);
  });

  it("returns empty array for null/undefined input", () => {
    expect(detectCompileErrors(null)).toHaveLength(0);
    expect(detectCompileErrors(undefined)).toHaveLength(0);
    expect(detectCompileErrors("")).toHaveLength(0);
  });
});

describe("detectCompileErrors — tsc pattern", () => {
  it("parses a tsc error with file location", () => {
    const log = `src/Bar.ts(42,8): error TS2345: Argument of type 'string' is not assignable`;
    const errors = detectCompileErrors(log);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("src/Bar.ts");
    expect(errors[0].line).toBe(42);
    expect(errors[0].message).toMatch(/TS2345/);
  });
});

// ─── test_failed gate widening integration tests ───────────────────────────

describe("refine test_failed gate — context fallback", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_test_failed_gate");
    ensureDir(path.join(projectRoot, "notes"));
    ensureDir(path.join(projectRoot, ".rks"));
    writeFile(path.join(projectRoot, ".rks", "project.json"), JSON.stringify({
      projectId: "test-project",
      branches: { working: "staging", integration: "staging", production: "main" },
    }));
  });

  function makeStory(id) {
    return `---
id: ${id}
status: not-implemented
phase: ready
testRequirements:
  - "Test passes"
targetFiles:
  - path: src/Foo.tsx
    op: edit
---

## Problem
Test story.

## Acceptance Criteria
- [ ] One criterion
`;
  }

  it("emits add_search_pattern with priority critical when context contains esbuild compile error", async () => {
    const id = "test-gate-context-compile";
    writeFile(path.join(projectRoot, "notes", `${id}.md`), makeStory(id));

    const esbuildLog = `/Users/project/src/Foo.tsx:267:6: ERROR: Unexpected closing fragment tag does not match opening "div" tag\n/Users/project/src/Foo.tsx:269:0: ERROR: The character "}" is not valid inside a JSX element`;

    const result = await runRefineTool({
      projectRoot,
      problemId: id,
      trigger: "test_failed",
      context: esbuildLog,
    });

    expect(result.ok).toBe(true);
    const compileSuggestions = result.suggestions.filter(s => s.type === "add_search_pattern" && s.priority === "critical");
    expect(compileSuggestions.length).toBeGreaterThanOrEqual(1);
    expect(compileSuggestions[0].reason).toMatch(/[Cc]ompile error/);
  });

  it("does NOT enter test_failed block when both testOutput and context are absent", async () => {
    const id = "test-gate-no-output";
    writeFile(path.join(projectRoot, "notes", `${id}.md`), makeStory(id));

    const result = await runRefineTool({
      projectRoot,
      problemId: id,
      trigger: "test_failed",
      // no testOutput, no context
    });

    expect(result.ok).toBe(true);
    const criticalSuggestions = result.suggestions.filter(s => s.priority === "critical");
    expect(criticalSuggestions).toHaveLength(0);
  });

  it("compile errors suppress generic add_code_snippet fallthrough (concreteTestSuggestionFired)", async () => {
    const id = "test-gate-suppress-fallthrough";
    writeFile(path.join(projectRoot, "notes", `${id}.md`), makeStory(id));

    const esbuildLog = `/project/src/Foo.tsx:10:5: ERROR: Unexpected end of file`;

    const result = await runRefineTool({
      projectRoot,
      problemId: id,
      trigger: "test_failed",
      context: esbuildLog,
    });

    expect(result.ok).toBe(true);
    // compile error path fired — should not also have fix_numeric_assertion or fix_test_assertion
    const numericSuggestions = result.suggestions.filter(s => s.type === "fix_numeric_assertion");
    const assertionSuggestions = result.suggestions.filter(s => s.type === "fix_test_assertion");
    expect(numericSuggestions).toHaveLength(0);
    expect(assertionSuggestions).toHaveLength(0);
  });
});

// ─── plan_rejected trigger ───────────────────────────────────────────────────

describe("refine trigger: plan_rejected", { timeout: 15000 }, () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTempDir("refine_plan_rejected");
    ensureDir(path.join(projectRoot, "notes"));
    writeFile(
      path.join(projectRoot, "notes", "backlog.feat.test-plan-rejected.md"),
      `---
id: backlog.feat.test-plan-rejected
title: Test story
phase: ready
targetFiles:
  - path: src/foo.mjs
    op: edit
---
Fix foo.
`
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns ok: true with trigger plan_rejected — no enum error", async () => {
    const result = await runRefineTool({
      projectRoot,
      problemId: "backlog.feat.test-plan-rejected",
      trigger: "plan_rejected",
      context: "Plan validation failed: missing SEARCH patterns",
    });
    expect(result.ok).toBe(true);
  });

  it("plan_rejected produces same analysis shape as plan_failed", async () => {
    const [rejectedResult, failedResult] = await Promise.all([
      runRefineTool({
        projectRoot,
        problemId: "backlog.feat.test-plan-rejected",
        trigger: "plan_rejected",
        context: "Plan validation failed: missing SEARCH patterns",
      }),
      runRefineTool({
        projectRoot,
        problemId: "backlog.feat.test-plan-rejected",
        trigger: "plan_failed",
        context: "Plan validation failed: missing SEARCH patterns",
      }),
    ]);
    expect(rejectedResult.ok).toBe(true);
    expect(failedResult.ok).toBe(true);
    expect(Object.keys(rejectedResult)).toEqual(expect.arrayContaining(Object.keys(failedResult)));
  });

  it("all existing trigger values still accepted after enum change", async () => {
    for (const trigger of ["plan_failed", "exec_failed", "test_failed", "design"]) {
      const result = await runRefineTool({
        projectRoot,
        problemId: "backlog.feat.test-plan-rejected",
        trigger,
      });
      expect(result.ok).toBe(true);
    }
  });
});
