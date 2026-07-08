#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { FigmaMcpHttpClient, describeFigmaConnectivityError } from "./figma-client.mjs";

const FALLBACK_TOOLS = [
  { name: "get_metadata", description: "Get metadata about the current Figma document and selection." },
  { name: "get_screenshot", description: "Get a screenshot for a nodeId/frame/component." },
  { name: "get_design_context", description: "Get design context for a nodeId." },
  { name: "get_variable_defs", description: "Get variable definitions from the file." },
  { name: "create_design_system_rules", description: "Generate design system rules from the file." },
  { name: "get_figjam", description: "Get FigJam context for a nodeId." },
];

const client = new FigmaMcpHttpClient();

const server = new Server({ name: "routekit-figma-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const tools = await client.toolsList();
    return { tools: tools && tools.length ? tools : FALLBACK_TOOLS };
  } catch (error) {
    // If Figma isn't running, keep the server alive and show a stable tool surface.
    return { tools: FALLBACK_TOOLS, _error: describeFigmaConnectivityError(error) };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = request.params.arguments || {};
  try {
    const result = await client.toolsCall(tool, args);
    // Figma MCP tools typically return { content: [...] }. Preserve as-is.
    if (result && typeof result === "object" && Array.isArray(result.content)) return result;
    return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }] };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, describeFigmaConnectivityError(error));
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

