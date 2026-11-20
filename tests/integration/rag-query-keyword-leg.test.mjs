import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";

// backlog.fix.rag-hybrid-keyword-leg-always-empty — query() must feed hybridSearch a populated BM25
// index so a verbatim-sentence query gets a lexical signal.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const QUERY_MJS = resolve(ROOT, "packages/rag/src/query.mjs");
const HYBRID_MJS = resolve(ROOT, "packages/rag/src/hybrid-search.mjs");

function stubVector(text) {
  const hash = createHash("sha256").update(String(text || "")).digest();
  const vec = new Array(384);
  for (let i = 0; i < 384; i += 1) vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
  return vec;
}

const SENTENCE = "Quick re-orientation, since a lot moved after you finished the v4 pass.";
const TARGET = "doc.target";
const DOCS = [
  { slug: "doc.a", text: "routekit governance pipeline plan build ship" },
  { slug: "doc.b", text: "rag embedding vector search lancedb notes" },
  { slug: "doc.c", text: "guardrails hooks off-rail scoped writes" },
  { slug: "doc.d", text: "telemetry dashboard cost report cycles" },
  { slug: TARGET, text: `Hello counsel. ${SENTENCE} Details follow below.`, vector: stubVector(SENTENCE).map((x) => -x) },
];
const N = DOCS.length;

let root;
let dbPath;

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-keyword-"));
  dbPath = join(root, "notes.lancedb");
  const db = await connect(dbPath);
  const rows = DOCS.map((d, i) => ({
    id: `id-${i}`,
    slug: d.slug,
    title: d.slug,
    path: `${d.slug}.md`,
    text: d.text,
    chunkId: 0,
    tags: ["seed"],
    status: "implemented",
    updatedAt: new Date(0).toISOString(),
    content_type: "note",
    source_class: "canonical",
    vector: d.vector ?? stubVector(d.text),
  }));
  await db.createTable("embeddings", rows);
});

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("query() keyword leg", () => {
  it("verbatim-sentence query yields a non-null keywordScore on the containing document", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const res = await query({ db: dbPath, q: SENTENCE, k: N });
    expect(res.ok).toBe(true);
    const row = res.matches.find((m) => m.slug === TARGET);
    expect(row).toBeDefined();
    expect(typeof row.keywordScore).toBe("number");
    expect(row.keywordScore).toBeGreaterThan(0);
  });

  it("the document ranks strictly higher than under semantic-only fusion", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const { hybridSearch } = await import(pathToFileURL(HYBRID_MJS).href);
    const res = await query({ db: dbPath, q: SENTENCE, k: N });
    const semanticList = res.matches.map((m) => ({ id: m.slug, score: m.semanticScore }));
    const semOnly = await hybridSearch({ query: SENTENCE, semanticResults: semanticList, k: N });
    const semOnlyRank = semOnly.results.findIndex((r) => r.id === TARGET) + 1;
    // Non-vacuity: the target must not already be first semantically.
    expect(semOnlyRank).toBeGreaterThan(1);
    const fusedRank = res.matches.find((m) => m.slug === TARGET).hybridRank;
    expect(fusedRank).toBeLessThan(semOnlyRank);
  });

  it("a query whose terms occur in no document leaves keywordScore null and the order semantic", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const res = await query({ db: dbPath, q: "zzqxv wqpzt", k: N });
    expect(res.ok).toBe(true);
    for (const m of res.matches) expect(m.keywordScore == null).toBe(true);
    const scores = res.matches.map((m) => m.semanticScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("result shape is unchanged: every match carries full row metadata plus fusion fields", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const res = await query({ db: dbPath, q: SENTENCE, k: N });
    expect(res.ok).toBe(true);
    for (const key of ["query", "qtype", "weights", "results"]) expect(res).toHaveProperty(key);
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches.length).toBeLessThanOrEqual(N);
    for (const m of res.matches) {
      for (const key of ["slug", "path", "title", "text", "status", "chunkId", "tags", "score", "hybridRank", "semanticScore", "keywordScore"]) {
        expect(m).toHaveProperty(key);
      }
      expect(typeof m.slug).toBe("string");
      expect(m.slug.length).toBeGreaterThan(0);
      expect(typeof m.score).toBe("number");
      expect(Number.isFinite(m.score)).toBe(true);
    }
  });
});

describe("query() keyword leg — chunks sharing one slug", () => {
  // Separate table so the rank-margin fixture above is untouched. Two rows share slug TARGET; the
  // sentence is only in chunk 0, which precedes chunk 1 in SEMANTIC order (the order query() walks
  // semRes.matches). A per-row addDocument would let chunk 1 REPLACE chunk 0's text in the index.
  const OTHER_CHUNK_TEXT = "Appendix signatures contact block counsel";
  const GROUPED = [
    ...DOCS.slice(0, 4).map((d) => ({ slug: d.slug, text: d.text, chunkId: 0 })),
    { slug: TARGET, chunkId: 0, text: `Hello counsel. ${SENTENCE} Details follow below.` },
    { slug: TARGET, chunkId: 1, text: OTHER_CHUNK_TEXT, vector: stubVector(SENTENCE).map((x) => -2 * x) },
  ];
  let groupedDb;

  beforeAll(async () => {
    groupedDb = join(root, "grouped.lancedb");
    const db = await connect(groupedDb);
    const rows = GROUPED.map((d, i) => ({
      id: `g-${i}`,
      slug: d.slug,
      title: d.slug,
      path: `${d.slug}.md`,
      text: d.text,
      chunkId: d.chunkId,
      tags: ["seed"],
      status: "implemented",
      updatedAt: new Date(0).toISOString(),
      content_type: "note",
      source_class: "canonical",
      vector: d.vector ?? stubVector(d.text),
    }));
    await db.createTable("embeddings", rows);
  });

  it("precondition: the sentence-bearing chunk precedes the other chunk of the same slug in semantic order", async () => {
    const db = await connect(groupedDb);
    const table = await db.openTable("embeddings");
    const rows = await table.search(stubVector(SENTENCE)).limit(GROUPED.length).toArray();
    const order = rows.filter((r) => r.slug === TARGET).map((r) => Number(r.chunkId));
    expect(order).toEqual([0, 1]);
  });

  it("a sentence present only in the earlier chunk still yields a numeric keywordScore > 0 for that slug", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const res = await query({ db: groupedDb, q: SENTENCE, k: GROUPED.length });
    expect(res.ok).toBe(true);
    const rows = res.matches.filter((m) => m.slug === TARGET);
    expect(rows.length).toBe(1);
    expect(typeof rows[0].keywordScore).toBe("number");
    expect(rows[0].keywordScore).toBeGreaterThan(0);
  });
});

describe("hybridSearch() in isolation", () => {
  it("without bm25Index returns the semantic order with every keyword leg null", async () => {
    const { hybridSearch } = await import(pathToFileURL(HYBRID_MJS).href);
    const res = await hybridSearch({
      query: "anything at all",
      semanticResults: [{ id: "b", score: 0.5 }, { id: "a", score: 0.9 }, { id: "c", score: 0.1 }],
      k: 5,
    });
    expect(res.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    for (const r of res.results) expect(r.keyword).toBeNull();
  });
});
