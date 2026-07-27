#!/usr/bin/env node
/**
 * track-agent-provenance.mjs — PostToolUse hook
 *
 * Bridges the provenance gap between server-side agents and coordinator-level
 * enforcement. When an agent (Research, Git, PO) returns results containing
 * file paths, this hook extracts those paths and writes them to session state
 * via addRagSourcedPath(). This allows enforce-read-provenance to permit
 * subsequent reads of files the agent identified.
 *
 * Matcher: All mcp__rks__rks_agent_* tools (research, git, dendron, telemetry, ship, cycle-complete, story, delivery, recovery, etc.)
 */
import { addRagSourcedPath } from "../lib/session-state.mjs";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/**
 * Extract the agent's JSON result from the hook data.
 * PostToolUse hook data has tool_result which for MCP tools is
 * { content: [{ type: "text", text: "..." }] } or a plain string/object.
 */
function extractAgentResult(hookData) {
  // Try tool_result first (standard PostToolUse field)
  const toolResult = hookData.tool_result;
  if (toolResult) {
    // MCP content array: { content: [{ type: "text", text: "JSON string" }] }
    if (toolResult.content && Array.isArray(toolResult.content)) {
      const textBlock = toolResult.content.find(c => c.type === "text");
      if (textBlock && textBlock.text) {
        try { return JSON.parse(textBlock.text); } catch {}
      }
    }
    // Plain string
    if (typeof toolResult === "string") {
      try { return JSON.parse(toolResult); } catch {}
    }
    // Already parsed object with agent fields
    if (typeof toolResult === "object" && (toolResult.ok !== undefined || toolResult.sources || toolResult.answer)) {
      return toolResult;
    }
  }

  // Fallback: some hook formats embed result in tool_input
  const toolInput = hookData.tool_input || {};
  if (toolInput.result && typeof toolInput.result === "object") {
    return toolInput.result;
  }

  return null;
}

/**
 * Extract file paths from an agent result.
 * Handles different agent output shapes:
 *   Research: { sources: [{ file: "path", snippet: "..." }] }
 *   Git:      { data: { files: [{ path: "..." }], ... } }
 *   PO:       { sources: ["path1", "path2"] }
 */
function extractPaths(result) {
  const paths = new Set();

  if (!result || typeof result !== "object") return [];

  // Research Agent / PO Agent: sources array
  if (Array.isArray(result.sources)) {
    for (const src of result.sources) {
      if (!src) continue;
      if (typeof src === "string") {
        // PO agent: sources is string array
        if (looksLikeFilePath(src)) paths.add(src);
      } else if (typeof src === "object") {
        // Research agent: { file: "path", snippet: "..." }
        if (src.file) paths.add(String(src.file));
        if (src.path) paths.add(String(src.path));
      }
    }
  }

  // Git Agent: data object may contain file paths
  // Dendron Agent: data.path, data.filename
  // Ship/Story/Delivery/Recovery: data may contain various path fields
  if (result.data && typeof result.data === "object") {
    const data = result.data;
    // files array from git_state
    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        if (!f) continue;
        if (typeof f === "string") paths.add(f);
        else if (f.path) paths.add(String(f.path));
      }
    }
    // Single file field
    if (data.file) paths.add(String(data.file));
    // Dendron Agent: path and filename fields
    if (data.path) paths.add(String(data.path));
    if (data.filename && looksLikeFilePath(String(data.filename))) paths.add(String(data.filename));
    // Diff output may reference file paths
    if (data.diff && typeof data.diff === "string") {
      extractPathsFromText(data.diff, paths);
    }
    // targetFiles from plan/story agents
    if (Array.isArray(data.targetFiles)) {
      for (const f of data.targetFiles) {
        if (typeof f === "string" && looksLikeFilePath(f)) paths.add(f);
      }
    }
  }

  // Fallback: extract file-path-like strings from answer text
  if (result.answer && typeof result.answer === "string") {
    extractPathsFromText(result.answer, paths);
  }
  if (result.summary && typeof result.summary === "string") {
    extractPathsFromText(result.summary, paths);
  }

  return Array.from(paths).filter(p => p && looksLikeFilePath(p));
}

/**
 * Regex extraction of file paths from free text.
 * Matches patterns like "packages/mcp-rks/src/foo.mjs" or "notes/backlog.bar.md"
 */
function extractPathsFromText(text, pathSet) {
  const re = /((?:packages|src|notes|docs|\.routekit|\.rks|\.claude|templates|scripts|__tests__)\/[\w\-\.\/]+\.[a-zA-Z0-9_\-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pathSet.add(m[1]);
  }
}

function looksLikeFilePath(s) {
  return /\.[a-zA-Z0-9]+$/.test(s) && s.includes("/");
}

/**
 * Derive a provenance query string from the agent's input.
 */
function getProvenanceQuery(hookData) {
  const input = hookData.tool_input || {};
  // Research agent: query field
  if (input.query) return `agent:research "${input.query}"`;
  // Git agent: request field
  if (input.request) return `agent:git "${input.request}"`;
  // PO agent: problemId field
  if (input.problemId) return `agent:product-owner "${input.problemId}"`;
  // Generic: agent field + stringified input
  if (input.input && typeof input.input === "object") {
    return `agent:${input.agent || "unknown"} ${JSON.stringify(input.input).slice(0, 100)}`;
  }
  return `agent:${hookData.tool_name || "unknown"}`;
}

(async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name || hookData.tool || "";

  // Only process agent tool results
  const agentTools = [
    "rks_agent_run",
    "rks_agent_research",
    "rks_agent_validate_story",
    "rks_agent_git",
    "rks_agent_external_research",
    "rks_agent_dendron",
    "rks_agent_telemetry",
    "rks_agent_ship",
    "rks_agent_cycle_complete",
    "rks_agent_story",
    "rks_agent_delivery",
    "rks_agent_recovery",
  ];
  const isAgentTool = agentTools.some(t => toolName.includes(t));
  if (!isAgentTool) process.exit(0);

  const result = extractAgentResult(hookData);
  if (!result) {
    process.stderr.write(`[agent-provenance] No parseable result from ${toolName}\n`);
    process.exit(0);
  }

  const paths = extractPaths(result);
  const query = getProvenanceQuery(hookData);

  for (const p of paths) {
    try {
      addRagSourcedPath(p, query);
    } catch {
      // best-effort
    }
  }

  if (paths.length > 0) {
    process.stderr.write(`[agent-provenance] Tracked ${paths.length} paths from ${toolName}: ${paths.slice(0, 5).join(", ")}\n`);
  }

  process.exit(0);
})();
