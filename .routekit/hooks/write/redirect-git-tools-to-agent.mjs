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

  // rks_stash is routed differently from the rest: the git agent CANNOT create a stash, and a
  // stash it did create would have no restore path. The tokened rks_stash MCP tool is the only
  // path that registers an auto-pop against the Governor session, so that is where a stash
  // intent must go. The deny is unchanged — only the destination differs.
  const isStash = toolName === "mcp__rks__rks_stash";

  denyWithRedirect(buildRedirectOutput({
    reason: isStash
      ? `${desc} must go through the tokened rks_stash tool, not the Git Agent — the agent cannot create a stash and cannot register an auto-pop. Do not call ${toolName} without a Governor session.`
      : `${desc} redirected to Git Agent. Do not call ${toolName} directly.`,
    agent: isStash ? "mcp__rks__rks_governor_init" : "mcp__rks__rks_agent_git",
    agentParams: isStash ? { projectId } : { projectId, request },
    instructions: isStash
      ? [
          "Call rks_governor_init to obtain a session token, then call rks_stash with _governorToken.",
          "That path registers an auto-pop so the stash cannot be abandoned when the session ends.",
        ]
      : [
          "Launch a Governor — it will use rks_agent_git for git operations.",
        ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
