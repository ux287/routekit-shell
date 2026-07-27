#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect git MCP tools → Git Agent
 *
 * Intercepts direct calls to git MCP tools (rks_git_commit, rks_git_branch,
 * rks_checkout, rks_git_merge, rks_git_state, rks_stash, rks_restore) and
 * blocks with structured JSON redirecting to rks_agent_git.
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
  "mcp__rks__rks_git_commit": "git commit",
  "mcp__rks__rks_git_branch": "git branch",
  "mcp__rks__rks_checkout": "git checkout",
  "mcp__rks__rks_git_merge": "git merge",
  "mcp__rks__rks_git_state": "git state",
  "mcp__rks__rks_stash": "git stash",
  "mcp__rks__rks_restore": "git restore",
  "mcp__rks__rks_cherry_pick": "git cherry-pick",
  "mcp__rks__rks_tag": "git tag",
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
  const request = toolInput.message || toolInput.branch || toolInput.ref || desc;

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-git-tools-to-agent",
    blocked: true,
    reason: `Git operations must go through a Governor. See CLAUDE.md for the Build pattern.`,
    originalTool: toolName,
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `${desc} redirected to Git Agent. Do not call ${toolName} directly.`,
    agent: "mcp__rks__rks_agent_git",
    agentParams: { projectId, request },
    instructions: [
      "Launch a Governor — it will use rks_agent_git for git operations.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
