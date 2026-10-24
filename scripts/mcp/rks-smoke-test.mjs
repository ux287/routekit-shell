#!/usr/bin/env node
/**
 * RKS MCP Tool Smoke Tests
 *
 * Tests read-only MCP tools that are safe to run without side effects.
 * @see backlog.test.comprehensive-test-suite
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define checks for read-only resources related to MCP tools.
const checks = [
  {
    name: "packages/mcp-rks server entry",
    path: path.resolve(__dirname, "../../packages/mcp-rks/src/server.mjs"),
    required: true,
  },
  {
    name: "rks_rag_query tool (source file)",
    path: path.resolve(__dirname, "../../packages/mcp-rks/src/tools/rks_rag_query.mjs"),
    required: false,
  },
  {
    name: "rks_templates_list tool (source file)",
    path: path.resolve(__dirname, "../../packages/mcp-rks/src/tools/rks_templates_list.mjs"),
    required: false,
  },
  {
    name: "rks_project_get tool (source file)",
    path: path.resolve(__dirname, "../../packages/mcp-rks/src/tools/rks_project_get.mjs"),
    required: false,
  },
];

async function run() {
  console.log("[rks-smoke] Running MCP smoke checks (read-only)");

  let failed = 0;

  for (const c of checks) {
    const exists = fs.existsSync(c.path);
    if (exists) {
      console.log(`  \x1b[32m✓ PASS\x1b[0m ${c.name} -> ${path.relative(process.cwd(), c.path)}`);
    } else if (c.required) {
      console.log(`  \x1b[31m✗ FAIL\x1b[0m ${c.name} (missing) -> ${path.relative(process.cwd(), c.path)}`);
      failed++;
    } else {
      console.log(`  \x1b[33m! SKIP\x1b[0m ${c.name} (optional, not present)`);
    }
  }

  if (failed > 0) {
    console.error(`[rks-smoke] ${failed} required check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("[rks-smoke] All required checks passed");
  }
}

run();
