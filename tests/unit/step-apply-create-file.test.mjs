import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { applySearchReplace, applyCreateFile } from "../../packages/mcp-rks/src/server/step-apply.mjs";
import { reviewPlan } from "../../packages/mcp-rks/src/server/plan-quality.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rks-create-file-test-"));
}

// ---------------------------------------------------------------------------
// applySearchReplace — regression: existing behavior unaffected
// ---------------------------------------------------------------------------

describe("applySearchReplace — regression", () => {
  it("applies a single search/replace edit to an existing file", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.js");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
    applySearchReplace(filePath, [{ search: "const x = 1;", replace: "const x = 99;" }]);
    expect(fs.readFileSync(filePath, "utf8")).toContain("const x = 99;");
  });

  it("throws when file does not exist", () => {
    expect(() =>
      applySearchReplace("/nonexistent/path/file.js", [{ search: "x", replace: "y" }])
    ).toThrow();
  });

  it("throws when search string is not found", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "test.js");
    fs.writeFileSync(filePath, "const x = 1;\n");
    expect(() =>
      applySearchReplace(filePath, [{ search: "NOT_PRESENT", replace: "y" }])
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyCreateFile — unit tests
// ---------------------------------------------------------------------------

describe("applyCreateFile", () => {
  it("writes file content to disk at the given path", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "newfile.mjs");
    applyCreateFile(filePath, "export const x = 1;\n");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("export const x = 1;\n");
  });

  it("creates intermediate directories when they do not exist", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "deep", "nested", "dir", "file.mjs");
    applyCreateFile(filePath, "// content\n");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("throws when content is empty string", () => {
    const dir = makeTempDir();
    expect(() => applyCreateFile(path.join(dir, "f.mjs"), "")).toThrow(/empty content/);
  });

  it("throws when content is whitespace only", () => {
    const dir = makeTempDir();
    expect(() => applyCreateFile(path.join(dir, "f.mjs"), "   \n  ")).toThrow(/empty content/);
  });

  it("throws when content is missing (undefined)", () => {
    const dir = makeTempDir();
    expect(() => applyCreateFile(path.join(dir, "f.mjs"), undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// exec.mjs create_file dispatch — routes through applyCreateFile
// ---------------------------------------------------------------------------

describe("exec.mjs create_file dispatch", () => {
  it("exec imports applyCreateFile from step-apply", () => {
    const execSource = fs.readFileSync(
      new URL("../../packages/mcp-rks/src/server/exec.mjs", import.meta.url),
      "utf8"
    );
    expect(execSource).toContain("applyCreateFile");
    expect(execSource).toContain("step-apply.mjs");
  });

  it("exec routes create_file through applyCreateFile, not inline writeFileSync", () => {
    const execSource = fs.readFileSync(
      new URL("../../packages/mcp-rks/src/server/exec.mjs", import.meta.url),
      "utf8"
    );
    // The create_file block should call applyCreateFile
    const createBlock = execSource.slice(execSource.indexOf('action === "create_file"'));
    const beforeNextAction = createBlock.slice(0, createBlock.indexOf('action === "edit_file"'));
    expect(beforeNextAction).toContain("applyCreateFile");
  });
});

// ---------------------------------------------------------------------------
// plan-quality.mjs checkCreateFileStep — via reviewPlan
// ---------------------------------------------------------------------------

describe("plan-quality: create_file step validation", () => {
  const dir = makeTempDir();

  it("raises error when create_file step has empty content", async () => {
    const plan = {
      steps: [{ action: "create_file", path: "src/new.mjs", content: "" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const err = result.errors.find(e => e.check === "create_file_empty_content");
    expect(err).toBeDefined();
    expect(err.severity).toBe("error");
  });

  it("raises error when create_file step has missing content", async () => {
    const plan = {
      steps: [{ action: "create_file", path: "src/new.mjs" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const err = result.errors.find(e => e.check === "create_file_empty_content");
    expect(err).toBeDefined();
  });

  it("raises error (hard block) when create_file target already exists on disk", async () => {
    const existingFile = path.join(dir, "existing.mjs");
    fs.writeFileSync(existingFile, "// exists\n");
    const plan = {
      steps: [{ action: "create_file", path: "existing.mjs", content: "// new content\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    const err = result.errors.find(e => e.check === "create_file_already_exists");
    expect(err).toBeDefined();
    expect(err.severity).toBe("error");
    expect(result.ok).toBe(false);
  });

  it("passes when create_file step has valid content and new path", async () => {
    const plan = {
      steps: [{ action: "create_file", path: "brand-new.mjs", content: "export const x = 1;\n" }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    expect(result.errors.filter(e => e.check?.startsWith("create_file"))).toHaveLength(0);
  });

  it("search_replace-only plans continue to work without error after create_file dispatch changes", async () => {
    const existingFile = path.join(dir, "target.mjs");
    fs.writeFileSync(existingFile, "const x = 1;\n");
    const plan = {
      steps: [{
        action: "search_replace",
        path: "target.mjs",
        edits: [{ search: "const x = 1;", replace: "const x = 2;" }],
      }],
    };
    const result = await reviewPlan({ projectRoot: dir, plan, problemContent: null });
    expect(result.errors.filter(e => e.check?.startsWith("create_file"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// reviewer.mjs create action — empty content becomes note step
// ---------------------------------------------------------------------------

describe("reviewer.mjs create action — empty content becomes note", () => {
  it("reviewer converts empty-content create action to note step", () => {
    const reviewerSource = fs.readFileSync(
      new URL("../../packages/mcp-rks/src/llm/reviewer.mjs", import.meta.url),
      "utf8"
    );
    expect(reviewerSource).toContain("create_file step for");
    expect(reviewerSource).toContain("has no content");
    expect(reviewerSource).toContain('step.action = "note"');
  });

  it("reviewer does NOT fall back to empty string for create content", () => {
    const reviewerSource = fs.readFileSync(
      new URL("../../packages/mcp-rks/src/llm/reviewer.mjs", import.meta.url),
      "utf8"
    );
    expect(reviewerSource).not.toContain('edit.content || ""');
  });
});
