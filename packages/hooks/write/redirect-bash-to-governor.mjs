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
    /^node\s+scripts\/analyze-vitest-report\.mjs(\s|$)/.test(cmd) ||
    // Read-only git inspection the Dispatcher runs constantly (git-state checks, /ci).
    // The bare verbs are read-only regardless of trailing args.
    /^git\s+(status|log|rev-parse|show|diff)(\s|$)/.test(cmd) ||
    // `git branch` is a mode-multiplexer, so this is TERMINAL-anchored: the whole command
    // must be `git branch` + only read-only flags + end-of-string. A trailing mutating flag
    // (`git branch -v -d foo`) breaks the group and does NOT match → redirect. Bare
    // `git branch` (lists) matches; `git branch <name>` (create) does not.
    /^git\s+branch(\s+(--list|--show-current|-a|-r|-v|-l))*\s*$/.test(cmd)
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

  // Preserve guardrail-bump attribution WITHOUT re-emitting the raw command.
  //
  // emitGuardrailBump derives the blocked-tool name as
  //   blockedTool || agentParams.tool || <first token of agentParams.command>
  // (hook-output.mjs). Passing `tool` explicitly resolves to the SAME value the
  // command-derivation produced, so dashboards aggregating on it are unchanged —
  // while `command` no longer has to appear in agentParams at all.
  const commandTool = command.trim().split(/\s+/)[0] || "Bash";

  denyWithRedirect(buildRedirectOutput({
    reason: "Bash commands must go through the Governor, not run directly.",
    // NOT an MCP tool name. This previously said "mcp__rks__rks_agent_run", which
    // cannot service a shell command: its schema is { agent, input } and it dispatches
    // LLM agents from a registry, none of whose input schemas accepts a command string.
    // There is NO ad-hoc command-execution tool available to a Governor, so naming one
    // sent every Bash redirect to a dead end. Two Governors followed it and stalled;
    // a human ran the commands manually. Describe what IS possible instead.
    agent: "governor",
    agentParams: { projectId, tool: commandTool },
    instructions: [
      "There is NO ad-hoc command-execution tool. Do NOT call mcp__rks__rks_agent_run —",
      "it dispatches LLM agents, not shell commands, and will not run this.",
      "",
      "What IS available, in order of preference:",
      "1. Read-only inspection runs directly, no redirect: gh run list|view|download,",
      "   node scripts/analyze-vitest-report.mjs, git status|log|rev-parse|show|diff,",
      "   and read-only forms of git branch. Re-check your command against that list.",
      "2. If the command is part of implementing a story, it belongs in a plan as a",
      "   run_command step, executed via rks_exec — that is the only sanctioned path",
      "   to a shell in this repo.",
      "3. Test runs are driven by a story's testFiles frontmatter, not invoked ad hoc.",
      "4. Otherwise, ask the user to run it in their terminal and paste the output.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
