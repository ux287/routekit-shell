#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import { getComputedStyleTool } from "./tools/get-computed-style.mjs";
import { getElementInfoTool } from "./tools/get-element-info.mjs";

class BrowserDevToolsServer {
  constructor() {
    this.server = new Server(
      {
        name: "browser-devtools",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.browser = null;
    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // Register available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_computed_style",
            description: "Get computed CSS styles for an element on a web page",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL to navigate to (e.g., http://localhost:8080)" },
                selector: { type: "string", description: "CSS selector for the element (e.g., .hero-headline)" },
                properties: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional list of CSS properties to return (e.g., ['font-family', 'font-size'])"
                }
              },
              required: ["url", "selector"]
            }
          },
          {
            name: "get_element_info",
            description: "Get element metadata including tagName, classList, boundingBox, and key computed styles",
            inputSchema: {
              type: "object",
              properties: {
                url: { type: "string", description: "URL to navigate to (e.g., http://localhost:8080)" },
                selector: { type: "string", description: "CSS selector for the element (e.g., .hero-headline)" }
              },
              required: ["url", "selector"]
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Ensure browser is available
        if (!this.browser) {
          this.browser = await chromium.launch({ headless: true });
        }

        switch (name) {
          case "get_computed_style":
            return await getComputedStyleTool(this.browser, args);
          case "get_element_info":
            return await getElementInfoTool(this.browser, args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Browser DevTools MCP server running on stdio");
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

const server = new BrowserDevToolsServer();

// Cleanup on exit
process.on("SIGINT", async () => {
  await server.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await server.cleanup();
  process.exit(0);
});

server.start().catch(console.error);