import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import { updateField, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";

describe("dendron updateField YAML arrays", () => {
  let notesDir;

  function createNote(filename, fm, body = "") {
    const fmLines = Object.entries(fm)
      .map(([k, v]) => {
        if (Array.isArray(v)) return v.length === 0 ? `${k}: []` : `${k}:\n${v.map(x => `  - ${x}`).join("\n")}`;
        return `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`;
      })
      .join("\n");
    writeFile(path.join(notesDir, filename), `---\n${fmLines}\n---\n\n${body}\n`);
  }

  beforeEach(() => {
    notesDir = makeTempDir("dendron_update_field");
  });

  it("wraps single targetFiles value as YAML array of objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "packages/mcp-rks/src/server/exec.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(Array.isArray(parsed.data.targetFiles)).toBe(true);
    expect(parsed.data.targetFiles[0].path).toBe("packages/mcp-rks/src/server/exec.mjs");
    expect(parsed.data.targetFiles[0].op).toBe("edit");
  });

  it("splits comma-separated targetFiles into array of objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "a.mjs, b.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toHaveLength(2);
    expect(parsed.data.targetFiles[0].path).toBe("a.mjs");
    expect(parsed.data.targetFiles[1].path).toBe("b.mjs");
  });

  it("parses JSON array targetFiles value into objects", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", '["a.mjs", "b.mjs"]');

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toHaveLength(2);
    expect(parsed.data.targetFiles[0].path).toBe("a.mjs");
    expect(parsed.data.targetFiles[1].path).toBe("b.mjs");
  });

  it("handles dependsOn as array field", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "dependsOn", "backlog.foo.bar");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(Array.isArray(parsed.data.dependsOn)).toBe(true);
    expect(parsed.data.dependsOn).toEqual(["backlog.foo.bar"]);
  });

  it("leaves non-array fields as strings", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "testFile", "tests/unit/foo.test.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(typeof parsed.data.testFile).toBe("string");
    expect(parsed.data.testFile).toBe("tests/unit/foo.test.mjs");
  });

  it("preserves existing arrays when updating other fields", () => {
    createNote("test.md", {
      id: "test",
      title: "Test",
      created: 1,
      updated: 2,
      targetFiles: ["src/a.mjs", "src/b.mjs"],
    });
    updateField(notesDir, "test.md", "phase", "ready");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    const parsed = parseFrontmatter(raw);
    expect(parsed.data.targetFiles).toEqual(["src/a.mjs", "src/b.mjs"]);
    expect(parsed.data.phase).toBe("ready");
  });

  it("writes proper YAML object array syntax in output", () => {
    createNote("test.md", { id: "test", title: "Test", created: 1, updated: 2 });
    updateField(notesDir, "test.md", "targetFiles", "src/foo.mjs");

    const raw = fs.readFileSync(path.join(notesDir, "test.md"), "utf8");
    // Should contain YAML array-of-objects syntax, not a flat string
    expect(raw).toMatch(/- path:.*src\/foo\.mjs/);
    expect(raw).toMatch(/op:.*edit/);
    expect(raw).not.toContain('targetFiles: "src/foo.mjs"');
  });
});

describe("dendron updateField — arch_verdict is refused", () => {
  let notesDir;

  function createNote(filename, fm) {
    const fmLines = Object.entries(fm)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
      .join("\n");
    writeFile(path.join(notesDir, filename), `---\n${fmLines}\n---\n\nbody\n`);
  }

  beforeEach(() => {
    notesDir = makeTempDir("dendron_update_field_arch");
    createNote("s.md", { id: "s", title: "S", created: 1, updated: 2, phase: "ready" });
  });

  // The verdict is COMPUTED from a frozen finding ledger. A direct write would
  // restore the unbounded-round defect the ledger exists to close, because the
  // verdict would once again be whatever the reviewer says it is.
  it("throws on a direct arch_verdict write", () => {
    expect(() => updateField(notesDir, "s.md", "arch_verdict", "approved")).toThrow();
  });

  it("names rks_arch_verdict as the required path, so the refusal is actionable", () => {
    expect(() => updateField(notesDir, "s.md", "arch_verdict", "approved")).toThrow(/rks_arch_verdict/);
  });

  it("refuses 'needs-revision' too — the block is on the field, not on a value", () => {
    expect(() => updateField(notesDir, "s.md", "arch_verdict", "needs-revision")).toThrow(/rks_arch_verdict/);
  });

  it("writes NOTHING when it refuses", () => {
    const before = fs.readFileSync(path.join(notesDir, "s.md"), "utf8");
    expect(() => updateField(notesDir, "s.md", "arch_verdict", "approved")).toThrow();
    expect(fs.readFileSync(path.join(notesDir, "s.md"), "utf8")).toBe(before);
  });

  it("permits the write when the internal writer option is set (the tool's own path)", () => {
    expect(() => updateField(notesDir, "s.md", "arch_verdict", "approved", { internalWriter: true })).not.toThrow();
    const parsed = parseFrontmatter(fs.readFileSync(path.join(notesDir, "s.md"), "utf8"));
    expect(parsed.data.arch_verdict).toBe("approved");
  });

  // Was: arch_findings_count and arch_round were writable, because only
  // arch_verdict was guarded. backlog.fix.arch-reserved-fields-write-contract
  // inverted that — the verdict is a pure function of arch_round and arch_ledger,
  // so leaving those two open left the verdict choosable without naming it.
  it("refuses the other four reserved arch fields too", () => {
    for (const field of ["arch_round", "arch_ledger", "arch_deferred", "arch_findings_count"]) {
      expect(() => updateField(notesDir, "s.md", field, "2"), field).toThrow(/rks_arch_verdict/);
    }
  });

  it("leaves NON-reserved fields writable — the guard is a set, not an arch_ prefix", () => {
    // A startsWith("arch_") implementation would pass every other assertion here
    // while silently reserving names the contract never claimed.
    expect(() => updateField(notesDir, "s.md", "arch_reviewer", "vince")).not.toThrow();
    expect(() => updateField(notesDir, "s.md", "title", "T2")).not.toThrow();
    const parsed = parseFrontmatter(fs.readFileSync(path.join(notesDir, "s.md"), "utf8"));
    expect(parsed.data.arch_reviewer).toBe("vince");
  });
});
