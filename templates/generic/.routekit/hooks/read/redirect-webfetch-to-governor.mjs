#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect WebFetch → Governor
 *
 * Intercepts ALL WebFetch tool calls and redirects to the Governor.
 * The Dispatcher does not fetch external URLs directly.
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

  if (toolName !== "WebFetch") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const url = toolInput.url || "";
  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-webfetch-to-governor",
    blocked: true,
    reason: `Web access must go through a Governor. See CLAUDE.md for the Build pattern.`,
    url: url.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: "WebFetch must go through the Governor. Do not fetch URLs directly.",
    agent: "governor",
    agentParams: { projectId, query: "fetch " + url.slice(0, 150) },
    instructions: [
      "Launch a Governor and include the URL and what information you need.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
