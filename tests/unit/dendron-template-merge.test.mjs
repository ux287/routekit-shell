import { describe, it, expect } from "vitest";
import { mergeTemplateWithGenerated, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

const TEMPLATE_RAW = `---
id: "templates.backlog"
title: "Backlog"
desc: ""
status: "not-implemented"
testFile: ""
targetFiles: []
---

## Problem
Describe the problem clearly and concisely.

## Acceptance Criteria
- (clear, testable criteria)

## Testing Requirements
- [ ] Test that createWidget() returns a valid widget with correct defaults
`;

describe("mergeTemplateWithGenerated", () => {
  const templateParsed = parseFrontmatter(TEMPLATE_RAW);

  it("uses provided content exclusively when content is non-empty", () => {
    const content = "## Problem\n\nThe real problem.\n\n## Acceptance Criteria\n\n- [ ] Real AC 1\n- [ ] Real AC 2";
    const { body } = mergeTemplateWithGenerated({
      generated: { title: "Test Story", desc: "A test" },
      templateParsed,
      content,
      id: "backlog.feat.test",
    });

    expect(body).toBe(content.trim());
    expect(body).not.toContain("createWidget");
    expect(body).not.toContain("Describe the problem clearly");
  });

  it("falls back to template body when content is empty", () => {
    const { body } = mergeTemplateWithGenerated({
      generated: { title: "Test Story", desc: "A test" },
      templateParsed,
      content: "",
      id: "backlog.feat.test",
    });

    expect(body).toContain("Describe the problem clearly");
    expect(body).toContain("createWidget");
  });

  it("falls back to template body when content is not provided", () => {
    const { body } = mergeTemplateWithGenerated({
      generated: { title: "Test Story", desc: "A test" },
      templateParsed,
      id: "backlog.feat.test",
    });

    expect(body).toContain("Describe the problem clearly");
  });

  it("merges template frontmatter fields regardless of content", () => {
    const content = "## Problem\n\nReal content here.";
    const { merged } = mergeTemplateWithGenerated({
      generated: { title: "My Story", desc: "Description" },
      templateParsed,
      content,
      id: "backlog.feat.test",
    });

    expect(merged.id).toBe("backlog.feat.test");
    expect(merged.title).toBe("My Story");
    expect(merged.status).toBe("not-implemented");
    expect(merged.testFile).toBe("");
    expect(Array.isArray(merged.targetFiles)).toBe(true);
  });

  it("handles whitespace-only content as empty (falls back to template)", () => {
    const { body } = mergeTemplateWithGenerated({
      generated: { title: "Test", desc: "" },
      templateParsed,
      content: "   \n  \n  ",
      id: "backlog.feat.test",
    });

    expect(body).toContain("Describe the problem clearly");
  });
});
