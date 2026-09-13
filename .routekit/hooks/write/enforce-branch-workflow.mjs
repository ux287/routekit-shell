#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce branch workflow policies
 *
 * Ensures all work happens on feature branches:
 * - Blocks commits directly to protected branches (main, dev)
 * - Requires feature branches to be created from dev
 * - Blocks merges to main (require PRs)
 * - Runs tests before merging to dev
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
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "branch-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Default policy if no config
    return {
      base_branch: "dev",
      protected_branches: ["main", "dev"],
      feature_branch_pattern: "^(feature|fix|refactor|docs|chore)/.+",
      block_direct_commits_to: ["main", "dev"],
      block_merge_to_main: true,
      require_tests_before_merge: true,
      merge_test_command: "npm test",
      exempt_branches: [],
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
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function isGitCommand(command) {
  return /^\s*git\s+/.test(command) || /&&\s*git\s+/.test(command) || /;\s*git\s+/.test(command);
}

function extractGitCommands(command) {
  const gitCmdRegex = /git\s+[^;&|]+/g;
  return command.match(gitCmdRegex) || [];
}

function isFeatureBranch(branchName, pattern) {
  try {
    const regex = new RegExp(pattern);
    return regex.test(branchName);
  } catch {
    return false;
  }
}

function runTests(testCommand) {
  try {
    execSync(testCommand, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000,
    });
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getBaseBranchOfCurrentBranch() {
  try {
    // Get the merge base with dev to check if we branched from dev
    const mergeBase = execSync("git merge-base HEAD dev", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const devHead = execSync("git rev-parse dev", {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // If merge-base equals dev HEAD, we branched from current dev
    return mergeBase === devHead ? "dev" : "unknown";
  } catch {
    return "unknown";
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

  // Check if current branch is exempt
  const exemptBranches = config.exempt_branches || [];
  if (exemptBranches.includes(currentBranch)) {
    process.exit(0);
  }

  for (const gitCmd of gitCommands) {
    // Check for commits on protected branches
    if (/^git\s+commit\b/.test(gitCmd)) {
      const blockCommitTo = config.block_direct_commits_to || [];
      if (blockCommitTo.includes(currentBranch)) {
        const featurePattern = config.feature_branch_pattern || "^(feature|fix|refactor|docs|chore)/.+";
        process.stderr.write(
          `\n⛔ Direct commits to '${currentBranch}' are blocked\n` +
          `   Create a feature branch first:\n` +
          `   git checkout -b feature/your-feature-name\n\n` +
          `   Branch naming convention: ${featurePattern}\n` +
          `   Examples: feature/add-login, fix/button-alignment, docs/api-guide\n\n`
        );
        process.exit(2);
      }
    }

    // Check for creating branches - must be from dev
    if (/^git\s+checkout\s+-b\s+/.test(gitCmd)) {
      const baseBranch = config.base_branch || "dev";

      // Extract the new branch name
      const branchMatch = gitCmd.match(/checkout\s+-b\s+(\S+)/);
      const newBranchName = branchMatch ? branchMatch[1] : null;

      // Check if we're on the correct base branch
      if (currentBranch !== baseBranch) {
        process.stderr.write(
          `\n⚠️  Creating branch from '${currentBranch}' instead of '${baseBranch}'\n` +
          `   Recommended workflow:\n` +
          `   1. git checkout ${baseBranch}\n` +
          `   2. git pull origin ${baseBranch}\n` +
          `   3. git checkout -b ${newBranchName || "feature/your-feature"}\n\n` +
          `   Proceeding anyway (this is a warning, not a block).\n\n`
        );
        // Warning only, don't block
      }

      // Validate branch naming convention
      if (newBranchName) {
        const featurePattern = config.feature_branch_pattern || "^(feature|fix|refactor|docs|chore)/.+";
        if (!isFeatureBranch(newBranchName, featurePattern)) {
          process.stderr.write(
            `\n⚠️  Branch name '${newBranchName}' doesn't follow convention\n` +
            `   Expected pattern: ${featurePattern}\n` +
            `   Examples: feature/add-login, fix/button-bug, docs/readme-update\n\n` +
            `   Proceeding anyway (this is a warning, not a block).\n\n`
          );
          // Warning only, don't block
        }
      }
    }

    // Check for merges to main - blocked, use PRs
    if (/^git\s+merge\b/.test(gitCmd) && currentBranch === "main") {
      if (config.block_merge_to_main !== false) {
        process.stderr.write(
          `\n⛔ Direct merges to 'main' are blocked\n` +
          `   Use a Pull Request instead:\n` +
          `   1. Push your feature branch: git push -u origin <branch>\n` +
          `   2. Create PR on GitHub to merge into main\n` +
          `   3. Get review and merge via GitHub UI\n\n`
        );
        process.exit(2);
      }
    }

    // Check for merges to dev - require tests first
    if (/^git\s+merge\b/.test(gitCmd) && currentBranch === "dev") {
      if (config.require_tests_before_merge) {
        const testCommand = config.merge_test_command || "npm test";
        process.stderr.write(`\n🧪 Running tests before merge to dev...\n`);

        const result = runTests(testCommand);
        if (!result.success) {
          process.stderr.write(
            `\n⛔ Tests must pass before merging to dev\n` +
            `   Command: ${testCommand}\n` +
            `   Error: ${result.message}\n\n` +
            `   💡 Fix the failing tests and try again.\n\n`
          );
          process.exit(2);
        }
        process.stderr.write(`✅ Tests passed, proceeding with merge\n\n`);
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
