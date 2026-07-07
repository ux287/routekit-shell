#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce RAG for search operations
 *
 * Blocks bash grep/find/rg calls and encourages use of rks_rag_query/orchestrator_query.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (message to stderr)
 */
import fs from "fs";
import path from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_DIR = path.join(PROJECT_DIR, ".routekit", "telemetry");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "guardrails.log");

/**
 * Detect projectId from environment or directory name
 */
function getProjectId() {
  if (process.env.RKS_PROJECT_ID) {
    return process.env.RKS_PROJECT_ID;
  }
  return path.basename(PROJECT_DIR);
}

function appendTelemetry(entry) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch (e) {
    // best-effort telemetry
  }
}

const SEARCH_PATTERNS = [
  /\bgrep\s+(?!-[vqc])/,  // grep but not just grep -v, -q, -c (filtering/checking)
  /\brg\s+/,              // ripgrep
  /\bfind\s+\.\s/,        // find . (exploratory)
  /\bfind\s+\.\/\s/,      // find ./ (exploratory)
];

function isSearchCommand(command) {
  const cmd = command.toLowerCase();
  return SEARCH_PATTERNS.some(pattern => pattern.test(cmd));
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

  // Only enforce on Bash tool
  if (toolName !== "Bash") {
    process.exit(0);
  }

  // Check guardrails escape hatch
  if (process.env.RKS_GUARDRAILS === "off") {
    process.exit(0);
  }

  const command = toolInput.command || "";

  // Check if this is a search command
  if (!isSearchCommand(command)) {
    process.exit(0);
  }

  // Emit telemetry
  appendTelemetry({
    ts: new Date().toISOString(),
    blocked: true,
    reason: "grep-find-rg-detected",
    command: command.slice(0, 200),
  });

  // Block with helpful message
  const projectId = getProjectId();

  const message = [
    "",
    "⛔ Raw search tool blocked: detected use of grep/find/rg",
    `   Command: ${command.slice(0, 80)}${command.length > 80 ? "..." : ""}`,
    "",
    `   💡 Run: rks_rag_query { projectId: "${projectId}", q: "your search query" }`,
    "",
    "   Or for orchestrated queries:",
    `   💡 Run: orchestrator_query { projectId: "${projectId}", query: "your question" }`,
    "",
  ].join("\n");

  process.stderr.write(message);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
