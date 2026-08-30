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
import { homedir } from "os";
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { execSync } from "child_process";

// Log file for debugging
const LOG_FILE = join(homedir(), "Documents", "projects", ".routekit", "mcp-debug.log");

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} [DENDRON] ${message}\n`;
  console.error(message);
  try {
    appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    // Ignore file write errors
  }
}

// Project configuration
const PROJECT_ROOT = process.env.ROUTEKIT_PROJECT_ROOT || process.cwd();
const NOTES_DIR = join(PROJECT_ROOT, "notes");
const PROJECT_SLUG = "routekit-shell";

const server = new Server({
  name: `routekit-dendron-${PROJECT_SLUG}`,
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Utility functions
function generateFrontmatter(filename, customTitle = null, customDesc = null) {
  const id = basename(filename, '.md');
  const title = customTitle || generateTitleFromFilename(filename);
  const desc = customDesc || generateDescriptionFromId(id);
  const timestamp = new Date().toISOString();
  
  return `---
id: ${id}
title: ${title}
desc: ${desc}
updated: ${timestamp}
created: ${timestamp}
---

`;
}

function generateTitleFromFilename(filename) {
  const base = basename(filename, '.md');
  const parts = base.split('.');
  const lastPart = parts[parts.length - 1];
  return lastPart.charAt(0).toUpperCase() + lastPart.slice(1).replace(/-/g, ' ');
}

function generateDescriptionFromId(id) {
  const parts = id.split('.');
  return `Documentation for ${parts.join(' › ')}`;
}

function ensureNotesDir() {
  if (!existsSync(NOTES_DIR)) {
    mkdirSync(NOTES_DIR, { recursive: true });
    log(`📁 Created notes directory: ${NOTES_DIR}`);
  }
}

function createOrUpdateNote(filename, content, customTitle = null, customDesc = null) {
  ensureNotesDir();
  const fullPath = join(NOTES_DIR, filename);
  const frontmatter = generateFrontmatter(filename, customTitle, customDesc);
  const fullContent = frontmatter + content;
  
  if (existsSync(fullPath)) {
    const backup = `${fullPath}.bak.${Date.now()}`;
    copyFileSync(fullPath, backup);
    log(`📋 Backed up existing file to: ${backup}`);
  }
  
  writeFileSync(fullPath, fullContent, 'utf8');
  log(`📝 Created/updated note: ${fullPath}`);
  return fullPath;
}

function listNotes() {
  ensureNotesDir();
  const files = [];
  const readDir = (dir, prefix = '') => {
    const entries = require('fs').readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        readDir(fullPath, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith('.md')) {
        const stat = statSync(fullPath);
        files.push({
          name: `${prefix}${entry.name}`,
          path: fullPath,
          modified: stat.mtime,
          size: stat.size
        });
      }
    }
  };
  readDir(NOTES_DIR);
  return files.sort((a, b) => b.modified - a.modified);
}

// Tool schemas
const createNoteSchema = z.object({
  filename: z.string().min(1).describe("Note filename (e.g., 'project.feature.md')"),
  content: z.string().describe("Note content (markdown)"),
  title: z.string().optional().describe("Custom title (optional)"),
  description: z.string().optional().describe("Custom description (optional)")
});

const readNoteSchema = z.object({
  filename: z.string().min(1).describe("Note filename to read")
});

const updateNoteSchema = z.object({
  filename: z.string().min(1).describe("Note filename to update"),
  content: z.string().describe("New content (will replace entire file)"),
  title: z.string().optional().describe("Custom title (optional)"),
  description: z.string().optional().describe("Custom description (optional)")
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [
    {
      name: "dendron_create_note",
      description: "Create a new Dendron note with frontmatter",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Note filename (e.g., 'project.feature.md')",
            minLength: 1
          },
          content: {
            type: "string",
            description: "Note content (markdown)"
          },
          title: {
            type: "string",
            description: "Custom title (optional)"
          },
          description: {
            type: "string", 
            description: "Custom description (optional)"
          }
        },
        required: ["filename", "content"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_read_note",
      description: "Read an existing Dendron note",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Note filename to read",
            minLength: 1
          }
        },
        required: ["filename"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_update_note", 
      description: "Update an existing Dendron note",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Note filename to update",
            minLength: 1
          },
          content: {
            type: "string",
            description: "New content (will replace entire file)"
          },
          title: {
            type: "string",
            description: "Custom title (optional)"
          },
          description: {
            type: "string",
            description: "Custom description (optional)"
          }
        },
        required: ["filename", "content"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_list_notes",
      description: "List all notes in the vault",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  ];
  log(`🔧 Returning ${tools.length} tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "dendron_create_note": {
        const input = createNoteSchema.parse(args || {});
        const filePath = createOrUpdateNote(input.filename, input.content, input.title, input.description);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Note created: ${input.filename}`,
                path: filePath
              }, null, 2),
            },
          ],
        };
      }

      case "dendron_read_note": {
        const input = readNoteSchema.parse(args || {});
        const filePath = join(NOTES_DIR, input.filename);
        
        if (!existsSync(filePath)) {
          throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${input.filename}`);
        }
        
        const content = readFileSync(filePath, 'utf8');
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                filename: input.filename,
                path: filePath,
                content: content
              }, null, 2),
            },
          ],
        };
      }

      case "dendron_update_note": {
        const input = updateNoteSchema.parse(args || {});
        const filePath = join(NOTES_DIR, input.filename);
        
        if (!existsSync(filePath)) {
          throw new McpError(ErrorCode.InvalidRequest, `Note not found: ${input.filename}`);
        }
        
        const updatedPath = createOrUpdateNote(input.filename, input.content, input.title, input.description);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Note updated: ${input.filename}`,
                path: updatedPath
              }, null, 2),
            },
          ],
        };
      }

      case "dendron_list_notes": {
        const notes = listNotes();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: notes.length,
                notes: notes
              }, null, 2),
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
  const port = process.env.PORT || 3002;
  log(`🚀 Starting Dendron MCP HTTP Server on port ${port}...`);
  
  const transport = new SSEServerTransport("/mcp", {
    port: port,
  });
  
  log("📡 Created HTTP/SSE transport");
  await server.connect(transport);
  log(`✅ Dendron MCP Server connected on http://localhost:${port}/mcp`);
  log(`📍 Server name: routekit-dendron-${PROJECT_SLUG}`);
  log("🔧 Available tools: dendron_create_note, dendron_read_note, dendron_update_note, dendron_list_notes");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});