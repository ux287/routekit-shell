/**
 * backlog.fix.rag-query-arrow-tags-serialization
 *
 * Two compounding mechanisms, tested independently:
 *
 *  1. No decode at the read boundary — `tags: row.tags || []` let an Arrow Vector through, because
 *     a Vector is truthy. `toPlainList` is the shared, duck-typed decode that closes it.
 *  2. `scrubSecrets` EXPANDED that Vector — a Vector is not `Array.isArray`, so it fell into the
 *     generic-object branch and `Object.entries()` enumerated its private internals into the
 *     emitted payload, at EVERY fidelity tier including L0 metadata-only.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/rag-arrow-tags-decode.test.mjs
 */
import { describe, it, expect } from "vitest";
import { toPlainList, UNTAGGED_SENTINEL } from "../../packages/rag/src/rag-columns.mjs";
import { scrubSecrets, applyFidelity, FIDELITY_LEVELS } from "../../packages/rag/src/fidelity-filter.mjs";

/** The private field names whose presence in a payload IS the bug. */
const ARROW_INTERNALS = ["_offsets", "valueOffsets", "nullBitmap", "numChildren", "stride", "typeId"];

/**
 * Stand-in for an Apache Arrow Vector: NOT an Array, exposes toArray(), and carries the same
 * private-looking fields the real blob leaked. Deliberately not the real driver type — the decode
 * must be duck-typed, so a hand-rolled shape is the honest test of that contract.
 */
class FakeArrowVector {
  constructor(items) {
    this._items = items;
    this._offsets = [0, items.length];
    this.valueOffsets = { 0: 8, 1: 12 };
    this.nullBitmap = {};
    this.stride = 1;
    this.numChildren = 0;
    this.length = items.length;
    this.type = { typeId: 5 };
  }
  toArray() {
    return this._items;
  }
}

/** Duck type with NO toArray() — only toJSON(). Proves version tolerance. */
class JsonOnlyList {
  constructor(items) {
    this._items = items;
  }
  toJSON() {
    return this._items;
  }
}

/** Duck type with NO toArray() and NO toJSON() — only iterability. */
class IterableOnlyList {
  constructor(items) {
    this._items = items;
  }
  [Symbol.iterator]() {
    return this._items[Symbol.iterator]();
  }
}

describe("toPlainList — the shared Arrow-list decode", () => {
  it("decodes an Arrow-Vector-shaped value to a plain string[] with no instanceof check", () => {
    const out = toPlainList(new FakeArrowVector(["code"]));
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["code"]);
    expect(out.every((t) => typeof t === "string")).toBe(true);
  });

  it("is a no-op passthrough for an already-plain array of strings", () => {
    const out = toPlainList(["code", "design-system"]);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual(["code", "design-system"]);
  });

  it("returns [] for null, undefined and unrecognized non-iterable shapes, and never throws", () => {
    expect(toPlainList(null)).toEqual([]);
    expect(toPlainList(undefined)).toEqual([]);
    expect(toPlainList({ notAList: true })).toEqual([]);
    expect(toPlainList(42)).toEqual([]);
    expect(() => toPlainList({ toArray: () => { throw new Error("driver blew up"); } })).not.toThrow();
    expect(toPlainList({ toArray: () => { throw new Error("driver blew up"); } })).toEqual([]);
  });

  it("is version-tolerant: decodes a toJSON-only duck type with no toArray()", () => {
    const out = toPlainList(new JsonOnlyList(["code"]));
    expect(out).toEqual(["code"]);
    expect(out.every((t) => typeof t === "string")).toBe(true);
  });

  it("is version-tolerant: decodes an iterator-only duck type with no toArray() and no toJSON()", () => {
    const out = toPlainList(new IterableOnlyList(["notes", "code"]));
    expect(out).toEqual(["notes", "code"]);
    expect(out.every((t) => typeof t === "string")).toBe(true);
  });

  it("maps the ['untagged'] backfill sentinel to [] — the pinned disposition of the tool contract", () => {
    // RAG_COLUMN_DEFAULTS backfills a NON-EMPTY array because LanceDB cannot infer an element type
    // from []. This assertion pins which of the two allowed dispositions the implementation chose,
    // so the response contract is explicit rather than undocumented.
    expect(toPlainList([UNTAGGED_SENTINEL])).toEqual([]);
    expect(toPlainList(new FakeArrowVector([UNTAGGED_SENTINEL]))).toEqual([]);
    // A real tag that merely CO-OCCURS with the sentinel is not swallowed.
    expect(toPlainList([UNTAGGED_SENTINEL, "code"])).toEqual([UNTAGGED_SENTINEL, "code"]);
  });
});

