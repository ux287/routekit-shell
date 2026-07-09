#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect RAG MCP tools → Research Agent
 *
 * Intercepts direct calls to RAG/KG query tools and redirects to the
 * Research Agent. The agent provides structured answers with sources,
 * confidence scores, and provenance tracking — raw RAG queries don't.
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
  "mcp__rks__rks_rag_query": "RAG query",
  "mcp__rks__rks_kg_query": "knowledge graph query",
};

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;

  if (!REDIRECTED_TOOLS[toolName]) process.exit(0);
  if (isGuardrailsOff()) process.exit(0);

  const toolInput = hookData.tool_input || {};
  if (toolInput._governorToken) process.exit(0);
  const projectId = toolInput.projectId || getProjectId();
  const query = toolInput.q || toolInput.query || toolInput.question || "";
  const desc = REDIRECTED_TOOLS[toolName];

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-rag-tools-to-agent",
    blocked: true,
    reason: `RAG operations must go through a Governor. See CLAUDE.md for the Build pattern.`,
    originalTool: toolName,
    query: query.slice(0, 200),
    projectId,
  });

  denyWithRedirect(buildRedirectOutput({
    reason: `${desc} redirected to Research Agent. Do not call ${toolName} directly.`,
    agent: "mcp__rks__rks_agent_research",
    agentParams: { projectId, query: query.slice(0, 150) },
    instructions: [
      "Launch a Governor — it will use rks_agent_research for RAG queries.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
