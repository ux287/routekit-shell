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

  const toolResult = hookData.tool_result || "";
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
