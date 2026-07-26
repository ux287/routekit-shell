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
import { query as ragQuery } from "../rag/query.mjs";
import { getDefaultRagConfig } from "../rag/utils.mjs";
import {
  ragQuerySchema,
  RAG_TOOL_DEFINITIONS,
  handleRagInit,
  handleRagEmbed,
} from "./rag-tools-shared.mjs";
import { createServer } from "http";
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

// Tool schemas (rag_*) come from the single shared definition in ./rag-tools-shared.mjs.

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [...RAG_TOOL_DEFINITIONS];
  log(`🔧 Returning ${tools.length} tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "rag_init":
        return await handleRagInit(args);

      case "rag_embed":
        return await handleRagEmbed(args);

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

  // SSEServerTransport is PER-CONNECTION and its 2nd argument is the live http.ServerResponse of the
  // SSE GET request. Passing an options object here was the boot bug — `this.res.writeHead` blew up.
  // Client opens the SSE stream with GET /mcp, then POSTs JSON-RPC messages to /messages.
  const MESSAGE_ENDPOINT = "/messages";
  let transport = null;

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/mcp" || req.url === "/sse")) {
        transport = new SSEServerTransport(MESSAGE_ENDPOINT, res);
        await server.connect(transport);
        return;
      }
      if (req.method === "POST" && req.url && req.url.startsWith(MESSAGE_ENDPOINT)) {
        if (!transport) {
          res.writeHead(400).end("No active SSE session");
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end("Not found");
    } catch (err) {
      log(`❌ HTTP handler error: ${err?.message || err}`);
      if (!res.headersSent) {
        res.writeHead(500).end(String(err?.message || err));
      }
    }
  });

  httpServer.listen(port, () => {
    log(`✅ RAG MCP Server connected on http://localhost:${port}/mcp`);
    log(`📍 Server name: routekit-rag-${DEFAULTS.projectSlug || 'unknown'}`);
    log("🔧 Available tools: rag_init, rag_embed, rag_query");
  });
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});