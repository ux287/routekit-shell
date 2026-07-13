import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  truncateText,
  extractSectionLines,
  detectFileMetadata,
  guessFilePath,
  buildContentForPath,
  parseListAndTables,
  isParserWork,
  isTestWork,
  isDocWork,
  resolveTarget,
  buildNoteDrivenSteps,
} from "../../packages/mcp-rks/src/server/planner-note-steps.mjs";
// backlog.fix.planner-note-step-false-rejection: validateStep now comes from planner.mjs — the ONE
// live copy. planner-note-steps.mjs used to export a second, identical implementation that nothing
// in src/ imported; a duplicate rule is a rule that can silently diverge, and this bug was born of
// exactly that class of drift. The duplicate is now module-private, so the tests below exercise the
// copy the planner actually runs.
import { validateStep } from "../../packages/mcp-rks/src/server/planner.mjs";

describe("planner-note-steps", () => {
  describe("truncateText", () => {
    it("returns empty string for null/undefined", () => {
      expect(truncateText(null)).toBe("");
      expect(truncateText(undefined)).toBe("");
      expect(truncateText("")).toBe("");
    });

    it("returns text unchanged if shorter than length", () => {
      expect(truncateText("short text", 50)).toBe("short text");
    });

    it("truncates text with ellipsis when exceeding length", () => {
      const result = truncateText("This is a very long text that needs to be truncated", 20);
      expect(result.length).toBeLessThanOrEqual(21); // 20 + ellipsis
      expect(result.endsWith("…")).toBe(true);
    });

    it("trims whitespace", () => {
      expect(truncateText("  text with spaces  ")).toBe("text with spaces");
    });
  });

  describe("extractSectionLines", () => {
    it("returns empty array for null/undefined markdown", () => {
      expect(extractSectionLines(null, /test/)).toEqual([]);
      expect(extractSectionLines(undefined, /test/)).toEqual([]);
    });

    it("extracts lines under matching heading", () => {
      const markdown = `
# Introduction
Some intro text.

## Requirements
- First requirement
- Second requirement

## Other Section
Other content.
`;
      const lines = extractSectionLines(markdown, /^#{1,6}\s+requirements/i);
      expect(lines).toContain("- First requirement");
      expect(lines).toContain("- Second requirement");
      expect(lines).not.toContain("Some intro text.");
      expect(lines).not.toContain("Other content.");
    });

    it("handles string patterns", () => {
      const markdown = `
## Acceptance
- Criterion 1
- Criterion 2
`;
      const lines = extractSectionLines(markdown, "^#{1,6}\\s+acceptance");
      expect(lines).toContain("- Criterion 1");
    });
  });

  describe("detectFileMetadata", () => {
    it("returns empty object for null/undefined", () => {
      expect(detectFileMetadata(null)).toEqual({});
      expect(detectFileMetadata(undefined)).toEqual({});
    });

    it("extracts backtick-quoted file paths", () => {
      const result = detectFileMetadata("Update `src/components/Button.tsx`");
      expect(result.filePath).toBe("src/components/Button.tsx");
    });

    it("extracts plain file paths", () => {
      const result = detectFileMetadata("Modify packages/cli/bin/routekit.js");
      expect(result.filePath).toBe("packages/cli/bin/routekit.js");
    });

    it("detects create action hint", () => {
      const result = detectFileMetadata("Create a new file `src/utils/helper.js`");
      expect(result.actionHint).toBe("create_file");
    });

    it("detects edit action hint", () => {
      const result = detectFileMetadata("Edit the config file");
      expect(result.actionHint).toBe("edit_file");
    });

    it("detects delete action hint", () => {
      const result = detectFileMetadata("Delete the old module");
      expect(result.actionHint).toBe("delete_file");
    });

    it("detects run_command action hint", () => {
      const result = detectFileMetadata("Run npm install");
      expect(result.actionHint).toBe("run_command");
    });
  });

  describe("guessFilePath", () => {
    it("returns null for null/undefined", () => {
      expect(guessFilePath(null)).toBeNull();
      expect(guessFilePath(undefined)).toBeNull();
    });

    it("returns server.mjs for buildNoteDrivenSteps references", () => {
      expect(guessFilePath("modify buildNoteDrivenSteps function")).toBe("packages/mcp-rks/src/server.mjs");
    });

    it("returns test path for regression test references", () => {
      expect(guessFilePath("add regression tests")).toBe("packages/mcp-rks/__tests__/planner.spec.mjs");
    });

    it("returns docs path for planning.md references", () => {
      expect(guessFilePath("update planning.md documentation")).toBe("notes/how-to.development-workflow.planning.md");
    });

    it("returns telemetry path for telemetry references", () => {
      expect(guessFilePath("emit telemetry event")).toBe(".rks/telemetry/summary.csv");
    });
  });

  describe("parseListAndTables", () => {
    it("parses bullet items", () => {
      const lines = [
        "- First item",
        "- Second item",
        "* Third item",
      ];
      const items = parseListAndTables(lines);
      expect(items.length).toBe(3);
      expect(items[0].type).toBe("bullet");
      expect(items[0].text).toBe("First item");
    });

    it("parses numbered items", () => {
      const lines = [
        "1. First step",
        "2. Second step",
      ];
      const items = parseListAndTables(lines);
      expect(items.length).toBe(2);
      expect(items[0].text).toBe("First step");
    });

    it("parses table rows", () => {
      const lines = [
        "| path/to/file.js | Description of change |",
        "| another/file.ts | Another description |",
      ];
      const items = parseListAndTables(lines);
      expect(items.length).toBe(2);
      expect(items[0].type).toBe("table");
      expect(items[0].path).toBe("path/to/file.js");
    });

    it("skips separator rows", () => {
      const lines = [
        "| File | Description |",
        "| --- | --- |",
        "| test.js | Test file |",
      ];
      const items = parseListAndTables(lines);
      // Should skip header and separator, only get data row
      expect(items.some(i => i.path === "test.js")).toBe(true);
    });
  });

  describe("content classifiers", () => {
    it("isParserWork identifies parser-related work", () => {
      expect(isParserWork("modify buildNoteDrivenSteps")).toBe(true);
      expect(isParserWork("add table utility")).toBe(true);
      expect(isParserWork("random text")).toBe(false);
    });

    it("isTestWork identifies test-related work", () => {
      expect(isTestWork("add regression tests")).toBe(true);
      expect(isTestWork("update spec file")).toBe(true);
      expect(isTestWork("random text")).toBe(false);
    });

    it("isDocWork identifies documentation work", () => {
      expect(isDocWork("update documentation")).toBe(true);
      expect(isDocWork("modify planning.md")).toBe(true);
      expect(isDocWork("random text")).toBe(false);
    });
  });

  describe("validateStep", () => {
    it("returns null for invalid input", () => {
      expect(validateStep(null)).toBeNull();
      expect(validateStep(undefined)).toBeNull();
      expect(validateStep("string")).toBeNull();
    });

    it("passes through note actions", () => {
      const step = { action: "note", title: "Test", description: "Desc" };
      expect(validateStep(step)).toEqual(step);
    });

    // backlog.fix.planner-note-step-false-rejection: these now exercise planner.mjs's validateStep
    // — the ONE the planner actually runs. They previously imported a duplicate from
    // planner-note-steps.mjs that had already DIVERGED: it downgraded invalid steps to
    // `action: "note"`, while the live copy fail-fasts with `_invalid`. So these assertions were
    // green against an implementation nothing in src/ ever called. That is the exact drift this
    // story exists to end; the duplicate is now module-private.
    //
    // An invalid step is REJECTED (_invalid), never disguised as a note. A note is documentation;
    // exec throws on one. Conflating "this step is broken" with "this step is a comment" is what
    // let a single bad step silently discard an entire valid plan.
    it("validates run_command requires command", () => {
      const step = { action: "run_command", command: "" };
      const result = validateStep(step);
      expect(result._invalid).toBe(true);
      expect(result._invalidReason).toMatch(/empty command/i);
    });

    it("validates run_command with valid command", () => {
      const step = { action: "run_command", command: "npm test" };
      const result = validateStep(step);
      expect(result.action).toBe("run_command");
    });

    it("validates search_replace requires edits array", () => {
      const step = { action: "search_replace", path: "test.js" };
      const result = validateStep(step);
      expect(result._invalid).toBe(true);
      expect(result._invalidReason).toBe("missing edits array");
    });

    it("rejects edit_file without content", () => {
      const step = { action: "edit_file", path: "test.js", content: "" };
      const result = validateStep(step);
      expect(result._invalid).toBe(true);
    });

    it("rejects paths with newlines", () => {
      const step = { action: "edit_file", path: "test\n.js", content: "code" };
      const result = validateStep(step);
      expect(result._invalid).toBe(true);
    });

    it("rejects paths with ..", () => {
      const step = { action: "edit_file", path: "../escape.js", content: "code" };
      const result = validateStep(step);
      expect(result._invalid).toBe(true);
    });
  });

  describe("buildNoteDrivenSteps", () => {
    it("returns empty array for null/undefined markdown", () => {
      expect(buildNoteDrivenSteps(null)).toEqual([]);
      expect(buildNoteDrivenSteps(undefined)).toEqual([]);
    });

    it("extracts steps from requirements section", () => {
      const markdown = `
## Requirements
- Add new feature A
- Update feature B
`;
      const steps = buildNoteDrivenSteps(markdown);
      expect(steps.length).toBeGreaterThan(0);
      steps.forEach(step => {
        expect(step).toHaveProperty("action");
        expect(step).toHaveProperty("order");
      });
    });

    it("extracts steps from acceptance criteria", () => {
      const markdown = `
## Acceptance
- [ ] System handles edge case X
- [x] Unit tests pass
`;
      const steps = buildNoteDrivenSteps(markdown);
      expect(steps.length).toBeGreaterThan(0);
    });

    it("returns fallback note step when no requirements found", () => {
      const markdown = `
Some content without any requirements section.
Just plain text here.
`;
      const steps = buildNoteDrivenSteps(markdown);
      expect(steps.length).toBe(1);
      expect(steps[0].action).toBe("note");
      expect(steps[0].title).toBe("Review problem note");
    });

    it("assigns sequential order to steps", () => {
      const markdown = `
## Requirements
- Step one
- Step two
- Step three
`;
      const steps = buildNoteDrivenSteps(markdown);
      const orders = steps.map(s => s.order);
      for (let i = 0; i < orders.length - 1; i++) {
        expect(orders[i]).toBeLessThan(orders[i + 1]);
      }
    });
  });
});
