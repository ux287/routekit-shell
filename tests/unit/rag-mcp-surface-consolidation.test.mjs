import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// backlog.feat.rag-consolidate-mcp-surface — the two standalone RAG MCP servers had byte-identical
// rag_* schemas and rag_init/rag_embed handlers. This consolidates them onto ONE shared module,
// while PRESERVING each server's rag_query behavior (stdio: retrieveWithRouting; http: direct
// ragQuery). Source-introspection guards the consolidation + the behavior preservation.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
// Strip comments so token-absence checks assert on CODE, not explanatory prose: the shared module's
// header comment deliberately names runRagInit / last-embed.json / etc. to explain why they're avoided.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SHARED = "scripts/mcp/rag-tools-shared.mjs";
const STDIO = "scripts/mcp/rag-server.mjs";
const HTTP = "scripts/mcp/rag-server-http.mjs";

describe("rag MCP surface consolidation — shared source of truth", () => {
  it("the shared module exports the rag_* schemas, tool definitions, and rag_init/rag_embed handlers", () => {
    const src = read(SHARED);
    expect(src).toMatch(/export const ragInitSchema/);
    expect(src).toMatch(/export const ragEmbedSchema/);
    expect(src).toMatch(/export const ragQuerySchema/);
    expect(src).toMatch(/export const RAG_TOOL_DEFINITIONS/);
    expect(src).toMatch(/export async function handleRagInit/);
    expect(src).toMatch(/export async function handleRagEmbed/);
  });

  it("the shared rag_init/rag_embed handlers delegate to the RAW scripts, NOT the governed wrappers", () => {
    const raw = read(SHARED);
    const code = stripComments(raw);
    // Delegates to the raw init/embed scripts (imports are code).
    expect(raw).toMatch(/from ["']\.\.\/rag\/init\.mjs["']/);
    expect(raw).toMatch(/from ["']\.\.\/rag\/embed\.mjs["']/);
    // The governed wrappers drop client `db` and add lock/telemetry/compaction — must not appear in CODE.
    expect(code).not.toContain("runRagInit");
    expect(code).not.toContain("runRagEmbed");
    expect(code).not.toContain("packages/mcp-rks");
    expect(code).not.toContain("rag/tools.mjs");
  });

  it("the shared handlers introduce none of the governed-wrapper side-effects", () => {
    const code = stripComments(read(SHARED));
    expect(code).not.toMatch(/locked:\s*true/);
    expect(code).not.toContain("last-embed.json");
    expect(code).not.toContain("table.optimize");
    expect(code).not.toContain("rag.embed.");
    expect(code).not.toContain("spawnSync");
  });

  it("both servers import the shared schema + handlers and re-declare no private rag_* schemas", () => {
    for (const f of [STDIO, HTTP]) {
      const src = read(f);
      expect(src, `${f} must import from the shared module`).toMatch(/from ["']\.\/rag-tools-shared\.mjs["']/);
      expect(src, `${f} must use the shared RAG_TOOL_DEFINITIONS`).toContain("RAG_TOOL_DEFINITIONS");
      expect(src, `${f} must delegate rag_init to the shared handler`).toContain("handleRagInit");
      expect(src, `${f} must delegate rag_embed to the shared handler`).toContain("handleRagEmbed");
      expect(src, `${f} still re-declares ragInitSchema`).not.toMatch(/const ragInitSchema\s*=\s*z\.object/);
      expect(src, `${f} still re-declares ragEmbedSchema`).not.toMatch(/const ragEmbedSchema\s*=\s*z\.object/);
      expect(src, `${f} still re-declares ragQuerySchema`).not.toMatch(/const ragQuerySchema\s*=\s*z\.object/);
    }
  });

  it("no server imports the raw init/embed scripts directly anymore (handlers hoisted to shared)", () => {
    for (const f of [STDIO, HTTP]) {
      const src = read(f);
      expect(src, `${f} must not import raw init.mjs directly`).not.toMatch(/from ["']\.\.\/rag\/init\.mjs["']/);
      expect(src, `${f} must not import raw embed.mjs directly`).not.toMatch(/from ["']\.\.\/rag\/embed\.mjs["']/);
    }
  });
});

describe("rag MCP surface consolidation — behavior preserved per transport", () => {
  it("stdio rag_query STILL routes through retrieveWithRouting (routing + guardrails intact), not runRagQuery", () => {
    const src = read(STDIO);
    expect(src).toContain("retrieveWithRouting");
    const ragQueryCase = src.slice(src.indexOf('case "rag_query"'), src.indexOf('case "orchestrator_query"'));
    expect(ragQueryCase).toContain("retrieveWithRouting");
    expect(ragQueryCase).not.toContain("runRagQuery");
  });

  it("http rag_query STILL uses the direct ragQuery path, unchanged", () => {
    const src = read(HTTP);
    expect(src).toMatch(/import \{ query as ragQuery \} from ["']\.\.\/rag\/query\.mjs["']/);
    const ragQueryCase = src.slice(src.indexOf('case "rag_query"'));
    expect(ragQueryCase).toContain("await ragQuery(input)");
    expect(ragQueryCase).not.toContain("retrieveWithRouting");
    expect(ragQueryCase).not.toContain("runRagQuery");
  });

  it("stdio preserves its full tool set incl. orchestrator_query + error_analysis", () => {
    const src = read(STDIO);
    for (const t of ["orchestrator_query", "error_analysis"]) expect(src).toContain(`name: "${t}"`);
  });

  it("the shared rag_query schema is a superset carrying the optional additive `raw` field", () => {
    const src = read(SHARED);
    const q = src.slice(src.indexOf("export const ragQuerySchema"), src.indexOf("RAG_TOOL_DEFINITIONS"));
    expect(q).toMatch(/raw:\s*z\.boolean\(\)\.optional\(\)/);
  });

  it("neither server nor the shared module references runRagQuery in code (no conflation with the governed wrapper)", () => {
    for (const f of [SHARED, STDIO, HTTP]) {
      expect(stripComments(read(f))).not.toContain("runRagQuery");
    }
  });
});
