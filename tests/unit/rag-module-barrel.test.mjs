import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// backlog.feat.rag-module-public-contract — the RAG barrel (packages/mcp-rks/src/rag/index.mjs) is a
// documented TWO-TIER public contract: Tier 1 = governed ops + embedding pipeline (export *);
// Tier 2 = a small transitional set of named re-exports still referenced by two consumers. The
// lower-level primitives (hybrid-search / fidelity-filter / source-classifier / notes-chunker and
// the rag-columns internals) are intentionally NOT public and must not be reachable via the barrel.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const RAG_DIR = resolve(ROOT, "packages/mcp-rks/src/rag");
const BARREL = resolve(RAG_DIR, "index.mjs");
const importBarrel = () => import(pathToFileURL(BARREL).href);

describe("RAG module barrel — two-tier public contract", () => {
  it("imports cleanly", async () => {
    const b = await importBarrel();
    expect(b).toBeTypeOf("object");
  });

  it("PUBLIC tier: the governed tools are reachable via the barrel", async () => {
    const b = await importBarrel();
    for (const fn of [
      "runRagInit", "runRagEmbed", "runRagQuery", "runRagCompact",
      "ensureRagIndex", "runExhaustiveSearch", "getLastEmbedTime",
    ]) {
      expect(b[fn], fn).toBeTypeOf("function");
    }
  });

  it("PUBLIC tier: the shared embedding pipeline is reachable via the barrel", async () => {
    const b = await importBarrel();
    expect(b.getSharedEmbeddingPipeline).toBeTypeOf("function");
    expect(b.embedScopedFiles).toBeTypeOf("function");
  });

  it("TRANSITIONAL tier: only the four referenced primitive symbols are reachable via the barrel", async () => {
    const b = await importBarrel();
    for (const fn of ["missingRequiredColumns", "selectableProjection", "tableFieldNames", "inferQueryIntent"]) {
      expect(b[fn], fn).toBeTypeOf("function");
    }
  });

  it("DROPPED: the lower-level primitives are NOT reachable via the barrel (public surface narrowed)", async () => {
    const b = await importBarrel();
    for (const sym of [
      "hybridSearch", "detectQueryType", "rrfCombine",                                  // hybrid-search
      "filterByFidelity", "applyFidelity", "getEffectiveFidelity", "FIDELITY_LEVELS", "DEFAULT_FIDELITY", // fidelity-filter
      "classifySource", "classifyContentType", "SOURCE_CLASSES", "CONTENT_TYPES",         // source-classifier
      "chunkNoteText", "chunkParsedNote", "chunkNoteFile",                                // notes-chunker
      "isImplementationQuery", "getNamespaceBoost", "getCanonicalPathBoost", "CONTENT_TYPE_BOOST", "NAMESPACE_BOOST", // query-intent (non-transitional)
      "RAG_REQUIRED_COLUMNS", "normalizeRagRows",                                         // rag-columns (non-trio)
    ]) {
      expect(b[sym], `${sym} must NOT be reachable via the barrel`).toBeUndefined();
    }
  });

  it("preserves export identity for the public + transitional symbols", async () => {
    const b = await importBarrel();
    const tools = await import(pathToFileURL(resolve(RAG_DIR, "tools.mjs")).href);
    const emb = await import(pathToFileURL(resolve(RAG_DIR, "embedding-pipeline.mjs")).href);
    const cols = await import(pathToFileURL(resolve(RAG_DIR, "rag-columns.mjs")).href);
    const qi = await import(pathToFileURL(resolve(RAG_DIR, "query-intent.mjs")).href);
    expect(b.runRagQuery).toBe(tools.runRagQuery);
    expect(b.getSharedEmbeddingPipeline).toBe(emb.getSharedEmbeddingPipeline);
    expect(b.missingRequiredColumns).toBe(cols.missingRequiredColumns);
    expect(b.inferQueryIntent).toBe(qi.inferQueryIntent);
  });

  it("barrel source shape: export * only from the public modules; NAMED re-exports for the transitional two; no export * from the dropped modules", () => {
    const src = readFileSync(BARREL, "utf8");
    expect(src).toContain(`export * from './tools.mjs'`);
    expect(src).toContain(`export * from './embedding-pipeline.mjs'`);
    // Transitional: named re-exports (not `export *`) so only the referenced symbols leak.
    expect(src).toMatch(/export \{[^}]*missingRequiredColumns[^}]*\} from ['"]\.\/rag-columns\.mjs['"]/);
    expect(src).toMatch(/export \{[^}]*inferQueryIntent[^}]*\} from ['"]\.\/query-intent\.mjs['"]/);
    // No `export *` from the dropped modules — nor a blanket `export *` of the transitional two.
    for (const m of ["hybrid-search", "fidelity-filter", "source-classifier", "notes-chunker", "rag-columns", "query-intent"]) {
      expect(src, m).not.toContain(`export * from './${m}.mjs'`);
    }
  });

  it("introduces no LLM credential dependency at import", () => {
    const src = readFileSync(BARREL, "utf8");
    expect(src).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|Authorization|apiKey/);
  });
});
