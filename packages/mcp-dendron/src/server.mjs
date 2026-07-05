#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  resolveProjectRoot,
  resolveNotesDir,
  readNoteRaw,
  writeNoteRaw,
  frontmatterDefaults,
  formatWithFrontmatter,
  parseFrontmatter,
  validateNoteFrontmatter,
  canonicalIdFromFilename,
  findMatchingSchema,
  loadSchemaTemplate,
  mergeTemplateWithGenerated,
  updateField,
} from "./dendron.mjs";

const createNoteSchema = z.object({
  filename: z.string().describe("Dendron note filename, e.g. 'design.ui.buttons.md'"),
  title: z.string().optional(),
  desc: z.string().optional(),
  content: z.string().optional(),
});

const fixFrontmatterSchema = z.object({
  filename: z.string().describe("Dendron note filename under the notes/ vault"),
});

const readNoteSchema = z.object({
  filename: z.string().describe("Dendron note filename under the notes/ vault"),
});

const validateSchemaSchema = z.object({
  pattern: z.string().optional().describe("Glob pattern under notes/ (default: **/*.md)"),
});

const editNoteSchema = z.object({
  filename: z.string().describe("Dendron note filename to edit, e.g. 'backlog.apply-via-exec-only.md'"),
  content: z.string().describe("New markdown content (frontmatter will be preserved/updated automatically)"),
});

const updateFieldSchema = z.object({
  filename: z.string().describe("Dendron note filename, e.g. 'backlog.foo.md'"),
  field: z.string().describe("Field to update. Prefix with 'body.' for in-body patterns"),
  value: z.string().describe("New value for the field"),
});

const markImplementedSchema = z.object({
  filename: z.string().describe("Backlog note filename, e.g. 'backlog.foo.bar.md'"),
  commitId: z.string().optional().describe("Git commit hash for provenance tracking"),
});

function getContext() {
  const projectRoot = resolveProjectRoot();
  const notesDir = resolveNotesDir(projectRoot);
  return { projectRoot, notesDir };
}

function assertNotesDir(notesDir) {
  if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `notes directory not found: ${notesDir} (set ROUTEKIT_PROJECT_ROOT/ROUTEKIT_NOTES_DIR)`
    );
  }
}

