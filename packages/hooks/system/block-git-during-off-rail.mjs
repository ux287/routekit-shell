#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Route direct git write operations to guardrails-on during off-rail sessions.
 *
 * When guardrails are off (hooks.bak/ exists), agents should not run raw git
 * write commands (add, commit, push, stash, merge, rebase, reset, restore,
 * cherry-pick, revert, tag, rm). Instead, treat the gesture as a completion
 * signal and route to rks_guardrails_on, which handles commit → branch → PR →
 * merge → cycle_complete automatically.
 *
 * Git read commands (status, diff, log, branch --list, show) are always allowed.
 *
 * Tier: system (never disabled by rks_guardrails_off)
 */
import fs from "fs";
import path from "path";
import {
  readHookInput, getProjectId, buildRedirectOutput, denyWithRedirect,
} from "./hook-output.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HOOKS_BAK = path.join(PROJECT_DIR, ".routekit", "hooks.bak");

/**
 * Check if an off-rail session is active.
 * The presence of hooks.bak/ means rks_guardrails_off moved hooks there.
 */
function isOffRailActive() {
  return fs.existsSync(HOOKS_BAK);
}

/**
 * Extract git subcommands from a bash command string.
 * Handles chained commands (&&, ;, |).
 */
function extractGitSubcommands(command) {
  const gitCmdRegex = /\bgit\s+([a-z-]+)/gi;
  const matches = [];
  let m;
  while ((m = gitCmdRegex.exec(command)) !== null) {
    matches.push(m[1].toLowerCase());
  }
  return matches;
}

/**
 * Git subcommands that mutate the repository or working tree.
 */
const WRITE_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "push",
  "stash",
  "merge",
  "rebase",
  "reset",
  "restore",
  "cherry-pick",
  "revert",
  "tag",
  "rm",
]);

/**
 * Check if the full command contains dangerous checkout patterns.
 * We allow `git checkout <branch>` for navigation but block `git checkout -- .`
 * which discards changes.
 */
function isDestructiveCheckout(command) {
  return /\bgit\s+checkout\s+--\s/i.test(command);
}

async function main() {
  const hookData = await readHookInput();
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only enforce on Bash tool
  if (toolName !== "Bash") process.exit(0);

  const command = toolInput.command || "";

  // Only check if this contains a git command
  if (!/\bgit\s+/i.test(command)) process.exit(0);

  // Only enforce during off-rail sessions
  if (!isOffRailActive()) process.exit(0);

  // Extract git subcommands and check for write operations
  const subcommands = extractGitSubcommands(command);
  const writeOps = subcommands.filter(sc => WRITE_SUBCOMMANDS.has(sc));

  // Also check for destructive checkout
  if (isDestructiveCheckout(command)) {
    writeOps.push("checkout --");
  }

  if (writeOps.length === 0) {
    // git status, diff, log, branch, show, etc. are fine
    process.exit(0);
  }

  const projectId = getProjectId();
  const ops = [...new Set(writeOps)].join(", ");

  denyWithRedirect(buildRedirectOutput({
    reason: `Looks like you're done with your changes — completing the off-rail session (git ${ops} detected).`,
    agent: "mcp__rks__rks_guardrails_on",
    agentParams: { projectId },
    instructions: [
      "Call mcp__rks__rks_guardrails_on with the projectId to commit, branch, open a PR, merge, and complete the cycle automatically.",
    ],
    project: projectId,
  }));
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
