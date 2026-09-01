/**
 * Tests for backlog.fix.arch-reserved-fields-write-contract.
 *
 * The `arch_verdict` guard shipped in be164150 covered ONE field and one function.
 * Two holes followed from that:
 *
 *  1. The verdict is a pure function of `arch_round` and the frozen `arch_ledger`.
 *     Leaving those writable let any caller choose the verdict without ever naming
 *     it — demonstrated in practice when a stuck story was unblocked by hand-editing
 *     `arch_round` from "1" to "0".
 *  2. `updateFieldDirect` carried no guard at all, and the array-routing call sites
 *     send it any array-valued write — so `arch_verdict: ["approved"]` walked past
 *     the one guard that did exist.
 *
 * These are the first tests of `updateFieldDirect` in the repo: an exhaustive
 * search for it across tests/ returned zero against a positive control of 73
 * `updateField` hits. So the suite deliberately covers its NON-refusal path too,
 * rather than being refusal-only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, writeFile } from "../helpers/tmp.mjs";
import {
  updateField,
  updateFieldDirect,
  parseFrontmatter,
  ARCH_RESERVED_FIELDS,
} from "../../packages/mcp-rks/src/dendron.mjs";

let notesDir;

const NOTE = "s.md";
const BODY = "\n## Problem\n\nBody text.\n";

function createNote() {
  writeFile(
    path.join(notesDir, NOTE),
    `---\nid: "s"\ntitle: "S"\ncreated: 1\nupdated: 2\nphase: "ready"\n---\n${BODY}`,
  );
}

function readRaw() {
  return fs.readFileSync(path.join(notesDir, NOTE), "utf8");
}

function readFm() {
  return parseFrontmatter(readRaw()).data;
}

beforeEach(() => {
  notesDir = makeTempDir("dendron_reserved_fields");
  createNote();
});

describe("ARCH_RESERVED_FIELDS — the set itself", () => {
  it("holds exactly the five arch-owned fields", () => {
    expect([...ARCH_RESERVED_FIELDS].sort()).toEqual([
      "arch_deferred",
      "arch_findings_count",
      "arch_ledger",
      "arch_round",
      "arch_subject",
      "arch_verdict",
    ]);
  });

  // backlog.fix.arch-ledger-subject-rebinding. Called out separately from the set
  // pin because the reason it must be reserved is not the same as the other five:
  // arch_subject is the digest the ledger is BOUND to, so an unreserved one could
  // forge a rebase with junk, or suppress a legitimate one by writing the current
  // digest after amending a story.
  it("reserves arch_subject — the digest the ledger is bound to", () => {
    expect(ARCH_RESERVED_FIELDS.has("arch_subject")).toBe(true);
  });

  // Defined once and consulted by both writers. Asserting the set's contents
  // rather than grepping the source keeps this a behavioural pin.
  it("does NOT reserve phase — four production sites legitimately reset arch-approved", () => {
    expect(ARCH_RESERVED_FIELDS.has("phase")).toBe(false);
  });
});

describe("updateField — refuses every reserved field", () => {
  it.each([...ARCH_RESERVED_FIELDS])("refuses %s", (field) => {
    expect(() => updateField(notesDir, NOTE, field, "x")).toThrow(/rks_arch_verdict/);
  });

  it.each([...ARCH_RESERVED_FIELDS])("names the refused field %s in the message", (field) => {
    expect(() => updateField(notesDir, NOTE, field, "x")).toThrow(new RegExp(field));
  });

  it("permits every reserved field when internalWriter is set", () => {
    for (const field of ARCH_RESERVED_FIELDS) {
      expect(() => updateField(notesDir, NOTE, field, "x", { internalWriter: true }), field).not.toThrow();
    }
    expect(readFm().arch_verdict).toBe("x");
  });
});

describe("updateFieldDirect — refuses every reserved field", () => {
  it.each([...ARCH_RESERVED_FIELDS])("refuses %s", (field) => {
    expect(() => updateFieldDirect(notesDir, NOTE, field, ["x"])).toThrow(/rks_arch_verdict/);
  });

  // The specific bypass this story closes: an array value routed past the
  // single-field guard that only lived in updateField.
  it("refuses the array-valued arch_verdict bypass", () => {
    expect(() => updateFieldDirect(notesDir, NOTE, "arch_verdict", ["approved"])).toThrow(/rks_arch_verdict/);
  });

  it("refuses when called with NO options object at all", () => {
    // agents/dendron.mjs and agents/research.mjs both call with four arguments.
    expect(() => updateFieldDirect(notesDir, NOTE, "arch_round", ["1"])).toThrow(/rks_arch_verdict/);
  });

  it("refuses when handed an options object that lacks the flag", () => {
    // server.mjs forwards a writeOptions object; absence of the flag must refuse.
    expect(() => updateFieldDirect(notesDir, NOTE, "arch_ledger", ["k"], { skipEmbed: true })).toThrow(
      /rks_arch_verdict/,
    );
  });

  it("permits every reserved field when internalWriter is set", () => {
    for (const field of ARCH_RESERVED_FIELDS) {
      expect(
        () => updateFieldDirect(notesDir, NOTE, field, ["x"], { internalWriter: true }),
        field,
      ).not.toThrow();
    }
    expect(readFm().arch_ledger).toEqual(["x"]);
  });

  // First non-refusal coverage this function has ever had.
  it("still writes a non-reserved array field normally", () => {
    updateFieldDirect(notesDir, NOTE, "testFiles", ["a.mjs", "b.mjs"]);
    expect(readFm().testFiles).toEqual(["a.mjs", "b.mjs"]);
  });
});

describe("a refused write touches nothing", () => {
  it.each([...ARCH_RESERVED_FIELDS])("leaves the note byte-identical after updateField refuses %s", (field) => {
    const before = readRaw();
    expect(() => updateField(notesDir, NOTE, field, "x")).toThrow();
    expect(readRaw()).toBe(before);
  });

  it.each([...ARCH_RESERVED_FIELDS])(
    "leaves the note byte-identical after updateFieldDirect refuses %s",
    (field) => {
      const before = readRaw();
      expect(() => updateFieldDirect(notesDir, NOTE, field, ["x"])).toThrow();
      expect(readRaw()).toBe(before);
    },
  );

  it("refuses before the note is even read — a missing note still refuses on the field", () => {
    // If the guard ran after the existence check this would throw "Note not found"
    // instead, so the message distinguishes the two orderings.
    expect(() => updateField(notesDir, "does-not-exist.md", "arch_verdict", "approved")).toThrow(
      /rks_arch_verdict/,
    );
  });
});

describe("phase is unaffected", () => {
  it("still accepts arch-approved through updateField with no internalWriter", () => {
    expect(() => updateField(notesDir, NOTE, "phase", "arch-approved")).not.toThrow();
    expect(readFm().phase).toBe("arch-approved");
  });

  it("still rejects an invalid phase value — existing validation unchanged", () => {
    expect(() => updateField(notesDir, NOTE, "phase", "not-a-real-phase")).toThrow(/Invalid phase/);
  });
});

describe("the guard is a set, not an arch_ prefix", () => {
  it.each(["arch_reviewer", "arch_notes", "architecture"])("leaves %s writable", (field) => {
    expect(() => updateField(notesDir, NOTE, field, "v")).not.toThrow();
    expect(readFm()[field]).toBe("v");
  });
});
