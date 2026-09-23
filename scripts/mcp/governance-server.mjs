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
import { execSync } from "child_process";
import { homedir } from "os";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Compute repo root from this file's location: scripts/mcp/ → ../../
const _selfDir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = (
  (process.env.ROUTEKIT_PROJECT_ROOT && resolve(process.env.ROUTEKIT_PROJECT_ROOT)) ||
  resolve(_selfDir, '..', '..')
);

const SELF_PROJECT_ID = (() => {
  const envId = process.env.ROUTEKIT_PROJECT_ID;
  if (envId && envId.trim()) return envId.trim();
  const rksPath = join(PROJECT_ROOT, '.rks', 'project.json');
  try {
    const rks = JSON.parse(readFileSync(rksPath, 'utf8'));
    if (rks.id) return rks.id;
  } catch (_) {}
  throw new Error('[rks-gov] Cannot determine SELF_PROJECT_ID: set ROUTEKIT_PROJECT_ID in .mcp.json or ensure .rks/project.json exists');
})();

// Log file for debugging
const LOG_FILE = join(homedir(), "Documents", "projects", ".routekit", "mcp-governance-debug.log");

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
  name: `routekit-governance-${SELF_PROJECT_ID}`,
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
  },
});

// Tool schemas
const govTestRunSchema = z.object({
  projectId: z.string().describe("Project ID from registry"),
  testType: z.enum(['unit', 'integration', 'e2e', 'all']).describe("Type of tests to run").default("all"),
  filePattern: z.string().describe("File glob or pattern to run specific tests").optional(),
  timeout: z.number().describe("Test timeout in milliseconds").default(120000),
  watch: z.boolean().describe("Run tests in watch mode").default(false)
});

const govLintCheckSchema = z.object({
  fix: z.boolean().describe("Auto-fix linting issues").default(false),
  scope: z.enum(['all', 'cli', 'design', 'templates']).describe("Scope to lint").default("all")
});

const govBuildCheckSchema = z.object({
  skipCache: z.boolean().describe("Skip build cache").default(false),
  package: z.enum(['all', 'cli', 'design']).describe("Package to build").default("all")
});

const govScopeValidateSchema = z.object({
  expectedFiles: z.array(z.string()).describe("Files expected to be modified").default([]),
  checkBreaking: z.boolean().describe("Check for breaking changes").default(true)
});

const govQualityCheckSchema = z.object({
  checkDocs: z.boolean().describe("Check documentation quality").default(true),
  checkTests: z.boolean().describe("Check test coverage").default(true),
  checkTypes: z.boolean().describe("Check TypeScript types").default(true)
});

const govRegressionCheckSchema = z.object({
  checkTemplates: z.boolean().describe("Check template integrity").default(true),
  checkCLI: z.boolean().describe("Check CLI commands").default(true),
  checkDesignSystem: z.boolean().describe("Check design system components").default(true)
});

const govReleaseCheckSchema = z.object({
  prerelease: z.boolean().describe("Check for prerelease").default(false),
  dryRun: z.boolean().describe("Dry run without publishing").default(true)
});

// Helper functions

function parseTestOutput(output, exitCode) {
  const result = {
    passCount: 0,
    failCount: 0,
    failures: [],
    duration: 0,
    exitCode: exitCode
  };

  // Try to parse Jest JSON output format
  const jestMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (jestMatch) {
    try {
      const jestData = JSON.parse(jestMatch[0]);
      if (jestData.numPassedTests) result.passCount = jestData.numPassedTests;
      if (jestData.numFailedTests) result.failCount = jestData.numFailedTests;
      if (jestData.testDuration) result.duration = jestData.testDuration;
      if (Array.isArray(jestData.testResults)) {
        jestData.testResults.forEach(tr => {
          if (Array.isArray(tr.assertionResults)) {
            tr.assertionResults.forEach(ar => {
              if (ar.status === 'failed') {
                result.failures.push({
                  testName: ar.fullName || ar.title,
                  message: ar.failureMessages ? ar.failureMessages.join('\n') : 'Failed',
                  file: tr.name
                });
              }
            });
          }
        });
      }
      return result;
    } catch (e) {
      // Fall through to regex parsing
    }
  }

  // Try to parse Mocha JSON output format
  const mochaMatch = output.match(/\{[\s\S]*"stats"[\s\S]*"passes"[\s\S]*\}/);
  if (mochaMatch) {
    try {
      const mochaData = JSON.parse(mochaMatch[0]);
      if (mochaData.stats) {
        result.passCount = mochaData.stats.passes || 0;
        result.failCount = mochaData.stats.failures || 0;
        result.duration = mochaData.stats.duration || 0;
      }
      if (Array.isArray(mochaData.failures)) {
        mochaData.failures.forEach(f => {
          result.failures.push({
            testName: f.fullTitle,
            message: f.err ? f.err.message : 'Failed',
            file: f.file || 'unknown'
          });
        });
      }
      return result;
    } catch (e) {
      // Fall through to regex parsing
    }
  }

  // Fallback: regex extraction from test output
  const passRegex = /(\d+)\s+pass/i;
  const failRegex = /(\d+)\s+fail/i;
  const durationRegex = /(\d+)\s*ms/;

  const passMatch = output.match(passRegex);
  if (passMatch) result.passCount = parseInt(passMatch[1], 10);

  const failMatch = output.match(failRegex);
  if (failMatch) result.failCount = parseInt(failMatch[1], 10);

  const durationMatch = output.match(durationRegex);
  if (durationMatch) result.duration = parseInt(durationMatch[1], 10);

  return result;
}

