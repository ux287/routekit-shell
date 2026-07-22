import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// backlog.feat.rag-consolidate-embedding-pipeline — structural + behavioral coverage for the
// embedding-model-load dedup: the shell query path delegates to the shared singleton, and the
// app-web template gets its own self-contained singleton (a scaffolded app has no packages/mcp-rks).

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

// The verbatim model-load call the consolidation removes from every consumer (both quote styles).
const hasVerbatimLoad = (src) =>
  src.includes("pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')") ||
  src.includes('pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")');

const SHELL_QUERY = "scripts/rag/query.mjs";
const TEMPLATE_DIR = "templates/app-web/scripts/rag";
const TEMPLATE_SINGLETON = `${TEMPLATE_DIR}/embedding-pipeline.mjs`;
const TEMPLATE_CONSUMERS = [
  `${TEMPLATE_DIR}/embed.mjs`,
  `${TEMPLATE_DIR}/query.mjs`,
  `${TEMPLATE_DIR}/query-with-logging.mjs`,
];

describe("RAG embedding-pipeline consolidation — shell scripts/rag", () => {
  it("scripts/rag/query.mjs delegates to the shared singleton", () => {
    const src = read(SHELL_QUERY);
    expect(src).toContain("getSharedEmbeddingPipeline");
    expect(src).toMatch(/packages\/mcp-rks\/src\/rag\/embedding-pipeline\.mjs/);
  });

  it("scripts/rag/query.mjs holds no verbatim model load", () => {
    expect(hasVerbatimLoad(read(SHELL_QUERY))).toBe(false);
  });

  it("no verbatim model load remains anywhere under scripts/rag/", () => {
    const dir = resolve(ROOT, "scripts/rag");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) => hasVerbatimLoad(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("RAG embedding-pipeline consolidation — app-web template", () => {
  it("the template-local shared singleton exists and exports getSharedEmbeddingPipeline", () => {
    expect(existsSync(resolve(ROOT, TEMPLATE_SINGLETON))).toBe(true);
    expect(read(TEMPLATE_SINGLETON)).toMatch(/export\s+async\s+function\s+getSharedEmbeddingPipeline/);
  });

  it("the verbatim model load lives only in the singleton (at most once across the template rag scripts)", () => {
    const owners = [TEMPLATE_SINGLETON, ...TEMPLATE_CONSUMERS].filter((f) => hasVerbatimLoad(read(f)));
    expect(owners).toEqual([TEMPLATE_SINGLETON]);
  });

  it("the three consumers import the template-local singleton and never reach into packages/mcp-rks", () => {
    for (const f of TEMPLATE_CONSUMERS) {
      const src = read(f);
      expect(src, `${f} must import the template-local singleton`).toContain("from './embedding-pipeline.mjs'");
      // A scaffolded app-web project has no packages/mcp-rks — such an import would break the scaffold.
      expect(src, `${f} must not import the shell singleton`).not.toContain("packages/mcp-rks");
    }
  });

  it("no template consumer retains its own inline model load", () => {
    for (const f of TEMPLATE_CONSUMERS) {
      expect(hasVerbatimLoad(read(f)), `${f} still loads the model inline`).toBe(false);
    }
  });

  it("consolidation introduces no API-key / credential dependency on the embed/query path", () => {
    for (const f of [SHELL_QUERY, TEMPLATE_SINGLETON, ...TEMPLATE_CONSUMERS]) {
      expect(read(f), `${f} must stay key-free`).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|Authorization|apiKey/);
    }
  });
});

describe("template shared singleton — stub-mode behavior (offline, deterministic)", () => {
  it("stub mode yields a deterministic 384-dim vector for the same input", async () => {
    process.env.RKS_RAG_EMBEDDINGS_MODE = "stub";
    // Cache-busted import so the module-level singleton picks up stub mode fresh.
    const url = pathToFileURL(resolve(ROOT, TEMPLATE_SINGLETON)).href + "?stub-determinism";
    const mod = await import(url);
    const pipe = await mod.getSharedEmbeddingPipeline();
    const a = await pipe("hello world");
    const b = await pipe("hello world");
    expect(a.data.length).toBe(384);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    delete process.env.RKS_RAG_EMBEDDINGS_MODE;
  });
});
