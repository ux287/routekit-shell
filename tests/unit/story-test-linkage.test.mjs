import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";
import {
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  writeNoteRaw,
} from "../../packages/mcp-rks/src/dendron.mjs";

describe("story-test-linkage — testFile frontmatter convention", () => {
  let notesDir;

  beforeEach(() => {
    notesDir = makeTempDir("test-linkage");
  });

  it("frontmatterDefaults generates valid frontmatter without testFile", () => {
    const fm = frontmatterDefaults({ id: "backlog.test", title: "Test Story", desc: "A test" });
    expect(fm.id).toBe("backlog.test");
    expect(fm.title).toBe("Test Story");
    expect(fm.desc).toBe("A test");
    expect(fm.created).toBeTypeOf("number");
    expect(fm.updated).toBeTypeOf("number");
    // testFile is not included by default
    expect(fm.testFile).toBeUndefined();
  });

  it("testFile can be added to generated frontmatter and persists through write/parse cycle", () => {
    const fm = frontmatterDefaults({ id: "backlog.feat.login", title: "Login Feature" });
    fm.testFile = "tests/unit/login.test.mjs";

    const content = formatWithFrontmatter(fm, "## Problem\nLogin is broken.");
    const notePath = path.join(notesDir, "backlog.feat.login.md");
    writeNoteRaw(notePath, content);

    const raw = fs.readFileSync(notePath, "utf8");
    const parsed = parseFrontmatter(raw);

    expect(parsed.data.testFile).toBe("tests/unit/login.test.mjs");
    expect(parsed.data.id).toBe("backlog.feat.login");
    expect(parsed.content).toContain("Login is broken.");
  });

  it("existing notes without testFile parse correctly (no regression)", () => {
    const fm = frontmatterDefaults({ id: "backlog.old", title: "Old Story" });
    const content = formatWithFrontmatter(fm, "## Problem\nSomething old.");
    const notePath = path.join(notesDir, "backlog.old.md");
    writeNoteRaw(notePath, content);

    const raw = fs.readFileSync(notePath, "utf8");
    const parsed = parseFrontmatter(raw);

    expect(parsed.data.id).toBe("backlog.old");
    expect(parsed.data.testFile).toBeUndefined();
    expect(parsed.content).toContain("Something old.");
  });

  it("testFile as empty string is treated as not set", () => {
    const fm = frontmatterDefaults({ id: "backlog.empty-test" });
    fm.testFile = "";

    const content = formatWithFrontmatter(fm, "body");
    const parsed = parseFrontmatter(content);

    // Empty string is preserved in YAML but should be falsy
    const hasTestFile = parsed.data.testFile && String(parsed.data.testFile).trim().length > 0;
    expect(hasTestFile).toBeFalsy();
  });

  it("testFile with path to test file round-trips through frontmatter", () => {
    const fm = {
      id: "backlog.feat.auth",
      title: "Auth Feature",
      desc: "Add OAuth",
      testFile: "tests/unit/auth.test.mjs",
      created: Date.now(),
      updated: Date.now(),
    };

    const content = formatWithFrontmatter(fm, "## Goal\nAdd OAuth support.");
    const parsed = parseFrontmatter(content);

    expect(parsed.data.testFile).toBe("tests/unit/auth.test.mjs");
  });
});
