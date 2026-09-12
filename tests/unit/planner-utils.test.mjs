import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  MAX_SNIPPET_LINES,
  isRagIndexFresh,
  writeJson,
  summarizeProblemNote,
  getCodemapPath,
  getAnalysisPath,
  readCodemap,
  readAnalysis,
  readSnippet,
  extractSnippet,
  normalizeRagPath,
  classifyPlanStatus,
  runsRoot,
  detectFrameworkFromFiles,
} from "../../packages/mcp-rks/src/server/planner-utils.mjs";

describe("planner-utils", () => {
  describe("MAX_SNIPPET_LINES", () => {
    it("is defined as 80", () => {
      expect(MAX_SNIPPET_LINES).toBe(80);
    });
  });

  describe("writeJson", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-utils-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("writes JSON to file", () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { foo: "bar", num: 42 };
      writeJson(filePath, data);

      const result = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(result).toEqual(data);
    });

    it("creates parent directories if needed", () => {
      const filePath = path.join(tempDir, "nested", "deep", "test.json");
      const data = { nested: true };
      writeJson(filePath, data);

      expect(fs.existsSync(filePath)).toBe(true);
      const result = JSON.parse(fs.readFileSync(filePath, "utf8"));
      expect(result).toEqual(data);
    });
  });

  describe("summarizeProblemNote", () => {
    it("returns null for null/undefined", () => {
      expect(summarizeProblemNote(null)).toBeNull();
      expect(summarizeProblemNote(undefined)).toBeNull();
    });

    it("extracts title from frontmatter", () => {
      const markdown = `---
title: My Problem Title
status: pending
---

# Other Heading

Some content.
`;
      expect(summarizeProblemNote(markdown)).toBe("My Problem Title");
    });

    it("extracts first heading when no frontmatter title", () => {
      const markdown = `# Problem Statement

This is the problem description.
`;
      expect(summarizeProblemNote(markdown)).toBe("Problem Statement");
    });

    it("truncates long first paragraph when no title/heading", () => {
      const longParagraph = "A".repeat(300);
      const markdown = longParagraph;
      const result = summarizeProblemNote(markdown);
      expect(result.length).toBeLessThanOrEqual(241); // 240 + ellipsis
    });
  });

  describe("getCodemapPath", () => {
    it("returns correct path", () => {
      const result = getCodemapPath("/root/project", "my-project");
      expect(result).toBe("/root/project/.rks/state/my-project/codemap.json");
    });
  });

  describe("getAnalysisPath", () => {
    it("returns correct path", () => {
      const result = getAnalysisPath("/root/project", "my-project");
      expect(result).toBe("/root/project/.rks/state/my-project/analysis.json");
    });
  });

  describe("readCodemap", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-utils-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns null when file doesn't exist", () => {
      expect(readCodemap(tempDir, "missing-project")).toBeNull();
    });

    it("reads codemap when file exists", () => {
      const projectId = "test-project";
      const codemapPath = path.join(tempDir, ".rks", "state", projectId, "codemap.json");
      const codemapData = { projectId, pages: [], components: [] };

      fs.mkdirSync(path.dirname(codemapPath), { recursive: true });
      fs.writeFileSync(codemapPath, JSON.stringify(codemapData));

      const result = readCodemap(tempDir, projectId);
      expect(result).not.toBeNull();
      expect(result.path).toBe(codemapPath);
      expect(result.data).toEqual(codemapData);
    });
  });

  describe("readAnalysis", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-utils-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns null when file doesn't exist", () => {
      expect(readAnalysis(tempDir, "missing-project")).toBeNull();
    });

    it("reads analysis when file exists", () => {
      const projectId = "test-project";
      const analysisPath = path.join(tempDir, ".rks", "state", projectId, "analysis.json");
      const analysisData = { projectId, framework: "test" };

      fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
      fs.writeFileSync(analysisPath, JSON.stringify(analysisData));

      const result = readAnalysis(tempDir, projectId);
      expect(result).toEqual(analysisData);
    });

    it("returns null for invalid JSON", () => {
      const projectId = "test-project";
      const analysisPath = path.join(tempDir, ".rks", "state", projectId, "analysis.json");

      fs.mkdirSync(path.dirname(analysisPath), { recursive: true });
      fs.writeFileSync(analysisPath, "invalid json");

      expect(readAnalysis(tempDir, projectId)).toBeNull();
    });
  });

  describe("readSnippet", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-utils-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns null for missing file", () => {
      expect(readSnippet(tempDir, "missing.js")).toBeNull();
    });

    it("reads file content", () => {
      const filePath = path.join(tempDir, "test.js");
      const content = "const x = 1;\nconst y = 2;";
      fs.writeFileSync(filePath, content);

      expect(readSnippet(tempDir, "test.js")).toBe(content);
    });
  });

  describe("extractSnippet", () => {
    it("returns null for null/undefined text", () => {
      expect(extractSnippet(null, /test/)).toBeNull();
      expect(extractSnippet(undefined, /test/)).toBeNull();
    });

    it("returns null when pattern not found", () => {
      expect(extractSnippet("hello\nworld", /notfound/)).toBeNull();
    });

    it("extracts lines around pattern match", () => {
      const text = [
        "line 1",
        "line 2",
        "line 3",
        "target line",
        "line 5",
        "line 6",
        "line 7",
      ].join("\n");

      const result = extractSnippet(text, /target/, 2);
      expect(result).toContain("line 2");
      expect(result).toContain("line 3");
      expect(result).toContain("target line");
      expect(result).toContain("line 5");
      // Note: end is exclusive in slice, so line 6 is not included with contextLines=2
    });
  });

  describe("normalizeRagPath", () => {
    it("returns null for null/undefined", () => {
      expect(normalizeRagPath("/root", null)).toBeNull();
      expect(normalizeRagPath("/root", undefined)).toBeNull();
    });

    it("returns relative path unchanged", () => {
      expect(normalizeRagPath("/root", "src/file.js")).toBe("src/file.js");
    });

    it("converts absolute path to relative", () => {
      expect(normalizeRagPath("/root/project", "/root/project/src/file.js")).toBe("src/file.js");
    });
  });

  describe("classifyPlanStatus", () => {
    it("returns 'note_only' for empty steps", () => {
      expect(classifyPlanStatus({ steps: [] })).toBe("note_only");
    });

    it("returns 'error' when llmStatus is error", () => {
      expect(classifyPlanStatus({ steps: [], llmStatus: "error" })).toBe("error");
    });

    it("returns 'executable' for edit_file with content", () => {
      const status = classifyPlanStatus({
        steps: [{ action: "edit_file", path: "test.js", content: "code" }],
      });
      expect(status).toBe("executable");
    });

    it("returns 'executable' for create_file with content", () => {
      const status = classifyPlanStatus({
        steps: [{ action: "create_file", path: "new.js", content: "code" }],
      });
      expect(status).toBe("executable");
    });

    it("returns 'executable' for search_replace with edits", () => {
      const status = classifyPlanStatus({
        steps: [{
          action: "search_replace",
          path: "test.js",
          edits: [{ search: "old", replace: "new" }],
        }],
      });
      expect(status).toBe("executable");
    });

    it("returns 'needs_refinement' for note steps", () => {
      const status = classifyPlanStatus({
        steps: [{ action: "note", title: "Todo" }],
      });
      expect(status).toBe("needs_refinement");
    });

    it("returns 'needs_refinement' for mixed note and executable steps", () => {
      const status = classifyPlanStatus({
        steps: [
          { action: "edit_file", path: "test.js", content: "code" },
          { action: "note", title: "Review" },
        ],
      });
      expect(status).toBe("needs_refinement");
    });

    it("returns 'note_only' for edit_file without content", () => {
      const status = classifyPlanStatus({
        steps: [{ action: "edit_file", path: "test.js", content: "" }],
      });
      expect(status).toBe("note_only");
    });
  });

  describe("runsRoot", () => {
    it("returns correct path", () => {
      expect(runsRoot("/project")).toBe("/project/.rks/runs");
    });
  });

  describe("detectFrameworkFromFiles", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-utils-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns null for unknown framework", () => {
      expect(detectFrameworkFromFiles(tempDir)).toBeNull();
    });

    it("detects eleventy from .eleventy.js", () => {
      fs.writeFileSync(path.join(tempDir, ".eleventy.js"), "");
      expect(detectFrameworkFromFiles(tempDir)).toBe("eleventy-nunjucks");
    });

    it("detects astro from astro.config.mjs", () => {
      fs.writeFileSync(path.join(tempDir, "astro.config.mjs"), "");
      expect(detectFrameworkFromFiles(tempDir)).toBe("astro");
    });

    it("detects astro from astro.config.ts", () => {
      fs.writeFileSync(path.join(tempDir, "astro.config.ts"), "");
      expect(detectFrameworkFromFiles(tempDir)).toBe("astro");
    });
  });
});
