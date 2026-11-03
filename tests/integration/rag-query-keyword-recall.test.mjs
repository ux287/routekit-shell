import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";

// Fault injection for the schema-unreadable case: table.schema() throws for ONE fixture path only, so
// tableFieldNames reaches its own catch and returns [] (rag-columns.mjs). Every other connect() returns
// the real driver's connection, unwrapped, so every other test in this file runs against the real driver.
const schemaFault = vi.hoisted(() => ({ dbPath: null, calls: 0 }));
vi.mock("@lancedb/lancedb", async (importOriginal) => {
  const real = await importOriginal();
  const passThrough = (target, override) => new Proxy(target, {
    get(t, p) {
      if (p in override) return override[p];
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return {
    ...real,
    connect: async (uri, ...rest) => {
      const db = await real.connect(uri, ...rest);
      if (uri !== schemaFault.dbPath) return db;
      return passThrough(db, {
        openTable: async (...args) => passThrough(await db.openTable(...args), {
          schema: async () => { schemaFault.calls += 1; throw new Error("injected: schema unreadable"); },
        }),
      });
    },
  };
});

// backlog.fix.rag-keyword-leg-cannot-recall-outside-semantic-window — a note that holds a qualifying
// query (4+ whitespace tokens) verbatim is pinned into the top k even when its semantic rank is
// outside the 3·k candidate window, for code, concept and mixed queries alike.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const QUERY_MJS = resolve(ROOT, "packages/rag/src/query.mjs");
const HYBRID_MJS = resolve(ROOT, "packages/rag/src/hybrid-search.mjs");
const BM25_MJS = resolve(ROOT, "packages/rag/src/bm25-index.mjs");
const FIDELITY_MJS = resolve(ROOT, "packages/rag/src/fidelity-filter.mjs");

function stubVector(text) {
  const hash = createHash("sha256").update(String(text || "")).digest();
  const vec = new Array(384);
  for (let i = 0; i < 384; i += 1) vec[i] = (hash[i % hash.length] / 255) * 2 - 1;
  return vec;
}
const scale = (v, c) => v.map((x) => x * c);

const K = 5;
const WINDOW = 3 * K;
// The stub vector is not normalised, so a row stored at c·v sits at a distance proportional to |c − 1|
// from v. Targets sit at FAR·v (|−4 − 1| = 5); every distractor sits within 2 of its own query vector.
// The per-query raw-vector preconditions below are the witness, not this arithmetic.
const FAR = -4;

const SENTENCE = "Quick re-orientation, since a lot moved after you finished the v4 pass."; // code
const CONCEPT = "Invoice 4471 settled 2026 09 30 ref 8812"; // concept
const MIXED = "Ticket 5521 7730 9014"; // mixed
const ESCAPE_Q = "the owner's build hit 100% on rel_2 today";
const DECOY_TEXT = "Status: the owner's build hit 1009 on relX2 today."; // matches only if % and _ are wildcards
const SHORT = "Ledger 3391 7720"; // 3 tokens: below the pin threshold
const PIN = "Harbor crane manifest checklist"; // 4 tokens
const SPLIT = "Northwind ferry timetable revised"; // 4 tokens
const QV = stubVector(SENTENCE);

function row(id, slug, text, vector, chunkId = 0) {
  return {
    id, slug, title: slug, path: `${slug}.md`, text, chunkId, tags: ["seed"],
    status: "implemented", updatedAt: new Date(0).toISOString(), content_type: "note",
    source_class: "project", vector,
  };
}

// n distractors next to v that share no token with any query in this file.
function near(prefix, v, n, step) {
  return Array.from({ length: n }, (_, i) =>
    row(`${prefix}-${i}`, `doc.near.${String(i).padStart(2, "0")}`,
      `telemetry dashboard cost report cycles ${i}${i < 3 ? " inwindowonly" : ""}`, scale(v, 1 + step * (i + 1))));
}

const TARGETS = {
  code: { slug: "doc.target", q: SENTENCE, text: `Hello counsel. ${SENTENCE} Details follow below.` },
  concept: { slug: "doc.concept", q: CONCEPT, text: `Payment record: ${CONCEPT} closed.` },
  mixed: { slug: "doc.mixed", q: MIXED, text: `Queue entry ${MIXED} escalated.` },
  escape: { slug: "doc.escape", q: ESCAPE_Q, text: `Status: ${ESCAPE_Q}.` },
  short: { slug: "doc.short", q: SHORT, text: `${SHORT} archived.` },
};
const TARGET = TARGETS.code.slug;

const MAIN = [
  ...near("n", QV, 4 * K, 0.01),
  ...Object.values(TARGETS).map((t, i) => row(`t-${i}`, t.slug, t.text, scale(stubVector(t.q), FAR))),
  row("decoy", "doc.decoy", DECOY_TEXT, scale(stubVector(ESCAPE_Q), -3)),
];

const PV = stubVector(PIN);
const PIN_ROWS = [
  ...near("p", PV, 4 * K, 0.01),
  // Identical shortest texts (equal BM25 score), inserted in REVERSE slug order.
  row("p-b", "doc.pin.b", `${PIN}.`, scale(PV, FAR)),
  row("p-a", "doc.pin.a", `${PIN}.`, scale(PV, FAR)),
  ...[1, 2, 3, 4, 5].map((n) => row(`p-${n}`, `doc.pin.${n}`, `${PIN} ${"appendix ".repeat(3 * n).trim()}`, scale(PV, FAR))),
];
const PIN_SLUGS = PIN_ROWS.filter((r) => r.slug.startsWith("doc.pin.")).map((r) => r.slug);

// doc.split: chunk 0 (no phrase) is inside the window, chunk 1 (holds SPLIT verbatim) is outside it.
const XV = stubVector(SPLIT);
const SPLIT_ROWS = [
  ...near("s", XV, WINDOW, 0.01),
  row("s-0", "doc.split", "Overview page for operations staff", scale(XV, 1), 0),
  row("s-1", "doc.split", `Notice: ${SPLIT} for winter.`, scale(XV, FAR), 1),
];

// Escape characters themselves: the target holds `\` and `!`; each decoy would match only if ONE of them
// acted as a LIKE escape (doc.decoy.bs: backslash consumed; doc.decoy.bang: `!` consumed).
const BANG = "path C:\\temp a!b review today"; // 5 tokens; the runtime string holds one backslash
const EV = stubVector(BANG);
const BANG_ROWS = [
  ...near("e", EV, 4 * K, 0.01),
  row("e-t", "doc.bang", `Status: ${BANG}.`, scale(EV, FAR)),
  row("e-bs", "doc.decoy.bs", "Status: path C:temp a!b review today.", scale(EV, -3)),
  row("e-bang", "doc.decoy.bang", "Status: path C:\\temp ab review today.", scale(EV, -3)),
];

// Chunk dedupe: identical single-chunk texts holding DUP, one inside the window and one outside it.
// If the in-window phrase chunk were indexed twice, its BM25 document would double in length and
// term frequency, so the two keywordScores would differ.
const DUP = "Granite quarry shipment ledger"; // 4 tokens
const DV = stubVector(DUP);
const DUP_ROWS = [
  ...near("d", DV, WINDOW, 0.01),
  row("d-in", "doc.dup.in", `Entry: ${DUP} filed.`, scale(DV, 1)),
  row("d-out", "doc.dup.out", `Entry: ${DUP} filed.`, scale(DV, FAR)),
];

// Truncation: TRUNC is held verbatim by n notes, plus distractors that do not hold it. The phrase
// deliberately contains neither "truncat" nor "200", because query.mjs echoes the query to stderr.
const TRUNC = "Copper valve inspection round"; // 4 tokens
const TV = stubVector(TRUNC);
const truncRows = (n) => [
  ...near("u", TV, 4 * K, 0.01),
  ...Array.from({ length: n }, (_, i) => row(`u-${i}`, `doc.trunc.${i}`, `${TRUNC} entry ${i}`, scale(TV, FAR - 0.01 * i))),
];

// Legacy table: the MAIN rows with no text column at all.
const LEGACY_ROWS = MAIN.map(({ text: _text, ...rest }) => rest);

let root;
let mainDb;
let pinDb;
let splitDb;
let bigDb;
let bangDb;
let dupDb;
let truncDb;
let exactDb;
let legacyDb;
let unreadableDb;
let query;
let FIDELITY_LEVELS;

async function prepareTable(dbPath, rows) {
  await (await connect(dbPath)).createTable("embeddings", rows);
}

async function rawTop(dbPath, q, n) {
  const table = await (await connect(dbPath)).openTable("embeddings");
  return table.search(stubVector(q)).limit(n).toArray();
}

beforeAll(async () => {
  process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
  root = mkdtempSync(join(tmpdir(), "rks-rag-recall-"));
  mainDb = join(root, "main.lancedb");
  pinDb = join(root, "pin.lancedb");
  splitDb = join(root, "split.lancedb");
  bigDb = join(root, "big.lancedb");
  await prepareTable(mainDb, MAIN);
  await prepareTable(pinDb, PIN_ROWS);
  await prepareTable(splitDb, SPLIT_ROWS);
  bangDb = join(root, "bang.lancedb");
  dupDb = join(root, "dup.lancedb");
  truncDb = join(root, "trunc.lancedb");
  exactDb = join(root, "exact.lancedb");
  legacyDb = join(root, "legacy.lancedb");
  await prepareTable(bangDb, BANG_ROWS);
  await prepareTable(dupDb, DUP_ROWS);
  await prepareTable(truncDb, truncRows(201));
  await prepareTable(exactDb, truncRows(200));
  await prepareTable(legacyDb, LEGACY_ROWS);
  // A full MAIN copy whose schema() read is made to throw (schemaFault above); armed only after creation.
  unreadableDb = join(root, "unreadable.lancedb");
  await prepareTable(unreadableDb, MAIN);
  schemaFault.dbPath = unreadableDb;
  // Target inserted LAST. This fixture does NOT guard against a default row limit: with a `where`
  // filter the limit applies after filtering, so the one matching row is returned under any limit
  // (ARCH round-1 item 3). It is the strict-last semantic-rank and latency fixture only; the explicit
  // row limit is witnessed by the phraseScanTruncated fixture (more than PHRASE_SCAN_ROW_LIMIT matching rows).
  const big = Array.from({ length: 2000 }, (_, i) =>
    row(`b-${i}`, `doc.big.${i}`, `filler note ${i} about governance pipeline plan build ship`, scale(QV, 1 + 0.001 * (i + 1))));
  big.push(row("b-target", TARGET, TARGETS.code.text, scale(QV, FAR)));
  await prepareTable(bigDb, big);
  ({ query } = await import(pathToFileURL(QUERY_MJS).href));
  ({ FIDELITY_LEVELS } = await import(pathToFileURL(FIDELITY_MJS).href));
}, 60_000);

afterAll(() => {
  delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  if (root) rmSync(root, { recursive: true, force: true });
});

const full = (db, q, extra = {}) =>
  query({ db, q, k: K, fidelity: FIDELITY_LEVELS.L3_FULL, overrides: { project: FIDELITY_LEVELS.L3_FULL }, ...extra });
const slugs = (res) => res.matches.map((m) => m.slug);

describe("preconditions: each target is outside the 3·k window for its own query", () => {
  it.each(Object.entries(TARGETS))("%s target", async (_name, t) => {
    const rows = await rawTop(mainDb, t.q, WINDOW);
    expect(rows.length).toBe(WINDOW);
    expect(rows.some((r) => r.slug === t.slug)).toBe(false);
    expect(rows.some((r) => r.slug === "doc.decoy")).toBe(false);
  });

  it("pin fixture: no phrase note is inside the window", async () => {
    const rows = await rawTop(pinDb, PIN, WINDOW);
    expect(rows.length).toBe(WINDOW);
    expect(rows.some((r) => r.slug.startsWith("doc.pin."))).toBe(false);
  });

  it("split fixture: only the phrase-free chunk 0 of doc.split is inside the window", async () => {
    const rows = await rawTop(splitDb, SPLIT, WINDOW);
    expect(rows.filter((r) => r.slug === "doc.split").map((r) => Number(r.chunkId))).toEqual([0]);
  });

  it("escape-character fixture: neither the target nor either decoy is inside the window", async () => {
    const rows = await rawTop(bangDb, BANG, WINDOW);
    expect(rows.length).toBe(WINDOW);
    for (const s of ["doc.bang", "doc.decoy.bs", "doc.decoy.bang"]) expect(rows.some((r) => r.slug === s)).toBe(false);
  });

  it("dedupe fixture: doc.dup.in is inside the window and doc.dup.out is not", async () => {
    const rows = await rawTop(dupDb, DUP, WINDOW);
    expect(rows.some((r) => r.slug === "doc.dup.in")).toBe(true);
    expect(rows.some((r) => r.slug === "doc.dup.out")).toBe(false);
  });

  it("legacy fixture: the table has no text column", async () => {
    const table = await (await connect(legacyDb)).openTable("embeddings");
    const names = (await table.schema()).fields.map((f) => f.name);
    expect(names).not.toContain("text");
    expect(names).toContain("vector");
  });

  it("scale fixture: a raw search over all 2,001 rows ranks the target strictly last", async () => {
    const rows = await rawTop(bigDb, SENTENCE, 2001);
    expect(rows.length).toBe(2001);
    expect(rows[2000].slug).toBe(TARGET);
    expect(rows[2000]._distance).toBeGreaterThan(rows[1999]._distance);
  });
});

describe("AC1: verbatim recall outside the window, for every query class", () => {
  it.each([
    ["code", TARGETS.code],
    ["concept", TARGETS.concept],
    ["mixed", TARGETS.mixed],
  ])("%s query returns its target within the top k", async (qtype, t) => {
    const res = await full(mainDb, t.q);
    expect(res.ok).toBe(true);
    expect(res.qtype).toBe(qtype);
    expect(res.matches.length).toBeLessThanOrEqual(K);
    expect(slugs(res)).toContain(t.slug);
  });
});

describe("AC2: pin rule", () => {
  it("the pinned note heads the result and unchanged fusion fills the remaining slots", async () => {
    const res = await full(mainDb, SENTENCE);
    expect(res.matches.length).toBe(K);
    expect(res.matches[0].slug).toBe(TARGET);
    expect(res.matches[0].hybridRank).toBe(1);
    for (const m of res.matches.slice(1)) expect(typeof m.semanticScore).toBe("number");
  });

  it("pinned notes are capped at k and ordered by BM25 score descending, ties by note id ascending", async () => {
    const res = await full(pinDb, PIN);
    expect(res.ok).toBe(true);
    expect(res.matches.length).toBe(K);
    for (const m of res.matches) expect(PIN_SLUGS).toContain(m.slug);
    expect(slugs(res).slice(0, 2)).toEqual(["doc.pin.a", "doc.pin.b"]);
    expect(res.matches[0].keywordScore).toBe(res.matches[1].keywordScore);
    const scores = res.matches.map((m) => m.keywordScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("no two matches share a note identity", async () => {
    for (const [db, q] of [[mainDb, SENTENCE], [mainDb, CONCEPT], [pinDb, PIN], [splitDb, SPLIT]]) {
      const res = await full(db, q);
      const ids = res.matches.map((m) => m.slug || m.path);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("a note whose phrase sits only in an out-of-window chunk is pinned once with a numeric keywordScore", async () => {
    const res = await full(splitDb, SPLIT);
    const rows = res.matches.filter((m) => m.slug === "doc.split");
    expect(rows.length).toBe(1);
    expect(rows[0].hybridRank).toBe(1);
    expect(typeof rows[0].keywordScore).toBe("number");
    expect(rows[0].keywordScore).toBeGreaterThan(0);
  });
});

describe("AC3: a keyword-only hit gets the same metadata and fidelity treatment as a semantic hit", () => {
  it("same key set, stored metadata, and the matching chunk text at L3", async () => {
    const res = await full(mainDb, SENTENCE);
    const hit = res.matches.find((m) => m.slug === TARGET);
    const sem = res.matches.find((m) => m.slug !== TARGET);
    expect(sem).toBeDefined();
    expect(Object.keys(hit).sort()).toEqual(Object.keys(sem).sort());
    expect(hit.path).toBe(`${TARGET}.md`);
    expect(hit.title).toBe(TARGET);
    expect(hit.status).toBe("implemented");
    expect(hit.content_type).toBe("note");
    expect(hit.fidelity).toBe("L3");
    expect(hit.text).toContain(SENTENCE);
  });

  it("same fidelity tier and text null at L0_METADATA", async () => {
    const res = await query({ db: mainDb, q: SENTENCE, k: K, fidelity: FIDELITY_LEVELS.L0_METADATA });
    const hit = res.matches.find((m) => m.slug === TARGET);
    const sem = res.matches.find((m) => m.slug !== TARGET);
    expect(hit).toBeDefined();
    expect(hit.fidelity).toBe(sem.fidelity);
    expect(hit.text).toBeNull();
  });
});

describe("AC4: ordinary queries are unchanged", () => {
  it("a 3-token query held verbatim only outside the window pins nothing", async () => {
    const res = await full(mainDb, SHORT);
    expect(res.ok).toBe(true);
    expect(slugs(res)).not.toContain(TARGETS.short.slug);
    for (const m of res.matches) expect(typeof m.semanticScore).toBe("number");
  });

  it("a query with no keyword match anywhere keeps semantic order and adds no keyword-only hit", async () => {
    const res = await full(mainDb, "zzqxv wqpzt");
    expect(res.ok).toBe(true);
    for (const m of res.matches) {
      expect(m.keywordScore == null).toBe(true);
      expect(typeof m.semanticScore).toBe("number");
    }
    const scores = res.matches.map((m) => m.semanticScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("a query whose keyword matches all lie inside the window adds no keyword-only hit", async () => {
    // "inwindowonly" occurs only in doc.near.00-02, the three nearest rows (semantic ranks 1-3).
    const res = await full(mainDb, "inwindowonly");
    expect(res.ok).toBe(true);
    expect(res.matches.filter((m) => typeof m.keywordScore === "number").every((m) => ["doc.near.00", "doc.near.01", "doc.near.02"].includes(m.slug))).toBe(true);
    for (const m of res.matches) expect(typeof m.semanticScore).toBe("number");
  });
});

describe("hybridSearch() pinnedIds in isolation", () => {
  let hybridSearch;
  let createIndex;
  beforeAll(async () => {
    ({ hybridSearch } = await import(pathToFileURL(HYBRID_MJS).href));
    ({ createIndex } = await import(pathToFileURL(BM25_MJS).href));
  });
  const SEM = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, score: 1 - n / 10 }));
  function index() {
    const idx = createIndex();
    idx.addDocument("s1", "routekit pipeline build ship");
    idx.addDocument("s5", "Invoice archive folder");
    idx.addDocument("P", `Payment record: ${CONCEPT} closed.`);
    return idx;
  }
  const ids = (res) => res.results.map((r) => r.id);

  it("returns deep-equal output with pinnedIds omitted and with pinnedIds []", async () => {
    const seen = [];
    for (const q of ["routekit pipeline build", CONCEPT, MIXED]) {
      const a = await hybridSearch({ query: q, semanticResults: SEM, bm25Index: index(), k: K });
      const b = await hybridSearch({ query: q, semanticResults: SEM, bm25Index: index(), k: K, pinnedIds: [] });
      expect(b).toEqual(a);
      seen.push(a.qtype);
    }
    expect(seen).toEqual(["code", "concept", "mixed"]);
  });

  it("a pinned keyword-only id that unchanged concept fusion cuts heads the result", async () => {
    const base = await hybridSearch({ query: CONCEPT, semanticResults: SEM, bm25Index: index(), k: K });
    expect(base.qtype).toBe("concept");
    expect(ids(base)).not.toContain("P"); // non-vacuity: fusion alone cuts it
    const pinned = await hybridSearch({ query: CONCEPT, semanticResults: SEM, bm25Index: index(), k: K, pinnedIds: ["P"] });
    expect(pinned.results.length).toBe(K);
    expect(ids(pinned)[0]).toBe("P");
    expect(ids(pinned).slice(1)).toEqual(ids(base).filter((id) => id !== "P").slice(0, K - 1));
    expect(pinned.results[0].semantic).toBeNull();
    expect(pinned.results[0].keyword.score).toBeGreaterThan(0);
  });

  it("duplicate pinnedIds emit the id once", async () => {
    const res = await hybridSearch({ query: CONCEPT, semanticResults: SEM, bm25Index: index(), k: K, pinnedIds: ["P", "P"] });
    expect(res.results.length).toBe(K);
    expect(ids(res).filter((id) => id === "P").length).toBe(1);
  });
});

describe("AC5: score provenance", () => {
  it("the keyword-only hit has semanticScore and baseScore strictly null and a positive numeric keywordScore", async () => {
    const res = await full(mainDb, SENTENCE);
    const hit = res.matches.find((m) => m.slug === TARGET);
    expect(hit.semanticScore).toBeNull();
    expect(hit.baseScore).toBeNull();
    expect(typeof hit.keywordScore).toBe("number");
    expect(hit.keywordScore).toBeGreaterThan(0);
    for (const m of res.matches.filter((x) => x.slug !== TARGET)) {
      expect(typeof m.semanticScore).toBe("number");
      expect(typeof m.baseScore).toBe("number");
    }
  });
});

describe("AC6: the phrase prefilter matches literally", () => {
  it("', % and _ are literal: the exact note is returned and the wildcard-only decoy is not", async () => {
    const res = await full(mainDb, ESCAPE_Q);
    expect(res.ok).toBe(true);
    expect(slugs(res)).toContain(TARGETS.escape.slug);
    expect(slugs(res)).not.toContain("doc.decoy");
    expect(res.matches.find((m) => m.slug === TARGETS.escape.slug).semanticScore).toBeNull();
  });
});

function captureErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  // mockRestore() clears mock.calls, so restore() snapshots the messages first; messages() stays
  // readable after restore, which is how the assertions below use it.
  let snapshot = null;
  const read = () => spy.mock.calls.map((args) => args.map(String).join(" "));
  return {
    messages: () => snapshot ?? read(),
    restore: () => { snapshot = read(); spy.mockRestore(); },
  };
}

describe("AC6: the escape characters themselves match literally", () => {
  it("a phrase holding a backslash and ! returns its note and neither decoy", async () => {
    const res = await full(bangDb, BANG);
    expect(res.ok).toBe(true);
    expect(slugs(res)).toContain("doc.bang");
    expect(slugs(res)).not.toContain("doc.decoy.bs");
    expect(slugs(res)).not.toContain("doc.decoy.bang");
    expect(res.matches.find((m) => m.slug === "doc.bang").semanticScore).toBeNull();
  });
});

describe("phrase chunks are counted once per note", () => {
  it("in-window and out-of-window notes with identical phrase text get equal keywordScore", async () => {
    const res = await full(dupDb, DUP);
    const din = res.matches.find((m) => m.slug === "doc.dup.in");
    const dout = res.matches.find((m) => m.slug === "doc.dup.out");
    expect(din).toBeDefined();
    expect(dout).toBeDefined();
    expect(typeof din.semanticScore).toBe("number"); // in-window
    expect(dout.semanticScore).toBeNull(); // out-of-window
    expect(typeof din.keywordScore).toBe("number");
    expect(din.keywordScore).toBeGreaterThan(0);
    expect(din.keywordScore).toBe(dout.keywordScore);
  });
});

describe("phrase-scan truncation is observed and reported", () => {
  it("201 matching rows: ok true, phraseScanTruncated true, exactly one warning naming the 200 limit", async () => {
    const cap = captureErrors();
    let res;
    try { res = await full(truncDb, TRUNC); } finally { cap.restore(); }
    expect(res.ok).toBe(true);
    expect(res.phraseScanTruncated).toBe(true);
    expect(res.phraseScanSkipped).toBeNull();
    const warnings = cap.messages().filter((m) => /truncat/i.test(m));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("200");
  });

  it("exactly 200 matching rows is not truncation", async () => {
    const cap = captureErrors();
    let res;
    try { res = await full(exactDb, TRUNC); } finally { cap.restore(); }
    expect(res.ok).toBe(true);
    expect(res.phraseScanTruncated).toBe(false);
    expect(cap.messages().some((m) => /truncat/i.test(m))).toBe(false);
  });

  it("a qualifying query matching few rows reports false; a below-threshold query reports null", async () => {
    const few = await full(mainDb, SENTENCE);
    expect(few.phraseScanTruncated).toBe(false);
    expect(few.phraseScanSkipped).toBeNull();
    const short = await full(mainDb, SHORT);
    expect(short.phraseScanTruncated).toBeNull();
    expect(short.phraseScanSkipped).toBeNull();
  });

  it("the query() return keeps its pre-existing top-level keys alongside the two additive fields", async () => {
    const res = await full(mainDb, SENTENCE);
    for (const key of ["ok", "matches", "query", "qtype", "weights", "results", "phraseScanTruncated", "phraseScanSkipped"]) {
      expect(res).toHaveProperty(key);
    }
  });
});

describe("legacy table with no text column", () => {
  it("a qualifying query skips the phrase scan, returns ok true and reports the skip once", async () => {
    const cap = captureErrors();
    let res;
    try { res = await full(legacyDb, SENTENCE); } finally { cap.restore(); }
    expect(res.ok).toBe(true);
    expect(res.phraseScanSkipped).toBe("no_text_column");
    expect(res.phraseScanTruncated).toBeNull();
    const skips = cap.messages().filter((m) => /skip/i.test(m));
    expect(skips.length).toBe(1);
    expect(skips[0]).toContain("text");
  });
});

describe("unreadable table schema", () => {
  it("an empty field list skips the phrase scan as schema_unreadable (never no_text_column) and reports it once", async () => {
    const before = schemaFault.calls;
    const cap = captureErrors();
    let res;
    try { res = await full(unreadableDb, SENTENCE); } finally { cap.restore(); }
    expect(schemaFault.calls).toBeGreaterThan(before); // non-vacuity: the injected schema() failure was reached
    expect(res.ok, res.error).toBe(true);
    expect(Array.isArray(res.matches)).toBe(true);
    expect(res.phraseScanSkipped).toBe("schema_unreadable");
    expect(res.phraseScanTruncated).toBeNull();
    const skips = cap.messages().filter((m) => /skip/i.test(m));
    expect(skips.length).toBe(1);
    expect(skips[0]).toMatch(/schema/i);
  });
});

describe("AC7: latency", () => {
  it("median of 5 queries over a 2,001-row index stays under 1,500 ms and every call recalls the target", async () => {
    await full(bigDb, SENTENCE); // warm-up
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const res = await full(bigDb, SENTENCE);
      times.push(performance.now() - t0);
      expect(slugs(res)).toContain(TARGET);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(1500);
  }, 60_000);
});
