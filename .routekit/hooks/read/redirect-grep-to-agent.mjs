#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Grep → Research Agent
 *
 * Intercepts ALL Grep tool calls and redirects to the Research Agent.
 * Grep is a discovery tool — content search across the codebase is exactly
 * what the Research Agent does, but with RAG context, synthesis, and
 * structured results instead of raw grep output flooding the coordinator.
 *
 * No exceptions: all code search goes through the Research Agent.
 *
 * Output mechanism:
 *   Exit 0 + no output = allow (guardrails off only)
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.governor.hook-routing
 */
import fs from "fs";
import path from "path";
import { getPhase } from "../../../node_modules/@routekit/mcp-rks/src/shared/session-state.mjs";
import {
  readHookInput, getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff, PROJECT_DIR,
} from "../system/hook-output.mjs";

const SCOPE_FILE = path.join(PROJECT_DIR, ".rks", "active-scope.json");

// Allow if the search path is or contains any scoped file
function isPathInActiveScope(searchPath) {
  try {
    const data = JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    const allowed = Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
    if (!allowed.length) return false;
    const absSearch = path.isAbsolute(searchPath) ? searchPath : path.resolve(PROJECT_DIR, searchPath);
    return allowed.some(f => {
      const a = path.isAbsolute(f) ? f : path.resolve(PROJECT_DIR, f);
      return a === absSearch || a.startsWith(absSearch + path.sep);
    });
  } catch { return false; }
}

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (toolName !== "Grep") process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  const pattern = toolInput.pattern || "";
  const searchPath = toolInput.path || ".";

  if (isPathInActiveScope(searchPath)) process.exit(0);
  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-grep-to-agent",
    blocked: true,
    reason: `Use a Governor to search code. See CLAUDE.md for the Verify pattern (max_turns: 10).`,
    pattern: pattern.slice(0, 200),
    path: searchPath,
    projectId,
  });

  const query = pattern
    ? `search for "${pattern.slice(0, 100)}" in ${searchPath}`
    : `search codebase in ${searchPath}`;

  denyWithRedirect(buildRedirectOutput({
    reason: `Code search must go through the Research Agent, not direct Grep.`,
    agent: "mcp__rks__rks_agent_research",
    agentParams: { projectId, query },
    instructions: [
      "Launch a Governor with the Verify pattern from CLAUDE.md.",
      "Tell the Governor what pattern you are searching for and why.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
