#!/usr/bin/env node
/**
 * block-vitest-background.mjs — PreToolUse hook (system tier)
 *
 * Blocks any Bash call that runs `vitest run` with run_in_background: true.
 * Background vitest launches produce empty output files while running, causing
 * polling loops, cascading rg/node processes, and CPU thrash.
 *
 * Exit 0 + JSON stdout (deny) = blocked
 * Exit 0 (no output)          = allow
 */

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

  const isBackground = hookData.tool_input?.run_in_background === true;
  if (!isBackground) process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "BLOCKED: vitest run must be called synchronously. Use a single foreground call with a timeout. See CLAUDE.md § Test Execution.",
      additionalContext:
        "Run vitest synchronously, read the output once when it exits. No background. No monitor. No retry loop.",
    },
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
