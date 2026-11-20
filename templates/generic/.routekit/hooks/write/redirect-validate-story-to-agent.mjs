#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect rks_validate_story → Product Owner Agent
 *
 * Intercepts direct calls to mcp__rks__rks_validate_story and blocks with
 * structured JSON redirecting to mcp__rks__rks_agent_validate_story.
 *
 * Output mechanism:
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.governor.hook-routing
 */
import {
  readHookInput, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "mcp__rks__rks_validate_story") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const projectId = toolInput.projectId || "";
  const problemId = toolInput.problemId || "";

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-validate-story-to-agent",
    blocked: true,
    reason: `Story validation must go through a Governor. See CLAUDE.md for the Build pattern.`,
    problemId,
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `rks_validate_story redirected to Product Owner Agent. Do not call it directly.`,
    agent: "mcp__rks__rks_agent_validate_story",
    agentParams: { projectId, problemId },
    instructions: [
      "Launch a Governor — it will use rks_agent_validate_story.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
