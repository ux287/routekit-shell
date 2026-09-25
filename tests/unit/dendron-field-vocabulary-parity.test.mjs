/**
 * Field-vocabulary guard parity - backlog.fix.field-vocabulary-guard-parity
 *
 * `phase` was validated inside `updateField` only. `updateFieldDirect` is publicly
 * reachable: server.mjs and agents/dendron.mjs both dispatch to it whenever the
 * incoming value is an Array, so { field: "phase", value: ["bogus"] } reached a
 * writer with no phase guard and wrote. These tests pin the guard on BOTH writers,
 * and pin that it lives in exactly one place.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import {
  updateField,
  updateFieldDirect,
  ARCH_RESERVED_FIELDS,
  FIELD_VOCABULARIES,
  VALID_PHASES,
} from "../../packages/mcp-rks/src/dendron.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DENDRON_SRC_PATH = path.resolve(HERE, "../../packages/mcp-rks/src/dendron.mjs");

const NOTE = "s.md";
const BODY = "\n## Problem\n\nBody text.\n";

let notesDir;

function createNote() {
  writeFile(
    path.join(notesDir, NOTE),
    ["---", 'id: "s"', 'title: "S"', 'phase: "draft"', "---", BODY].join("\n"),
  );
}

function readRaw() {
  return fs.readFileSync(path.join(notesDir, NOTE), "utf8");
}

function messageFrom(fn) {
  try {
    fn();
  } catch (err) {
    return String(err.message);
  }
  return null;
}

beforeEach(() => {
  notesDir = makeTempDir("dendron_field_vocabulary");
  createNote();
});

describe("FIELD_VOCABULARIES - the registry itself", () => {
  it("has exactly one key, and it is phase", () => {
    expect(Object.keys(FIELD_VOCABULARIES).sort()).toEqual(["phase"]);
  });

  it("maps phase to the same vocabulary as VALID_PHASES", () => {
    expect([...FIELD_VOCABULARIES.phase].sort()).toEqual([...VALID_PHASES].sort());
  });

  it("does not widen the ARCH reserved set - phase is still not reserved", () => {
    expect(ARCH_RESERVED_FIELDS.has("phase")).toBe(false);
  });
});

describe("updateFieldDirect - the closed bypass", () => {
  it("throws on an out-of-vocabulary phase passed as an array", () => {
    expect(() => updateFieldDirect(notesDir, NOTE, "phase", ["not-a-real-phase"])).toThrow(
      /Invalid phase/,
    );
  });

  it("throws on an array whose single element IS a legal phase", () => {
    expect(() => updateFieldDirect(notesDir, NOTE, "phase", ["ready"])).toThrow(/Invalid phase/);
  });

  it("throws on an out-of-vocabulary phase passed as a scalar", () => {
    expect(() => updateFieldDirect(notesDir, NOTE, "phase", "not-a-real-phase")).toThrow(
      /Invalid phase/,
    );
  });

  it("still writes a legal scalar phase - the guard rejects values, not the field", () => {
    updateFieldDirect(notesDir, NOTE, "phase", "ready");
    expect(readRaw()).toMatch(/^phase:\s*"?ready"?\s*$/m);
  });

  it("is not unlocked by internalWriter", () => {
    expect(() =>
      updateFieldDirect(notesDir, NOTE, "phase", ["bogus"], { internalWriter: true }),
    ).toThrow(/Invalid phase/);
  });

  it("leaves the note byte-identical when it refuses", () => {
    const before = readRaw();
    expect(() => updateFieldDirect(notesDir, NOTE, "phase", ["bogus"])).toThrow();
    expect(readRaw()).toBe(before);
  });

  it("refuses BEFORE any note I/O - a missing note still reports the phase error", () => {
    expect(() => updateFieldDirect(notesDir, "does-not-exist.md", "phase", ["bogus"])).toThrow(
      /Invalid phase/,
    );
  });

  it("still refuses ARCH reserved fields with the reserved-field message", () => {
    expect(() => updateFieldDirect(notesDir, NOTE, "arch_verdict", ["approved"])).toThrow(
      /rks_arch_verdict/,
    );
  });

  it("leaves unregistered fields alone", () => {
    expect(updateFieldDirect(notesDir, NOTE, "testFiles", ["a.mjs", "b.mjs"]).ok).toBe(true);
  });

  it("keeps the array-shrink guard: a shrinking write returns ok false and does not throw", () => {
    updateFieldDirect(notesDir, NOTE, "testFiles", ["a.mjs", "b.mjs"]);
    let res;
    expect(() => {
      res = updateFieldDirect(notesDir, NOTE, "testFiles", ["a.mjs"]);
    }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(
      updateFieldDirect(notesDir, NOTE, "testFiles", ["a.mjs"], { acknowledgeRemoval: true }).ok,
    ).toBe(true);
  });
});

describe("updateField - unchanged where it already worked", () => {
  it("still throws on an out-of-vocabulary scalar phase, naming value and vocabulary", () => {
    const message = messageFrom(() => updateField(notesDir, NOTE, "phase", "not-a-real-phase"));
    expect(message).toMatch(/Invalid phase/);
    expect(message).toContain("not-a-real-phase");
    for (const phase of VALID_PHASES) {
      expect(message).toContain(phase);
    }
  });

  it("still writes a legal scalar phase", () => {
    updateField(notesDir, NOTE, "phase", "ready");
    expect(readRaw()).toMatch(/^phase:\s*"?ready"?\s*$/m);
  });

  it.each([...VALID_PHASES])("accepts %s", (phase) => {
    expect(() => updateField(notesDir, NOTE, "phase", phase)).not.toThrow();
  });

  it("leaves unregistered fields alone", () => {
    expect(() => updateField(notesDir, NOTE, "title", "anything")).not.toThrow();
  });

  it("matches the registry key exactly - phaseNotes is not phase", () => {
    expect(() => updateField(notesDir, NOTE, "phaseNotes", "anything")).not.toThrow();
  });
});

describe("one guard, one home", () => {
  it("both writers throw the identical message for the same invalid phase", () => {
    const direct = messageFrom(() =>
      updateFieldDirect(notesDir, NOTE, "phase", "not-a-real-phase"),
    );
    const viaUpdateField = messageFrom(() =>
      updateField(notesDir, NOTE, "phase", "not-a-real-phase"),
    );
    expect(direct).not.toBeNull();
    expect(direct).toBe(viaUpdateField);
  });

  it("the inline phase block is gone from dendron.mjs", () => {
    const src = fs.readFileSync(DENDRON_SRC_PATH, "utf8");
    expect(src).not.toMatch(/if \(field === ["']phase["']\)/);
  });
});
