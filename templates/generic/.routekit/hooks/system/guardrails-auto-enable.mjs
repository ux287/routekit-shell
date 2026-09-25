#!/usr/bin/env node
/**
 * PostToolUse hook: auto-enable guardrails after a successful git commit
 * - Runs on Bash commands
 * - If a git commit succeeded and guardrails are disabled (file exists with enabled: false),
 *   this hook sets enabled: true and clears disabledAt, and logs the action.
 */
import fs from "fs";
import path from "path";
import yaml from "../lib/js-yaml.mjs";
import { appendTelemetry } from "./hook-output.mjs";

/**
 * Flatten a PostToolUse result payload to something string operations can match.
 *
 * Bash `tool_response` is an OBJECT { stdout, stderr, interrupted, isImage }. The
 * failure guards in this tier are string operations, so the object must be flattened
 * first — otherwise RegExp.test() silently coerces it to "[object Object]" and never
 * matches (and String.prototype.includes throws outright).
 *
 * @param {unknown} value
 * @returns {string}
 */
function toSearchableString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const parts = [];
    if (typeof value.stdout === "string") parts.push(value.stdout);
    if (typeof value.stderr === "string") parts.push(value.stderr);
    if (parts.length > 0) return parts.join("\n");
    try { return JSON.stringify(value); } catch { return ""; }
  }
  return String(value);
}

/**
 * Report a PostToolUse payload shape this hook cannot interpret.
 * Top-level KEY NAMES ONLY — never values, which may carry credential material.
 */
function reportUnknownPayloadShape(toolName, hookData, detail) {
  let keys = [];
  try { keys = Object.keys(hookData || {}).sort(); } catch { /* best-effort */ }
  process.stderr.write(
    `[guardrails-auto-enable] Unrecognized PostToolUse payload from ${toolName} (${detail}); ` +
      `top-level keys: ${keys.join(", ") || "<none>"}\n`,
  );
  try {
    appendTelemetry({
      event: "hook.payload_shape_unknown",
      hook: "guardrails-auto-enable",
      tool_name: toolName,
      detail,
      keys, // KEY NAMES ONLY
      timestamp: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GUARD_PATH = path.join(PROJECT_DIR, ".routekit", "guardrails.yaml");

function isGitCommitCommand(command) {
  return /\bgit\s+commit\b/.test(command);
}

function loadGuardFile() {
  if (!fs.existsSync(GUARD_PATH)) return null;
  try {
    const raw = fs.readFileSync(GUARD_PATH, "utf8");
    return yaml.load(raw) || {};
  } catch {
    return null;
  }
}

function writeGuardFile(obj) {
  try {
    const dir = path.dirname(GUARD_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GUARD_PATH, yaml.dump(obj), "utf8");
    return true;
  } catch {
    return false;
  }
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

  if (hookData.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = (hookData.tool_input || {}).command || "";
  if (!isGitCommitCommand(command)) {
    process.exit(0);
  }

  // Claude Code sends `tool_response`, never `tool_result` — reading the latter meant
  // this was always undefined, coerced to "", and the failure guard below could never
  // match. Consequence: guardrails auto-enabled after commits that actually FAILED.
  //
  // `??` selects the primary field but preserves a present-but-falsy response; the
  // outer `|| ""` still coerces null/undefined for the string match.
  //
  // toSearchableString is not optional: Bash tool_response is an OBJECT
  // { stdout, stderr, interrupted, isImage }, and RegExp.test(object) coerces to
  // "[object Object]" — so a bare field rename would leave this just as broken.
  const toolResult = toSearchableString(hookData.tool_response ?? hookData.tool_result) || "";
  if (hookData.tool_response === undefined && hookData.tool_result === undefined) {
    reportUnknownPayloadShape(hookData.tool_name || "Bash", hookData, "neither tool_response nor tool_result present");
  }
  // If commit failed, skip
  if (/error:|fatal:|Exit code/i.test(toolResult)) {
    process.stderr.write("Guardrails auto-enable: git commit appears to have failed, skipping.\n");
    process.exit(0);
  }

  const cfg = loadGuardFile();
  if (!cfg) {
    // Nothing to do
    process.exit(0);
  }

  if (cfg.enabled === false) {
    cfg.enabled = true;
    cfg.disabledAt = null;
    const ok = writeGuardFile(cfg);
    if (ok) {
      process.stderr.write("Guardrails auto-enabled after commit\n");
    } else {
      process.stderr.write("Guardrails auto-enable failed: could not write guardrails file\n");
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Guardrails auto-enable hook error: ${err.message}\n`);
  process.exit(0);
});