function notePathFromFilename(notesDir, filename) {
  const safe = String(filename || "").trim();
  if (!safe || safe.includes("..") || safe.includes("/") || safe.includes("\\") || safe.includes("\n")) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid filename: ${filename}`);
  }
  return path.join(notesDir, safe.endsWith(".md") ? safe : `${safe}.md`);
}

const server = new Server(
  { name: "routekit-dendron", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "dendron_create_note",
      description: "Create a Dendron note with RouteKit-style frontmatter in the project notes vault.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string" },
          title: { type: "string" },
          desc: { type: "string" },
          content: { type: "string" },
        },
        required: ["filename"],
      },
    },
    {
      name: "dendron_fix_frontmatter",
      description: "Ensure a Dendron note has required frontmatter fields and correct id.",
      inputSchema: {
        type: "object",
        properties: { filename: { type: "string" } },
        required: ["filename"],
      },
    },
    {
      name: "dendron_validate_schema",
      description: "Validate frontmatter presence/required fields for notes under notes/.",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" } },
      },
    },
    {
      name: "dendron_edit_note",
      description: "Edit an existing Dendron note. Preserves frontmatter (id stays same, updated timestamp refreshed). Replaces the content body.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Note filename e.g. 'backlog.apply-via-exec-only.md'" },
          content: { type: "string", description: "New markdown content (frontmatter auto-preserved)" },
        },
        required: ["filename", "content"],
      },
    },
    {
      name: "dendron_read_note",
      description: "Read a Dendron note's content (frontmatter + body). Use before dendron_edit_note to get current content.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Note filename e.g. 'backlog.foo.md'" },
        },
        required: ["filename"],
      },
    },
    {
      name: "dendron_update_field",
      description: "Update a single field in a Dendron note (frontmatter or body pattern). Use for atomic status changes.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Note filename e.g. 'backlog.foo.md'" },
          field: { type: "string", description: "Field to update. Prefix with 'body.' for in-body patterns like **Status**" },
          value: { type: "string", description: "New value for the field" },
        },
        required: ["filename", "field", "value"],
      },
    },
    {
      name: "dendron_mark_implemented",
      description: "Mark a backlog story as implemented. Atomically updates status, adds commitId for provenance, and moves to z_implemented namespace.",
      inputSchema: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Backlog note filename e.g. 'backlog.foo.bar.md'" },
          commitId: { type: "string", description: "Git commit hash for provenance tracking" },
        },
        required: ["filename"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name;
  const args = request.params.arguments || {};
  const { notesDir } = getContext();
  assertNotesDir(notesDir);

  try {
    if (tool === "dendron_create_note") {
      const input = createNoteSchema.parse(args);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidRequest, `Note already exists: ${path.relative(notesDir, notePath)}`);
      }
      const id = canonicalIdFromFilename(input.filename);
      const generated = frontmatterDefaults({ id, title: input.title || null, desc: input.desc || null });
      const content = input.content || "";

      // Try to find a matching schema and apply its template if present
      const schema = findMatchingSchema(notesDir, input.filename);
      if (schema && schema.template) {
        const tpl = loadSchemaTemplate(notesDir, schema.template);
        if (tpl) {
          const { merged, body } = mergeTemplateWithGenerated({ generated, templateParsed: tpl.parsed, content, id });
          writeNoteRaw(notePath, formatWithFrontmatter(merged, body));
          
          // Verify file was actually persisted
          if (!fs.existsSync(notePath)) {
            throw new McpError(
              ErrorCode.InternalError,
              `File write reported success but file not found: ${notePath}`
            );
          }
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, path: path.relative(notesDir, notePath), id, schema: schema.id, verified: true }, null, 2),
              },
            ],
          };
        }
      }

      // Fallback: original behavior
      writeNoteRaw(notePath, formatWithFrontmatter(generated, content));
      
      // Verify file was actually persisted
      if (!fs.existsSync(notePath)) {
        throw new McpError(
          ErrorCode.InternalError,
          `File write reported success but file not found: ${notePath}`
        );
      }
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, path: path.relative(notesDir, notePath), id, verified: true }, null, 2),
          },
        ],
      };
    }

    if (tool === "dendron_fix_frontmatter") {
      const input = fixFrontmatterSchema.parse(args);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidParams, `Note not found: ${path.relative(notesDir, notePath)}`);
      }
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const id = canonicalIdFromFilename(input.filename);
      const next = {
        ...frontmatterDefaults({ id }),
        ...(parsed.data || {}),
        id,
        updated: Date.now(),
      };
      const out = formatWithFrontmatter(next, parsed.content || "");
      writeNoteRaw(notePath, out);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, path: path.relative(notesDir, notePath), id }, null, 2),
          },
        ],
      };
    }

    if (tool === "dendron_validate_schema") {
      const input = validateSchemaSchema.parse(args);
      const pattern = input.pattern && input.pattern.trim() ? input.pattern.trim() : "**/*.md";
      const { globSync } = await import("glob");
      const matches = globSync(pattern, { cwd: notesDir, nodir: true, dot: true }).sort();
      const results = matches.map((rel) => {
        const notePath = path.join(notesDir, rel);
        const raw = readNoteRaw(notePath);
        const validation = validateNoteFrontmatter(raw);
        return { path: rel, ...validation };
      });
      const ok = results.every((r) => r.ok);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok, count: results.length, results }, null, 2),
          },
        ],
      };
    }

    if (tool === "dendron_edit_note") {
      const input = editNoteSchema.parse(args);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidParams, `Note not found: ${path.relative(notesDir, notePath)}`);
      }
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const id = parsed.data?.id || canonicalIdFromFilename(input.filename);
      const next = {
        ...(parsed.data || {}),
        id,
        updated: Date.now(),
      };
      const out = formatWithFrontmatter(next, input.content);
      writeNoteRaw(notePath, out);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, path: path.relative(notesDir, notePath), id }, null, 2),
          },
        ],
      };
    }

if (tool === "dendron_read_note") {
      // Validate/normalize filename input
      const inputFilename = String((args && args.filename) || "").trim();
      if (!inputFilename) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: "Missing filename" }, null, 2),
            },
          ],
        };
      }

      try {
        const notePath = notePathFromFilename(notesDir, inputFilename);
        if (!fs.existsSync(notePath)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: `Note not found: ${path.relative(notesDir, notePath)}` }, null, 2),
              },
            ],
          };
        }

        const raw = readNoteRaw(notePath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, filename: inputFilename, content: raw }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2),
            },
          ],
        };
      }
    }

    if (tool === "dendron_update_field") {
      const input = updateFieldSchema.parse(args);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidParams, `Note not found: ${path.relative(notesDir, notePath)}`);
      }
      const result = updateField(notesDir, input.filename, input.field, input.value);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, path: path.relative(notesDir, notePath), ...result }, null, 2),
          },
        ],
      };
    }

    if (tool === "dendron_mark_implemented") {
      const input = markImplementedSchema.parse(args);
      const notePath = notePathFromFilename(notesDir, input.filename);
      if (!fs.existsSync(notePath)) {
        throw new McpError(ErrorCode.InvalidParams, `Note not found: ${path.relative(notesDir, notePath)}`);
      }
      // Validate backlog.* namespace (not already in z_implemented)
      if (!input.filename.startsWith("backlog.") || input.filename.startsWith("backlog.z_implemented.")) {
        throw new McpError(ErrorCode.InvalidParams, `Note must be in backlog.* namespace (not z_implemented): ${input.filename}`);
      }
      // Read and update frontmatter
      const raw = readNoteRaw(notePath);
      const parsed = parseFrontmatter(raw);
      const id = parsed.data?.id || canonicalIdFromFilename(input.filename);
      const next = {
        ...(parsed.data || {}),
        id,
        status: "implemented",
        updated: Date.now(),
      };
      if (input.commitId) {
        next.commitId = input.commitId;
      }
      const out = formatWithFrontmatter(next, parsed.content);
      writeNoteRaw(notePath, out);
      // Rename to z_implemented namespace
      const newFilename = input.filename.replace(/^backlog\./, "backlog.z_implemented.");
      const newPath = notePathFromFilename(notesDir, newFilename);
      fs.renameSync(notePath, newPath);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              oldPath: path.relative(notesDir, notePath),
              newPath: path.relative(notesDir, newPath),
              id,
              status: "implemented",
              commitId: input.commitId || null,
            }, null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InternalError, error?.message || String(error));
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

