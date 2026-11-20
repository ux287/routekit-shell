#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect WebSearch → External Research Agent
 *
 * Intercepts WebSearch tool calls and blocks with structured JSON redirecting
 * to mcp__rks__rks_agent_external_research.
 *
 * Output mechanism:
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.governor.hook-routing
 */
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "WebSearch") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const query = toolInput.query || "";
  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-websearch-to-agent",
    blocked: true,
    reason: `Web search must go through a Governor. See CLAUDE.md for the Build pattern.`,
    query: query.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `WebSearch redirected to External Research Agent. Do not call WebSearch directly.`,
    agent: "mcp__rks__rks_agent_external_research",
    agentParams: { projectId, query: query.slice(0, 150) },
    instructions: [
      "Launch a Governor and include your search query and what you need to learn.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
