/**
 * backlog.fix.keyless-rag-uat-quickfixes — AC3 / AC4 / AC5
 *
 * The RAG QUERY path must NOT let @lancedb/lancedb's connect() auto-create an empty store when the
 * path is missing/wrong: that would return an empty result set from a freshly-fabricated index
 * (and leave a stray dir behind) instead of surfacing the real "no index here" error. The guard is
 * scoped to the query path only — the init/embed create paths must still create on first run
 * (behaviorally witnessed by the existing tests/integration/rag-embed-upsert.test.mjs).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "@routekit/rag/query";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

describe("rag query: no auto-create on a missing store (AC3/AC5)", () => {
  it("query against a non-existent store path errors and does NOT fabricate an index", async () => {
    const missing = path.join(os.tmpdir(), `rag-missing-${process.pid}-${Date.now()}.lancedb`);
    expect(fs.existsSync(missing)).toBe(false);

    const res = await query({ db: missing, q: "anything" });

    // AC3: a clear error, not { ok:true, matches:[] } from a freshly-created empty index.
    expect(res.ok).toBe(false);
    expect(String(res.error || "")).toMatch(/not found|does not exist|no such/i);
    // AC5: the query path must not have fabricated an empty store dir/table.
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe("rag create paths untouched — guard is query-path-only (AC4)", () => {
  it("the no-auto-create guard lives ONLY in the query path", () => {
    expect(read("packages/rag/src/query.mjs")).toMatch(/RAG store not found at/);
    expect(read("packages/rag/src/embed.mjs")).not.toMatch(/RAG store not found at/);
    expect(read("packages/rag/src/init.mjs")).not.toMatch(/RAG store not found at/);
  });

  it("the embed path still creates the embeddings table", () => {
    // Behavioral create-path success is covered by tests/integration/rag-embed-upsert.test.mjs;
    // this is the structural witness that this change did not disturb it.
    expect(read("packages/rag/src/embed.mjs")).toMatch(/createTable/);
  });
});
