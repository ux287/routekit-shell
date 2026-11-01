/**
 * Witness for backlog.fix.dendron-update-field-drops-unknown-targetfile-keys.
 *
 * `dendron_update_field` accepted a `searchPattern` key on every targetFiles entry,
 * persisted only path/op/desc, and returned SUCCESS. The caller learned of the loss only
 * by reading the frontmatter back and diffing.
 *
 * Option (c) REPORT was chosen over PRESERVE and REJECT:
 *   - REJECT: too broad a blast radius; dendron_update_field is on the PO/QA/refine
 *     authoring paths.
 *   - PRESERVE: `shared/frontmatter.mjs` interpolates non-string nested values RAW, so an
 *     object-valued unknown key would write `key: [object Object]` into durable frontmatter.
 * Keys are still dropped. What changes is that the result says so.
 *
 * Pure filesystem + module import. No subprocess spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  normalizeTargetFiles,
  inspectTargetFiles,
  KNOWN_TARGET_FILE_KEYS,
} from "../../packages/mcp-rks/src/shared/normalize-target-files.mjs";
import { updateField, updateFieldDirect } from "../../packages/mcp-rks/src/dendron.mjs";

let notesDir;

const NOTE = `---
id: "backlog.fix.probe"
title: "probe"
desc: "probe"
phase: "draft"
---

## Problem

probe body
`;

beforeEach(() => {
  notesDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-unknown-keys-"));
  fs.writeFileSync(path.join(notesDir, "backlog.fix.probe.md"), NOTE, "utf8");
});

afterEach(() => {
  fs.rmSync(notesDir, { recursive: true, force: true });
});

const write = (value) =>
  Array.isArray(value)
    ? updateFieldDirect(notesDir, "backlog.fix.probe", "targetFiles", value, { skipEmbed: true })
    : updateField(notesDir, "backlog.fix.probe", "targetFiles", value, { skipEmbed: true });

describe("inspectTargetFiles — what the normalizer discards", () => {
  it("reports an unrecognised key, naming the entry it came from", () => {
    // Defect-present: nothing reported it at all. `normalizeTargetFiles` builds a fresh
    // object from named fields, so the key is gone by construction and unobservable.
    const r = inspectTargetFiles([{ path: "a.mjs", op: "edit", searchPattern: "x" }]);
    expect(r.droppedKeys).toEqual([{ index: 0, path: "a.mjs", keys: ["searchPattern"] }]);
  });

  it("does NOT misreport recognised aliases as dropped", () => {
    // The plausible wrong fix is diffing input keys against OUTPUT keys. That flags
    // `file`, `action`, `create` and `op` — each of which IS read and honoured. This is
    // the assertion that fails against that implementation.
    const r = inspectTargetFiles([
      { file: "a.mjs", action: "CREATE" },
      { name: "b.mjs", create: true },
      { target: "c.mjs", op: "edit", reason: "r", desc: "d" },
    ]);
    expect(r.droppedKeys).toEqual([]);
    expect(r.normalized.map((t) => t.path)).toEqual(["a.mjs", "b.mjs", "c.mjs"]);
  });

  it("reports a whole entry removed by the filter, separately from key loss", () => {
    // Defect-present: `.filter(Boolean)` deleted the entry and the count silently shrank.
    // Reported apart from droppedKeys because losing an entry is the coarser failure.
    const r = inspectTargetFiles([{ op: "edit", desc: "no path anywhere" }]);
    expect(r.droppedEntries).toEqual([
      { index: 0, reason: "entry has no path, file, name or target key" },
    ]);
    expect(r.normalized).toEqual([]);
  });

  it("does not flag a bare string entry, which carries no keys to lose", () => {
    const r = inspectTargetFiles(["a.mjs"]);
    expect(r.droppedKeys).toEqual([]);
    expect(r.droppedEntries).toEqual([]);
  });

  it("leaves normalizeTargetFiles behaviour unchanged", () => {
    // The reporting wrapper must not alter the array its many other callers rely on.
    const input = [{ path: "a.mjs", op: "create", searchPattern: "x", desc: "d" }];
    expect(inspectTargetFiles(input).normalized).toEqual(normalizeTargetFiles(input));
  });

  it("KNOWN_TARGET_FILE_KEYS covers every key the normalizer actually reads", () => {
    for (const k of ["path", "file", "name", "target", "action", "op", "create", "reason", "desc"]) {
      expect(KNOWN_TARGET_FILE_KEYS, `${k} is read by normalizeTargetFiles`).toContain(k);
    }
  });
});

describe("dendron_update_field — both dispatch routes report the loss", () => {
  // server.mjs branches on Array.isArray(input.value): an ARRAY reaches updateFieldDirect,
  // a JSON STRING reaches updateField via parsePossibleArray. A string fixture is required
  // for the second route — passing an array would exercise the first route twice.

  it("ARRAY route reports the dropped key", () => {
    // Defect-present: { ok: true, path, id } with no mention of searchPattern.
    const res = write([{ path: "a.mjs", op: "edit", searchPattern: "x" }]);
    expect(res.ok).toBe(true);
    expect(res.droppedKeys).toEqual([{ index: 0, path: "a.mjs", keys: ["searchPattern"] }]);
  });

  it("JSON STRING route reports the dropped key", () => {
    const res = write('[{"path":"a.mjs","op":"edit","searchPattern":"x"}]');
    expect(res.ok).toBe(true);
    expect(res.droppedKeys).toEqual([{ index: 0, path: "a.mjs", keys: ["searchPattern"] }]);
  });

  it("still drops the key — REPORT does not mean PRESERVE", () => {
    // The write contract is deliberately unchanged. Asserting this stops a later reader
    // mistaking the report for round-tripping, and pins the decision that was made.
    write([{ path: "a.mjs", op: "edit", searchPattern: "x", desc: "d" }]);
    const raw = fs.readFileSync(path.join(notesDir, "backlog.fix.probe.md"), "utf8");
    expect(raw).not.toContain("searchPattern");
    expect(raw).toContain("a.mjs");
    expect(raw).toContain("d");
  });

  it("omits the report entirely when nothing was dropped", () => {
    // An always-present empty array would change the result shape for every write and
    // break existing toEqual assertions on it. Absence of the key is the signal.
    const res = write([{ path: "a.mjs", op: "edit", desc: "d" }]);
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("droppedKeys");
    expect(res).not.toHaveProperty("droppedEntries");
  });

  it("omits the report for a field that is not targetFiles", () => {
    const res = updateField(notesDir, "backlog.fix.probe", "phase", "ready", { skipEmbed: true });
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("droppedKeys");
  });
});

// ── backlog.fix.dendron-array-field-write-destroys-unread-entries ────────────
//
// Two DIFFERENT losses now report on the same result object, and conflating them would
// make either unreadable. Normalization discarding an unrecognised per-entry key is not
// an entry disappearing, and an entry disappearing is not a key being dropped.

describe("droppedKeys and removed are distinct reports", () => {
  it("a targetFiles write carrying unknown keys reports droppedKeys AND the array delta", () => {
    const r = write([{ path: "a.mjs", op: "edit", searchPattern: "x" }]);
    expect(r.ok).toBe(true);
    expect(r.droppedKeys).toEqual([{ index: 0, path: "a.mjs", keys: ["searchPattern"] }]);
    // The entry itself survived — normalization kept it, minus one key.
    expect(r.beforeCount).toBe(0);
    expect(r.afterCount).toBe(1);
    expect(r.removed).toEqual([]);
  });

  it("normalization dropping a key does NOT populate removed", () => {
    write([{ path: "a.mjs", op: "edit" }, { path: "b.mjs", op: "edit" }]);
    const r = write([
      { path: "a.mjs", op: "edit", searchPattern: "x" },
      { path: "b.mjs", op: "edit", bogus: 1 },
    ]);
    expect(r.droppedKeys.length).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);
    expect(r.beforeCount).toBe(2);
    expect(r.afterCount).toBe(2);
  });

  it("a write whose normalization discards nothing reports no removed entries", () => {
    const r = write([{ path: "a.mjs", op: "edit" }]);
    expect(r.droppedKeys).toBeUndefined();
    expect(r.removed).toEqual([]);
  });

  it("a shrinking targetFiles write is refused before normalization loss is reported", () => {
    write([{ path: "a.mjs", op: "edit" }, { path: "b.mjs", op: "edit" }]);
    const r = write([{ path: "a.mjs", op: "edit" }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("array_entries_removed");
    expect(r.removed).toEqual([{ path: "b.mjs", op: "edit" }]);
  });
});
