import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const QUERY_MJS = resolve(ROOT, "packages/rag/src/query.mjs");
const HYBRID_MJS = resolve(ROOT, "packages/rag/src/hybrid-search.mjs");
const FIDELITY_MJS = resolve(ROOT, "packages/rag/src/fidelity-filter.mjs");

function stubVector(text) {
  const hash = createHash("sha256").update(String(text || "")).digest();
  const vec = new Array(384);
  for (let i = 0; i < 384; i += 1) vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
  return vec;
}

const Q = "zqxv probe wkly";
const QV = stubVector(Q);
const scaled = (c) => QV.map((x) => x * c);

// Raw chunk-row order by distance: A#0, A#1, B#0, A#2, B#1, C#0, D#0, E#0, F#0.
// Note A occupies raw rows 1, 2 and 4; the top 5 raw rows hold only notes A and B (fewer than 5
// notes), and the first 15 rows (3 * k for k = 5) hold 6 notes.
// Factors stay at or below 1.064 so every squared-L2 distance stays well below 1 and every
// baseScore (1 - _distance) is positive; a negative baseScore would invert the status boost.
// A#0 (c = 1.0) is identical to the query vector, so its _distance is 0 (the query.mjs:106 case).
// B#0 is NEARER than B#1 but carries status "unknown" (STATUS_BOOST 0.8) while B#1 carries
// "implemented" (1.5), so B's best-SCORING chunk is chunkId 1 while its first row found is chunkId 0.
const MULTI = [
  { slug: "doc.a", chunkId: 0, text: "alpha first chunk text", c: 1.0 },
  { slug: "doc.a", chunkId: 1, text: "alpha second chunk text", c: 1.008 },
  { slug: "doc.b", chunkId: 0, text: "bravo first chunk text", c: 1.016, status: "unknown" },
  { slug: "doc.a", chunkId: 2, text: "alpha third chunk text", c: 1.024 },
  { slug: "doc.b", chunkId: 1, text: "bravo second chunk text", c: 1.032 },
  { slug: "doc.c", chunkId: 0, text: "charlie only chunk text", c: 1.04 },
  { slug: "doc.d", chunkId: 0, text: "delta only chunk text", c: 1.048 },
  { slug: "doc.e", chunkId: 0, text: "echo only chunk text", c: 1.056 },
  { slug: "doc.f", chunkId: 0, text: "foxtrot only chunk text", c: 1.064 },
];
const SINGLE = MULTI.filter((d) => d.chunkId === 0 && d.slug !== "doc.a" && d.slug !== "doc.b");

function toRows(docs, prefix) {
  return docs.map((d, i) => ({
    id: `${prefix}-${i}`,
    slug: d.slug,
    title: d.slug,
    path: `${d.slug}.md`,
    text: d.text,
    chunkId: d.chunkId,
    tags: ["seed"],
    status: d.status || "implemented",
    updatedAt: new Date(0).toISOString(),
    content_type: "note",
    source_class: "canonical",
    vector: scaled(d.c),
  }));
}

