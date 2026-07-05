#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Architecture Drift Detection
 *
 * Detects when code changes might conflict with established architecture
 * decisions documented in design notes. Queries RAG for relevant
 * architecture documentation and warns when drift is detected.
 *
 * Exit codes:
 *   0 = allow (with optional warning)
 *   2 = block (when on_drift_detected is "block")
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { execSync } from "child_process";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "architecture-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      enabled: false, // Disabled by default if no config
    };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return yaml.load(content) || { enabled: false };
  } catch {
    return { enabled: false };
  }
}

function matchesPattern(filePath, pattern) {
  // Convert glob pattern to regex
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(",").join("|")})`);

  try {
    return new RegExp(`^${regex}$`).test(filePath);
  } catch {
    return false;
  }
}

function shouldSkipFile(filePath, config) {
  const skipPatterns = config.skip_patterns || [];
  for (const pattern of skipPatterns) {
    if (filePath.includes(pattern.replace(/\*/g, ""))) {
      return true;
    }
    if (matchesPattern(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

function isNewFileCreation(toolName, filePath) {
  if (toolName !== "Write") return false;
  return !fs.existsSync(filePath);
}

function isStructuralChange(filePath, config) {
  const structuralDirs = config.structural_directories || [];
  for (const dir of structuralDirs) {
    if (filePath.startsWith(dir)) {
      return true;
    }
  }
  return false;
}

function getArchitectureQuery(filePath, config) {
  const monitoredPatterns = config.monitored_patterns || [];
  for (const item of monitoredPatterns) {
    if (matchesPattern(filePath, item.pattern)) {
      return item.architecture_query;
    }
  }
  return null;
}

function queryRag(query, config) {
  // Try to call the RAG MCP tool via CLI
  // This is a simplified approach - in production you might call the MCP server directly
  const shellRoot = process.env.ROUTEKIT_SHELL_ROOT || path.join(PROJECT_DIR);
  const limit = config.rag_query_limit || 3;

  try {
    const result = execSync(
      `node "${shellRoot}/packages/cli/bin/routekit.js" rag query routekit-shell "${query}" 2>/dev/null || echo "{}"`,
      {
        cwd: PROJECT_DIR,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(result.trim());
      if (parsed.results) {
        return parsed.results.slice(0, limit);
      }
    } catch {
      // Not JSON, might be formatted output
      // Return empty - RAG might not be available
    }

    return [];
  } catch {
    // RAG query failed - don't block, just skip architecture check
    return [];
  }
}

function formatArchitectureWarning(filePath, query, ragResults, isNewFile) {
  const action = isNewFile ? "Creating new file" : "Modifying structural file";

  let output = `\n📐 Architecture Review Advisory\n`;
  output += `${"─".repeat(50)}\n`;
  output += `${action}: ${path.basename(filePath)}\n`;
  output += `Query: "${query}"\n\n`;

  if (ragResults.length > 0) {
    output += `📚 Relevant architecture documentation:\n`;
    for (const result of ragResults) {
      const title = result.title || result.file || "Unknown";
      const snippet = result.snippet || result.content || "";
      const truncated = snippet.length > 150 ? snippet.slice(0, 150) + "..." : snippet;
      output += `\n   • ${title}\n`;
      if (truncated) {
        output += `     ${truncated.replace(/\n/g, "\n     ")}\n`;
      }
    }
    output += `\n💡 Review the architecture docs above to ensure alignment.\n`;
  } else {
    output += `💡 No specific architecture docs found for this area.\n`;
    output += `   Consider documenting the pattern if this is a new structural decision.\n`;
  }

  output += "\n";
  return output;
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

  // Only check on Edit and Write tools
  if (!["Edit", "Write"].includes(toolName)) {
    process.exit(0);
  }

  const filePath = toolInput.file_path;
  if (!filePath) {
    process.exit(0);
  }

  const config = loadConfig();

  // Exit if not enabled
  if (!config.enabled) {
    process.exit(0);
  }

  // Get relative path for pattern matching
  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  // Skip if file matches skip patterns
  if (shouldSkipFile(relativePath, config)) {
    process.exit(0);
  }

  const checkOn = config.check_on || {};
  const isNewFile = isNewFileCreation(toolName, filePath);
  const isStructural = isStructuralChange(relativePath, config);

  // Determine if we should check this change
  let shouldCheck = false;
  let reason = "";

  if (isNewFile && checkOn.new_file_creation) {
    shouldCheck = true;
    reason = "new file creation";
  } else if (isStructural && checkOn.directory_structure_change) {
    shouldCheck = true;
    reason = "structural change";
  }

  if (!shouldCheck) {
    process.exit(0);
  }

  // Get architecture query for this file pattern
  let query = getArchitectureQuery(relativePath, config);
  if (!query) {
    // Generate generic query based on file location
    const parts = relativePath.split("/").slice(0, 2);
    query = `architecture patterns ${parts.join(" ")}`;
  }

  // Query RAG for relevant architecture docs
  const ragResults = queryRag(query, config);

  // Output advisory warning
  const warning = formatArchitectureWarning(relativePath, query, ragResults, isNewFile);
  process.stderr.write(warning);

  // Check if we should block
  if (config.on_drift_detected === "block" && ragResults.length > 0) {
    process.stderr.write(
      `⛔ Architecture review required before proceeding.\n` +
        `   Set 'on_drift_detected: warn' in .routekit/architecture-policy.yaml to allow.\n\n`
    );
    process.exit(2);
  }

  // Allow with warning
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Architecture hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
