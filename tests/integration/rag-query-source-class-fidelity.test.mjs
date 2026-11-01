import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";

// backlog.fix.source-class-never-projected-fidelity-defaults-permissive
// The source_class STORED on a LanceDB row must reach filterByFidelity through query(), so the tier a
// match is served at is decided by the row's own class, not by the `|| 'project'` fallback.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const QUERY_MJS = resolve(ROOT, "packages/rag/src/query.mjs");
const FIDELITY_MJS = resolve(ROOT, "packages/rag/src/fidelity-filter.mjs");

// Mirror the shared singleton's stub embedder so fixture vectors match query()'s stub output.
function stubVector(text) {
  const hash = createHash("sha256").update(String(text || "")).digest();
  const vec = new Array(384);
  for (let i = 0; i < 384; i += 1) vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
  return vec;
}

// One row per class. "canonical" is not a DEFAULT_FIDELITY key: it pins the unknown-class path.
const CLASSES = ["public", "project", "client", "sensitive", "legal", "canonical"];
const SECRET_LITERAL = "SECRETVAL";

// D7 phrase-leg fixture (separate db). PK = 3, so query() asks the vector leg for 3 * PK = 9 rows.
// 4 * PK = 12 distractors (at least 3 * PK + 1) sit next to the phrase's query vector and fill that
// window; the one sensitive row holding PHRASE verbatim sits at FAR * v, outside it. Precedent:
// tests/integration/rag-query-keyword-recall.test.mjs (scale, FAR = -4, near()).
const PK = 3;
const FAR = -4;
const PHRASE = "Basalt kiln firing schedule"; // 4 whitespace tokens: qualifies for the phrase scan
const scale = (v, c) => v.map((x) => x * c);
function phraseRows() {
  const pv = stubVector(PHRASE);
  const mk = (id, slug, text, vector, source_class) => ({
    id, slug, title: slug, path: `${slug}.md`, text, chunkId: 0, tags: ["seed"], status: "implemented",
    updatedAt: new Date(0).toISOString(), content_type: "note", source_class, vector,
  });
  return [
    ...Array.from({ length: 4 * PK }, (_, i) =>
      mk(`pd-${i}`, `doc.phrase.near.${String(i).padStart(2, "0")}`, `telemetry dashboard cost report ${i}`,
        scale(pv, 1 + 0.01 * (i + 1)), "project")),
    mk("pd-target", "doc.phrase.sensitive", `Kiln log: ${PHRASE} for spring.`, scale(pv, FAR), "sensitive"),
  ];
}

function row(cls, i, { withSourceClass = true } = {}) {
  const text = `rag embedding search ${cls} body token=${SECRET_LITERAL}`;
  const r = {
    id: `id-${i}`,
    slug: `doc.${cls}`,
    title: cls,
    path: `doc.${cls}.md`,
    text,
    chunkId: 0,
    tags: ["seed"],
    status: "implemented",
    updatedAt: new Date(0).toISOString(),
    content_type: "note",
    vector: stubVector(text),
  };
  if (withSourceClass) r.source_class = cls;
  return r;
}

let root;
let dbPath;
let legacyDbPath;
let phraseDbPath;
let query;
let FIDELITY_LEVELS;

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-source-class-"));
  dbPath = join(root, "notes.lancedb");
  legacyDbPath = join(root, "legacy.lancedb");
  const db = await connect(dbPath);
  await db.createTable("embeddings", CLASSES.map((c, i) => row(c, i)));
  const legacy = await connect(legacyDbPath);
  await legacy.createTable("embeddings", CLASSES.map((c, i) => row(c, i, { withSourceClass: false })));
  phraseDbPath = join(root, "phrase.lancedb");
  await (await connect(phraseDbPath)).createTable("embeddings", phraseRows());
  ({ query } = await import(pathToFileURL(QUERY_MJS).href));
  ({ FIDELITY_LEVELS } = await import(pathToFileURL(FIDELITY_MJS).href));
}, 60_000);

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

const run = (extra = {}) => query({ db: dbPath, q: "rag embedding search", k: CLASSES.length, ...extra });
const bySlug = (res) => Object.fromEntries(res.matches.map((m) => [m.slug, m]));

