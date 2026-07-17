#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { init as ragInit }  from "../rag/init.mjs";
import { embed as ragEmbed } from "../rag/embed.mjs";
import { query as ragQuery } from "../rag/query.mjs";
import { getDefaultRagConfig } from "../rag/utils.mjs";
import { homedir } from "os";
import { writeFileSync, appendFileSync } from "fs";
import { join } from "path";

// Log file for debugging
const LOG_FILE = join(homedir(), "Documents", "projects", ".routekit", "mcp-debug.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} ${message}\n`;
  console.error(message);
  try {
    appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    // Ignore file write errors
  }
}

// Get project-specific defaults
const DEFAULTS = getDefaultRagConfig();

const server = new Server({
  name: `routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`,
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool schemas
const ragInitSchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db)
});

const ragEmbedSchema = z.object({
  vault: z.string().describe("Absolute path to notes vault").default(DEFAULTS.vault),
  glob: z.string().describe("Glob filter like 'project-slug.*'").default(DEFAULTS.glob),
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db)
});

const ragQuerySchema = z.object({
  db: z.string().describe("Absolute path to DB").default(DEFAULTS.db),
  q: z.string().min(2).describe("User query / question"),
  k: z.number().int().min(1).max(20).default(DEFAULTS.k)
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [
    {
      name: "rag_init",
      description: "Initialize or open a local LanceDB for RAG.",
      inputSchema: {
        type: "object",
        properties: {
          db: {
            type: "string",
            description: "Absolute path to DB",
            default: DEFAULTS.db
          }
        },
        additionalProperties: false
      },
    },
    {
      name: "rag_embed", 
      description: "Embed notes from a Dendron vault into the local vector DB.",
      inputSchema: {
        type: "object",
        properties: {
          vault: {
            type: "string",
            description: "Absolute path to notes vault",
            default: DEFAULTS.vault
          },
          glob: {
            type: "string", 
            description: "Glob filter like 'project-slug.*'",
            default: DEFAULTS.glob
          },
          db: {
            type: "string",
            description: "Absolute path to DB", 
            default: DEFAULTS.db
          }
        },
        additionalProperties: false
      },
    },
    {
      name: "rag_query",
      description: "Similarity search over local RAG DB.",
      inputSchema: {
        type: "object",
        properties: {
          db: {
            type: "string",
            description: "Absolute path to DB",
            default: DEFAULTS.db
          },
          q: {
            type: "string",
            description: "User query / question",
            minLength: 2
          },
          k: {
            type: "integer",
            description: "Number of results to return",
            minimum: 1,
            maximum: 20,
            default: DEFAULTS.k
          }
        },
        required: ["q"],
        additionalProperties: false
      },
    },
  ];
  log(`🔧 Returning ${tools.length} tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "rag_init": {
        const input = ragInitSchema.parse(args || {});
        const result = await ragInit(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "rag_embed": {
        const input = ragEmbedSchema.parse(args || {});
        const result = await ragEmbed(input);
        return {
          content: [
            {
              type: "text", 
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "rag_query": {
        const input = ragQuerySchema.parse(args || {});
        const result = await ragQuery(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name}`
        );
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${error.message}`
      );
    }
    throw error;
  }
});

// Start HTTP server
async function main() {
  const port = process.env.PORT || 3001;
  log(`🚀 Starting RAG MCP HTTP Server on port ${port}...`);
  
  const transport = new SSEServerTransport("/mcp", {
    port: port,
  });
  
  log("📡 Created HTTP/SSE transport");
  await server.connect(transport);
  log(`✅ RAG MCP Server connected on http://localhost:${port}/mcp`);
  log(`📍 Server name: routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`);
  log("🔧 Available tools: rag_init, rag_embed, rag_query");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});