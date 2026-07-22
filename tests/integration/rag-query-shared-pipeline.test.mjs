import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";

// backlog.feat.rag-consolidate-embedding-pipeline — behavior-preservation for the shell query path.
// After query.mjs is repointed at the shared singleton, query() must still run end-to-end. In stub
// mode the embedder is deterministic + 384-dim, so a fixture built with the same stub vectors is
// dimension-compatible: if the shared pipeline changed the vector width, LanceDB .search() would
// throw and query() would return ok:false — this test would catch it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const QUERY_MJS = resolve(ROOT, "scripts/rag/query.mjs");

// Mirror the shared singleton's stub embedder so the fixture vectors match query()'s stub output.
function stubVector(text) {
  const hash = createHash("sha256").update(String(text || "")).digest();
  const vec = new Array(384);
  for (let i = 0; i < 384; i += 1) vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
  return vec;
}

const DOCS = [
  { text: "routekit governance pipeline plan build ship", slug: "doc.a", title: "A" },
  { text: "rag embedding vector search lancedb notes", slug: "doc.b", title: "B" },
  { text: "guardrails hooks off-rail scoped writes", slug: "doc.c", title: "C" },
];

let root;
let dbPath;

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-query-"));
  dbPath = join(root, "notes.lancedb");
  const db = await connect(dbPath);
  // Rows carry the full RAG_REQUIRED_COLUMNS contract + source_class so the reader's projection and
  // fidelity filter both resolve cleanly.
  const rows = DOCS.map((d, i) => ({
    id: `id-${i}`,
    slug: d.slug,
    title: d.title,
    path: `${d.slug}.md`,
    text: d.text,
    chunkId: 0,
    tags: ["seed"],
    status: "implemented",
    updatedAt: new Date(0).toISOString(),
    content_type: "note",
    source_class: "canonical",
    vector: stubVector(d.text),
  }));
  await db.createTable("embeddings", rows);
});

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("scripts/rag/query.mjs — behavior-preserving after embedding-pipeline consolidation", () => {
  it("query() runs end-to-end in stub mode against a LanceDB fixture and returns ok + matches array", async () => {
    const mod = await import(pathToFileURL(QUERY_MJS).href);
    const res = await mod.query({ db: dbPath, q: "rag embedding search", k: 3 });
    // ok:true proves the whole path ran — including a 384-dim query vector compatible with the
    // 384-dim fixture index. A dimension change would have thrown inside .search() → ok:false.
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.matches)).toBe(true);
  });

  it("stub embedder is deterministic and 384-dim (same input → identical vector)", () => {
    const a = stubVector("hello world");
    const b = stubVector("hello world");
    expect(a.length).toBe(384);
    expect(a).toEqual(b);
  });
});
