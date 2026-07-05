#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Bash → Governor
 *
 * Intercepts ALL Bash tool calls and redirects through the Governor.
 * Bash commands must be orchestrated — the Governor picks the right
 * agent (git, run, etc.) based on the command.
 *
 * Output mechanism:
 *   Exit 0 + no output = allow (guardrails off only)
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.governor.hook-routing
 */
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

/**
 * Read-only CI observability allowlist.
 *
 * CI inspection is observability, not a governed mutation — the same class as
 * the read-only research/telemetry agents that already run under guardrails-on.
 * These commands (used by the /ci skill) are therefore permitted to run Bash
 * directly while guardrails are on. MUTATING gh (run rerun/cancel, workflow
 * run/dispatch, pr comment/edit/close/merge) is deliberately NOT listed and
 * continues to redirect to the Governor.
 *
 * Matching is ANCHORED on the leading command tokens after trim (never a
 * substring), and any shell control/redirection/chaining metacharacter rejects
 * the command outright — so an allowlisted prefix cannot smuggle a second
 * command (e.g. "gh run list && gh pr merge", "gh run list; rm -rf").
 */
function isReadOnlyCiCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  // Reject shell control / redirection / chaining so nothing can ride along.
  if (/[;&|`$(){}<>\\\n]/.test(cmd)) return false;
  return (
    /^gh\s+run\s+(list|view|download)(\s|$)/.test(cmd) ||
    /^node\s+scripts\/analyze-vitest-report\.mjs(\s|$)/.test(cmd)
  );
}

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "Bash") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const command = toolInput.command || "";

  // Read-only CI observability commands run directly under guardrails-on.
  if (isReadOnlyCiCommand(command)) process.exit(0);

  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-bash-to-governor",
    blocked: true,
    reason: "Bash commands must go through the Governor. See CLAUDE.md.",
    command: command.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: "Bash commands must go through the Governor, not run directly.",
    agent: "mcp__rks__rks_agent_run",
    agentParams: { projectId, command },
    instructions: [
      "Launch a Governor with the pattern from CLAUDE.md.",
      "Tell the Governor what command you need and why.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
