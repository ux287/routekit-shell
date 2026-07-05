#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: Documentation Sync Check
 *
 * After code changes, checks if related documentation exists and
 * may need updating. Helps maintain documentation accuracy.
 *
 * Exit codes:
 *   0 = always (PostToolUse hooks are advisory only)
 *
 * Output:
 *   Suggestions written to stderr when docs may need updating
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { execSync } from "child_process";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "docs-sync-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      enabled: true,
      check_file_patterns: ["\\.ts$", "\\.tsx$", "\\.js$", "\\.mjs$"],
      skip_patterns: ["node_modules/", "dist/", "\\.test\\.", "\\.spec\\."],
      doc_locations: ["notes/", "docs/", "README.md"],
      rag_query_for_docs: true,
      min_changes_to_suggest: 10, // Lines changed to trigger suggestion
    };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return yaml.load(content) || {};
  } catch {
    return { enabled: true };
  }
}

function matchesPattern(filePath, patterns) {
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(filePath)) {
        return true;
      }
    } catch {
      // Invalid regex
    }
  }
  return false;
}

function getRelatedDocs(filePath, config) {
  // Query RAG for docs that might reference this file
  const shellRoot = process.env.ROUTEKIT_SHELL_ROOT || PROJECT_DIR;
  const fileName = path.basename(filePath, path.extname(filePath));

  // Build query from file path components
  const pathParts = filePath.split("/").filter((p) => p && p !== "src" && p !== "packages");
  const query = `documentation ${fileName} ${pathParts.slice(-3).join(" ")}`;

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

    try {
      const parsed = JSON.parse(result.trim());
      if (parsed.results) {
        // Filter to only docs/notes (not code)
        return parsed.results
          .filter((r) => {
            const file = r.file || r.title || "";
            return file.includes("notes/") || file.includes("docs/") || file.endsWith(".md");
          })
          .slice(0, 3);
      }
    } catch {
      // Not JSON
    }

    return [];
  } catch {
    return [];
  }
}

function estimateChanges(toolName, toolInput) {
  // Rough estimate of lines changed
  if (toolName === "Write") {
    const content = toolInput.content || "";
    return content.split("\n").length;
  }
  if (toolName === "Edit") {
    const oldLines = (toolInput.old_string || "").split("\n").length;
    const newLines = (toolInput.new_string || "").split("\n").length;
    return Math.abs(newLines - oldLines) + Math.max(oldLines, newLines);
  }
  return 0;
}

function formatDocsSuggestion(filePath, relatedDocs, changeSize) {
  let output = `\n📝 Documentation Sync Reminder\n`;
  output += `${"─".repeat(45)}\n`;
  output += `Modified: ${path.basename(filePath)} (~${changeSize} lines)\n\n`;

  if (relatedDocs.length > 0) {
    output += `📚 Related documentation that may need updating:\n`;
    for (const doc of relatedDocs) {
      const title = doc.title || doc.file || "Unknown";
      output += `   • ${title}\n`;
    }
    output += `\n💡 Consider reviewing these docs for accuracy.\n`;
  } else {
    output += `💡 No related docs found. Consider adding documentation\n`;
    output += `   if this code introduces new features or APIs.\n`;
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

  // Only check after Edit and Write tools
  if (!["Edit", "Write"].includes(toolName)) {
    process.exit(0);
  }

  const filePath = toolInput.file_path;
  if (!filePath) {
    process.exit(0);
  }

  const config = loadConfig();

  if (!config.enabled) {
    process.exit(0);
  }

  // Get relative path
  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  // Skip if doesn't match check patterns
  const checkPatterns = config.check_file_patterns || ["\\.ts$", "\\.js$"];
  if (!matchesPattern(relativePath, checkPatterns)) {
    process.exit(0);
  }

  // Skip if matches skip patterns
  const skipPatterns = config.skip_patterns || [];
  if (matchesPattern(relativePath, skipPatterns)) {
    process.exit(0);
  }

  // Estimate change size
  const changeSize = estimateChanges(toolName, toolInput);
  const minChanges = config.min_changes_to_suggest || 10;

  // Only suggest for substantial changes
  if (changeSize < minChanges) {
    process.exit(0);
  }

  // Query for related docs
  const relatedDocs = config.rag_query_for_docs ? getRelatedDocs(relativePath, config) : [];

  // Output suggestion
  const suggestion = formatDocsSuggestion(relativePath, relatedDocs, changeSize);
  process.stderr.write(suggestion);

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Docs sync hook error: ${err.message}\n`);
  process.exit(0);
});
