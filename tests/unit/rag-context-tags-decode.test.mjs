/**
 * backlog.fix.rag-query-arrow-tags-serialization — the PLANNER side of the defect.
 *
 * `rag-context.mjs` is the in-server LanceDB reader the planner consumes. It filtered code chunks
 * from note chunks with `row.tags && row.tags.includes("code")` against an UNDECODED value, so this
 * was never merely a serialization cosmetic — an Arrow Vector's `.includes` semantics are
 * driver-dependent, and the filter is load-bearing for what context the planner sees.
 *
 * The driver is mocked (pattern: tests/unit/rag-autocompact-noop-guard.test.mjs:49) so rows can be
 * handed back with Vector-shaped tags deterministically, with no live .lancedb touched.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs tests/unit/rag-context-tags-decode.test.mjs
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const RAG_COLUMNS = [
  "id",
  "slug",
  "title",
  "path",
  "text",
  "chunkId",
  "tags",
  "status",
  "updatedAt",
  "content_type",
];

/** Arrow-Vector stand-in: not an Array, exposes toArray(), carries the leaked internals. */
class FakeArrowVector {
  constructor(items) {
    this._items = items;
    this._offsets = [0, items.length];
    this.valueOffsets = { 0: 8, 1: 12 };
    this.nullBitmap = {};
    this.stride = 1;
    this.numChildren = 0;
    this.length = items.length;
  }
  toArray() {
    return this._items;
  }
}

// dbPath must exist on disk — queryDb/queryDbByType early-return on fs.existsSync.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "rag-context-tags-"));

/** Swapped per-test to drive the same fixture through plain vs Vector-shaped tags. */
let tagShape = (items) => items;

function fixtureRows() {
  return [
    {
      id: "id-code",
      slug: "src.thing",
      title: "thing.mjs",
      path: "packages/rag/src/thing.mjs",
      text: "export function decodeThing() { return true; }",
      chunkId: 0,
      tags: tagShape(["code"]),
      status: "implemented",
      updatedAt: new Date(0).toISOString(),
      content_type: "code",
      _distance: 0.1,
    },
    {
      id: "id-note",
      slug: "notes.design",
      title: "design.md",
      path: "notes/design.md",
      text: "A note about the design of the thing.",
      chunkId: 0,
      tags: tagShape(["design-system"]),
      status: "implemented",
      updatedAt: new Date(0).toISOString(),
      content_type: "note",
      _distance: 0.2,
    },
  ];
}

function makeTable() {
  const chain = {
    select: () => chain,
    where: () => chain,
    limit: () => chain,
    toArray: async () => fixtureRows(),
  };
  return {
    schema: async () => ({ fields: RAG_COLUMNS.map((name) => ({ name })) }),
    search: () => chain,
    query: () => chain,
  };
}

vi.mock("@lancedb/lancedb", () => ({
  connect: vi.fn(async () => ({
    tableNames: async () => ["embeddings"],
    openTable: async () => makeTable(),
  })),
}));

// Keep the REAL column contract (including toPlainList — it is the code under test); stub only the
// embedder so no ONNX model loads.
vi.mock("@routekit/rag", async () => {
  const columns = await import("../../packages/rag/src/rag-columns.mjs");
  return {
    ...columns,
    getSharedEmbeddingPipeline: async () => async () => ({ data: new Float32Array(384) }),
  };
});

vi.mock("../../packages/cli/src/rag/config.mjs", () => ({
  getRagPaths: () => ({ unified: dbDir, notes: dbDir, code: dbDir, kg: dbDir }),
}));

const { getRagContext, getCodeSnippets, getCodeSnippetsWithScores } = await import(
  "../../packages/mcp-rks/src/rag-context.mjs"
);

beforeEach(() => {
  tagShape = (items) => items;
});

describe("rag-context — code/notes bucketing against Vector-shaped tags", () => {
  it("buckets code and notes correctly when the driver hands back Arrow-shaped tags", async () => {
    tagShape = (items) => new FakeArrowVector(items);
    const ctx = await getRagContext("/fake/project", "decode the thing");

    expect(ctx.code.map((r) => r.path)).toEqual(["packages/rag/src/thing.mjs"]);
    expect(ctx.notes.map((r) => r.path)).toEqual(["notes/design.md"]);
  });

  it("returns tags as plain string arrays in BOTH buckets, so planner selection consumes usable tags", async () => {
    tagShape = (items) => new FakeArrowVector(items);
    const ctx = await getRagContext("/fake/project", "decode the thing");

    for (const row of [...ctx.code, ...ctx.notes]) {
      expect(Array.isArray(row.tags)).toBe(true);
      expect(row.tags.every((t) => typeof t === "string")).toBe(true);
    }
    expect(ctx.code[0].tags).toEqual(["code"]);
    expect(ctx.notes[0].tags).toEqual(["design-system"]);
  });

  it("is representation-independent: plain-array and Vector-shaped tags produce identical bucketing", async () => {
    tagShape = (items) => items;
    const plain = await getRagContext("/fake/project", "decode the thing");

    tagShape = (items) => new FakeArrowVector(items);
    const vectorShaped = await getRagContext("/fake/project", "decode the thing");

    expect(vectorShaped.code.map((r) => r.path)).toEqual(plain.code.map((r) => r.path));
    expect(vectorShaped.notes.map((r) => r.path)).toEqual(plain.notes.map((r) => r.path));
    expect(vectorShaped.code[0].tags).toEqual(plain.code[0].tags);
  });

  it("emits no Arrow internals in the context handed to the planner", async () => {
    tagShape = (items) => new FakeArrowVector(items);
    const serialized = JSON.stringify(await getRagContext("/fake/project", "decode the thing"));
    for (const key of ["_offsets", "valueOffsets", "nullBitmap", "numChildren", "stride", "typeId"]) {
      expect(serialized).not.toContain(key);
    }
  });
});

describe("rag-context — code-snippet paths beyond the mapping sites", () => {
  it("getCodeSnippets returns only code-tagged chunks under Vector-shaped tags", async () => {
    tagShape = (items) => new FakeArrowVector(items);
    const snippets = await getCodeSnippets("/fake/project", "packages/rag/src/thing.mjs", "decodeThing");

    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.join("\n")).toContain("decodeThing");
    expect(snippets.join("\n")).not.toContain("A note about the design");
  });

  it("getCodeSnippetsWithScores returns only code-tagged chunks under Vector-shaped tags", async () => {
    tagShape = (items) => new FakeArrowVector(items);
    const scored = await getCodeSnippetsWithScores("/fake/project", "packages/rag/src/thing.mjs", "decodeThing");

    expect(scored.length).toBeGreaterThan(0);
    expect(scored.every((s) => typeof s.text === "string")).toBe(true);
    expect(scored.map((s) => s.text).join("\n")).not.toContain("A note about the design");
  });
});
