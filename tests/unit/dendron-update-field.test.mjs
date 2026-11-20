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

// ── backlog.fix.dendron-array-field-write-destroys-unread-entries ────────────
//
// A Governor rewrote testRequirements from a TRUNCATED read and silently destroyed 22
// of 40 entries. The write returned ok:true, writeOk:true, commitOk:true — nothing in
// the response named the loss, and it was caught only because a byte count fell where
// growth was expected.
//
// Both write doors already HOLD the prior array when they overwrite it, so the
// comparison that detects this is a read, not a redesign. These witnesses pin that the
// comparison is made, that it is made against the note rather than the caller, and that
// a shrink is refused rather than reported.

import { updateFieldDirect, arrayFieldDelta, ARRAY_FIELDS } from "../../packages/mcp-rks/src/dendron.mjs";

describe("arrayFieldDelta — the extracted comparison", () => {
  it("reports counts and the removed entry VALUES, not merely how many", () => {
    const d = arrayFieldDelta(["a", "b", "c"], ["a"]);
    expect(d.beforeCount).toBe(3);
    expect(d.afterCount).toBe(1);
    expect(d.removed).toEqual(["b", "c"]);
  });

  it("is a MULTISET difference — removing one of two identical entries counts", () => {
    // A set difference would report this as removing nothing, which is the silent loss
    // the guard exists to surface.
    expect(arrayFieldDelta(["a", "a"], ["a"]).removed).toEqual(["a"]);
  });

  it("ignores key ORDER when comparing object entries", () => {
    const before = [{ path: "a.mjs", op: "edit" }];
    const after = [{ op: "edit", path: "a.mjs" }];
    expect(arrayFieldDelta(before, after).removed).toEqual([]);
  });

  it("treats an absent prior as an empty array", () => {
    expect(arrayFieldDelta(undefined, ["a"])).toEqual({ beforeCount: 0, afterCount: 1, removed: [] });
  });

  // The catch-fallback assignment inside updateField is awkward to drive from outside;
  // asserting the helper directly is what makes that path covered rather than assumed.
  it("reports a same-length replacement as removing the entries that disappeared", () => {
    const d = arrayFieldDelta(["a", "b"], ["x", "y"]);
    expect(d.beforeCount).toBe(2);
    expect(d.afterCount).toBe(2);
    expect(d.removed).toEqual(["a", "b"]);
  });
});

