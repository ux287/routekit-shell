import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateField, updateFieldDirect, updateFields, canonicalIdFromFilename } from "../../packages/mcp-rks/src/dendron.mjs";

const SERVER_SRC = fs.readFileSync(path.resolve("packages/mcp-rks/src/server.mjs"), "utf8");

const NOTE = "backlog.fix.id-write-fixture";
const FM_WITH_ID = [`id: "${NOTE}"`, `title: "id write fixture"`, `status: "not-implemented"`].join("\n");
const FM_NO_ID = [`title: "id write fixture"`, `status: "not-implemented"`].join("\n");

function writeNote(notesDir, frontmatter) {
  const notePath = path.join(notesDir, `${NOTE}.md`);
  fs.writeFileSync(notePath, `---\n${frontmatter}\n---\n\n# body\n`);
  return notePath;
}

function idLine(text) {
  const m = text.match(/^id:.*$/m);
  return m ? m[0] : null;
}

describe("dendron id field writes", () => {
  let notesDir;
  beforeEach(() => { notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendron-id-write-")); });
  afterEach(() => { fs.rmSync(notesDir, { recursive: true, force: true }); });

  it("updateField with field id never reports ok true while the old id stays on disk", () => {
    const notePath = writeNote(notesDir, FM_WITH_ID);
    const before = fs.readFileSync(notePath, "utf8");
    expect(() => updateField(notesDir, NOTE, "id", "backlog.fix.renamed")).toThrow(/'id'/);
    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("updateFieldDirect with field id never reports ok true while the old id stays on disk", () => {
    const notePath = writeNote(notesDir, FM_WITH_ID);
    const before = fs.readFileSync(notePath, "utf8");
    expect(() => updateFieldDirect(notesDir, NOTE, "id", ["backlog.fix.renamed"])).toThrow(/'id'/);
    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("updateFields with an id entry never reports ok true while the old id stays on disk", () => {
    const notePath = writeNote(notesDir, FM_WITH_ID);
    const before = fs.readFileSync(notePath, "utf8");
    const result = updateFields(notesDir, NOTE, { id: "backlog.fix.renamed", title: "changed" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fields_refused");
    const idRefusal = result.refused.find((r) => r.field === "id");
    expect(idRefusal).toBeDefined();
    expect(idRefusal.reason).toBe("id_field_refused");
    expect(idRefusal.detail).toMatch(/'id'/);
    expect(fs.readFileSync(notePath, "utf8")).toBe(before);
  });

  it("a non-id field write leaves an existing id line byte-identical", () => {
    const notePath = writeNote(notesDir, FM_WITH_ID);
    const beforeId = idLine(fs.readFileSync(notePath, "utf8"));
    expect(beforeId).toBe(`id: "${NOTE}"`);
    expect(updateField(notesDir, NOTE, "title", "changed title").ok).toBe(true);
    expect(idLine(fs.readFileSync(notePath, "utf8"))).toBe(beforeId);
    expect(updateFieldDirect(notesDir, NOTE, "testFiles", ["tests/unit/x.test.mjs"]).ok).toBe(true);
    expect(idLine(fs.readFileSync(notePath, "utf8"))).toBe(beforeId);
  });

  it("a non-id field write on a note with no id adds the canonical id", () => {
    const notePath = writeNote(notesDir, FM_NO_ID);
    expect(idLine(fs.readFileSync(notePath, "utf8"))).toBeNull();
    const result = updateField(notesDir, NOTE, "title", "changed title");
    expect(result.ok).toBe(true);
    const expected = canonicalIdFromFilename(NOTE);
    expect(result.id).toBe(expected);
    const line = idLine(fs.readFileSync(notePath, "utf8"));
    expect(line).not.toBeNull();
    expect(line.replace(/^id:\s*/, "").replace(/^"|"$/g, "")).toBe(expected);
  });

  it("dendron_update_field tool description states the id rule", () => {
    const at = SERVER_SRC.indexOf('name: "dendron_update_field"');
    expect(at).toBeGreaterThan(-1);
    const m = SERVER_SRC.slice(at).match(/description:\s*"([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/\bid\b/);
    expect(m[1]).toMatch(/refused/);
    expect(m[1]).toMatch(/dendron_rename_note/);
  });
});
