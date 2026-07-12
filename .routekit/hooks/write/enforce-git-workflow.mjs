#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce git workflow policies
 *
 * Blocks dangerous git operations and requires tests before commit.
 * Suggests proper workflow (PRs, GitHub MCP) when blocking.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with message to stderr)
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "git-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Default policy if no config
    return {
      protected_branches: ["main", "dev"],
      blocked_operations: [],
      require_tests: { before_commit: true, test_command: "npm test" }
    };
  }
  const content = fs.readFileSync(CONFIG_PATH, "utf8");
  return yaml.load(content) || {};
}

function getCurrentBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch {
    return null;
  }
}

function isGitCommand(command) {
  return /^\s*git\s+/.test(command) || /&&\s*git\s+/.test(command) || /;\s*git\s+/.test(command);
}

function extractGitCommands(command) {
  // Extract all git commands from a potentially chained command
  const gitCmdRegex = /git\s+[^;&|]+/g;
  return command.match(gitCmdRegex) || [];
}

function runTests(testCommand) {
  try {
    execSync(testCommand, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000 // 2 minute timeout
    });
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function main() {
  // Read hook input from stdin
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
  const toolInput = hookData.tool_input || {};

  // Only enforce on Bash tool
  if (toolName !== "Bash") {
    process.exit(0);
  }

  const command = toolInput.command || "";

  // Only check git commands
  if (!isGitCommand(command)) {
    process.exit(0);
  }

  const config = loadConfig();
  const currentBranch = getCurrentBranch();
  const gitCommands = extractGitCommands(command);

  // Check each git command against blocked operations
  for (const gitCmd of gitCommands) {
    // Check blocked operations
    for (const blocked of config.blocked_operations || []) {
      const pattern = new RegExp(blocked.pattern, "i");
      const branches = blocked.branches || config.protected_branches || [];

      if (pattern.test(gitCmd)) {
        // Check if current branch is in the blocked branches list
        if (branches.length === 0 || branches.includes(currentBranch)) {
          process.stderr.write(
            `\n⛔ ${blocked.message || "Operation blocked by git policy"}\n` +
            `   Command: ${gitCmd}\n` +
            `   Branch: ${currentBranch}\n` +
            `\n   💡 Consider using a Pull Request workflow instead.\n\n`
          );
          process.exit(2);
        }
      }
    }

    // Check for force push to protected branches
    if (/push.*--force|push.*-f\b/.test(gitCmd)) {
      const protectedBranches = config.protected_branches || ["main", "dev"];
      for (const branch of protectedBranches) {
        if (gitCmd.includes(branch) || currentBranch === branch) {
          process.stderr.write(
            `\n⛔ Force push to protected branch blocked\n` +
            `   Command: ${gitCmd}\n` +
            `   Branch: ${branch}\n` +
            `\n   💡 Use a Pull Request to merge changes to ${branch}.\n\n`
          );
          process.exit(2);
        }
      }
    }

    // Check for direct push to protected branches (optional, can be configured)
    if (/^git\s+push\s+/.test(gitCmd) && !gitCmd.includes("--force") && !gitCmd.includes("-f")) {
      const protectedBranches = config.protected_branches || ["main", "dev"];
      for (const branch of protectedBranches) {
        // Check if pushing to a protected branch
        if (gitCmd.includes(`origin ${branch}`) || gitCmd.includes(`origin/${branch}`)) {
          if (config.require_pr_for_protected !== false) {
            process.stderr.write(
              `\n⛔ Direct push to protected branch blocked\n` +
              `   Command: ${gitCmd}\n` +
              `   Branch: ${branch}\n` +
              `\n   💡 Create a Pull Request to merge changes to ${branch}.\n\n`
            );
            process.exit(2);
          }
        }
      }
    }

    // Check for commits - require tests first
    if (/^git\s+commit\b/.test(gitCmd)) {
      const requireTests = config.require_tests || {};
      if (requireTests.before_commit) {
        const testCommand = requireTests.test_command || "npm test";
        process.stderr.write(`\n🧪 Running tests before commit...\n`);

        const result = runTests(testCommand);
        if (!result.success) {
          process.stderr.write(
            `\n⛔ Tests must pass before committing\n` +
            `   Command: ${testCommand}\n` +
            `   Error: ${result.message}\n` +
            `\n   💡 Fix the failing tests and try again.\n\n`
          );
          process.exit(2);
        }
        process.stderr.write(`✅ Tests passed\n\n`);
      }
    }
  }

  // All checks passed
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
