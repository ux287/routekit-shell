#!/usr/bin/env node
/**
 * block-concurrent-vitest.mjs — PreToolUse hook (system tier)
 *
 * Blocks a second `vitest run` Bash command when one is already running.
 * Uses RKS_MOCK_VITEST_RUNNING env var for test mocking.
 *
 * Exit 0 + JSON stdout (deny) = vitest already running, block the command
 * Exit 0 (no output)          = allow
 */
import { spawnSync } from "node:child_process";

function isVitestRunning() {
  if (process.env.RKS_MOCK_VITEST_RUNNING === "1") return true;
  if (process.env.RKS_MOCK_VITEST_RUNNING === "0") return false;
  const result = spawnSync("pgrep", ["-f", "vitest run"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function main() {
  let hookData;
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (hookData.tool_name !== "Bash") process.exit(0);

  const command = hookData.tool_input?.command || "";
  if (!command.includes("vitest run")) process.exit(0);

  if (!isVitestRunning()) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "BLOCKED: vitest process is already running. Wait for the current run to complete before launching another.",
      additionalContext:
        "Only one vitest run may execute at a time. See CLAUDE.md ## Test Execution.",
    },
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
