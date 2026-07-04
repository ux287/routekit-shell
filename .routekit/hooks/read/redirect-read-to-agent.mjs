#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Read → Research Agent
 *
 * Intercepts Read tool calls and blocks unless the file has established
 * provenance (RAG-sourced, user-specified, plan target, or runtime config).
 *
 * Off-rail session scope enforcement:
 *   When an active off-rail session exists (.rks/active-scope.json), reads
 *   are restricted to the session's allowedFiles. Any file outside that list
 *   is hard-denied with a redirect to the Research Governor. This prevents
 *   the off-rail escape hatch from being used as a general-purpose file reader.
 *
 * Allowed reads (no active off-rail session):
 * - runtime_paths from read-policy.yaml (infrastructure files)
 * - Files identified by Research Agent (RAG-sourced in session state)
 * - Files explicitly mentioned by the user
 * - Files listed in the current plan's targetFiles
 *
 * Output mechanism:
 *   Exit 0 + no output = allow (provenance established or guardrails off)
 *   Exit 0 + JSON hookSpecificOutput = deny with redirect via additionalContext
 *
 * @see backlog.feat.hook-off-rail-read-scope-enforcement
 */
import fs from "fs";
import path from "path";
import { hasValidProvenance, getPhase } from "../../../node_modules/@routekit/mcp-rks/src/shared/session-state.mjs";
import {
  getProjectId, appendTelemetry,
  buildRedirectOutput, denyWithRedirect, isGuardrailsOff, PROJECT_DIR,
} from "../system/hook-output.mjs";
const POLICY_PATH = path.join(PROJECT_DIR, ".routekit", "read-policy.yaml");
const SCOPE_FILE = path.join(PROJECT_DIR, ".rks", "active-scope.json");

function isFileInActiveScope(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    const allowed = Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
    if (!allowed.length) return false;
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_DIR, filePath);
    return allowed.some(f => {
      const a = path.isAbsolute(f) ? f : path.resolve(PROJECT_DIR, f);
      return abs === a;
    });
  } catch { return false; }
}

function readAllowedFiles() {
  try {
    const data = JSON.parse(fs.readFileSync(SCOPE_FILE, "utf8"));
    return Array.isArray(data.allowedFiles) ? data.allowedFiles : [];
  } catch { return []; }
}

function loadRuntimePaths() {
  const defaults = [
    ".routekit/*.yaml",
    ".routekit/hooks/*",
    "package.json",
    "tsconfig.json",
    ".mcp.json",
    "CLAUDE.md",
    ".rks/*.yaml",
    ".rks/runs/*",
    ".rks/session/*",
    ".claude/*",
  ];

  try {
    if (!fs.existsSync(POLICY_PATH)) return defaults;
    const text = fs.readFileSync(POLICY_PATH, "utf8");
    const paths = [];
    let inRuntimePaths = false;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "runtime_paths:") {
        inRuntimePaths = true;
        continue;
      }
      if (inRuntimePaths) {
        if (trimmed.startsWith("- ")) {
          paths.push(trimmed.slice(2).replace(/^["']|["']$/g, ""));
        } else if (trimmed && !trimmed.startsWith("#")) {
          break;
        }
      }
    }
    return paths.length > 0 ? paths : defaults;
  } catch {
    return defaults;
  }
}

function matchesRuntimePath(relativePath, patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(
      "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*") +
      "$"
    );
    if (regex.test(relativePath)) return true;
  }
  return false;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolName = hookData.tool_name;
  if (toolName !== "Read") process.exit(0);

  const toolInput = hookData.tool_input || {};
  const filePath = toolInput.file_path;

  if (!filePath) {
    process.exit(0);
  }

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(PROJECT_DIR, filePath);
  const relativePath = path.relative(PROJECT_DIR, absolutePath);

  if (relativePath.startsWith("..")) {
    process.exit(0);
  }

  const shortPath =
    relativePath.length > 80
      ? "..." + relativePath.slice(-77)
      : relativePath;

  // 0. Off-rail session scope enforcement (takes precedence over all other checks).
  //    When active-scope.json exists, only allowedFiles may be read directly.
  //    Everything else routes to the Research Governor — the off-rail escape hatch
  //    is for implementation only, not general-purpose file browsing.
  const scopeActive = fs.existsSync(SCOPE_FILE);
  if (scopeActive) {
    if (isFileInActiveScope(absolutePath)) {
      process.exit(0); // In scope — implementation read, allow
    }

    // Outside scope — hard deny + handoff to Research Governor
    const allowed = readAllowedFiles();
    const projectId = getProjectId();

    appendTelemetry({
      ts: new Date().toISOString(),
      hook: "redirect-read-to-agent",
      blocked: true,
      reason: "off-rail scope: file outside allowedFiles",
      path: relativePath,
      projectId,
    });

    denyWithRedirect(buildRedirectOutput({
      reason: `BLOCKED: "${shortPath}" is outside your off-rail session scope (allowedFiles: ${JSON.stringify(allowed)}). Route reads outside allowedFiles through the Research Governor.`,
      agent: "mcp__rks__rks_agent_research",
      agentParams: { projectId, query: `contents and purpose of ${shortPath}` },
      instructions: [
        `Call rks_governor_init({ projectId: '${projectId}', flowType: 'open' }) then rks_agent_research({ query: 'contents and purpose of ${shortPath}' }).`,
        "Research Governor reads with provenance, cites sources, and returns a trusted answer. That is the path forward.",
      ],
      project: projectId,
    }));
    return;
  }

  // 1. No active off-rail session — check global guardrails state
  if (isGuardrailsOff()) process.exit(0);

  // 2. Check runtime_paths — infrastructure files always allowed
  const runtimePaths = loadRuntimePaths();
  if (matchesRuntimePath(relativePath, runtimePaths)) {
    process.exit(0);
  }

  // 3. Check session-state provenance (RAG-sourced, user-specified, plan targets)
  const provenance = hasValidProvenance(relativePath);
  if (provenance.valid) {
    process.exit(0);
  }

  // 4. No provenance — block and redirect to Research Agent
  const projectId = getProjectId();

  appendTelemetry({
    ts: new Date().toISOString(),
    hook: "redirect-read-to-agent",
    blocked: true,
    reason: `Use a Governor to read files. See CLAUDE.md for the Verify pattern (max_turns: 10).`,
    path: relativePath,
    projectId,
  });

  const query = `contents and purpose of ${shortPath}`;

  denyWithRedirect(buildRedirectOutput({
    reason: `No provenance for "${shortPath}". Discovery reads must go through the Research Agent.`,
    agent: "mcp__rks__rks_agent_research",
    agentParams: { projectId, query },
    instructions: [
      "Launch a Governor with the Verify pattern from CLAUDE.md.",
      "Tell the Governor which file and what information you need from it.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
