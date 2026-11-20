import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import { loadStory, loadStoryField } from "../../packages/mcp-rks/src/shared/story-loader.mjs";

describe("loadStory", () => {
  let projectRoot;
  let notesDir;

  beforeEach(() => {
    projectRoot = makeTempDir("story-loader-test");
    notesDir = path.join(projectRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
  });

  function writeStory(filename, frontmatter, body) {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          const items = v.map(item => {
            if (typeof item === "object") {
              const fields = Object.entries(item).map(([fk, fv]) => `    ${fk}: ${JSON.stringify(fv)}`).join("\n");
              return `  -\n${fields}`;
            }
            return `  - ${item}`;
          }).join("\n");
          return `${k}:\n${items}`;
        }
        return `${k}: ${JSON.stringify(v)}`;
      })
      .join("\n");
    fs.writeFileSync(path.join(notesDir, filename), `---\n${fm}\n---\n\n${body}`);
  }

  it("returns frontmatter with parsed YAML data", () => {
    writeStory("backlog.feat.test.md", { id: "backlog.feat.test", title: "Test Story", phase: "draft" }, "## Problem\nSome problem");
    const result = loadStory(projectRoot, "backlog.feat.test");
    expect(result.frontmatter.id).toBe("backlog.feat.test");
    expect(result.frontmatter.title).toBe("Test Story");
    expect(result.frontmatter.phase).toBe("draft");
  });

  it("returns body with markdown content after frontmatter", () => {
    writeStory("backlog.feat.body.md", { id: "backlog.feat.body" }, "## Problem\nThe body content");
    const result = loadStory(projectRoot, "backlog.feat.body");
    expect(result.body).toContain("## Problem");
    expect(result.body).toContain("The body content");
  });

  it("returns resolved absolute path to the story file", () => {
    writeStory("backlog.feat.path.md", { id: "backlog.feat.path" }, "body");
    const result = loadStory(projectRoot, "backlog.feat.path");
    expect(path.isAbsolute(result.path)).toBe(true);
    expect(result.path).toContain("backlog.feat.path.md");
  });

  it("returns normalized targetFiles from frontmatter", () => {
    writeStory("backlog.feat.targets.md", {
      id: "backlog.feat.targets",
      targetFiles: [
        { path: "src/foo.mjs", op: "create", desc: "New file" },
        { path: "src/bar.mjs", op: "edit", desc: "Edit file" },
      ],
    }, "body");
    const result = loadStory(projectRoot, "backlog.feat.targets");
    expect(result.targetFiles).toHaveLength(2);
    expect(result.targetFiles[0].path).toBe("src/foo.mjs");
    expect(result.targetFiles[1].path).toBe("src/bar.mjs");
  });

  it("returns empty targetFiles array when frontmatter has none", () => {
    writeStory("backlog.feat.notargets.md", { id: "backlog.feat.notargets" }, "body");
    const result = loadStory(projectRoot, "backlog.feat.notargets");
    expect(result.targetFiles).toEqual([]);
  });

  it("throws a descriptive error when story file does not exist", () => {
    expect(() => loadStory(projectRoot, "backlog.feat.nonexistent")).toThrow(/not found/i);
  });
});

describe("loadStoryField", () => {
  let projectRoot;
  let notesDir;

  beforeEach(() => {
    projectRoot = makeTempDir("story-field-test");
    notesDir = path.join(projectRoot, "notes");
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(
      path.join(notesDir, "backlog.feat.field.md"),
      "---\nid: backlog.feat.field\nphase: ready\ntestExempt: true\n---\n\nbody"
    );
  });

  it("returns the requested field value", () => {
    expect(loadStoryField(projectRoot, "backlog.feat.field", "phase")).toBe("ready");
  });

  it("returns default when field is missing", () => {
    expect(loadStoryField(projectRoot, "backlog.feat.field", "missing", "fallback")).toBe("fallback");
  });

  it("returns default when story does not exist", () => {
    expect(loadStoryField(projectRoot, "backlog.feat.nope", "phase", "draft")).toBe("draft");
  });
});