describe("scrubSecrets — hardened against enumerating non-plain instances", () => {
  it("does not enumerate a class instance's private fields into its output", () => {
    const out = scrubSecrets({ tags: new FakeArrowVector(["code"]) });
    const serialized = JSON.stringify(out);
    for (const key of ARROW_INTERNALS) {
      expect(serialized).not.toContain(key);
    }
  });

  it("still recurses into plain object literals, null-prototype objects and arrays", () => {
    const nullProto = Object.create(null);
    nullProto.note = "api_key=sk-live-abcdef";

    const out = scrubSecrets({
      literal: { inner: "password=hunter2" },
      nullProto,
      list: ["token=abc123", "harmless prose about the key to success"],
    });

    expect(out.literal.inner).toContain("[REDACTED]");
    expect(out.literal.inner).not.toContain("hunter2");
    expect(out.nullProto.note).toContain("[REDACTED]");
    expect(out.nullProto.note).not.toContain("sk-live-abcdef");
    expect(out.list[0]).toContain("[REDACTED]");
    expect(out.list[0]).not.toContain("abc123");
    // Prose must survive: REDACTION_PATTERN requires an assignment, not a bare word.
    expect(out.list[1]).toBe("harmless prose about the key to success");
  });

  it("closes enumeration WITHOUT opening a scrub bypass: a class instance holding a literal secret does not leak it", () => {
    // The tempting fix — pass non-plain values through unchanged — fails here, because
    // JSON.stringify enumerates own enumerable props at the transport boundary anyway.
    class Carrier {
      constructor() {
        this.blob = "api_key=sk-ant-SUPERSECRETVALUE";
      }
    }
    const serialized = JSON.stringify(scrubSecrets({ payload: new Carrier() }));
    expect(serialized).not.toContain("SUPERSECRETVALUE");
    expect(serialized).not.toContain("sk-ant-");
  });

  it("preserves Date values as ISO strings rather than dropping them", () => {
    // updatedAt can arrive as a Date from the driver; the hardening must not silently null it.
    const stamp = new Date("2026-08-09T00:00:00.000Z");
    expect(scrubSecrets({ updatedAt: stamp }).updatedAt).toBe("2026-08-09T00:00:00.000Z");
  });
});

describe("applyFidelity — no Arrow internals at ANY tier", () => {
  const tiers = [
    ["L0_METADATA", FIDELITY_LEVELS.L0_METADATA],
    ["L1_ABSTRACTED", FIDELITY_LEVELS.L1_ABSTRACTED],
    ["L2_REDACTED", FIDELITY_LEVELS.L2_REDACTED],
    ["L3_FULL", FIDELITY_LEVELS.L3_FULL],
  ];

  for (const [label, level] of tiers) {
    it(`emits no Arrow internals at ${label}`, () => {
      const result = {
        id: "id-0",
        path: "notes/thing.md",
        score: 0.5,
        source_class: "project",
        text: "some retrieved body text",
        tags: new FakeArrowVector(["code"]),
      };
      const serialized = JSON.stringify(applyFidelity(result, level));
      for (const key of ARROW_INTERNALS) {
        expect(serialized).not.toContain(key);
      }
    });
  }

  it("L0 is covered explicitly because ...rest spreads tags even in metadata-only mode", () => {
    const out = applyFidelity(
      { id: "id-0", path: "p.md", score: 1, source_class: "project", text: "body", tags: new FakeArrowVector(["code"]) },
      FIDELITY_LEVELS.L0_METADATA,
    );
    expect(out.text).toBeNull();
    expect(JSON.stringify(out)).not.toContain("_offsets");
  });

  it("decoded tags survive fidelity filtering as a plain string array", () => {
    const out = applyFidelity(
      { id: "id-0", path: "p.md", score: 1, source_class: "project", text: "body", tags: toPlainList(new FakeArrowVector(["code"])) },
      FIDELITY_LEVELS.L2_REDACTED,
    );
    expect(out.tags).toEqual(["code"]);
  });
});
