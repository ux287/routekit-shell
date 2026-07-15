#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { homedir } from "os";
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, statSync, readdirSync } from "fs";
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
---`;
}

function generateTitleFromFilename(filename) {
  const segments = basename(filename, '.md').split('.');
  const lastSegment = segments[segments.length - 1];
  const cleanSegment = lastSegment.replace(/^\d+-/, '');
  
  return cleanSegment
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function generateDescriptionFromId(id) {
  // Domain-based patterns (no project-specific prefixes)
  if (id.startsWith('design.')) return 'Design system and UI documentation';
  if (id.startsWith('workflow.')) return 'Development workflow and process documentation';
  if (id.startsWith('getting-started.')) return 'Getting started guide and onboarding documentation';
  if (id.startsWith('project-structure.')) return 'Project architecture and structure documentation';
  if (id.startsWith('templates.')) return 'Template and scaffolding documentation';
  if (id.startsWith('cli.')) return 'Command-line interface documentation';
  if (id.startsWith('hub.')) return 'Project hub and dashboard documentation';
  if (id.startsWith('mcp.')) return 'Model Context Protocol server documentation';
  if (id.startsWith('rag.')) return 'Retrieval-Augmented Generation system documentation';
  if (id.startsWith('assets.')) return 'Asset management and media documentation';
  if (id.startsWith('troubleshooting.')) return 'Troubleshooting guides and debugging documentation';
  if (id.startsWith('notes.')) return 'Notes and documentation patterns';
  
  // Check for sub-domain patterns
  if (id.includes('.getting-started.')) return 'Getting started guide and onboarding information';
  if (id.includes('.project-structure.')) return 'Project architecture and structure information';
  if (id.includes('.workflow.')) return 'Development workflow and process information';
  if (id.includes('.design-system.')) return 'Design system and component documentation';
  if (id.includes('.templates.')) return 'Template and scaffolding information';
  if (id.includes('.cli.')) return 'Command-line interface information';
  if (id.includes('.hub.')) return 'Project hub and dashboard information';
  if (id.includes('.mcp.')) return 'Model Context Protocol information';
  if (id.includes('.rag.')) return 'Retrieval-Augmented Generation system information';
  if (id.includes('.prompt-library.')) return 'Prompt library and AI assistance patterns';
  
  return 'Project documentation and information';
}

function hasFrontmatter(content) {
  return content.trimStart().startsWith('---');
}

// Schema template helpers
function parseFrontmatter(content) {
  // Simple frontmatter parser (no gray-matter dependency)
  const trimmed = String(content || '').trim();
  if (!trimmed.startsWith('---')) return { data: {}, content: trimmed };
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return { data: {}, content: trimmed };
  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();
  // Parse simple YAML (key: value pairs)
  const data = {};
  for (const line of yamlBlock.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Handle arrays like []
      if (value === '[]') value = [];
      else if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      data[match[1]] = value;
    }
  }
  return { data, content: body };
}

function findMatchingSchema(notesDir, filename) {
  try {
    // Match both naming conventions: *.schema.yml AND schema.*.yml
    const candidates = (readdirSync(notesDir) || []).filter((f) =>
      f.endsWith(".schema.yml") || f.startsWith("schema.")
    );
    for (const f of candidates) {
      const p = join(notesDir, f);
      const raw = String(readFileSync(p, "utf8") || "");
      const idMatch = raw.match(/^[\s-]*id:\s*([\w.\-]+)/mi);
      // Check both top-level namespace AND data.namespace (Dendron native format)
      const nsMatchTop = raw.match(/^[\s-]*namespace:\s*(true|false)/mi);
      const nsMatchData = raw.match(/data:\s*\n\s*namespace:\s*(true|false)/mi);
      const namespace = (nsMatchTop && nsMatchTop[1] === "true") ||
                        (nsMatchData && nsMatchData[1] === "true");

      // Check for template - could be string ref OR inline object
      const templateStringMatch = raw.match(/^\s*template:\s*([\w.\-]+)\s*$/mi);
      const templateObjectMatch = raw.match(/^\s*template:\s*\n/mi);

      let template = null;
      let inlineTemplate = null;

      if (templateStringMatch) {
        // External template reference: template: templates.backlog
        template = templateStringMatch[1].trim();
      } else if (templateObjectMatch) {
        // Inline template object - extract body
        const bodyMatch = raw.match(/template:\s*\n(?:.*\n)*?\s*body:\s*\|\s*\n([\s\S]*?)(?=\n\s*schema:|\n\s*children:|\n\s*-\s*id:|\n[a-z]+:|\Z)/i);
        if (bodyMatch) {
          // Dedent the body content
          const bodyLines = bodyMatch[1].split('\n');
          const minIndent = bodyLines.filter(l => l.trim()).reduce((min, l) => {
            const indent = l.match(/^(\s*)/)[1].length;
            return Math.min(min, indent);
          }, Infinity);
          inlineTemplate = bodyLines.map(l => l.slice(minIndent)).join('\n').trim();
        }
      }

      // Extract schema defaults from schema: section (Dendron native format)
      const schemaDefaults = {};
      const schemaSection = raw.match(/\n\s*schema:\s*\n([\s\S]*?)$/i);
      if (schemaSection) {
        // Look for properties with defaults
        const propsMatch = schemaSection[1].match(/properties:\s*\n([\s\S]*)/i);
        if (propsMatch) {
          // Parse each property for default values
          const propMatches = propsMatch[1].matchAll(/(\w+):\s*\n(?:.*\n)*?\s*default:\s*(.+)/gi);
          for (const m of propMatches) {
            const propName = m[1];
            let defaultVal = m[2].trim();
            // Parse the default value
            if (defaultVal === '[]') defaultVal = [];
            else if (defaultVal === 'true') defaultVal = true;
            else if (defaultVal === 'false') defaultVal = false;
            else if (defaultVal.startsWith('[') && defaultVal.endsWith(']')) {
              try { defaultVal = JSON.parse(defaultVal); } catch (e) { /* keep as string */ }
            }
            schemaDefaults[propName] = defaultVal;
          }
        }
      }

      const id = idMatch ? String(idMatch[1]).trim() : null;
      if (!id) continue;
      const fnameBase = basename(filename, '.md');
      if (namespace && (fnameBase === id || fnameBase.startsWith(`${id}.`))) {
        return { id, template, inlineTemplate, schemaDefaults, path: p };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

function loadSchemaTemplate(notesDir, templateRef, inlineTemplate, schemaDefaults) {
  try {
    // Handle inline template from Dendron native format
    if (inlineTemplate) {
      return {
        templatePath: null,
        inline: true,
        parsed: {
          data: schemaDefaults || {},  // Schema-level defaults (status, targetFiles, etc.)
          content: inlineTemplate
        }
      };
    }

    // Handle external template file reference
    if (!templateRef) return null;
    const templateId = typeof templateRef === "string" ? templateRef : null;
    if (!templateId) return null;
    const templatePath = join(notesDir, `${templateId}.md`);
    if (!existsSync(templatePath)) return null;
    const raw = readFileSync(templatePath, "utf8");
    return { templatePath, inline: false, parsed: parseFrontmatter(raw) };
  } catch (err) {
    return null;
  }
}

function mergeTemplateWithGenerated(generated, templateParsed, content, id) {
  const tmplFm = (templateParsed && templateParsed.data) || {};
  const tmplBody = (templateParsed && templateParsed.content) || "";
  // Merge: template fields first, then generated fields (generated wins for id/title/desc/dates)
  const merged = { ...tmplFm, ...generated };
  merged.id = id;
  // Body: if content provided, it REPLACES template body; otherwise use template body (placeholders)
  const body = (content && String(content).trim())
    ? String(content).trim()
    : (tmplBody && String(tmplBody).trim()) || "";
  return { merged, body };
}

function validateFrontmatter(content, filename = 'unknown') {
  const result = {
    valid: false,
    error: null,
    details: {
      filename,
      issues: [],
      foundFields: {},
      missingFields: [],
      invalidFields: [],
      lineAnalysis: []
    }
  };

  if (!hasFrontmatter(content)) {
    result.error = 'Missing frontmatter block';
    result.details.issues.push({
      type: 'missing_frontmatter',
      severity: 'error',
      message: 'File does not start with YAML frontmatter (---)',
      suggestion: 'Add YAML frontmatter block at the beginning of the file'
    });
    return result;
  }

  try {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      result.error = 'Malformed frontmatter block';
      result.details.issues.push({
        type: 'malformed_block',
        severity: 'error',
        message: 'Frontmatter block not properly closed with ---',
        suggestion: 'Ensure frontmatter starts and ends with --- on separate lines'
      });
      return result;
    }

    const frontmatterContent = frontmatterMatch[1];
    const lines = frontmatterContent.split('\n');
    const requiredFields = ['id', 'title', 'desc', 'updated', 'created'];
    
    // Analyze each line
    lines.forEach((line, index) => {
      const lineNum = index + 2; // +2 because of opening --- line
      const analysis = {
        lineNumber: lineNum,
        content: line.trim(),
        issues: []
      };
      
      if (line.trim() === '') {
        analysis.type = 'empty';
      } else if (line.match(/^\s*#/)) {
        analysis.type = 'comment';
      } else {
        const fieldMatch = line.match(/^\s*(\w+):\s*(.*)$/);
        if (fieldMatch) {
          const [, fieldName, fieldValue] = fieldMatch;
          analysis.type = 'field';
          analysis.fieldName = fieldName;
          analysis.fieldValue = fieldValue;
          
          result.details.foundFields[fieldName] = fieldValue;
          
          // Check for unquoted special characters in YAML
          if (fieldValue && !fieldValue.match(/^["']/) && fieldValue.includes(':')) {
            analysis.issues.push({
              type: 'yaml_syntax',
              severity: 'warning',
              message: `Field value contains ':' but is not quoted`,
              suggestion: `Quote the value: ${fieldName}: "${fieldValue}"`
            });
          }
          
          // Validate timestamp fields specifically
          if (['updated', 'created'].includes(fieldName)) {
            if (fieldValue.match(/^\d{13}$/)) {
              // Unix timestamp - valid but not preferred
              analysis.issues.push({
                type: 'timestamp_format',
                severity: 'info',
                message: 'Using Unix timestamp format',
                suggestion: 'Consider using ISO 8601 format for better readability'
              });
            } else if (fieldValue.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)) {
              // ISO format - check if quoted properly
              if (!fieldValue.match(/^["']/)) {
                analysis.issues.push({
                  type: 'yaml_quotes',
                  severity: 'error',
                  message: 'ISO timestamp should be quoted in YAML',
                  suggestion: `${fieldName}: "${fieldValue}"`,
                  expected: `"${fieldValue}"`,
                  actual: fieldValue
                });
              }
            } else if (fieldValue && !fieldValue.match(/^["']?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z["']?$/)) {
              analysis.issues.push({
                type: 'invalid_timestamp',
                severity: 'error',
                message: `Invalid timestamp format for ${fieldName}`,
                suggestion: 'Use ISO 8601 format: "2025-08-26T22:15:19.664Z"',
                expected: '"2025-08-26T22:15:19.664Z"',
                actual: fieldValue
              });
            }
          }
        } else {
          analysis.type = 'invalid';
          analysis.issues.push({
            type: 'invalid_syntax',
            severity: 'error',
            message: 'Line does not match YAML field syntax',
            suggestion: 'Use format: fieldName: fieldValue'
          });
        }
      }
      
      result.details.lineAnalysis.push(analysis);
    });

    // Check for missing required fields
    for (const field of requiredFields) {
      if (!result.details.foundFields[field]) {
        result.details.missingFields.push(field);
        result.details.issues.push({
          type: 'missing_field',
          severity: 'error',
          message: `Missing required field: ${field}`,
          suggestion: `Add ${field}: <appropriate_value>`
        });
      }
    }

    // Collect all issues from line analysis
    result.details.lineAnalysis.forEach(line => {
      if (line.issues && line.issues.length > 0) {
        line.issues.forEach(issue => {
          result.details.issues.push({
            ...issue,
            lineNumber: line.lineNumber,
            lineContent: line.content
          });
        });
      }
    });

    // Determine overall validity
    const hasErrors = result.details.issues.some(issue => issue.severity === 'error');
    result.valid = !hasErrors;
    
    if (hasErrors) {
      const errorCount = result.details.issues.filter(issue => issue.severity === 'error').length;
      result.error = `Found ${errorCount} error${errorCount > 1 ? 's' : ''} in frontmatter`;
    }

    return result;
  } catch (error) {
    result.error = `Parsing error: ${error.message}`;
    result.details.issues.push({
      type: 'parse_exception',
      severity: 'error',
      message: error.message,
      suggestion: 'Check for syntax errors in YAML frontmatter'
    });
    return result;
  }
}

// Tool schemas
const createNoteSchema = z.object({
  filename: z.string().describe("Note filename (e.g. 'design.ui-system.components.md' or 'workflow.deployment.md')"),
  title: z.string().optional().describe("Custom title (optional - will generate from filename)"),
  desc: z.string().optional().describe("Custom description (optional - will generate from namespace)"),
  content: z.string().default("").describe("Initial note content (optional)")
});

const reloadIndexSchema = z.object({
  workspace: z.string().optional().describe("VS Code workspace path (optional)")
});

const validateSchemaSchema = z.object({
  pattern: z.string().default("routekit-shell.*.md").describe("Glob pattern for files to validate")
});

const fixFrontmatterSchema = z.object({
  filename: z.string().describe("Specific file to fix frontmatter")
});

const bulkFixFrontmatterSchema = z.object({
  pattern: z.string().default("routekit-shell.*.md").describe("Glob pattern for files to fix"),
  dryRun: z.boolean().default(false).describe("Preview changes without applying them")
});

const refactorHierarchySchema = z.object({
  oldNamespace: z.string().describe("Old namespace pattern (e.g., 'routekit-shell.old.pattern')"),
  newNamespace: z.string().describe("New namespace pattern (e.g., 'routekit-shell.new.pattern')"),
  pattern: z.string().optional().describe("File pattern to match (defaults to oldNamespace + '*.md')"),
  dryRun: z.boolean().default(false).describe("Preview changes without applying them")
});

const importAssetSchema = z.object({
  sourcePath: z.string().describe("Absolute path to the external asset file"),
  targetNamespace: z.string().describe("Dendron namespace (e.g., 'assets.images.logo')"),
  description: z.string().optional().describe("Asset description for the markdown wrapper")
});

const doctorBrokenLinksSchema = z.object({
  fixBrokenLinks: z.boolean().default(false).describe("Automatically attempt to fix broken links found")
});

const editNoteSchema = z.object({
  filename: z.string().describe("Dendron note filename to edit (e.g. 'backlog.apply-via-exec-only.md')"),
  content: z.string().describe("New markdown content (frontmatter will be preserved/updated automatically)")
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [
    {
      name: "dendron_create_note",
      description: "Create a new Dendron note with proper frontmatter following RouteKit Shell standards.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Note filename (e.g. 'design.ui-system.components.md' or 'workflow.deployment.md')"
          },
          title: {
            type: "string",
            description: "Custom title (optional - will generate from filename)"
          },
          desc: {
            type: "string", 
            description: "Custom description (optional - will generate from namespace)"
          },
          content: {
            type: "string",
            description: "Initial note content (optional)",
            default: ""
          }
        },
        required: ["filename"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_reload_index",
      description: "Reload Dendron index to refresh transclusion references and schema recognition.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description: "VS Code workspace path (optional)"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "dendron_validate_schema",
      description: "Validate frontmatter and detect parsing errors in Dendron notes.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern for files to validate",
            default: "routekit-shell.*.md"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "dendron_fix_frontmatter",
      description: "Fix frontmatter for a specific file with proper ID and timestamp format.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Specific file to fix frontmatter"
          }
        },
        required: ["filename"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_bulk_fix_frontmatter", 
      description: "Fix frontmatter for multiple files matching a pattern.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob pattern for files to fix",
            default: "routekit-shell.*.md"
          },
          dryRun: {
            type: "boolean",
            description: "Preview changes without applying them",
            default: false
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "dendron_refactor_hierarchy",
      description: "Refactor Dendron namespace hierarchy by renaming files and updating IDs.",
      inputSchema: {
        type: "object",
        properties: {
          oldNamespace: {
            type: "string",
            description: "Old namespace pattern (e.g., 'routekit-shell.old.pattern')"
          },
          newNamespace: {
            type: "string", 
            description: "New namespace pattern (e.g., 'routekit-shell.new.pattern')"
          },
          pattern: {
            type: "string",
            description: "File pattern to match (defaults to oldNamespace + '*.md')"
          },
          dryRun: {
            type: "boolean",
            description: "Preview changes without applying them",
            default: false
          }
        },
        required: ["oldNamespace", "newNamespace"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_import_asset",
      description: "Import an external asset file into Dendron assets schema with proper naming and transclusion.",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: {
            type: "string",
            description: "Absolute path to the external asset file"
          },
          targetNamespace: {
            type: "string",
            description: "Dendron namespace (e.g., 'assets.images.logo')"
          },
          description: {
            type: "string",
            description: "Asset description for the markdown wrapper"
          }
        },
        required: ["sourcePath", "targetNamespace"],
        additionalProperties: false
      }
    },
    {
      name: "dendron_doctor_broken_links",
      description: "Run Dendron doctor to find broken links and optionally fix them automatically.",
      inputSchema: {
        type: "object",
        properties: {
          fixBrokenLinks: {
            type: "boolean",
            description: "Automatically attempt to fix broken links found",
            default: false
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "dendron_edit_note",
      description: "Edit an existing Dendron note. Preserves frontmatter (id stays same, updated timestamp refreshed). Replaces the content body.",
      inputSchema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "Note filename (e.g. 'backlog.apply-via-exec-only.md')"
          },
          content: {
            type: "string",
            description: "New markdown content (frontmatter auto-preserved)"
          }
        },
        required: ["filename", "content"],
        additionalProperties: false
      }
    }
  ];

  log(`🔧 Returning ${tools.length} Dendron tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "dendron_create_note": {
        const input = createNoteSchema.parse(args || {});
        const filePath = join(NOTES_DIR, input.filename);

        // Check if file already exists
        if (existsSync(filePath)) {
          throw new McpError(ErrorCode.InvalidParams, `File already exists: ${input.filename}`);
        }

        // Ensure notes directory exists
        mkdirSync(dirname(filePath), { recursive: true });

        const id = basename(input.filename, '.md');
        const generatedFm = {
          id,
          title: input.title || generateTitleFromFilename(input.filename),
          desc: input.desc || generateDescriptionFromId(id),
          updated: new Date().toISOString(),
          created: new Date().toISOString(),
        };

        // Check for matching schema and apply template if found
        const schema = findMatchingSchema(NOTES_DIR, input.filename);
        let fullContent;
        let appliedSchema = null;

        if (schema && (schema.template || schema.inlineTemplate)) {
          const tpl = loadSchemaTemplate(NOTES_DIR, schema.template, schema.inlineTemplate, schema.schemaDefaults);
          if (tpl) {
            const { merged, body } = mergeTemplateWithGenerated(generatedFm, tpl.parsed, input.content || '', id);
            const fmLines = Object.entries(merged).map(([k, v]) => {
              if (Array.isArray(v)) return `${k}: []`;
              if (typeof v === 'boolean') return `${k}: ${v}`;
              return `${k}: ${v}`;
            });
            fullContent = `---\n${fmLines.join('\n')}\n---\n\n${body}`;
            appliedSchema = schema.id;
            log(`📋 Applied schema template: ${schema.id} -> ${tpl.inline ? 'inline' : schema.template}`);
          }
        }

        // Fallback: original behavior if no template
        if (!fullContent) {
          const frontmatter = generateFrontmatter(input.filename, input.title, input.desc);
          fullContent = input.content
            ? `${frontmatter}\n\n${input.content}`
            : `${frontmatter}\n\n${input.content || ''}`;
        }

        // Write file
        writeFileSync(filePath, fullContent, 'utf-8');

        log(`✅ Created note: ${input.filename}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filename: input.filename,
                path: filePath,
                schema: appliedSchema,
                message: appliedSchema
                  ? `Note created with schema template: ${appliedSchema}`
                  : "Note created successfully with proper frontmatter"
              }, null, 2)
            }
          ]
        };
      }

      case "dendron_reload_index": {
        const input = reloadIndexSchema.parse(args || {});
        
        try {
          // Try to trigger VS Code command via AppleScript (macOS only)
          const script = `
            tell application "Visual Studio Code"
              activate
              delay 0.5
            end tell
            
            tell application "System Events"
              keystroke "p" using {command down, shift down}
              delay 0.5
              keystroke "Dendron: Reload Index"
              delay 0.5
              keystroke return
            end tell
          `;
          
          execSync(`osascript -e '${script}'`, { timeout: 10000 });
          
          log("✅ Triggered Dendron: Reload Index via AppleScript");
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  method: "AppleScript automation",
                  message: "Dendron index reload triggered successfully"
                }, null, 2)
              }
            ]
          };
        } catch (error) {
          log(`⚠️ AppleScript failed: ${error.message}`);
          
          return {
            content: [
              {
                type: "text", 
                text: JSON.stringify({
                  success: false,
                  message: "Could not automatically reload Dendron index. Please manually run 'Dendron: Reload Index' in VS Code command palette.",
                  instruction: "Press Cmd+Shift+P, then type 'Dendron: Reload Index' and press Enter"
                }, null, 2)
              }
            ]
          };
        }
      }

      case "dendron_validate_schema": {
        const input = validateSchemaSchema.parse(args || {});
        const { globSync } = await import('glob');
        
        const pattern = join(NOTES_DIR, input.pattern);
        const files = globSync(pattern);
        
        const results = {
          totalFiles: files.length,
          validFiles: [],
          invalidFiles: [],
          detailedResults: [],
          summary: {
            totalIssues: 0,
            errorCount: 0,
            warningCount: 0,
            infoCount: 0
          },
          errors: []
        };

        for (const filePath of files) {
          const filename = basename(filePath);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const validation = validateFrontmatter(content, filename);
            
            if (validation.valid) {
              results.validFiles.push(filename);
              results.detailedResults.push({
                filename,
                status: 'valid',
                issues: []
              });
            } else {
              results.invalidFiles.push({
                filename,
                error: validation.error,
                issueCount: validation.details.issues.length,
                errorCount: validation.details.issues.filter(i => i.severity === 'error').length,
                warningCount: validation.details.issues.filter(i => i.severity === 'warning').length
              });
              
              // Add to detailed results with full diagnostic information
              results.detailedResults.push({
                filename,
                status: 'invalid',
                error: validation.error,
                details: validation.details,
                actionableIssues: validation.details.issues.map(issue => ({
                  type: issue.type,
                  severity: issue.severity,
                  line: issue.lineNumber,
                  message: issue.message,
                  suggestion: issue.suggestion,
                  expected: issue.expected,
                  actual: issue.actual
                }))
              });
              
              // Update summary counts
              validation.details.issues.forEach(issue => {
                results.summary.totalIssues++;
                if (issue.severity === 'error') results.summary.errorCount++;
                if (issue.severity === 'warning') results.summary.warningCount++;
                if (issue.severity === 'info') results.summary.infoCount++;
              });
            }
          } catch (error) {
            results.errors.push({
              filename,
              error: `Failed to read file: ${error.message}`
            });
          }
        }

        log(`📊 Validated ${results.totalFiles} files: ${results.validFiles.length} valid, ${results.invalidFiles.length} invalid (${results.summary.errorCount} errors, ${results.summary.warningCount} warnings)`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      }

      case "dendron_fix_frontmatter": {
        const input = fixFrontmatterSchema.parse(args || {});
        const filePath = join(NOTES_DIR, input.filename);

        if (!existsSync(filePath)) {
          throw new McpError(ErrorCode.InvalidParams, `File not found: ${input.filename}`);
        }

        const content = readFileSync(filePath, 'utf-8');
        const beforeValidation = validateFrontmatter(content, input.filename);
        let newContent;

        if (hasFrontmatter(content)) {
          // Fix existing frontmatter
          const id = basename(input.filename, '.md');
          const title = generateTitleFromFilename(input.filename);
          const desc = generateDescriptionFromId(id);
          const timestamp = new Date().toISOString();

          // Replace frontmatter block
          newContent = content.replace(
            /^---\s*\n[\s\S]*?\n---/,
            `---
id: ${id}
title: ${title}  
desc: ${desc}
updated: ${timestamp}
created: ${timestamp}
---`
          );
        } else {
          // Add frontmatter to file without it
          const frontmatter = generateFrontmatter(input.filename);
          newContent = `${frontmatter}\n\n${content}`;
        }

        writeFileSync(filePath, newContent, 'utf-8');
        
        // Validate after fix
        const afterValidation = validateFrontmatter(newContent, input.filename);
        
        log(`🔧 Fixed frontmatter: ${input.filename} - ${beforeValidation.details.issues.length} issues → ${afterValidation.details.issues.length} issues`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filename: input.filename,
                message: "Frontmatter fixed successfully",
                before: {
                  valid: beforeValidation.valid,
                  issueCount: beforeValidation.details.issues.length,
                  issues: beforeValidation.details.issues
                },
                after: {
                  valid: afterValidation.valid,
                  issueCount: afterValidation.details.issues.length,
                  issues: afterValidation.details.issues
                },
                improvements: beforeValidation.details.issues.length - afterValidation.details.issues.length
              }, null, 2)
            }
          ]
        };
      }

      case "dendron_bulk_fix_frontmatter": {
        const input = bulkFixFrontmatterSchema.parse(args || {});
        const { globSync } = await import('glob');
        
        const pattern = join(NOTES_DIR, input.pattern);
        const files = globSync(pattern);
        
        const results = {
          totalFiles: files.length,
          processedFiles: [],
          skippedFiles: [],
          errors: []
        };

        for (const filePath of files) {
          const filename = basename(filePath);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const validation = validateFrontmatter(content, filename);
            
            if (validation.valid) {
              results.skippedFiles.push({
                filename,
                status: 'valid',
                issueCount: 0
              });
              continue;
            }

            if (input.dryRun) {
              results.processedFiles.push({
                filename,
                action: "would_fix",
                currentIssues: validation.details.issues.length,
                issueBreakdown: {
                  errors: validation.details.issues.filter(i => i.severity === 'error').length,
                  warnings: validation.details.issues.filter(i => i.severity === 'warning').length,
                  info: validation.details.issues.filter(i => i.severity === 'info').length
                },
                issues: validation.details.issues.map(issue => ({
                  line: issue.lineNumber,
                  type: issue.type,
                  severity: issue.severity,
                  message: issue.message,
                  suggestion: issue.suggestion
                }))
              });
            } else {
              // Fix the file
              let newContent;
              if (hasFrontmatter(content)) {
                const id = basename(filename, '.md');
                const title = generateTitleFromFilename(filename);
                const desc = generateDescriptionFromId(id);
                const timestamp = new Date().toISOString();

                newContent = content.replace(
                  /^---\s*\n[\s\S]*?\n---/,
                  `---
id: ${id}
title: ${title}
desc: ${desc}
updated: ${timestamp}
created: ${timestamp}
---`
                );
              } else {
                const frontmatter = generateFrontmatter(filename);
                newContent = `${frontmatter}\n\n${content}`;
              }

              writeFileSync(filePath, newContent, 'utf-8');
              
              // Validate after fix
              const afterValidation = validateFrontmatter(newContent, filename);
              
              results.processedFiles.push({
                filename,
                action: "fixed",
                before: {
                  valid: validation.valid,
                  issueCount: validation.details.issues.length,
                  issues: validation.details.issues
                },
                after: {
                  valid: afterValidation.valid,
                  issueCount: afterValidation.details.issues.length,
                  issues: afterValidation.details.issues
                },
                improvements: validation.details.issues.length - afterValidation.details.issues.length
              });
            }
          } catch (error) {
            results.errors.push({
              filename,
              error: error.message
            });
          }
        }

        log(`🔧 Bulk frontmatter fix: ${results.processedFiles.length} processed, ${results.skippedFiles.length} skipped`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      }

      case "dendron_refactor_hierarchy": {
        const input = refactorHierarchySchema.parse(args || {});
        const { globSync } = await import('glob');
        const { renameSync } = await import('fs');
        
        // Determine pattern
        const searchPattern = input.pattern || `${input.oldNamespace}*.md`;
        const pattern = join(NOTES_DIR, searchPattern);
        const files = globSync(pattern);
        
        const results = {
          totalFiles: files.length,
          operations: [],
          errors: []
        };

        for (const filePath of files) {
          const filename = basename(filePath);
          const oldId = basename(filename, '.md');
          
          // Generate new filename and ID
          const newId = oldId.replace(input.oldNamespace, input.newNamespace);
          const newFilename = `${newId}.md`;
          const newFilePath = join(NOTES_DIR, newFilename);

          try {
            if (input.dryRun) {
              results.operations.push({
                oldFile: filename,
                newFile: newFilename,
                oldId: oldId,
                newId: newId,
                action: "would_rename"
              });
            } else {
              // Read file content
              const content = readFileSync(filePath, 'utf-8');
              
              // Update frontmatter ID
              const updatedContent = content.replace(
                /^id: (.+)$/m,
                `id: ${newId}`
              );
              
              // Update any internal transclusion references
              const finalContent = updatedContent.replace(
                new RegExp(`!\\[\\[${input.oldNamespace}`, 'g'),
                `![[${input.newNamespace}`
              );
              
              // Write new file
              writeFileSync(newFilePath, finalContent, 'utf-8');
              
              // Remove old file
              if (filePath !== newFilePath) {
                renameSync(filePath, filePath + '.bak');
              }
              
              results.operations.push({
                oldFile: filename,
                newFile: newFilename,
                oldId: oldId,
                newId: newId,
                action: "renamed"
              });
            }
          } catch (error) {
            results.errors.push({
              filename,
              error: error.message
            });
          }
        }

        log(`🔄 Hierarchy refactor: ${results.operations.length} files processed, ${results.errors.length} errors`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2)
            }
          ]
        };
      }

      case "dendron_import_asset": {
        const input = importAssetSchema.parse(args || {});
        
        // Validate source file exists
        if (!existsSync(input.sourcePath)) {
          throw new McpError(ErrorCode.InvalidParams, `Source file not found: ${input.sourcePath}`);
        }

        // Get file information
        const sourceStats = statSync(input.sourcePath);
        const sourceBasename = basename(input.sourcePath);
        const sourceExt = extname(input.sourcePath);
        const sourceNameWithoutExt = basename(input.sourcePath, sourceExt);
        
        // Generate target paths
        const markdownPath = join(NOTES_DIR, `${input.targetNamespace}.md`);
        const assetFileName = `${input.targetNamespace}.${sourceNameWithoutExt}${sourceExt}`;
        const assetPath = join(NOTES_DIR, assetFileName);

        // Check if files already exist
        if (existsSync(markdownPath)) {
          throw new McpError(ErrorCode.InvalidParams, `Target markdown file already exists: ${input.targetNamespace}.md`);
        }
        if (existsSync(assetPath)) {
          throw new McpError(ErrorCode.InvalidParams, `Target asset file already exists: ${assetFileName}`);
        }

        // Copy the asset file
        copyFileSync(input.sourcePath, assetPath);
        
        // Determine asset type and format
        const assetType = sourceExt.slice(1).toLowerCase();
        const assetTypeCategory = ['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(assetType) ? 'image' :
                                 ['mp4', 'mov', 'avi'].includes(assetType) ? 'video' : 
                                 assetType === 'pdf' ? 'document' : 'other';
        
        // Format file size
        const sizeInMB = (sourceStats.size / (1024 * 1024)).toFixed(2);
        const formattedSize = sizeInMB < 1 ? `${(sourceStats.size / 1024).toFixed(1)}KB` : `${sizeInMB}MB`;

        // Generate frontmatter with asset-specific fields
        const timestamp = new Date().toISOString();
        const title = generateTitleFromFilename(`${input.targetNamespace}.md`);
        const description = input.description || `Asset documentation for ${sourceBasename}`;
        
        const frontmatter = `---
id: ${input.targetNamespace}
title: ${title}
desc: ${description}
type: ${assetTypeCategory}
format: ${assetType}
size: ${formattedSize}
asset_file: ${assetFileName}
original_path: ${input.sourcePath}
updated: ${timestamp}
created: ${timestamp}
---`;

        // Generate markdown content with transclusion
        const markdownContent = `${frontmatter}

# ${title}

![[${assetFileName}]]

## Asset Information
${description}

## Usage Context
Where and how this asset is used in documentation

## Source
Original file: \`${input.sourcePath}\`
Imported: ${new Date().toLocaleDateString()}

## Related Documentation
Links to documents that reference or use this asset`;

        // Write markdown file
        writeFileSync(markdownPath, markdownContent, 'utf-8');
        
        log(`✅ Imported asset: ${sourceBasename} → ${input.targetNamespace}`);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                sourcePath: input.sourcePath,
                targetNamespace: input.targetNamespace,
                markdownFile: `${input.targetNamespace}.md`,
                assetFile: assetFileName,
                assetType: assetTypeCategory,
                fileSize: formattedSize,
                message: "Asset imported successfully with markdown wrapper and transclusion"
              }, null, 2)
            }
          ]
        };
      }

      case "dendron_doctor_broken_links": {
        const input = doctorBrokenLinksSchema.parse(args || {});
        
        try {
          // Run Dendron Doctor via AppleScript to get broken links output
          const script = `
            tell application "Visual Studio Code"
              activate
              delay 0.5
            end tell
            
            tell application "System Events"
              keystroke "p" using {command down, shift down}
              delay 0.5
              keystroke "Dendron: Doctor"
              delay 0.5
              keystroke return
              delay 2
              keystroke "Find Broken Links"
              delay 0.5
              keystroke return
              delay 3
            end tell
          `;
          
          execSync(`osascript -e '${script}'`, { timeout: 15000 });
          
          // Wait a moment for the doctor to finish
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Try to read broken links from VS Code output (this is a simplified approach)
          // In practice, we'd need to parse the actual Dendron doctor output
          // For now, let's return a structure that helps identify common patterns
          
          const results = {
            success: true,
            method: "AppleScript automation",
            message: "Dendron doctor executed - check VS Code output for broken links",
            commonFixes: {
              "user.routekit/design": "Replace with [[design]]",
              "user.xenova/transformers": "External reference - consider removing or documenting",
              "user.modelcontextprotocol/sdk": "External reference - consider removing or documenting",
              "missing_component_files": "Create missing component files like design.design-system.components.*.md"
            },
            suggestedActions: [
              "Check VS Code 'Problems' panel for specific broken link details",
              "Look for [[user.*]] references that should be simplified", 
              "Create any missing note files that are referenced",
              "Remove or document external package references"
            ]
          };
          
          if (input.fixBrokenLinks) {
            // Attempt some automatic fixes
            const { globSync } = await import('glob');
            const pattern = join(NOTES_DIR, "*.md");
            const files = globSync(pattern);
            
            let fixCount = 0;
            const fixResults = [];
            
            for (const filePath of files) {
              const filename = basename(filePath);
              try {
                const content = readFileSync(filePath, 'utf-8');
                let updatedContent = content;
                
                // Fix common broken link patterns
                const fixes = [
                  { pattern: /\[\[user\.routekit\/design\]\]/g, replacement: '[[design]]', description: 'Fixed user.routekit/design references' },
                  { pattern: /\[\[user\.xenova\/transformers\]\]/g, replacement: '', description: 'Removed external transformers reference' },
                  { pattern: /\[\[user\.modelcontextprotocol\/sdk\]\]/g, replacement: '', description: 'Removed external MCP SDK reference' }
                ];
                
                const appliedFixes = [];
                for (const fix of fixes) {
                  const matches = updatedContent.match(fix.pattern);
                  if (matches) {
                    updatedContent = updatedContent.replace(fix.pattern, fix.replacement);
                    appliedFixes.push({ ...fix, matchCount: matches.length });
                    fixCount++;
                  }
                }
                
                if (appliedFixes.length > 0) {
                  writeFileSync(filePath, updatedContent, 'utf-8');
                  fixResults.push({
                    filename,
                    fixesApplied: appliedFixes
                  });
                }
              } catch (error) {
                fixResults.push({
                  filename,
                  error: error.message
                });
              }
            }
            
            results.autoFixes = {
              totalFixes: fixCount,
              filesModified: fixResults.filter(r => !r.error).length,
              results: fixResults
            };
            
            results.message += `. Applied ${fixCount} automatic fixes to broken links.`;
          }
          
          log(`🩺 Dendron doctor executed - ${input.fixBrokenLinks ? `applied ${results.autoFixes?.totalFixes || 0} fixes` : 'check VS Code for results'}`);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(results, null, 2)
              }
            ]
          };
        } catch (error) {
          log(`⚠️ Doctor failed: ${error.message}`);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  message: `Could not run Dendron doctor automatically: ${error.message}. Please manually run 'Dendron: Doctor' in VS Code.`,
                  instruction: "Press Cmd+Shift+P, then type 'Dendron: Doctor' and select 'Find Broken Links'"
                }, null, 2)
              }
            ]
          };
        }
      }

      case "dendron_edit_note": {
        const input = editNoteSchema.parse(args || {});
        const filePath = join(NOTES_DIR, input.filename);

        if (!existsSync(filePath)) {
          throw new McpError(ErrorCode.InvalidParams, `File not found: ${input.filename}`);
        }

        // Read existing file and parse frontmatter
        const existingContent = readFileSync(filePath, 'utf-8');
        const frontmatterMatch = existingContent.match(/^---\s*\n([\s\S]*?)\n---/);

        if (!frontmatterMatch) {
          throw new McpError(ErrorCode.InvalidParams, `File has no frontmatter: ${input.filename}`);
        }

        // Parse existing frontmatter to preserve fields
        const frontmatterLines = frontmatterMatch[1].split('\n');
        const frontmatterData = {};
        for (const line of frontmatterLines) {
          const match = line.match(/^(\w+):\s*(.*)$/);
          if (match) {
            let value = match[2].trim();
            // Parse special values
            if (value === '[]') {
              value = [];
            } else if (value.startsWith('[') && value.endsWith(']')) {
              try { value = JSON.parse(value); } catch (e) { /* keep as string */ }
            } else if (value === 'true') {
              value = true;
            } else if (value === 'false') {
              value = false;
            }
            frontmatterData[match[1]] = value;
          }
        }

        // Update timestamp
        const timestamp = new Date().toISOString();
        frontmatterData.updated = timestamp;

        // Rebuild frontmatter - preserve ALL existing fields, not just standard ones
        frontmatterData.id = frontmatterData.id || basename(input.filename, '.md');
        frontmatterData.title = frontmatterData.title || generateTitleFromFilename(input.filename);
        frontmatterData.desc = frontmatterData.desc || '';
        frontmatterData.updated = timestamp;
        frontmatterData.created = frontmatterData.created || timestamp;

        // Build frontmatter string preserving all fields
        const fmLines = [];
        // Standard fields first in consistent order
        const standardFields = ['id', 'title', 'desc', 'updated', 'created'];
        for (const key of standardFields) {
          if (frontmatterData[key] !== undefined) {
            fmLines.push(`${key}: ${frontmatterData[key]}`);
          }
        }
        // Then any custom fields (status, targetFiles, etc.)
        for (const key of Object.keys(frontmatterData)) {
          if (!standardFields.includes(key)) {
            const val = frontmatterData[key];
            // Handle arrays like targetFiles: []
            if (Array.isArray(val)) {
              fmLines.push(`${key}: ${JSON.stringify(val)}`);
            } else {
              fmLines.push(`${key}: ${val}`);
            }
          }
        }
        const newFrontmatter = `---\n${fmLines.join('\n')}\n---`;

        // Write new content
        const newContent = `${newFrontmatter}\n\n${input.content}`;
        writeFileSync(filePath, newContent, 'utf-8');

        log(`✏️ Edited note: ${input.filename}`);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filename: input.filename,
                path: filePath,
                message: "Note edited successfully, frontmatter preserved"
              }, null, 2)
            }
          ]
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

// Start the server
async function main() {
  log("🚀 Starting Dendron MCP Server...");
  const transport = new StdioServerTransport();
  log("📡 Created stdio transport");
  await server.connect(transport);
  log("✅ Dendron MCP Server connected");
  log(`📍 Server name: routekit-dendron-${PROJECT_SLUG}`);
  log("🔧 Available tools: dendron_create_note, dendron_edit_note, dendron_reload_index, dendron_validate_schema, dendron_fix_frontmatter, dendron_bulk_fix_frontmatter, dendron_refactor_hierarchy, dendron_import_asset, dendron_doctor_broken_links");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});