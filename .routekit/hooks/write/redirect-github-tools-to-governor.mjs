#!/usr/bin/env node
import {
  readHookInput,
  isGuardrailsOff,
  buildRedirectOutput,
  denyWithRedirect,
  getProjectId,
} from "../../../packages/hooks/system/hook-output.mjs";

const BLOCKED_TOOLS = new Set([
  "mcp__github__create_or_update_file",
  "mcp__github__push_files",
  "mcp__github__merge_pull_request",
]);

const hookData = await readHookInput();
const { tool_name, tool_input = {} } = hookData;

if (!BLOCKED_TOOLS.has(tool_name)) process.exit(0);
if (isGuardrailsOff()) process.exit(0);
if (tool_input._governorToken) process.exit(0);

denyWithRedirect(buildRedirectOutput({
  reason: "GitHub write tools require a governed Ship Governor session",
  agent: "mcp__rks__rks_agent_ship",
  agentParams: { projectId: getProjectId() },
  instructions: [
    "Initialize a Ship Governor first: rks_governor_init({ flowType: 'ship' })",
    "Then retry the GitHub tool call with _governorToken included in tool_input",
  ],
}));
