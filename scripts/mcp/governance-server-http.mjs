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
import { execSync } from "child_process";
import { homedir } from "os";
import { appendFileSync } from "fs";
import { join } from "path";

// Log file for debugging
const LOG_FILE = join(homedir(), "Documents", "projects", ".routekit", "mcp-governance-debug.log");
const PROJECT_ROOT = process.env.ROUTEKIT_PROJECT_ROOT || process.cwd();

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} [GOVERNANCE] ${message}\n`;
  console.error(message);
  try {
    appendFileSync(LOG_FILE, logMessage);
  } catch (e) {
    // Ignore file write errors
  }
}

const server = new Server({
  name: "routekit-governance-routekit-shell",
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool schemas
const govTestRunSchema = z.object({
  testType: z.enum(['unit', 'integration', 'e2e', 'all']).describe("Type of tests to run").default("all"),
  watch: z.boolean().describe("Run tests in watch mode").default(false)
});

const govLintCheckSchema = z.object({
  fix: z.boolean().describe("Auto-fix linting issues").default(false),
  scope: z.enum(['all', 'cli', 'design', 'templates']).describe("Scope to lint").default("all")
});

const govBuildCheckSchema = z.object({
  production: z.boolean().describe("Build for production").default(false),
  scope: z.enum(['all', 'cli', 'design', 'templates']).describe("Scope to build").default("all")
});

const govHealthCheckSchema = z.object({
  detailed: z.boolean().describe("Show detailed health information").default(false)
});

// Helper functions
function runCommand(command, options = {}) {
  log(`🔧 Running command: ${command}`);
  try {
    const result = execSync(command, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      ...options
    });
    log(`✅ Command succeeded`);
    return { success: true, output: result.trim(), error: null };
  } catch (error) {
    log(`❌ Command failed: ${error.message}`);
    return { success: false, output: null, error: error.message };
  }
}

function runTests(testType, watch) {
  const commands = {
    unit: 'npm test',
    integration: 'npm run test:integration',
    e2e: 'npm run test:e2e',
    all: 'npm run test:all'
  };
  
  let command = commands[testType] || commands.all;
  if (watch) {
    command += ' -- --watch';
  }
  
  return runCommand(command);
}

function runLint(fix, scope) {
  const lintCommands = {
    all: fix ? 'npm run lint:fix' : 'npm run lint',
    cli: fix ? 'npm run lint:cli:fix' : 'npm run lint:cli',
    design: fix ? 'npm run lint:design:fix' : 'npm run lint:design',
    templates: fix ? 'npm run lint:templates:fix' : 'npm run lint:templates'
  };
  
  const command = lintCommands[scope] || lintCommands.all;
  return runCommand(command);
}

function runBuild(production, scope) {
  const buildCommands = {
    all: production ? 'npm run build:prod' : 'npm run build',
    cli: 'npm run build:cli',
    design: 'npm run build:design',
    templates: 'npm run build:templates'
  };
  
  const command = buildCommands[scope] || buildCommands.all;
  return runCommand(command);
}

function performHealthCheck(detailed) {
  const checks = [];
  
  // Check if package.json exists
  const packageCheck = runCommand('test -f package.json');
  checks.push({
    name: 'Package.json exists',
    status: packageCheck.success ? 'PASS' : 'FAIL',
    details: packageCheck.success ? 'Found package.json' : 'Missing package.json'
  });
  
  // Check if node_modules exists
  const nodeModulesCheck = runCommand('test -d node_modules');
  checks.push({
    name: 'Dependencies installed',
    status: nodeModulesCheck.success ? 'PASS' : 'FAIL', 
    details: nodeModulesCheck.success ? 'node_modules directory exists' : 'Run npm install'
  });
  
  // Check git status
  const gitCheck = runCommand('git status --porcelain');
  checks.push({
    name: 'Git working directory',
    status: 'INFO',
    details: gitCheck.success ? 
      (gitCheck.output ? `${gitCheck.output.split('\n').length} changes` : 'Clean') :
      'Not a git repository'
  });
  
  if (detailed) {
    // Additional detailed checks
    const diskUsage = runCommand('du -sh .');
    if (diskUsage.success) {
      checks.push({
        name: 'Project size',
        status: 'INFO',
        details: diskUsage.output
      });
    }
    
    const nodeVersion = runCommand('node --version');
    if (nodeVersion.success) {
      checks.push({
        name: 'Node.js version',
        status: 'INFO',
        details: nodeVersion.output
      });
    }
  }
  
  return {
    success: true,
    checks: checks,
    summary: {
      total: checks.length,
      passed: checks.filter(c => c.status === 'PASS').length,
      failed: checks.filter(c => c.status === 'FAIL').length
    }
  };
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received");
  const tools = [
    {
      name: "governance_test_run",
      description: "Run project tests with governance oversight",
      inputSchema: {
        type: "object",
        properties: {
          testType: {
            type: "string",
            enum: ["unit", "integration", "e2e", "all"],
            description: "Type of tests to run",
            default: "all"
          },
          watch: {
            type: "boolean",
            description: "Run tests in watch mode",
            default: false
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "governance_lint_check",
      description: "Run linting checks with optional auto-fix",
      inputSchema: {
        type: "object",
        properties: {
          fix: {
            type: "boolean",
            description: "Auto-fix linting issues",
            default: false
          },
          scope: {
            type: "string",
            enum: ["all", "cli", "design", "templates"],
            description: "Scope to lint",
            default: "all"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "governance_build_check",
      description: "Run build process with governance validation",
      inputSchema: {
        type: "object",
        properties: {
          production: {
            type: "boolean",
            description: "Build for production",
            default: false
          },
          scope: {
            type: "string",
            enum: ["all", "cli", "design", "templates"],
            description: "Scope to build",
            default: "all"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "governance_health_check",
      description: "Perform comprehensive project health check",
      inputSchema: {
        type: "object",
        properties: {
          detailed: {
            type: "boolean",
            description: "Show detailed health information",
            default: false
          }
        },
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
      case "governance_test_run": {
        const input = govTestRunSchema.parse(args || {});
        const result = runTests(input.testType, input.watch);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: "test_run",
                testType: input.testType,
                watch: input.watch,
                ...result
              }, null, 2),
            },
          ],
        };
      }

      case "governance_lint_check": {
        const input = govLintCheckSchema.parse(args || {});
        const result = runLint(input.fix, input.scope);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: "lint_check",
                fix: input.fix,
                scope: input.scope,
                ...result
              }, null, 2),
            },
          ],
        };
      }

      case "governance_build_check": {
        const input = govBuildCheckSchema.parse(args || {});
        const result = runBuild(input.production, input.scope);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: "build_check",
                production: input.production,
                scope: input.scope,
                ...result
              }, null, 2),
            },
          ],
        };
      }

      case "governance_health_check": {
        const input = govHealthCheckSchema.parse(args || {});
        const result = performHealthCheck(input.detailed);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: "health_check",
                detailed: input.detailed,
                ...result
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
  const port = process.env.PORT || 3003;
  log(`🚀 Starting Governance MCP HTTP Server on port ${port}...`);
  
  const transport = new SSEServerTransport("/mcp", {
    port: port,
  });
  
  log("📡 Created HTTP/SSE transport");
  await server.connect(transport);
  log(`✅ Governance MCP Server connected on http://localhost:${port}/mcp`);
  log(`📍 Server name: routekit-governance-routekit-shell`);
  log("🔧 Available tools: governance_test_run, governance_lint_check, governance_build_check, governance_health_check");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Server error:", error);
  process.exit(1);
});