describe("ARRAY_FIELDS writes refuse a shrink and report the delta", () => {
  let dir;
  const NOTE = "s.md";

  function seed(fm) {
    dir = makeTempDir("dendron_array_guard");
    const lines = Object.entries({ id: "s", title: "S", created: 1, updated: 2, ...fm })
      .map(([k, v]) =>
        Array.isArray(v)
          ? v.length === 0
            ? `${k}: []`
            : `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`
          : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
      )
      .join("\n");
    writeFile(path.join(dir, NOTE), `---\n${lines}\n---\n\nbody\n`);
  }

  const readRaw = () => fs.readFileSync(path.join(dir, NOTE), "utf8");
  const readField = (f) => parseFrontmatter(readRaw()).data[f];

  beforeEach(() => seed({ testFiles: ["a", "b", "c"] }));

  it("updateFieldDirect RETURNS ok false and does not throw", () => {
    let res;
    expect(() => { res = updateFieldDirect(dir, NOTE, "testFiles", ["a"]); }).not.toThrow();
    expect(res.ok).toBe(false);
  });

  it("updateField (string door) refuses the same shrink and does not throw", () => {
    let res;
    expect(() => { res = updateField(dir, NOTE, "testFiles", '["a"]'); }).not.toThrow();
    expect(res.ok).toBe(false);
  });

  it("the refusal names the field, a reason code, both counts and the removed entries", () => {
    const res = updateFieldDirect(dir, NOTE, "testFiles", ["a"]);
    expect(res.error).toBe("array_entries_removed");
    expect(res.field).toBe("testFiles");
    expect(res.beforeCount).toBe(3);
    // PROSPECTIVE — the count the rejected write would have produced. The file still
    // holds 3; reporting that would make the afterCount < beforeCount trigger unfireable.
    expect(res.afterCount).toBe(1);
    expect(res.removed).toEqual(["b", "c"]);
    expect(readField("testFiles")).toEqual(["a", "b", "c"]);
  });

  it("leaves the note BYTE-IDENTICAL, including the updated timestamp", () => {
    const before = readRaw();
    updateFieldDirect(dir, NOTE, "testFiles", ["a"]);
    expect(readRaw()).toBe(before);
  });

  it("refuses the maximal shrink — an empty array over a non-empty one", () => {
    const res = updateFieldDirect(dir, NOTE, "testFiles", []);
    expect(res.ok).toBe(false);
    expect(res.afterCount).toBe(0);
    expect(res.removed).toEqual(["a", "b", "c"]);
  });

  it("treats a non-array scalar over an array as a removal", () => {
    const res = updateFieldDirect(dir, NOTE, "testFiles", "a");
    expect(res.ok).toBe(false);
    expect(res.removed).toEqual(["b", "c"]);
  });

  it("permits the shrink when the caller acknowledges it, and still reports the delta", () => {
    const res = updateFieldDirect(dir, NOTE, "testFiles", ["a"], { acknowledgeRemoval: true });
    expect(res.ok).toBe(true);
    expect(res.beforeCount).toBe(3);
    expect(res.afterCount).toBe(1);
    expect(res.removed).toEqual(["b", "c"]);
    expect(readField("testFiles")).toEqual(["a"]);
  });

  it("acknowledgement is per call — the identical call without it is refused", () => {
    expect(updateFieldDirect(dir, NOTE, "testFiles", ["a"], { acknowledgeRemoval: true }).ok).toBe(true);
    seed({ testFiles: ["a", "b", "c"] });
    expect(updateFieldDirect(dir, NOTE, "testFiles", ["a"]).ok).toBe(false);
  });

  it("does not refuse a growing write, and reports removed as empty", () => {
    seed({ testFiles: ["a"] });
    const res = updateFieldDirect(dir, NOTE, "testFiles", ["a", "b"]);
    expect(res.ok).toBe(true);
    expect(res.beforeCount).toBe(1);
    expect(res.afterCount).toBe(2);
    expect(res.removed).toEqual([]);
  });

  it("does not refuse a SAME-LENGTH replacement, yet still names what disappeared", () => {
    seed({ testFiles: ["a", "b"] });
    const res = updateFieldDirect(dir, NOTE, "testFiles", ["x", "y"]);
    expect(res.ok).toBe(true);
    expect(res.beforeCount).toBe(2);
    expect(res.afterCount).toBe(2);
    expect(res.removed).toEqual(["a", "b"]);
  });

  it("reports beforeCount 0 for a field the note does not yet carry", () => {
    seed({});
    const res = updateFieldDirect(dir, NOTE, "testFiles", ["a"]);
    expect(res.ok).toBe(true);
    expect(res.beforeCount).toBe(0);
  });

  it("sources afterCount from what was SERIALIZED, not from the caller's input length", () => {
    seed({});
    const res = updateField(dir, NOTE, "targetFiles", "a.mjs, b.mjs");
    expect(res.afterCount).toBe(2);
    expect(parseFrontmatter(readRaw()).data.targetFiles).toHaveLength(res.afterCount);
  });

  it("always SERIALIZES an ARRAY_FIELDS member as an array through the direct door", () => {
    seed({});
    const res = updateFieldDirect(dir, NOTE, "testFiles", "solo");
    expect(res.ok).toBe(true);
    expect(readField("testFiles")).toEqual(["solo"]);
    expect(res.afterCount).toBe(1);
  });

  // The string door rebinds the identifier holding the parsed value at its assignment
  // site, so a guard written there would compare the incoming array with itself.
  it("sources the prior array from the NOTE even on the string door", () => {
    const res = updateField(dir, NOTE, "testFiles", '["a"]');
    expect(res.beforeCount).toBe(3);
    expect(res.removed).toEqual(["b", "c"]);
  });

  it.each([...ARRAY_FIELDS])("refuses a shrink on %s through BOTH doors", (field) => {
    seed({ [field]: ["a", "b", "c"] });
    expect(updateFieldDirect(dir, NOTE, field, ["a"]).ok).toBe(false);
    seed({ [field]: ["a", "b", "c"] });
    expect(updateField(dir, NOTE, field, '["a"]').ok).toBe(false);
  });

  // Keying on Array.isArray(value) instead would extend the guard to every array-valued
  // field, including the reserved ARCH ones whose ledger shrinks by design.
  it("is keyed on ARRAY_FIELDS membership — a shrinking arch_ledger write is NOT refused", () => {
    seed({ arch_ledger: ["k1", "k2"] });
    expect(ARRAY_FIELDS.has("arch_ledger")).toBe(false);
    const res = updateFieldDirect(dir, NOTE, "arch_ledger", ["k1"], { internalWriter: true });
    expect(res.ok).toBe(true);
    expect(res.removed).toBeUndefined();
  });
});
