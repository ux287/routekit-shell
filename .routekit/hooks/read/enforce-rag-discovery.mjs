#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce RAG/KG for discovery operations
 *
 * Blocks discovery-style file operations (broad globs, directory reads, exploratory searches)
 * and redirects to RAG/orchestrator queries. Allows known-path reads (specific files).
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (message to stderr)
 */
import path from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Detect projectId from environment or directory name
 */
function getProjectId() {
  if (process.env.RKS_PROJECT_ID) {
    return process.env.RKS_PROJECT_ID;
  }
  return path.basename(PROJECT_DIR);
}

/**
 * Check if this is a discovery-style operation (broad search, no specific file)
 */
function isDiscoveryOperation(toolName, toolInput) {
  const discoveryTools = ["Glob", "Grep"];

  // Glob and Grep are always discovery-style
  if (discoveryTools.includes(toolName)) {
    const pattern = toolInput.pattern || toolInput.path || "";

    // Very broad patterns are discovery
    if (pattern.includes("**") || pattern === "*" || pattern.startsWith("*.")) {
      return true;
    }

    // Searching entire directories
    if (pattern === "." || pattern === "./" || pattern.endsWith("/")) {
      return true;
    }
  }

  // Read tool with directory-like paths
  if (toolName === "Read") {
    const filePath = toolInput.file_path || "";

    // No extension and looks like a directory
    if (!path.extname(filePath) && !filePath.includes("*")) {
      return true;
    }
  }

  // Bash with discovery commands
  if (toolName === "Bash") {
    const cmd = (toolInput.command || "").toLowerCase();

    // Common discovery patterns
    if (cmd.includes("find .") || cmd.includes("find ./")) return true;
    if (/\bls\s+-[a-z]*R/.test(cmd)) return true; // recursive ls
    if (/\btree\b/.test(cmd)) return true;
  }

  return false;
}

/**
 * Check if the path is a known/specific file (not exploratory)
 */
function isKnownPath(toolName, toolInput) {
  if (toolName === "Read") {
    const filePath = toolInput.file_path || "";
    // Has extension = specific file
    if (path.extname(filePath)) {
      return true;
    }
  }

  if (toolName === "Glob" || toolName === "Grep") {
    const pattern = toolInput.pattern || "";
    // Specific file pattern (not broad glob)
    if (!pattern.includes("**") && pattern.includes("/") && path.extname(pattern)) {
      return true;
    }
  }

  return false;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Check guardrails escape hatch
  if (process.env.RKS_GUARDRAILS === "off") {
    process.exit(0);
  }

  // Only check discovery-relevant tools
  const relevantTools = ["Read", "Glob", "Grep", "Bash"];
  if (!relevantTools.includes(toolName)) {
    process.exit(0);
  }

  // Allow known/specific paths
  if (isKnownPath(toolName, toolInput)) {
    process.exit(0);
  }

  // Check if this is a discovery operation
  if (!isDiscoveryOperation(toolName, toolInput)) {
    process.exit(0);
  }

  // Block discovery operations - suggest RAG
  const projectId = getProjectId();
  const targetPath = toolInput.file_path || toolInput.pattern || toolInput.path || "(unknown)";

  const message = [
    "",
    `⛔ Discovery operation blocked: ${toolName}`,
    `   Path/Pattern: ${targetPath}`,
    "",
    "   Use RAG or orchestrator queries for open-ended discovery.",
    "   If you need a specific file, provide the exact path.",
    "",
    `   💡 Run: orchestrator_query { projectId: "${projectId}", q: "your discovery question" }`,
    "",
    `   Or: rks_rag_query { projectId: "${projectId}", q: "search for specific files" }`,
    "",
  ].join("\n");

  process.stderr.write(message);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
