import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import { updateField, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

describe("dendron updateField YAML arrays", () => {
  let notesDir;

  function createNote(filename, fm, body = "") {
    const fmLines = Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return v.length === 0 ? `${k}: []` : `${k}:\n${v.map(x => `  - ${x}`).join("\n")}`;
        return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
      })
      .join("\n");
    writeFile(path.join(notesDir, filename), `---\n${fmLines}\n---\n\n${body}\n`);
  }

  beforeEach(() => {
    notesDir = makeTempDir("dendron_update_field");
  });

  it("wraps single targetFiles value as YAML array of objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "packages/mcp-rks/src/server/exec.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(Array.isArray(parsed.data.targetFiles)).toBe(true);
    expect(parsed.data.targetFiles[0].path).toBe("packages/mcp-rks/src/server/exec.mjs");
    expect(parsed.data.targetFiles[0].op).toBe("edit");
  });

  it("splits comma-separated targetFiles into array of objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "a.mjs, b.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toHaveLength(2);
    expect(parsed.data.targetFiles[0].path).toBe("a.mjs");
    expect(parsed.data.targetFiles[1].path).toBe("b.mjs");
  });

  it("parses JSON array targetFiles value into objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", '["a.mjs", "b.mjs"]');

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toHaveLength(2);
    expect(parsed.data.targetFiles[0].path).toBe("a.mjs");
    expect(parsed.data.targetFiles[1].path).toBe("b.mjs");
  });

  it("handles dependsOn as array field", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "dependsOn", "backlog.foo.bar");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(Array.isArray(parsed.data.dependsOn)).toBe(true);
    expect(parsed.data.dependsOn).toEqual(["backlog.foo.bar"]);
  });

  it("leaves non-array fields as strings", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "testFile", "tests/unit/foo.test.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(typeof parsed.data.testFile).toBe("string");
    expect(parsed.data.testFile).toBe("tests/unit/foo.test.mjs");
  });

  it("preserves existing arrays when updating other fields", () => {
    createNote("test.md", {
      id: "test",
      title: "Test",
      created: 1,
      updated: 2,
      targetFiles: ["src/a.mjs", "src/b.mjs"],
    });
    updateField(notesDir, "test.md", "phase", "ready");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toEqual(["src/a.mjs", "src/b.mjs"]);
    expect(parsed.data.phase).toBe("ready");
  });

  it("writes proper YAML object array syntax in output", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "src/foo.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    // Should contain YAML array-of-objects syntax, not a flat string
    expect(raw).toMatch(/- path:.*src\/foo\.mjs/);
    expect(raw).toMatch(/op:.*edit/);
    expect(raw).not.toContain('targetFiles: "src/foo.mjs"');
  });
});
