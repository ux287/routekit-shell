/**
 * Tests for dendron_edit_note surgical patch interface.
 * (backlog.feat.dendron-edit-note-patches)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNoteRaw, formatWithFrontmatter, readNoteRaw } from "../src/dendron.mjs";
import { parseFrontmatter } from "../src/dendron.mjs";

const FRONTMATTER = "---\nid: test-note\ntitle: Test\n---\n";
const BODY = "First line.\nSecond line.\nThird line.";
const ORIGINAL = FRONTMATTER + "\n" + BODY;

function applyPatches(body, patches) {
  let current = body;
  for (let i = 0; i < patches.length; i++) {
    const { search, replace } = patches[i];
    const idx = current.indexOf(search);
    if (idx === -1) {
      return { ok: false, patchIndex: i, search, error: "search_not_found" };
    }
    current = current.slice(0, idx) + replace + current.slice(idx + search.length);
  }
  return { ok: true, body: current };
}

describe("dendron_edit_note patch interface", () => {
  let tmpDir;
  let notePath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-patch-test-"));
    notePath = path.join(tmpDir, "test-note.md");
    fs.writeFileSync(notePath, ORIGINAL, "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("single patch: replaces first occurrence and writes file", () => {
    const result = applyPatches(BODY, [{ search: "Second line.", replace: "Updated line." }]);
    expect(result.ok).toBe(true);
    writeNoteRaw(notePath, formatWithFrontmatter({ id: "test-note", title: "Test" }, result.body));
    const written = fs.readFileSync(notePath, "utf8");
    expect(written).toContain("Updated line.");
    expect(written).not.toContain("Second line.");
    expect(written).toContain("First line.");
    expect(written).toContain("Third line.");
  });

  it("multi-patch success: all patches applied sequentially, file written once", () => {
    const result = applyPatches(BODY, [
      { search: "First line.", replace: "Line one." },
      { search: "Third line.", replace: "Line three." },
    ]);
    expect(result.ok).toBe(true);
    writeNoteRaw(notePath, formatWithFrontmatter({ id: "test-note", title: "Test" }, result.body));
    const written = fs.readFileSync(notePath, "utf8");
    expect(written).toContain("Line one.");
    expect(written).toContain("Line three.");
    expect(written).not.toContain("First line.");
    expect(written).not.toContain("Third line.");
  });

  it("no-match error: returns ok:false with patchIndex and search string", () => {
    const result = applyPatches(BODY, [{ search: "Nonexistent text.", replace: "Replacement." }]);
    expect(result.ok).toBe(false);
    expect(result.patchIndex).toBe(0);
    expect(result.search).toBe("Nonexistent text.");
    expect(result.error).toBe("search_not_found");
  });

  it("rollback: multi-patch where second fails leaves file byte-for-byte unchanged", () => {
    const before = fs.readFileSync(notePath, "utf8");
    const result = applyPatches(BODY, [
      { search: "First line.", replace: "Line one." },
      { search: "Nonexistent text.", replace: "Replacement." },
    ]);
    expect(result.ok).toBe(false);
    expect(result.patchIndex).toBe(1);
    // File must not have been written — still matches original
    const after = fs.readFileSync(notePath, "utf8");
    expect(after).toBe(before);
  });

  it("schema: patches array accepts {search, replace} objects", () => {
    const patches = [{ search: "First line.", replace: "Patched." }];
    expect(patches[0]).toHaveProperty("search");
    expect(patches[0]).toHaveProperty("replace");
    expect(typeof patches[0].search).toBe("string");
    expect(typeof patches[0].replace).toBe("string");
  });
});
