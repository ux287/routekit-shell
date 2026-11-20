/**
 * Witness for backlog.fix.targetfiles-op-silently-rewritten-to-edit.
 *
 * A targetFiles entry's `op` is stored as submitted (create | edit | delete) or the whole write
 * is refused with an explicit error and the note left byte-identical. Never silently coerced.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTargetFiles } from "../../packages/mcp-rks/src/shared/normalize-target-files.mjs";
import { updateField, updateFieldDirect, updateFields, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";
import { runRefineApplyTool } from "../../packages/mcp-rks/src/server/refine.mjs";

const NOTE = "backlog.fix.op-probe";
const NOTE_SRC = [
  "---",
  'id: "backlog.fix.op-probe"',
  'title: "probe"',
  'desc: "probe"',
  'phase: "draft"',
  "---",
  "",
  "## Problem",
  "",
  "probe",
  "",
].join("\n");

const BAD_OPS = ["rename", "CREATE", "modify"];
const BAD_ACTIONS = ["RENAME", "MODIFY"];
const DELETE_ENTRY = { path: "a.mjs", op: "delete", desc: "remove it" };

let notesDir;
const notePath = () => path.join(notesDir, NOTE + ".md");
const readRaw = () => fs.readFileSync(notePath(), "utf8");
const stored = () => parseFrontmatter(readRaw()).data.targetFiles;
const OPTS = { skipEmbed: true };

// The offending entry sits at index 1 so the error must name THAT index, not just "0".
const withBad = (bad) => [{ path: "ok.mjs", op: "edit" }, { path: "bad.mjs", ...bad }];

function expectNamesOffender(message, value) {
  expect(message).toContain("bad.mjs");
  expect(message).toContain(value);
  // Delimited index form, per ARCH advisory: a bare /\b1\b/ would match any standalone 1.
  expect(message).toMatch(/\bindex 1\b/);
  for (const admitted of ["create", "edit", "delete"]) expect(message).toContain(admitted);
}

beforeEach(() => {
  notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-op-contract-"));
  fs.writeFileSync(notePath(), NOTE_SRC);
});

afterEach(() => {
  fs.rmSync(notesDir, { recursive: true, force: true });
});

describe("targetFiles op delete round-trips", () => {
  it("updateFieldDirect stores op delete", () => {
    const res = updateFieldDirect(notesDir, NOTE, "targetFiles", [DELETE_ENTRY], OPTS);
    expect(res.ok).toBe(true);
    expect(stored()[0]).toMatchObject({ path: "a.mjs", op: "delete", desc: "remove it" });
  });

  it("updateField string door stores op delete", () => {
    const res = updateField(notesDir, NOTE, "targetFiles", JSON.stringify([DELETE_ENTRY]), OPTS);
    expect(res.ok).toBe(true);
    expect(stored()[0]).toMatchObject({ path: "a.mjs", op: "delete" });
  });

  it("updateFields multi-field writer stores op delete", () => {
    const res = updateFields(notesDir, NOTE, { targetFiles: [DELETE_ENTRY] }, OPTS);
    expect(res.ok).toBe(true);
    expect(stored()[0]).toMatchObject({ path: "a.mjs", op: "delete" });
  });
});

describe("out-of-vocabulary targetFiles values are refused", () => {
  it("updateFieldDirect throws on an out-of-vocabulary op and writes nothing", () => {
    for (const bad of BAD_OPS) {
      const before = readRaw();
      let err = null;
      try { updateFieldDirect(notesDir, NOTE, "targetFiles", withBad({ op: bad }), OPTS); } catch (e) { err = e; }
      expect(err, "op " + bad + " must be refused").not.toBeNull();
      expectNamesOffender(err.message, bad);
      expect(readRaw()).toBe(before);
    }
  });

  it("updateField string door throws on an out-of-vocabulary op and writes nothing", () => {
    // resolveStringFieldValue catches and falls back to the raw value; the refusal must not be swallowed there.
    for (const bad of BAD_OPS) {
      const before = readRaw();
      let err = null;
      try { updateField(notesDir, NOTE, "targetFiles", JSON.stringify(withBad({ op: bad })), OPTS); } catch (e) { err = e; }
      expect(err, "op " + bad + " must be refused").not.toBeNull();
      expectNamesOffender(err.message, bad);
      expect(readRaw()).toBe(before);
    }
  });

  it("updateFields refuses an out-of-vocabulary op with ok false and writes nothing", () => {
    for (const bad of BAD_OPS) {
      const before = readRaw();
      const res = updateFields(notesDir, NOTE, { title: "changed", targetFiles: withBad({ op: bad }) }, OPTS);
      expect(res.ok).toBe(false);
      const entry = res.refused.find((r) => r.field === "targetFiles");
      expect(entry).toBeTruthy();
      expectNamesOffender(String(entry.detail), bad);
      expect(readRaw()).toBe(before);
    }
  });

  it("an out-of-vocabulary action is refused on the direct and string doors", () => {
    for (const bad of BAD_ACTIONS) {
      const before = readRaw();
      expect(() => updateFieldDirect(notesDir, NOTE, "targetFiles", withBad({ action: bad }), OPTS)).toThrow(bad);
      expect(() => updateField(notesDir, NOTE, "targetFiles", JSON.stringify(withBad({ action: bad })), OPTS)).toThrow(bad);
      expect(readRaw()).toBe(before);
    }
  });
});

describe("existing targetFiles mappings are unchanged", () => {
  it("legacy shapes store the same op as before", () => {
    const input = [
      { path: "c1.mjs", op: "create" },
      { path: "c2.mjs", create: true },
      { path: "c3.mjs", action: "CREATE" },
      { path: "e1.mjs", op: "edit" },
      { path: "e2.mjs", action: "EDIT" },
      "e3.mjs",
      { path: "e4.mjs" },
      { path: "d1.mjs", action: "DELETE" },
      { file: "al1.mjs" },
      { name: "al2.mjs" },
      { target: "al3.mjs" },
    ];
    updateFieldDirect(notesDir, NOTE, "targetFiles", input, OPTS);
    const byPath = Object.fromEntries(stored().map((t) => [t.path, t.op]));
    expect(byPath).toEqual({
      "c1.mjs": "create", "c2.mjs": "create", "c3.mjs": "create",
      "e1.mjs": "edit", "e2.mjs": "edit", "e3.mjs": "edit", "e4.mjs": "edit",
      "d1.mjs": "delete",
      "al1.mjs": "edit", "al2.mjs": "edit", "al3.mjs": "edit",
    });
  });
});

describe("normalizeTargetFiles read side", () => {
  it("maps op delete to action DELETE", () => {
    const [t] = normalizeTargetFiles([{ path: "a.mjs", op: "delete" }]);
    expect(t.path).toBe("a.mjs");
    expect(t.action).toBe("DELETE");
  });

  it("never throws for out-of-vocabulary or malformed input", () => {
    const inputs = [
      [{ path: "a.mjs", op: "rename" }],
      [{ path: "a.mjs", action: "RENAME" }],
      [null, 42, "x.mjs", { op: "delete" }],
      undefined,
      "a.mjs",
    ];
    for (const input of inputs) {
      expect(() => normalizeTargetFiles(input)).not.toThrow();
      expect(Array.isArray(normalizeTargetFiles(input))).toBe(true);
    }
  });
});

describe("rks_refine_apply add_target_files merge", () => {
  let projectRoot;
  const PROBLEM = "backlog.fix.op-merge-probe";
  const storyPath = () => path.join(projectRoot, "notes", PROBLEM + ".md");
  const STORY_SRC = [
    "---",
    'id: "backlog.fix.op-merge-probe"',
    'title: "merge probe"',
    'desc: "merge probe"',
    'phase: "draft"',
    "targetFiles:",
    '  - path: "src/old.mjs"',
    '    op: "delete"',
    '    desc: "remove it"',
    "---",
    "",
    "## Problem",
    "",
    "merge probe",
    "",
  ].join("\n");

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rks-op-merge-"));
    fs.mkdirSync(path.join(projectRoot, "notes"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src/old.mjs"), "export const old = 1;\n");
    fs.writeFileSync(path.join(projectRoot, "src/new.mjs"), "export const fresh = 1;\n");
    fs.writeFileSync(storyPath(), STORY_SRC);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("a stored op delete survives an add_target_files merge", async () => {
    await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_target_files", data: { files: ["src/new.mjs"] } }],
    });
    const tf = parseFrontmatter(fs.readFileSync(storyPath(), "utf8")).data.targetFiles;
    const old = tf.find((t) => t.path === "src/old.mjs");
    expect(old.op).toBe("delete");
    expect(tf.find((t) => t.path === "src/new.mjs")).toBeTruthy();
  });

  it("an incoming out-of-vocabulary op is refused and the note is unchanged", async () => {
    const before = fs.readFileSync(storyPath(), "utf8");
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_target_files", data: { files: [{ path: "src/new.mjs", op: "rename" }] } }],
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("rename");
    expect(fs.readFileSync(storyPath(), "utf8")).toBe(before);
  });

  it("an existing out-of-vocabulary stored op is refused and the note is unchanged", async () => {
    // The offending stored entry sits at index 1 so the error must name THAT index.
    const src = STORY_SRC.replace(
      '    desc: "remove it"\n---',
      '    desc: "remove it"\n  - path: "src/legacy.mjs"\n    op: "rename"\n---',
    );
    expect(src).not.toBe(STORY_SRC);
    fs.writeFileSync(storyPath(), src);
    const before = fs.readFileSync(storyPath(), "utf8");
    const res = await runRefineApplyTool({
      projectRoot, problemId: PROBLEM, projectId: "p",
      refinements: [{ type: "add_target_files", data: { files: ["src/new.mjs"] } }],
    });
    expect(res.ok).toBe(false);
    // Asserted on the refusal's own message field, not the serialized result (ARCH advisory).
    const msg = String(res.error);
    expect(msg).toContain("src/legacy.mjs");
    expect(msg).toContain("rename");
    expect(msg).toMatch(/\bindex 1\b/);
    expect(fs.readFileSync(storyPath(), "utf8")).toBe(before);
  });
});
