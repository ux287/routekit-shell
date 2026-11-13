import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWithFrontmatter, parseFrontmatter } from "../../packages/mcp-rks/src/shared/frontmatter.mjs";
import { updateFieldDirect } from "../../packages/mcp-rks/src/dendron.mjs";

describe("YAML frontmatter quoting", () => {
  it("preserves string array items containing curly braces through round-trip", () => {
    const data = {
      id: "test-note",
      testRequirements: [
        "checkAllowedTool returns { ok: false, error: 'chain_violation' } when blocked",
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

// backlog.fix.yaml-frontmatter-quoting — plain-string array entries, driven through the real
// write path (updateFieldDirect on a temp notes dir) and re-read from disk as a whole note.
describe("plain-string array entries through updateFieldDirect", () => {
  const NOTE = [
    "---",
    'id: "yaml-quoting-fixture"',
    'title: "Fixture"',
    'phase: "draft"',
    "targetFiles:",
    '  - path: "src/foo.mjs"',
    '    op: "edit"',
    "---",
    "",
    "## Problem",
    "body",
    "",
  ].join("\n");

  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-quoting-"));
    fs.writeFileSync(path.join(dir, "fixture.md"), NOTE, "utf8");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAndReread(field, value, options = {}) {
    const res = updateFieldDirect(dir, "fixture", field, value, { skipEmbed: true, ...options });
    expect(res.ok).toBe(true);
    const raw = fs.readFileSync(path.join(dir, "fixture.md"), "utf8");
    // Whole-note re-read: throws if any line of the frontmatter block is now unparseable.
    const parsed = parseFrontmatter(raw);
    return parsed.data;
  }

  function expectOtherFieldsIntact(data) {
    expect(data.id).toBe("yaml-quoting-fixture");
    expect(data.title).toBe("Fixture");
    expect(data.phase).toBe("draft");
    expect(data.targetFiles).toEqual([{ path: "src/foo.mjs", op: "edit" }]);
  }

  const cases = [
    ["leading double quote", '"foo" is returned'],
    ["leading single quote", "'foo' is returned"],
    ["quoted phrase then text", '"foo" bar'],
    ["unterminated double quote", '"foo never closes'],
    ["leading hyphen-space", "- not a nested sequence"],
    ["embedded newline", "line one\nline two"],
    ["empty string", ""],
    ["true look-alike", "true"],
    ["false look-alike", "false"],
    ["null look-alike", "null"],
    ["tilde look-alike", "~"],
    ["integer look-alike", "42"],
    ["float look-alike", "3.14"],
  ];

  for (const [label, entry] of cases) {
    it(`round-trips a ${label} entry byte-identical as a string`, () => {
      const data = writeAndReread("testRequirements", [entry, "plain entry"]);
      expect(data.testRequirements).toEqual([entry, "plain entry"]);
      expect(typeof data.testRequirements[0]).toBe("string");
      expectOtherFieldsIntact(data);
    });
  }

  it("sweeps every YAML indicator absent from the denylist in leading position", () => {
    const entries = ["-x", "- x", "?x", "? x", ",x", "'x", '"x', "%x", "% x"];
    const data = writeAndReread("testRequirements", entries);
    expect(data.testRequirements).toEqual(entries);
    expectOtherFieldsIntact(data);
  });

  it("keeps numeric and boolean array members typed", () => {
    const nums = writeAndReread("arch_round_findings", [2, 2], { internalWriter: true });
    expect(nums.arch_round_findings).toEqual([2, 2]);
    const bools = writeAndReread("flags", [true, false]);
    expect(bools.flags).toEqual([true, false]);
    expectOtherFieldsIntact(bools);
  });

  it("leaves structured objects, map values and top-level strings in their existing form", () => {
    const raw = formatWithFrontmatter(
      {
        id: "x",
        targetFiles: [{ path: "p.mjs", op: "edit", desc: "d" }],
        channel: { remote: "r" },
        tags: ["plain"],
      },
      "",
    );
    expect(raw).toContain('id: "x"');
    expect(raw).toContain('targetFiles:\n  - path: "p.mjs"\n    op: "edit"\n    desc: "d"');
    expect(raw).toContain('channel:\n  remote: "r"');
    // A safe plain entry keeps its bare, readable form.
    expect(raw).toContain("tags:\n  - plain");
  });
});
