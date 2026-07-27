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
const PROJECT_ROOT = process.cwd();
const NOTES_DIR = join(PROJECT_ROOT, "notes");
const PROJECT_SLUG = "__slug__";

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
  // RouteKit Shell specific patterns
  if (id.includes('.getting-started.')) return 'Getting started guide for RouteKit Shell framework';
  if (id.includes('.project-structure.')) return 'Project structure documentation for RouteKit Shell';
  if (id.includes('.workflow.')) return 'Development workflow documentation for RouteKit Shell';
  if (id.includes('.design-system.')) return 'Design system documentation for RouteKit Shell';
  if (id.includes('.templates.')) return 'Template documentation for RouteKit Shell projects';
  if (id.includes('.cli.')) return 'CLI documentation for RouteKit Shell';
  if (id.includes('.notes.')) return 'Notes and documentation patterns for RouteKit Shell';
  if (id.includes('.hub.')) return 'Hub dashboard documentation for RouteKit Shell';
  if (id.includes('.mcp.')) return 'MCP server documentation for RouteKit Shell';
  if (id.includes('.rag.')) return 'RAG system documentation for RouteKit Shell';
  if (id.includes('.prompt-library.')) return 'Prompt library for RouteKit Shell development';
  
  return 'Documentation for the RouteKit Shell framework';
}

function hasFrontmatter(content) {
  return content.trimStart().startsWith('---');
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
  filename: z.string().describe("Note filename (e.g. '__slug__.new.topic.md')"),
  title: z.string().optional().describe("Custom title (optional - will generate from filename)"),
  desc: z.string().optional().describe("Custom description (optional - will generate from namespace)"),
  content: z.string().default("").describe("Initial note content (optional)")
});

const reloadIndexSchema = z.object({
  workspace: z.string().optional().describe("VS Code workspace path (optional)")
});

const validateSchemaSchema = z.object({
  pattern: z.string().default("__slug__.*.md").describe("Glob pattern for files to validate")
});

const fixFrontmatterSchema = z.object({
  filename: z.string().describe("Specific file to fix frontmatter")
});

const bulkFixFrontmatterSchema = z.object({
  pattern: z.string().default("__slug__.*.md").describe("Glob pattern for files to fix"),
  dryRun: z.boolean().default(false).describe("Preview changes without applying them")
});

const refactorHierarchySchema = z.object({
  oldNamespace: z.string().describe("Old namespace pattern (e.g., '__slug__.old.pattern')"),
  newNamespace: z.string().describe("New namespace pattern (e.g., '__slug__.new.pattern')"),
  pattern: z.string().optional().describe("File pattern to match (defaults to oldNamespace + '*.md')"),
  dryRun: z.boolean().default(false).describe("Preview changes without applying them")
});

const importAssetSchema = z.object({
  sourcePath: z.string().describe("Absolute path to the external asset file"),
  targetNamespace: z.string().describe("Dendron namespace (e.g., 'assets.images.logo')"),
  description: z.string().optional().describe("Asset description for the markdown wrapper")
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
            description: "Note filename (e.g. '__slug__.new.topic.md')"
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
            default: "__slug__.*.md"
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
            default: "__slug__.*.md"
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
            description: "Old namespace pattern (e.g., '__slug__.old.pattern')"
          },
          newNamespace: {
            type: "string", 
            description: "New namespace pattern (e.g., '__slug__.new.pattern')"
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

        // Generate frontmatter and content
        const frontmatter = generateFrontmatter(input.filename, input.title, input.desc);
        const fullContent = input.content 
          ? `${frontmatter}\n\n${input.content}`
          : `${frontmatter}\n\n${input.content || ''}`;

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
                message: "Note created successfully with proper frontmatter"
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
  log("🔧 Available tools: dendron_create_note, dendron_reload_index, dendron_validate_schema, dendron_fix_frontmatter, dendron_bulk_fix_frontmatter, dendron_refactor_hierarchy, dendron_import_asset");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});