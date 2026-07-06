#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect NotebookEdit → Governor
 *
 * Intercepts ALL NotebookEdit tool calls and redirects to the Governor.
 * NotebookEdit is functionally equivalent to Edit/Write but had no
 * enforcement hooks — this closes that gap.
 *
 * Output mechanism:
 *   Exit 0 + no output = allow (guardrails off only)
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 */
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "NotebookEdit") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const notebookPath = toolInput.notebook_path || "";
  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-notebookedit-to-governor",
    blocked: true,
    reason: `File changes must go through a Governor. See CLAUDE.md for the Build pattern (max_turns: 80).`,
    path: notebookPath.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: "NotebookEdit must go through the Governor. Do not edit notebooks directly.",
    agent: "governor",
    agentParams: { projectId, query: "edit notebook " + notebookPath.slice(0, 150) },
    instructions: [
      "Launch a Governor with the Build pattern from CLAUDE.md.",
      "Be specific about what to create or modify and the expected outcome.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
