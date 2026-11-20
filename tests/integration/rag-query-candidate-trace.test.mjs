/**
 * backlog.fix.rag-query-ranked-telemetry: query() returns candidateTrace (semantic window row count
 * plus per-note candidates) and the ranking is unchanged. The fixture mirrors
 * tests/integration/rag-query-per-note-fusion.test.mjs (stub vectors, real LanceDB in a temp dir).
 */
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

// Raw chunk-row order by distance: A#0, A#1, B#0, A#2, B#1, C#0, D#0, E#0, F#0 (9 rows, 6 notes).
// k 5 -> window 15 rows -> all 9 rows. k 2 -> window 6 rows -> notes A, B, C only.
const DOCS = [
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

let root;
let db;

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-candidate-trace-"));
  db = join(root, "multi.lancedb");
  const rows = DOCS.map((d, i) => ({
    id: `m-${i}`,
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
  await (await connect(db)).createTable("embeddings", rows);
});

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

async function runQuery(k) {
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

describe("query() candidateTrace", () => {
  it("windowRows equals the semantic window row count", async () => {
    expect((await runQuery(5)).candidateTrace.windowRows).toBe(9);
    expect((await runQuery(2)).candidateTrace.windowRows).toBe(6);
  });

  it("candidates hold one entry per distinct note in the semantic window", async () => {
    const at5 = (await runQuery(5)).candidateTrace.candidates;
    expect(at5).toHaveLength(6);
    expect(new Set(at5.map((c) => c.id)).size).toBe(6);
    const at2 = (await runQuery(2)).candidateTrace.candidates;
    expect(at2.map((c) => c.id).sort()).toEqual(["doc.a", "doc.b", "doc.c"]);
    expect(at2.some((c) => c.id === "doc.d")).toBe(false);
  });

  it("candidates are sorted by semanticScore descending with a contiguous 1-based semanticRank", async () => {
    const { candidates } = (await runQuery(5)).candidateTrace;
    expect(candidates.map((c) => c.semanticRank)).toEqual(candidates.map((_, i) => i + 1));
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i - 1].semanticScore).toBeGreaterThanOrEqual(candidates[i].semanticScore);
    }
  });

  it("each candidate carries exactly semanticRank, id, path and semanticScore", async () => {
    const { candidates } = (await runQuery(5)).candidateTrace;
    for (const c of candidates) {
      expect(Object.keys(c).sort()).toEqual(["id", "path", "semanticRank", "semanticScore"]);
      expect("text" in c).toBe(false);
    }
  });
});

describe("query() candidateTrace applied k and intent", () => {
  it("k and intent are the values query() applied, including its defaults", async () => {
    const { query } = await import(pathToFileURL(QUERY_MJS).href);
    const { FIDELITY_LEVELS } = await import(pathToFileURL(FIDELITY_MJS).href);
    const base = {
      db,
      q: Q,
      fidelity: FIDELITY_LEVELS.L3_FULL,
      overrides: { canonical: FIDELITY_LEVELS.L3_FULL, project: FIDELITY_LEVELS.L3_FULL },
    };
    const defaults = (await query(base)).candidateTrace;
    expect(defaults.k).toBe(5);
    expect(defaults.intent).toBe("neutral");
    const explicit = (await query({ ...base, k: 2, intent: "planning" })).candidateTrace;
    expect(explicit.k).toBe(2);
    expect(explicit.intent).toBe("planning");
  });
});

describe("query() ranking unchanged by candidateTrace", () => {
  it("matches order, hybridRank and results order are unchanged at k 5", async () => {
    const res = await runQuery(5);
    expect(res.ok).toBe(true);
    expect(res.matches.map((m) => m.slug)).toEqual(["doc.a", "doc.b", "doc.c", "doc.d", "doc.e"]);
    expect(res.matches.find((m) => m.slug === "doc.a").hybridRank).toBe(1);
    expect(res.results.map((r) => r.id)).toEqual(res.matches.map((m) => m.slug));
  });
});
