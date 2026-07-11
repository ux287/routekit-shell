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
 * Emit a `hook.guardrail_bump` event to the SERVER telemetry sink (.rks/telemetry) so that
 * client-side hook blocks/redirects ("guardrail bumps") become observable in the dashboard
 * trust panel — the SAME sink and canonical {id,type,timestamp,projectId,payload} envelope the
 * MCP server + readers use (NOT the orphaned .routekit/telemetry/guardrails.log). This is the
 * client-side half of hook/chain-violation telemetry (server-side chain.violation already emits
 * from governor-token.mjs). Best-effort: a telemetry failure must NEVER break the redirect.
 * @param {object} opts { reason, redirectAgent, agentParams, blockedTool, projectId, projectDir }
 */
export function emitGuardrailBump({ reason, redirectAgent, agentParams, blockedTool, projectId, projectDir } = {}) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, ".rks", "telemetry");
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `events-${date}.jsonl`);

    let scope = null;
    try {
      scope = JSON.parse(fs.readFileSync(path.join(root, ".rks", "active-scope.json"), "utf8"));
    } catch {
      /* no active scope */
    }

    const hookName = process.argv && process.argv[1]
      ? path.basename(process.argv[1]).replace(/\.mjs$/, "")
      : null;
    const tool = blockedTool
      || (agentParams && agentParams.tool)
      || (agentParams && typeof agentParams.command === "string" ? agentParams.command.trim().split(/\s+/)[0] : null)
      || null;

    const event = {
      id: `gb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "hook.guardrail_bump",
      timestamp: new Date().toISOString(),
      projectId: projectId || getProjectId(),
      payload: {
        hookName,
        blockedTool: tool,
        redirectAgent: redirectAgent || null,
        reason: reason || null,
        problemId: scope ? scope.problemId || null : null,
        tier: scope ? scope.tier || null : null,
        sessionId: scope ? scope.sessionId || null : null,
        context: agentParams != null ? agentParams : null,
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort: telemetry must never break the redirect
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

  // Observe the guardrail bump (best-effort; never breaks the redirect).
  try {
    emitGuardrailBump({ reason, redirectAgent: agent, agentParams, projectId });
  } catch {
    /* never break the redirect */
  }

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

// backlog.fix.hook-fallthrough-on-research-agent-outage
// How long an outage breadcrumb is honored. Past this the hooks fail closed (redirect) even if the
// breadcrumb is still on disk — a stale breadcrumb must never leave the read boundary open.
const OUTAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fail-closed reader for the Research-Agent outage breadcrumb the agent runner writes when a
 * research invocation fails with a genuine INFRASTRUCTURE error. Returns `{ active:true, category }`
 * ONLY when a well-formed breadcrumb exists AND is within TTL. Every edge — missing, unreadable,
 * malformed, future-dated, or stale (past TTL) — returns `false` so the caller redirects. This is
 * the security-sensitive gate: mis-reading a normal state as an outage would open a general read
 * bypass, so it defaults to "not an outage".
 *
 * @param {string} [projectDir]
 * @returns {{active:true, category:string}|false}
 */
export function isResearchAgentOutage(projectDir) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const file = path.join(root, ".rks", "telemetry", "research-agent-outage.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Date.parse(data && data.timestamp);
    if (!Number.isFinite(ts)) return false;          // malformed timestamp → fail closed
    const age = Date.now() - ts;
    if (age < 0 || age > OUTAGE_TTL_MS) return false; // future-dated or stale → fail closed
    const category = typeof data.category === "string" && data.category ? data.category : "unknown";
    return { active: true, category };
  } catch {
    return false; // missing / unreadable / invalid JSON → fail closed
  }
}

/**
 * Audit a Research-Agent outage fallthrough (a bounded direct read permitted because the agent is
 * down). Distinct reason `research_agent_outage_fallthrough`, recording tool + path + category, to
 * the same server telemetry sink as guardrail bumps. Best-effort — never breaks the read.
 */
export function emitOutageFallthrough({ blockedTool, targetPath, category, projectDir, projectId } = {}) {
  try {
    const root = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(root, ".rks", "telemetry");
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `events-${date}.jsonl`);
    const hookName = process.argv && process.argv[1]
      ? path.basename(process.argv[1]).replace(/\.mjs$/, "")
      : null;
    const event = {
      id: `rof-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "hook.research_agent_outage_fallthrough",
      timestamp: new Date().toISOString(),
      projectId: projectId || getProjectId(),
      payload: {
        reason: "research_agent_outage_fallthrough",
        hookName,
        blockedTool: blockedTool || null,
        path: targetPath || null,
        category: category || "unknown",
      },
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8" });
  } catch {
    // best-effort: audit must never break the read
  }
}

export { PROJECT_DIR };
