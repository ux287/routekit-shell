#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect dendron MCP tools → Dendron Agent
 *
 * Intercepts direct calls to dendron MCP tools (dendron_create_note,
 * dendron_edit_note, dendron_read_note, dendron_update_field,
 * dendron_fix_frontmatter, dendron_validate_schema, dendron_mark_implemented)
 * and blocks with structured JSON redirecting to rks_agent_dendron.
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

const REDIRECTED_TOOLS = {
  "mcp__rks__dendron_create_note": "create note",
  "mcp__rks__dendron_edit_note": "edit note",
  "mcp__rks__dendron_read_note": "read note",
  "mcp__rks__dendron_update_field": "update field",
  "mcp__rks__dendron_fix_frontmatter": "fix frontmatter",
  "mcp__rks__dendron_validate_schema": "validate schema",
  "mcp__rks__dendron_mark_implemented": "mark implemented",
};

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (!REDIRECTED_TOOLS[toolName]) process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  if (toolInput._governorToken) process.exit(0);
  const projectId = toolInput.projectId || getProjectId();
  const desc = REDIRECTED_TOOLS[toolName];
  const request = toolInput.noteId || toolInput.name || toolInput.body?.slice(0, 100) || desc;

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-dendron-tools-to-agent",
    blocked: true,
    reason: `Note operations must go through a Governor. See CLAUDE.md for the Build pattern.`,
    originalTool: toolName,
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `${desc} redirected to Dendron Agent. Do not call ${toolName} directly.`,
    agent: "mcp__rks__rks_agent_dendron",
    agentParams: { projectId, request },
    instructions: [
      "Launch a Governor — it will use rks_agent_dendron for note CRUD.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