let root;
let multiDb;
let singleDb;

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-per-note-"));
  multiDb = join(root, "multi.lancedb");
  singleDb = join(root, "single.lancedb");
  await (await connect(multiDb)).createTable("embeddings", toRows(MULTI, "m"));
  await (await connect(singleDb)).createTable("embeddings", toRows(SINGLE, "s"));
});

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("rrfCombine / hybridSearch with a repeated id", () => {
  it("rrfCombine fuses a repeated id on its best rank and emits it once", async () => {
    const { rrfCombine } = await import(pathToFileURL(HYBRID_MJS).href);
    const sem = [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "c", score: 0.7 }, { id: "a", score: 0.6 }];
    const out = rrfCombine(sem, []);
    const a = out.filter((r) => r.id === "a");
    expect(a.length).toBe(1);
    expect(a[0].r_sem).toBe(1);
  });

  it("hybridSearch reports a repeated id's best semantic score and rank", async () => {
    const { hybridSearch } = await import(pathToFileURL(HYBRID_MJS).href);
    const res = await hybridSearch({
      query: "anything at all",
      semanticResults: [{ id: "a", score: 0.9 }, { id: "b", score: 0.8 }, { id: "a", score: 0.1 }],
      k: 5,
    });
    const a = res.results.find((r) => r.id === "a");
    expect(a.semantic.score).toBe(0.9);
    expect(a.semantic.rank).toBe(1);
    expect(res.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("hybridSearch order is unchanged when no id repeats", async () => {
    const { hybridSearch } = await import(pathToFileURL(HYBRID_MJS).href);
    const res = await hybridSearch({
      query: "anything at all",
      semanticResults: [{ id: "b", score: 0.5 }, { id: "a", score: 0.9 }, { id: "c", score: 0.1 }],
      k: 5,
    });
    expect(res.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

// query() defaults to L2_REDACTED, so without this the fidelity filter returns text: null. Every
// query() call below requests full fidelity. Each match carries its row's stored source_class
// ("canonical"), so the 'canonical' override is the one that lifts it to L3.
async function runQuery(db, k) {
  const { query } = await import(pathToFileURL(QUERY_MJS).href);
  const { FIDELITY_LEVELS } = await import(pathToFileURL(FIDELITY_MJS).href);
  return query({
    db,
    q: Q,
    k,
    fidelity: FIDELITY_LEVELS.L3_FULL,
    overrides: { canonical: FIDELITY_LEVELS.L3_FULL, project: FIDELITY_LEVELS.L3_FULL },
  });
}

describe("query() per-note fusion", () => {
  it("precondition: full fidelity is in effect, so text assertions are meaningful", async () => {
    const res = await runQuery(multiDb, 5);
    expect(res.ok).toBe(true);
    expect(res.matches.length).toBeGreaterThan(0);
    for (const m of res.matches) {
      expect(m.fidelity).toBe("L3");
      expect(typeof m.text).toBe("string");
    }
  });

  it("a note whose chunks hold semantic ranks 1, 2 and 4 is fused at rank 1", async () => {
    const res = await runQuery(multiDb, 5);
    expect(res.ok).toBe(true);
    const a = res.matches.find((m) => m.slug === "doc.a");
    expect(a).toBeDefined();
    expect(a.hybridRank).toBe(1);
  });

  it("k = 5 returns 5 distinct notes when the top 5 raw rows hold only 2 notes", async () => {
    const res = await runQuery(multiDb, 5);
    expect(res.matches.length).toBe(5);
    const ids = res.matches.map((m) => m.slug);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["doc.a", "doc.b", "doc.c", "doc.d", "doc.e"]);
  });

  it("no two matches share a note identity (slug, or path when slug is absent)", async () => {
    const res = await runQuery(multiDb, 5);
    const keys = res.matches.map((m) => m.slug || m.path);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a zero-distance row gets baseScore 1 and is its note's best chunk", async () => {
    const res = await runQuery(multiDb, 5);
    const a = res.matches.find((m) => m.slug === "doc.a");
    expect(a.baseScore).toBeCloseTo(1, 6);
    expect(a.chunkId).toBe(0);
    expect(a.text).toBe("alpha first chunk text");
  });

  it("a match carries its note's best-scoring chunk, not the first chunk row found", async () => {
    const res = await runQuery(multiDb, 5);
    const b = res.matches.find((m) => m.slug === "doc.b");
    expect(b).toBeDefined();
    expect(b.chunkId).toBe(1);
    expect(b.text).toBe("bravo second chunk text");
    expect(b.status).toBe("implemented");
  });

  it("a corpus of single-chunk notes with no zero-distance row keeps semantic order", async () => {
    const res = await runQuery(singleDb, 4);
    expect(res.matches.map((m) => m.slug)).toEqual(["doc.c", "doc.d", "doc.e", "doc.f"]);
  });
});
