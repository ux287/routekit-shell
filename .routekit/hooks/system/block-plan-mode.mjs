#!/usr/bin/env node
/**
 * block-plan-mode.mjs — PreToolUse hook (system tier)
 *
 * Blocks EnterPlanMode in rks projects. Plan mode is never appropriate here:
 * the rks workflow (PO → QA → ARCH → build) replaces everything plan mode
 * provides, and all write hooks prevent direct implementation anyway.
 *
 * Redirects to /research (investigation) or /pipeline (implementation).
 *
 * Exit codes:
 *   0 = pass-through for any tool other than EnterPlanMode
 *   2 = block EnterPlanMode with redirect message
 */

async function main() {
  let input = "";
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch {
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(input || "{}");
  } catch {
    process.exit(0);
  }

  if (!data || data.tool_name !== "EnterPlanMode") {
    process.exit(0);
  }

  process.stderr.write(
    "Plan mode is not used in rks projects.\n" +
    "Use one of the following instead:\n" +
    "  /research — to investigate a question or design a solution\n" +
    "  /pipeline — to build new functionality end-to-end\n"
  );
  process.exit(2);
}

main();