function resolveProjectRoot(projectId) {
  if (projectId === SELF_PROJECT_ID) {
    return PROJECT_ROOT;
  }
  throw new Error(`Project not found: ${projectId}`);
}

function getTestCommand(projectRoot, testType, filePattern) {
  let command = 'npm test';
  
  if (testType !== 'all') {
    // Try tier-specific script first
    command = `npm run test:${testType}`;
  }
  
  if (filePattern) {
    // Append file pattern argument
    command += ` -- ${filePattern}`;
  }
  
  return command;
}

function emitTestTelemetry(projectId, testType, testResults) {
  try {
    const telemetryEvent = {
      type: 'gov.test.run',
      projectId,
      testType,
      passCount: testResults.passCount,
      failCount: testResults.failCount,
      duration: testResults.duration,
      exitCode: testResults.exitCode,
      timestamp: new Date().toISOString()
    };
    
    const telemetryPath = join(PROJECT_ROOT, '.rks', 'telemetry.log');
    log(`📊 Emitting telemetry: ${JSON.stringify(telemetryEvent)}`);
    appendFileSync(telemetryPath, JSON.stringify(telemetryEvent) + '\n');
  } catch (e) {
    log(`⚠️ Failed to emit telemetry: ${e.message}`);
  }
}

function runCommand(command, options = {}) {
  try {
    log(`🔧 Running: ${command}`);
    const result = execSync(command, { 
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      ...options 
    });
    return { success: true, output: result.toString() };
  } catch (error) {
    log(`❌ Command failed: ${error.message}`);
    return { success: false, error: error.message, output: error.stdout?.toString() || '' };
  }
}

