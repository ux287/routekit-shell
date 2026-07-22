// Single source of truth for the standalone RAG MCP servers (stdio + http/SSE).
//
// Owns the rag_* tool SCHEMAS, their ListTools JSON-Schema definitions, and the byte-identical
// rag_init/rag_embed handlers hoisted out of the two servers. The handlers delegate to the RAW
// scripts (../rag/init.mjs, ../rag/embed.mjs) — deliberately NOT the governed runRagInit/runRagEmbed
// wrappers in packages/mcp-rks/src/rag/tools.mjs, which drop the client `db` and add embed-lock
// gating, rag.embed.* telemetry, a git spawn, a last-embed.json write, and LanceDB compaction. This
// is a behavior-preserving hoist, not a mechanism swap.
//
// rag_query is intentionally NOT shared beyond its schema: each server keeps its own handler
// (stdio routes through retrieveWithRouting for routing + policy-guardrails; http calls ragQuery
// directly). Only the rag_query SCHEMA is shared, with `raw` optional/additive so http gains it
// backward-compatibly.
import { z } from "zod";
import { init as ragInit } from "../rag/init.mjs";
import { embed as ragEmbed } from "../rag/embed.mjs";
import { getDefaultRagConfig } from "../rag/utils.mjs";

const DEFAULTS = getDefaultRagConfig();

// --- Shared zod schemas (superset; `raw` optional/additive) ---
export const ragInitSchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db),
});

export const ragEmbedSchema = z.object({
  vault: z.string().describe("Absolute path to notes vault").default(DEFAULTS.vault),
  glob: z.string().describe("Glob filter like 'project-slug.*'").default(DEFAULTS.glob),
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db),
});

export const ragQuerySchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db),
  q: z.string().min(2).describe("User query / question"),
  k: z.number().int().min(1).max(20).default(DEFAULTS.k),
  raw: z.boolean().optional().describe("Return raw JSON format (for backward compatibility)"),
});

// --- Shared ListTools JSON-Schema definitions for the three rag_* tools ---
export const RAG_TOOL_DEFINITIONS = [
  {
    name: "rag_init",
    description: "Initialize or open a local LanceDB for RAG.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "Absolute path to DB", default: DEFAULTS.db },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rag_embed",
    description: "Embed notes from a Dendron vault into the local vector DB.",
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Absolute path to notes vault", default: DEFAULTS.vault },
        glob: { type: "string", description: "Glob filter like 'project-slug.*'", default: DEFAULTS.glob },
        db: { type: "string", description: "Absolute path to DB", default: DEFAULTS.db },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rag_query",
    description: "Similarity search over local RAG DB.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "Absolute path to DB", default: DEFAULTS.db },
        q: { type: "string", description: "User query / question", minLength: 2 },
        k: { type: "integer", description: "Number of results to return", minimum: 1, maximum: 20, default: DEFAULTS.k },
        raw: { type: "boolean", description: "Return raw JSON format (for backward compatibility)", default: false },
      },
      required: ["q"],
      additionalProperties: false,
    },
  },
];

// --- Shared rag_init / rag_embed handlers: RAW-script delegation, client params passed unchanged ---
export async function handleRagInit(args) {
  const input = ragInitSchema.parse(args || {});
  const result = await ragInit(input);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleRagEmbed(args) {
  const input = ragEmbedSchema.parse(args || {});
  const result = await ragEmbed(input);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
