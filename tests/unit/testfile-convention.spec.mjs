/**
 * Tests for testFile frontmatter convention (Story: backlog.dx.story-test-linkage)
 *
 * Validates that:
 * - testFile field is accepted in frontmatter
 * - dendron_create_note passes testFile through
 * - Existing notes without testFile still parse correctly
 * - Template includes testFile field
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import matter from "gray-matter";

import {
  parseFrontmatter,
  formatWithFrontmatter,
  frontmatterDefaults,
  mergeTemplateWithGenerated,
  validateNoteFrontmatter,
} from "../../packages/mcp-rks/src/dendron.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");
const NOTES_DIR = join(PROJECT_ROOT, "notes");

describe("testFile frontmatter convention", () => {
  describe("parsing", () => {
    it("parses testFile from frontmatter", () => {
      const content = `---
id: backlog.test
title: Test Story
testFile: tests/unit/foo.spec.mjs
---
Body content`;

      const parsed = parseFrontmatter(content);
      expect(parsed.data.testFile).toBe("tests/unit/foo.spec.mjs");
      expect(parsed.data.id).toBe("backlog.test");
    });

    it("handles notes without testFile (no regression)", () => {
      const content = `---
id: backlog.legacy
title: Legacy Story
status: not-implemented
---
Body content`;

      const parsed = parseFrontmatter(content);
      expect(parsed.data.id).toBe("backlog.legacy");
      expect(parsed.data.testFile).toBeUndefined();
      expect(parsed.content).toContain("Body content");
    });

    it("validates notes with testFile pass validation", () => {
      const content = `---
id: backlog.with-test
title: Story With Test
created: 1234567890
updated: 1234567890
testFile: tests/unit/foo.spec.mjs
---
Body`;

      const result = validateNoteFrontmatter(content);
      expect(result.ok).toBe(true);
      expect(result.data.testFile).toBe("tests/unit/foo.spec.mjs");
    });
  });

  describe("formatting", () => {
    it("round-trips testFile through format and parse", () => {
      const fm = {
        id: "backlog.roundtrip",
        title: "Roundtrip Test",
        created: Date.now(),
        updated: Date.now(),
        testFile: "tests/unit/roundtrip.spec.mjs",
      };
      const body = "## Problem\nTest problem.";

      const formatted = formatWithFrontmatter(fm, body);
      const reparsed = parseFrontmatter(formatted);

      expect(reparsed.data.testFile).toBe("tests/unit/roundtrip.spec.mjs");
      expect(reparsed.data.id).toBe("backlog.roundtrip");
      expect(reparsed.content).toContain("Test problem");
    });

    it("includes testFile in generated frontmatter when provided", () => {
      const defaults = frontmatterDefaults({ id: "backlog.gen", title: "Generated" });
      defaults.testFile = "tests/unit/gen.spec.mjs";
      const formatted = formatWithFrontmatter(defaults, "body");

      expect(formatted).toContain("testFile:");
      expect(formatted).toContain("tests/unit/gen.spec.mjs");
    });
  });

  describe("template", () => {
    it("backlog template includes testFile in frontmatter", () => {
      const templatePath = join(NOTES_DIR, "templates.backlog.md");
      const content = readFileSync(templatePath, "utf8");
      const parsed = matter(content);

      expect("testFile" in parsed.data).toBe(true);
    });

    it("backlog template includes Testing Requirements section", () => {
      const templatePath = join(NOTES_DIR, "templates.backlog.md");
      const content = readFileSync(templatePath, "utf8");

      expect(content).toContain("## Testing Requirements");
    });
  });

  describe("template merge", () => {
    it("preserves testFile from generated frontmatter through merge", () => {
      const templateParsed = {
        data: { status: "not-implemented", testFile: "" },
        content: "## Problem\nPlaceholder",
      };
      const generated = {
        title: "My Feature",
        testFile: "tests/unit/my-feature.spec.mjs",
      };

      const { merged } = mergeTemplateWithGenerated({
        generated,
        templateParsed,
        content: "## Problem\nActual problem.",
        id: "backlog.my-feature",
      });

      expect(merged.testFile).toBe("tests/unit/my-feature.spec.mjs");
    });
  });

  describe("backfill verification", () => {
    it("at least 10 z_implemented stories have testFile field", () => {
      const fs = require("fs");
      const notesDir = NOTES_DIR;
      const files = fs.readdirSync(notesDir).filter(
        (f) => f.startsWith("backlog.z_implemented.") && f.endsWith(".md")
      );

      let withTestFile = 0;
      for (const file of files) {
        const content = fs.readFileSync(join(notesDir, file), "utf8");
        const parsed = matter(content);
        if (parsed.data.testFile) {
          withTestFile++;
        }
      }

      expect(withTestFile).toBeGreaterThanOrEqual(10);
    });
  });
});