describe("query() honours the stored source_class", () => {
  it("precondition: every seeded row comes back", async () => {
    const res = await run({ fidelity: FIDELITY_LEVELS.L3_FULL });
    expect(res.ok).toBe(true);
    expect(Object.keys(bySlug(res)).sort()).toEqual(CLASSES.map((c) => `doc.${c}`).sort());
  });

  it("every match carries the source_class stored on its row", async () => {
    const res = await run({ fidelity: FIDELITY_LEVELS.L3_FULL });
    for (const m of res.matches) expect(m.source_class).toBe(m.slug.slice("doc.".length));
  });

  it("no overrides, L3 requested: each class is served at its DEFAULT_FIDELITY ceiling", async () => {
    const m = bySlug(await run({ fidelity: FIDELITY_LEVELS.L3_FULL }));
    expect(m["doc.public"].fidelity).toBe("L3");
    expect(m["doc.project"].fidelity).toBe("L2");
    expect(m["doc.client"].fidelity).toBe("L1");
    expect(m["doc.sensitive"].fidelity).toBe("L0");
    expect(m["doc.legal"].fidelity).toBe("L0");
    expect(m["doc.canonical"].fidelity).toBe("L2");
    expect(m["doc.sensitive"].text).toBeNull();
    expect(m["doc.legal"].text).toBeNull();
  });

  it("an override keyed by a stored class lifts that class with no project key (7801690b reproduction)", async () => {
    const m = bySlug(await run({ fidelity: FIDELITY_LEVELS.L3_FULL, overrides: { canonical: FIDELITY_LEVELS.L3_FULL } }));
    expect(m["doc.canonical"].fidelity).toBe("L3");
    expect(m["doc.project"].fidelity).toBe("L2");
  });

  it("a project/public override does not lift client, sensitive or legal", async () => {
    const m = bySlug(await run({
      fidelity: FIDELITY_LEVELS.L3_FULL,
      overrides: { project: FIDELITY_LEVELS.L3_FULL, public: FIDELITY_LEVELS.L3_FULL },
    }));
    expect(m["doc.project"].fidelity).toBe("L3");
    expect(m["doc.public"].fidelity).toBe("L3");
    expect(m["doc.client"].fidelity).toBe("L1");
    expect(m["doc.sensitive"].fidelity).toBe("L0");
    expect(m["doc.legal"].fidelity).toBe("L0");
  });

  it("an exact-phrase match OUTSIDE the semantic window carries and is filtered by its stored source_class (D7)", async () => {
    // Precondition: the sensitive phrase row is not among the raw top 3 * PK vector neighbours, so query()
    // can only return it through the phrase leg (phraseById), never the vector leg (bestById).
    const table = await (await connect(phraseDbPath)).openTable("embeddings");
    const raw = await table.search(stubVector(PHRASE)).limit(3 * PK).toArray();
    expect(raw.length).toBe(3 * PK);
    expect(raw.some((r) => r.slug === "doc.phrase.sensitive")).toBe(false);

    const res = await query({
      db: phraseDbPath, q: PHRASE, k: PK, fidelity: FIDELITY_LEVELS.L3_FULL,
      overrides: { project: FIDELITY_LEVELS.L3_FULL, public: FIDELITY_LEVELS.L3_FULL },
    });
    expect(res.ok).toBe(true);
    const hit = res.matches.find((m) => m.slug === "doc.phrase.sensitive");
    expect(hit).toBeDefined();
    expect(hit.semanticScore).toBeNull(); // proves it came via phraseById
    expect(hit.source_class).toBe("sensitive");
    expect(hit.fidelity).toBe("L0");
    expect(hit.text).toBeNull();
  });

  it("the secret scrub still applies at every tier on the query() path", async () => {
    for (const fidelity of [0, 1, 2, 3]) {
      const res = await run({ fidelity, overrides: { public: fidelity, project: fidelity, canonical: fidelity } });
      expect(res.matches.length).toBeGreaterThan(0);
      expect(JSON.stringify(res.matches)).not.toContain(SECRET_LITERAL);
    }
    const m = bySlug(await run({ fidelity: FIDELITY_LEVELS.L3_FULL }));
    expect(m["doc.public"].fidelity).toBe("L3");
    expect(m["doc.public"].text).toContain("rag embedding search public body");
  });

  it("a legacy index without a source_class column still queries (degraded projection, no throw)", async () => {
    const res = await query({ db: legacyDbPath, q: "rag embedding search", k: CLASSES.length, fidelity: FIDELITY_LEVELS.L3_FULL });
    expect(res.ok).toBe(true);
    expect(res.matches.length).toBeGreaterThan(0);
  });
});
