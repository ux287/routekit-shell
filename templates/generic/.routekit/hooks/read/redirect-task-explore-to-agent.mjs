#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Task → Governor
 *
 * Intercepts ALL Task tool calls. Sub-agents of ANY type (Explore,
 * general-purpose, Bash, Plan, claude-code-guide, statusline-setup)
 * run in isolated context where PreToolUse hooks do not fire — meaning
 * every redirect, enforcement, and provenance hook is completely bypassed.
 *
 * The ONLY exception: Governor launches matching the exact pattern from
 * CLAUDE.md (subagent_type "general-purpose" + Governor prompt signature).
 * These are allowed through because the Governor IS the governance layer.
 *
 * Output mechanism:
 *   Exit 0 + no output = allow (Governor launch or guardrails off)
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.hooks.block-all-task-subagents
 */
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff,
} from "../system/hook-output.mjs";

/**
 * Check if this Task call matches the Governor launch pattern from CLAUDE.md.
 * All three signals must match:
 * 1. subagent_type is "general-purpose"
 * 2. prompt contains "You are the Governor"
 * 3. prompt contains "MCP tools in sequence"
 */
function isGovernorLaunch(toolInput) {
  const subagentType = toolInput.subagent_type || "";
  const prompt = toolInput.prompt || "";

  return (
    subagentType === "general-purpose" &&
    prompt.includes("You are the Governor") &&
    prompt.includes("MCP tools in sequence")
  );
}

/**
 * Extract a meaningful query from the Task tool input.
 */
function extractQuery(toolInput) {
  const prompt = toolInput.prompt || "";
  const description = toolInput.description || "";
  const source = prompt || description;
  if (source) {
    const truncated = source.slice(0, 200);
    return truncated.length < source.length
      ? truncated.replace(/[^.!?\n]*$/, "").trim() || truncated.trim()
      : truncated.trim();
  }
  return "task sub-agent request";
}

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "Task") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};

  // Allow Governor launches through — they ARE governance
  if (toolInput.resume) process.exit(0);
  if (isGovernorLaunch(toolInput)) process.exit(0);

  const projectId = getProjectId();
  const subagentType = toolInput.subagent_type || "unknown";
  const query = extractQuery(toolInput);

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-task-to-governor",
    blocked: true,
    reason: `Sub-agent work must go through a Governor. See CLAUDE.md for Build/Verify/Debug patterns.`,
    subagentType,
    query: query.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `Task:${subagentType} sub-agents bypass ALL governance hooks. Launch a Governor instead.`,
    agent: "governor",
    agentParams: { projectId, query },
    instructions: [
      "Only Governor launches are allowed (subagent_type: general-purpose, prompt includes "You are the Governor").",
      "See CLAUDE.md for the right pattern: Build (max_turns: 80), Verify (max_turns: 10), Debug (max_turns: 40).",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
