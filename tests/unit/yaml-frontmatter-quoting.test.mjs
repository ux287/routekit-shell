import { describe, it, expect } from "vitest";
import { formatWithFrontmatter, parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";

describe("YAML frontmatter quoting", () => {
  it("preserves string array items containing curly braces through round-trip", () => {
    const data = {
      id: "test-note",
      testRequirements: [
        "assertToolAllowed returns { ok: false, error: 'chain_violation' } when blocked",
        "simple string without special chars",
      ],
    };
    const body = "## Problem\nSome content";
    const serialized = formatWithFrontmatter(data, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.data.testRequirements).toEqual(data.testRequirements);
  });

  it("preserves string array items containing colon-space patterns", () => {
    const data = {
      id: "test-note",
      testRequirements: [
        "returns object with ok: false and error: unauthorized",
      ],
    };
    const body = "";
    const serialized = formatWithFrontmatter(data, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.data.testRequirements).toEqual(data.testRequirements);
  });

  it("preserves structured targetFiles objects through round-trip", () => {
    const data = {
      id: "test-note",
      targetFiles: [
        { path: "src/foo.mjs", op: "edit", desc: "Modify foo" },
        { path: "tests/bar.test.mjs", op: "create", desc: "New test" },
      ],
    };
    const body = "## Content";
    const serialized = formatWithFrontmatter(data, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.data.targetFiles).toHaveLength(2);
    expect(parsed.data.targetFiles[0].path).toBe("src/foo.mjs");
    expect(parsed.data.targetFiles[0].op).toBe("edit");
    expect(parsed.data.targetFiles[1].path).toBe("tests/bar.test.mjs");
    expect(parsed.data.targetFiles[1].op).toBe("create");
  });

  it("does not corrupt other fields when testRequirements contain special chars", () => {
    const data = {
      id: "test-note",
      title: "My Story",
      phase: "planned",
      targetFiles: [
        { path: "src/foo.mjs", op: "edit", desc: "Change" },
      ],
      testRequirements: [
        "returns { ok: false, error: 'chain_violation', tool: toolName }",
      ],
    };
    const body = "## Problem\nContent here";
    const serialized = formatWithFrontmatter(data, body);
    const parsed = parseFrontmatter(serialized);

    expect(parsed.data.id).toBe("test-note");
    expect(parsed.data.title).toBe("My Story");
    expect(parsed.data.phase).toBe("planned");
    expect(parsed.data.targetFiles[0].path).toBe("src/foo.mjs");
    expect(parsed.data.testRequirements[0]).toBe(
      "returns { ok: false, error: 'chain_violation', tool: toolName }"
    );
  });
});
