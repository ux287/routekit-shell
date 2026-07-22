#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce orchestration for knowledge access
 *
 * Blocks direct Read/Grep/Glob access to:
 * - Knowledge paths (notes/, docs/) - always enforced
 * - Code paths (packages/, src/) - when enforce_code_rag is enabled
 *
 * Forces use of RAG MCP tools for semantic search instead of file sprawl.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with message to stderr)
 */
import fs from "fs";
import path from "path";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "enforcement.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // No config = allow everything
    return {
      knowledge_paths: [],
      code_knowledge_paths: [],
      allowed_paths: [],
      enforce_code_rag: false,
    };
  }
  const content = fs.readFileSync(CONFIG_PATH, "utf8");
  return yaml.load(content) || {
    knowledge_paths: [],
    code_knowledge_paths: [],
    allowed_paths: [],
    enforce_code_rag: false,
  };
}

function pathMatches(filePath, patterns) {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(filePath)) {
        return true;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

function extractPath(toolInput) {
  // Different tools use different parameter names
  return toolInput.file_path || toolInput.path || toolInput.pattern || null;
}

async function main() {
  // Read hook input from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    // If we can't parse input, allow by default
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only enforce on file access tools
  if (!["Read", "Grep", "Glob"].includes(toolName)) {
    process.exit(0);
  }

  // Check guardrails escape hatch
  if (process.env.RKS_GUARDRAILS === "off") {
    process.exit(0);
  }

  const targetPath = extractPath(toolInput);
  if (!targetPath) {
    process.exit(0);
  }

  const config = loadConfig();

  // Check if path is in allowed_paths (explicit allow takes precedence)
  if (pathMatches(targetPath, config.allowed_paths || [])) {
    process.exit(0);
  }

  // Check if path is in knowledge_paths (always blocked)
  if (pathMatches(targetPath, config.knowledge_paths || [])) {
    process.stderr.write(
      `\n⛔ Direct access to knowledge paths is blocked.\n` +
      `   Path: ${targetPath}\n` +
      `   Use RAG MCP tools (rag_query, orchestrator_query) instead.\n\n` +
      `   Example: rks_rag_query with q="your search query"\n\n`
    );
    process.exit(2);
  }

  // Check if path is in code_knowledge_paths (blocked when enforce_code_rag is true)
  if (config.enforce_code_rag && pathMatches(targetPath, config.code_knowledge_paths || [])) {
    process.stderr.write(
      `\n⛔ Direct access to code paths is blocked (code RAG enforcement enabled).\n` +
      `   Path: ${targetPath}\n` +
      `   Use semantic code search via RAG instead of direct file reads.\n\n` +
      `   Example: rks_rag_query with q="function name or description"\n` +
      `   This returns targeted code snippets with context.\n\n` +
      `   To disable: Set enforce_code_rag: false in .routekit/enforcement.yaml\n\n`
    );
    process.exit(2);
  }

  // Default: allow
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
