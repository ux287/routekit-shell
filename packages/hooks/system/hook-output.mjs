/**
 * hook-output.mjs — Shared output builder for PreToolUse redirect hooks
 *
 * Provides a consistent structured JSON output for all redirect hooks.
 * All hooks MUST use exit 0 + JSON stdout for denials (not exit 2 + stderr).
 * Claude Code only processes hookSpecificOutput JSON on exit 0.
 *
 * Governor routing fields are included in every redirect for the
 * Governor orchestration layer.
 *
 * @see notes/reports.hooks-redirect-architecture.md
 * @see backlog.governor.hook-routing
 */
import fs from "fs";
import path from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const TELEMETRY_DIR = path.join(PROJECT_DIR, ".routekit", "telemetry");
const TELEMETRY_FILE = path.join(TELEMETRY_DIR, "guardrails.log");

/**
 * Read and parse hook input from stdin.
 * @returns {Promise<object>} Parsed hook data
 */
export async function readHookInput() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input);
}

/**
 * Get the project ID from env or directory name.
 * @returns {string}
 */
export function getProjectId() {
  if (process.env.RKS_PROJECT_ID) return process.env.RKS_PROJECT_ID;
  return path.basename(PROJECT_DIR);
}

/**
 * Append a telemetry entry to the guardrails log.
 * @param {object} entry - Telemetry event data
 */
export function appendTelemetry(entry) {
  try {
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort telemetry
  }
}

/**
 * Build a structured deny output with redirect and governor routing.
 *
 * @param {object} opts
 * @param {string} opts.reason - Human-readable denial reason
 * @param {string} opts.agent - MCP agent tool name (e.g., "mcp__rks__rks_agent_git")
 * @param {object} opts.agentParams - Parameters for the agent call
 * @param {string[]} opts.instructions - Additional context lines for the Governor
 * @param {string} [opts.project] - Project ID (defaults to getProjectId())
 * @returns {object} JSON output for stdout
 */
export function buildRedirectOutput({ reason, agent, agentParams, instructions = [], project = null }) {
  const projectId = project || getProjectId();
  const paramsJson = JSON.stringify(agentParams);

  const contextLines = [
    `REDIRECT ORDER: Route to Governor. Do NOT call ${agent} or the original tool directly.`,
    `Context: ${paramsJson}`,
    ...instructions,
    ``,
    `GOVERNOR ROUTING:`,
    `  agent: ${agent}`,
    `  params: ${paramsJson}`,
    `  project: ${projectId}`,
  ];

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
      additionalContext: contextLines.join("\n"),
    },
  };
}

/**
 * Write the deny output to stdout and exit.
 * @param {object} output - Output from buildRedirectOutput
 */
export function denyWithRedirect(output) {
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

/**
 * Check if guardrails are off (escape hatch).
 * @returns {boolean}
 */
export function isGuardrailsOff() {
  return process.env.RKS_GUARDRAILS === "off";
}

export { PROJECT_DIR };
