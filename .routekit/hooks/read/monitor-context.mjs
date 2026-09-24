#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: Monitor Context Window Usage
 *
 * Tracks cumulative context usage across tool calls and warns
 * when approaching context window limits. Helps prevent context
 * exhaustion during long autonomous execution cycles.
 *
 * Exit codes:
 *   0 = allow (always - this is advisory only)
 *
 * Output:
 *   Warnings written to stderr when thresholds are reached
 */
import fs from "fs";
import path from "path";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "context-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      warning_threshold_percent: 80,
      critical_threshold_percent: 95,
      suggest_summarize_at: 70,
      track_tools: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"],
      estimated_context_limit: 200000,
      token_estimation: {
        Read: { per_line: 10, max_estimate: 50000 },
        Grep: { per_match: 50, max_estimate: 10000 },
        Glob: { per_file: 15, max_estimate: 5000 },
        Bash: { per_line: 8, max_estimate: 20000 },
        WebFetch: { per_response: 5000, max_estimate: 10000 },
        WebSearch: { per_result: 200, max_estimate: 3000 },
      },
      state_file: ".routekit/context-state.json",
      suggestions: {
        at_70_percent: [
          "Consider summarizing completed work before continuing",
          "Break remaining tasks into smaller focused steps",
        ],
        at_80_percent: [
          "Context is filling up - prioritize essential reads only",
          "Use targeted RAG queries instead of broad file searches",
        ],
        at_95_percent: [
          "Critical: Complete current task and commit progress",
          "Consider starting a new session for remaining work",
        ],
      },
    };
  }
  const content = fs.readFileSync(CONFIG_PATH, "utf8");
  return yaml.load(content) || {};
}

function loadState(statePath) {
  const fullPath = path.join(PROJECT_DIR, statePath);
  if (!fs.existsSync(fullPath)) {
    return {
      session_start: Date.now(),
      estimated_tokens: 0,
      tool_calls: [],
      last_warning_level: null,
    };
  }
  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const state = JSON.parse(content);
    // Check if session is stale (more than 2 hours old)
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (Date.now() - state.session_start > TWO_HOURS) {
      return {
        session_start: Date.now(),
        estimated_tokens: 0,
        tool_calls: [],
        last_warning_level: null,
      };
    }
    return state;
  } catch {
    return {
      session_start: Date.now(),
      estimated_tokens: 0,
      tool_calls: [],
      last_warning_level: null,
    };
  }
}

function saveState(statePath, state) {
  const fullPath = path.join(PROJECT_DIR, statePath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(state, null, 2));
}

function estimateTokens(toolName, toolOutput, config) {
  const estimation = config.token_estimation?.[toolName];
  if (!estimation) {
    // Default estimation for unknown tools
    const outputLength = typeof toolOutput === "string" ? toolOutput.length : JSON.stringify(toolOutput || "").length;
    return Math.min(Math.ceil(outputLength / 4), 5000);
  }

  let estimate = 0;

  if (toolName === "Read") {
    // Estimate based on line count
    const lines = typeof toolOutput === "string" ? toolOutput.split("\n").length : 0;
    estimate = lines * estimation.per_line;
  } else if (toolName === "Grep") {
    // Estimate based on match count
    const matches = typeof toolOutput === "string" ? (toolOutput.match(/\n/g) || []).length + 1 : 1;
    estimate = matches * estimation.per_match;
  } else if (toolName === "Glob") {
    // Estimate based on file count
    const files = typeof toolOutput === "string" ? (toolOutput.match(/\n/g) || []).length + 1 : 1;
    estimate = files * estimation.per_file;
  } else if (toolName === "Bash") {
    // Estimate based on output lines
    const lines = typeof toolOutput === "string" ? toolOutput.split("\n").length : 0;
    estimate = lines * estimation.per_line;
  } else if (toolName === "WebFetch") {
    estimate = estimation.per_response;
  } else if (toolName === "WebSearch") {
    // Estimate based on result count (rough)
    const results = typeof toolOutput === "string" ? (toolOutput.match(/https?:\/\//g) || []).length : 1;
    estimate = results * estimation.per_result;
  }

  return Math.min(estimate, estimation.max_estimate);
}

function getWarningLevel(percent, config) {
  if (percent >= config.critical_threshold_percent) return "critical";
  if (percent >= config.warning_threshold_percent) return "warning";
  if (percent >= config.suggest_summarize_at) return "suggest";
  return null;
}

function getSuggestions(level, config) {
  const suggestions = config.suggestions || {};
  if (level === "critical") return suggestions.at_95_percent || [];
  if (level === "warning") return suggestions.at_80_percent || [];
  if (level === "suggest") return suggestions.at_70_percent || [];
  return [];
}

function formatWarning(level, percent, suggestions) {
  const icons = {
    suggest: "\u{1F4CA}",    // chart
    warning: "\u26A0\uFE0F", // warning
    critical: "\u{1F6A8}",  // rotating light
  };
  const headers = {
    suggest: "Context Window Advisory",
    warning: "Context Window Warning",
    critical: "CRITICAL: Context Window Near Limit",
  };

  let output = `\n${icons[level]} ${headers[level]} (${percent.toFixed(1)}% estimated usage)\n`;
  output += `${"─".repeat(50)}\n`;

  if (suggestions.length > 0) {
    output += "Recommendations:\n";
    suggestions.forEach((s) => {
      output += `  • ${s}\n`;
    });
  }

  output += "\n";
  return output;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolOutput = hookData.tool_output || "";

  const config = loadConfig();
  const trackTools = config.track_tools || ["Read", "Grep", "Glob", "Bash"];

  // Only track specified tools
  if (!trackTools.includes(toolName)) {
    process.exit(0);
  }

  const statePath = config.state_file || ".routekit/context-state.json";
  const state = loadState(statePath);

  // Estimate tokens from this tool call
  const newTokens = estimateTokens(toolName, toolOutput, config);
  state.estimated_tokens += newTokens;

  // Track the call
  state.tool_calls.push({
    tool: toolName,
    tokens: newTokens,
    timestamp: Date.now(),
  });

  // Keep only last 100 tool calls to avoid state bloat
  if (state.tool_calls.length > 100) {
    state.tool_calls = state.tool_calls.slice(-100);
  }

  // Calculate percentage
  const contextLimit = config.estimated_context_limit || 200000;
  const percent = (state.estimated_tokens / contextLimit) * 100;

  // Determine warning level
  const level = getWarningLevel(percent, config);

  // Only warn if we've crossed a new threshold
  if (level && level !== state.last_warning_level) {
    const suggestions = getSuggestions(level, config);
    const warning = formatWarning(level, percent, suggestions);
    process.stderr.write(warning);
    state.last_warning_level = level;
  }

  // Save updated state
  saveState(statePath, state);

  // PostToolUse hooks should always exit 0 (advisory only)
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Context monitor error: ${err.message}\n`);
  process.exit(0);
});
