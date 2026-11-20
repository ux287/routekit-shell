/**
 * backlog.fix.dendron-update-field-rewrites-untouched-frontmatter
 *
 * A single-field write must change that field (plus the stamped `updated:` line)
 * and leave every other frontmatter line byte-identical. Driven through the real
 * write paths (updateField / updateFieldDirect) on a temp notes dir and re-read
 * from disk — never asserted on a serializer return value.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import {
  updateField,
  updateFieldDirect,
  editNote,
  markImplemented,
  parseFrontmatter,
} from "../../packages/mcp-rks/src/dendron.mjs";

const NOTE = "backlog.fix.probe.md";
const ORIGINAL_LINES = [
  "id: backlog.fix.probe",
  "title: Probe story",
  "status: draft",
  "retrieved: 2026-09-29",
  'quoted: "already quoted"',
  "created: 1790709875399",
  "updated: 1790709893251",
  "phase: draft",
];
const RAW = `---\n${ORIGINAL_LINES.join("\n")}\n---\n\n## Problem\n\nBody text.\n`;

function frontmatterLines(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter block on disk");
  return m[1].split("\n");
}

function expectUntouchedByteIdentical(after, writtenField) {
  const expected = ORIGINAL_LINES.filter(
    (l) => !l.startsWith(`${writtenField}:`) && !l.startsWith("updated:"),
  );
  const lines = frontmatterLines(after);
  let cursor = -1;
  for (const line of expected) {
    const at = lines.indexOf(line);
    expect(at, `untouched line lost or rewritten: ${line}`).toBeGreaterThan(-1);
    expect(at, `untouched line reordered: ${line}`).toBeGreaterThan(cursor);
    cursor = at;
  }
}

describe("dendron update_field leaves untouched frontmatter byte-identical", () => {
  let notesDir;
  let notePath;
  let savedTz;

  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "America/Denver";
    notesDir = makeTempDir("dendron_fm_fidelity");
    notePath = path.join(notesDir, NOTE);
    writeFile(notePath, RAW);
  });

  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    fs.rmSync(notesDir, { recursive: true, force: true });
  });

  it("positive control: the pinned zone is west of UTC, so Date.toString() shifts the day", () => {
    expect(String(new Date("2026-09-29"))).toContain("Sep 28 2026");
  });

  it("updateField (string value) keeps every other line byte-identical", () => {
    const res = updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true });
    expect(res.ok).not.toBe(false);
    const after = fs.readFileSync(notePath, "utf8");
    expectUntouchedByteIdentical(after, "status");
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(after).not.toMatch(/GMT/);
    expect(frontmatterLines(after)).toContain("title: Probe story");
    expect(parseFrontmatter(after).data.status).toBe("implemented");
  });

  it("updateFieldDirect (array value) keeps every other line byte-identical", () => {
    const res = updateFieldDirect(notesDir, NOTE, "testFiles", ["tests/unit/a.test.mjs"], { skipEmbed: true });
    expect(res.ok).toBe(true);
    const after = fs.readFileSync(notePath, "utf8");
    expectUntouchedByteIdentical(after, "testFiles");
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(after).not.toMatch(/GMT/);
    expect(parseFrontmatter(after).data.testFiles).toEqual(["tests/unit/a.test.mjs"]);
  });

  it("two successive writes to different fields still leave untouched lines byte-identical", () => {
    updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true });
    updateFieldDirect(notesDir, NOTE, "testFiles", ["tests/unit/a.test.mjs"], { skipEmbed: true });
    const after = fs.readFileSync(notePath, "utf8");
    const expected = ORIGINAL_LINES.filter(
      (l) => !l.startsWith("status:") && !l.startsWith("testFiles:") && !l.startsWith("updated:"),
    );
    const lines = frontmatterLines(after);
    for (const line of expected) expect(lines).toContain(line);
    const data = parseFrontmatter(after).data;
    expect(data.status).toBe("implemented");
    expect(data.testFiles).toEqual(["tests/unit/a.test.mjs"]);
  });

  it("the stamped updated: line changes and still parses as a number", () => {
    updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true });
    const data = parseFrontmatter(fs.readFileSync(notePath, "utf8")).data;
    expect(typeof data.updated).toBe("number");
    expect(data.updated).not.toBe(1790709893251);
  });

  it("the written string field keeps its current emitted form (scanners match phase: \"integrated\")", () => {
    updateField(notesDir, NOTE, "title", "New title", { skipEmbed: true });
    const after = fs.readFileSync(notePath, "utf8");
    expect(frontmatterLines(after)).toContain('title: "New title"');
  });

  it("a written value that is YAML-unsafe is still serialized safely and round-trips", () => {
    const tricky = '"leading quote: with colon-space {and braces}';
    updateField(notesDir, NOTE, "title", tricky, { skipEmbed: true });
    const after = fs.readFileSync(notePath, "utf8");
    expect(parseFrontmatter(after).data.title).toBe(tricky);
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
  });

  // ---- ARCH round-1 amendment: all four writers, duplicate repair, no-id, body carry-through ----

  function expectLinesInOrder(after, expected) {
    const lines = frontmatterLines(after);
    let cursor = -1;
    for (const line of expected) {
      const at = lines.indexOf(line);
      expect(at, `untouched line lost or rewritten: ${line}`).toBeGreaterThan(-1);
      expect(at, `untouched line reordered: ${line}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  }

  function afterFence(raw) {
    const m = raw.match(/^---\n[\s\S]*?\n---/);
    if (!m) throw new Error("no frontmatter block");
    return raw.slice(m[0].length);
  }

  it("editNote keeps every frontmatter line except updated: byte-identical and emits today's body form", () => {
    const newBody = "\n\n## Problem\n\nRewritten body.\n";
    editNote(notesDir, NOTE, newBody, { skipEmbed: true });
    const after = fs.readFileSync(notePath, "utf8");
    expectLinesInOrder(after, ORIGINAL_LINES.filter((l) => !l.startsWith("updated:")));
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(frontmatterLines(after)).toContain("title: Probe story");
    expect(after).not.toMatch(/GMT/);
    // today's emitted form: closing fence, one blank line, newBody with leading whitespace stripped
    expect(afterFence(after)).toBe(`\n\n${newBody.replace(/^\s+/, "")}`);
  });

  it("markImplemented moves the note, changes only id/updated/implementedCommit, and carries the body byte-for-byte", () => {
    markImplemented(notesDir, NOTE, "abc1234", { skipEmbed: true });
    expect(fs.existsSync(notePath)).toBe(false);
    const movedPath = path.join(notesDir, "backlog.z_implemented.fix.probe.md");
    expect(fs.existsSync(movedPath)).toBe(true);
    const after = fs.readFileSync(movedPath, "utf8");
    expectLinesInOrder(
      after,
      ORIGINAL_LINES.filter((l) => !l.startsWith("id:") && !l.startsWith("updated:")),
    );
    expect(frontmatterLines(after)).toContain("retrieved: 2026-09-29");
    expect(after).not.toMatch(/GMT/);
    const data = parseFrontmatter(after).data;
    expect(data.id).toBe("backlog.z_implemented.fix.probe");
    expect(data.implementedCommit).toBe("abc1234");
    expect(afterFence(after)).toBe(afterFence(RAW));
  });

  const DUP_RAW =
    "---\nid: backlog.fix.probe\ntitle: First title\nphase: draft\n---\n\n" +
    "---\ntitle: Second title\ndesc: only in second block\n---\n\nBody after duplicate.\n";

  const DUP_WRITERS = [
    ["updateField", () => updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true }), (d) => expect(d.status).toBe("implemented")],
    ["updateFieldDirect", () => updateFieldDirect(notesDir, NOTE, "testFiles", ["tests/unit/a.test.mjs"], { skipEmbed: true }), (d) => expect(d.testFiles).toEqual(["tests/unit/a.test.mjs"])],
  ];

  for (const [name, write, checkWritten] of DUP_WRITERS) {
    it(`duplicate-frontmatter repair via ${name} yields one merged block, first-block values winning`, () => {
      writeFile(notePath, DUP_RAW);
      write();
      const after = fs.readFileSync(notePath, "utf8");
      expect(after.split("\n").filter((l) => l === "---")).toHaveLength(2);
      const data = parseFrontmatter(after).data;
      checkWritten(data);
      expect(data.title).toBe("First title");
      expect(data.desc).toBe("only in second block");
      expect(afterFence(after).trimStart().startsWith("---")).toBe(false);
    });
  }

  it("a note with no id key gains an id: line and keeps every other line byte-identical", () => {
    const noIdLines = ORIGINAL_LINES.filter((l) => !l.startsWith("id:"));
    writeFile(notePath, `---\n${noIdLines.join("\n")}\n---\n\nBody.\n`);
    updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true });
    const after = fs.readFileSync(notePath, "utf8");
    expect(frontmatterLines(after).some((l) => l.startsWith("id:"))).toBe(true);
    expect(parseFrontmatter(after).data.id).toBe("backlog.fix.probe");
    expectLinesInOrder(
      after,
      noIdLines.filter((l) => !l.startsWith("status:") && !l.startsWith("updated:")),
    );
  });

  for (const [label, sep] of [["no blank line", "\n"], ["two blank lines", "\n\n\n"]]) {
    it(`updateField carries the body through byte-for-byte (${label} after the closing fence)`, () => {
      const raw = `---\n${ORIGINAL_LINES.join("\n")}\n---${sep}## Problem\n\nBody text.\n`;
      writeFile(notePath, raw);
      updateField(notesDir, NOTE, "status", "implemented", { skipEmbed: true });
      expect(afterFence(fs.readFileSync(notePath, "utf8"))).toBe(afterFence(raw));
    });
  }
});