async function validateScope(expectedFiles, checkBreaking) {
  try {
    log(`📋 Validating scope. Expected files: ${expectedFiles.length}`);
    
    const gitStatus = runCommand('git status --porcelain');
    if (!gitStatus.success) {
      return { success: false, error: "Could not get git status" };
    }

    const modifiedFiles = gitStatus.output.split('\n')
      .filter(line => line.trim())
      .map(line => line.substring(3).trim());

    const unexpectedFiles = modifiedFiles.filter(file => 
      !expectedFiles.some(expected => file.includes(expected))
    );

    let breaking = [];
    if (checkBreaking && modifiedFiles.length > 0) {
      // Check for breaking changes in CLI API
      const cliChanges = modifiedFiles.filter(f => f.includes('packages/cli'));
      if (cliChanges.length > 0) {
        const apiCheck = runCommand('grep -l "export" packages/cli/src/*.ts');
        if (apiCheck.success) {
          breaking.push('Potential breaking changes in CLI exports');
        }
      }
      
      // Check for breaking changes in design system
      const designChanges = modifiedFiles.filter(f => f.includes('packages/design'));
      if (designChanges.length > 0) {
        breaking.push('Potential breaking changes in design system components');
      }
    }

    return {
      success: true,
      modifiedFiles,
      expectedFiles,
      unexpectedFiles,
      breaking,
      inScope: unexpectedFiles.length === 0
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function checkQuality(options) {
  try {
    log(`🔍 Running quality checks`);
    const issues = [];
    
    if (options.checkDocs) {
      // Check for missing documentation
      const docsCheck = runCommand('grep -r "TODO:" notes/ --include="*.md" || true');
      if (docsCheck.success && docsCheck.output.trim()) {
        const todoCount = docsCheck.output.split('\n').filter(l => l.trim()).length;
        if (todoCount > 0) {
          issues.push({
            type: 'incomplete-docs',
            severity: 'warning',
            message: `Found ${todoCount} TODO items in documentation`,
            details: docsCheck.output.split('\n').slice(0, 3)
          });
        }
      }
    }

    if (options.checkTests) {
      // Check test coverage
      const testFiles = runCommand('find packages -name "*.test.ts" -o -name "*.test.tsx" | wc -l');
      if (testFiles.success) {
        const testCount = parseInt(testFiles.output.trim());
        if (testCount < 5) {
          issues.push({
            type: 'low-test-coverage',
            severity: 'warning',
            message: `Only ${testCount} test files found`,
            suggestion: 'Consider adding more test coverage'
          });
        }
      }
    }

    if (options.checkTypes) {
      // Check for TypeScript errors
      const typeCheck = runCommand('npm run typecheck');
      if (!typeCheck.success) {
        issues.push({
          type: 'type-errors',
          severity: 'error',
          message: 'TypeScript compilation errors found',
          details: typeCheck.output.split('\n').slice(0, 5)
        });
      }
    }

    return {
      success: true,
      issues,
      qualityScore: issues.length === 0 ? 100 : Math.max(0, 100 - (issues.length * 20)),
      criticalIssues: issues.filter(i => i.severity === 'error').length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function checkRegressions(options) {
  try {
    log(`🔍 Checking for regressions`);
    const issues = [];
    
    if (options.checkTemplates) {
      // Check template integrity
      const templateCheck = runCommand('ls -la packages/cli/templates/');
      if (!templateCheck.success) {
        issues.push({
          type: 'template-missing',
          severity: 'critical',
          message: 'Template directory not found'
        });
      }
    }

    if (options.checkCLI) {
      // Check CLI commands work
      const cliCheck = runCommand('node packages/cli/dist/index.js --version');
      if (!cliCheck.success) {
        issues.push({
          type: 'cli-broken',
          severity: 'critical',
          message: 'CLI command failed to execute'
        });
      }
    }

    if (options.checkDesignSystem) {
      // Check design system exports
      const designCheck = runCommand('grep -c "export" packages/design/src/index.ts');
      if (designCheck.success) {
        const exportCount = parseInt(designCheck.output.trim());
        if (exportCount < 5) {
          issues.push({
            type: 'design-exports-low',
            severity: 'warning',
            message: `Only ${exportCount} exports in design system`,
            suggestion: 'Ensure all components are properly exported'
          });
        }
      }
    }

    return {
      success: true,
      issues,
      regressionCount: issues.length,
      criticalIssues: issues.filter(i => i.severity === 'critical').length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("📋 ListTools request received for governance server");
  const tools = [
    {
      name: "gov_test_run",
      description: "Run tests to validate RouteKit Shell integrity",
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
      name: "gov_lint_check",
      description: "Check code linting and style compliance", 
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
      name: "gov_build_check",
      description: "Validate TypeScript compilation and build integrity",
      inputSchema: {
        type: "object", 
        properties: {
          skipCache: {
            type: "boolean",
            description: "Skip build cache",
            default: false
          },
          package: {
            type: "string",
            enum: ["all", "cli", "design"],
            description: "Package to build",
            default: "all"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "gov_scope_validate",
      description: "Validate that changes are within expected scope",
      inputSchema: {
        type: "object",
        properties: {
          expectedFiles: {
            type: "array",
            items: { type: "string" },
            description: "Files expected to be modified",
            default: []
          },
          checkBreaking: {
            type: "boolean", 
            description: "Check for breaking changes",
            default: true
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "gov_quality_check",
      description: "Check overall code and documentation quality",
      inputSchema: {
        type: "object",
        properties: {
          checkDocs: {
            type: "boolean",
            description: "Check documentation quality",
            default: true
          },
          checkTests: {
            type: "boolean",
            description: "Check test coverage",
            default: true
          },
          checkTypes: {
            type: "boolean",
            description: "Check TypeScript types",
            default: true
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "gov_regression_check",
      description: "Check for regressions in RouteKit Shell components",
      inputSchema: {
        type: "object",
        properties: {
          checkTemplates: {
            type: "boolean",
            description: "Check template integrity",
            default: true
          },
          checkCLI: {
            type: "boolean",
            description: "Check CLI commands",
            default: true
          },
          checkDesignSystem: {
            type: "boolean",
            description: "Check design system components",
            default: true
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "gov_release_check",
      description: "Validate readiness for release",
      inputSchema: {
        type: "object",
        properties: {
          prerelease: {
            type: "boolean",
            description: "Check for prerelease",
            default: false
          },
          dryRun: {
            type: "boolean",
            description: "Dry run without publishing",
            default: true
          }
        },
        additionalProperties: false
      }
    }
  ];
  log(`🔧 Returning ${tools.length} governance tools`);
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "gov_test_run": {
        const input = govTestRunSchema.parse(args || {});
        log(`🧪 Running tests: ${input.testType} for project ${input.projectId}`);
        
        try {
          // Resolve project root from registry
          const projectRoot = resolveProjectRoot(input.projectId);
          log(`📂 Project root: ${projectRoot}`);
          
          // Get appropriate test command
          const command = getTestCommand(projectRoot, input.testType, input.filePattern);
          log(`🔧 Test command: ${command}`);
          
          // Run the test command
          const startTime = Date.now();
          const cmdResult = runCommand(command, { cwd: projectRoot });
          const endTime = Date.now();
          
          // Parse test output into structured results
          const testResults = parseTestOutput(cmdResult.output, cmdResult.success ? 0 : 1);
          if (!cmdResult.success && !testResults.exitCode) {
            testResults.exitCode = 1;
          }
          
          // Emit telemetry event
          emitTestTelemetry(input.projectId, input.testType, testResults);
          
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tool: "gov_test_run",
                  projectId: input.projectId,
                  testType: input.testType,
                  filePattern: input.filePattern,
                  success: cmdResult.success,
                  testResults,
                  rawOutput: cmdResult.output,
                  error: cmdResult.error,
                  timestamp: new Date().toISOString()
                }, null, 2),
              },
            ],
          };
        } catch (error) {
          log(`❌ gov_test_run error: ${error.message}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tool: "gov_test_run",
                  projectId: input.projectId,
                  testType: input.testType,
                  success: false,
                  error: error.message,
                  testResults: {
                    passCount: 0,
                    failCount: 0,
                    failures: [],
                    duration: 0,
                    exitCode: 1
                  },
                  timestamp: new Date().toISOString()
                }, null, 2),
              },
            ],
          };
        }
      }

      case "gov_lint_check": {
        const input = govLintCheckSchema.parse(args || {});
        log(`✨ Running lint check (fix: ${input.fix}, scope: ${input.scope})`);
        
        let command = "npm run lint";
        if (input.scope !== "all") {
          command = `npm run lint:${input.scope}`;
        }
        if (input.fix) {
          command += " -- --fix";
        }
        
        const result = runCommand(command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_lint_check",
                fix: input.fix,
                scope: input.scope,
                ...result,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      case "gov_build_check": {
        const input = govBuildCheckSchema.parse(args || {});
        log(`🏗️ Running build check (skipCache: ${input.skipCache}, package: ${input.package})`);
        
        let command = "npm run build";
        if (input.package !== "all") {
          command = `npm run build:${input.package}`;
        }
        if (input.skipCache) {
          command += " -- --no-cache";
        }
        
        const result = runCommand(command);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_build_check",
                skipCache: input.skipCache,
                package: input.package,
                ...result,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      case "gov_scope_validate": {
        const input = govScopeValidateSchema.parse(args || {});
        log(`📋 Validating scope for ${input.expectedFiles.length} expected files`);
        const result = await validateScope(input.expectedFiles, input.checkBreaking);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_scope_validate",
                ...result,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      case "gov_quality_check": {
        const input = govQualityCheckSchema.parse(args || {});
        log(`📊 Running quality checks`);
        const result = await checkQuality(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_quality_check",
                ...result,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      case "gov_regression_check": {
        const input = govRegressionCheckSchema.parse(args || {});
        log(`🔍 Running regression checks`);
        const result = await checkRegressions(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_regression_check",
                ...result,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      case "gov_release_check": {
        const input = govReleaseCheckSchema.parse(args || {});
        log(`📦 Running release checks (prerelease: ${input.prerelease}, dryRun: ${input.dryRun})`);
        
        const checks = {
          tests: runCommand("npm test"),
          lint: runCommand("npm run lint"),
          build: runCommand("npm run build"),
          version: runCommand("npm version --no-git-tag-version patch --dry-run")
        };
        
        const allPassed = Object.values(checks).every(check => check.success);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                tool: "gov_release_check",
                prerelease: input.prerelease,
                dryRun: input.dryRun,
                readyForRelease: allPassed,
                checks: {
                  tests: checks.tests.success,
                  lint: checks.lint.success,
                  build: checks.build.success,
                  version: checks.version.success
                },
                details: checks,
                timestamp: new Date().toISOString()
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown governance tool: ${name}`
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
  log("🚀 Starting Governance MCP Server...");
  const transport = new StdioServerTransport();
  log("📡 Created stdio transport");
  await server.connect(transport);
  log("✅ Governance MCP Server connected");
  log(`📍 Server name: routekit-governance-${SELF_PROJECT_ID}`);
  log("🔧 Available tools: gov_test_run, gov_lint_check, gov_build_check, gov_scope_validate, gov_quality_check, gov_regression_check, gov_release_check");
}

// Always start the server when this module is loaded
main().catch((error) => {
  console.error("❌ Governance Server error:", error);
  process.exit(1);
});