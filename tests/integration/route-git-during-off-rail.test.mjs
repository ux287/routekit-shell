/**
 * Tests for route-git-during-off-rail — verifies that block-git-during-off-rail.mjs
 * redirects to rks_guardrails_on (not process.exit(2)) for write subcommands,
 * and passes through read-only subcommands.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

// Hook lives in hooks/system/ (system tier — never moved to hooks.bak)
const CANDIDATE_PATHS = [
  path.join(ROOT, ".routekit", "hooks", "system", "block-git-during-off-rail.mjs"),
  path.join(ROOT, ".routekit", "hooks", "block-git-during-off-rail.mjs"),
  path.join(ROOT, ".routekit", "hooks.bak", "block-git-during-off-rail.mjs"),
];
const HOOK_PATH = CANDIDATE_PATHS.find(p => fs.existsSync(p));

if (!HOOK_PATH) {
  throw new Error("block-git-during-off-rail.mjs not found in hooks/ or hooks.bak/");
}

function makeInput(command) {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command } });
}

/**
 * Run the hook with a given command.
 * offRail: if true, create hooks.bak/ in temp project dir to simulate off-rail session.
 */
function runHook(command, { offRail = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-hook-test-"));
  try {
    if (offRail) {
      fs.mkdirSync(path.join(tmpDir, ".routekit", "hooks.bak"), { recursive: true });
    }
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: makeInput(command),
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmpDir,
        RKS_PROJECT_ID: "test-project",
      },
    });
    const output = result.stdout ? (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() : null;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, output };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("block-git-during-off-rail — write commands redirect during off-rail", () => {
  it("git add redirects to rks_guardrails_on (not exit 2)", () => {
    const { exitCode, output } = runHook("git add .");
    expect(exitCode).toBe(0);
    expect(output).not.toBeNull();
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.additionalContext).toMatch(/REDIRECT ORDER/);
    expect(output.hookSpecificOutput.additionalContext).toMatch(/mcp__rks__rks_guardrails_on/);
  });

  it("each write subcommand redirects: commit, push, stash, merge, rebase, reset, restore, revert, tag, rm", () => {
    const writeCommands = [
      "git commit -m 'test'",
      "git push origin staging",
      "git stash",
      "git merge main",
      "git rebase main",
      "git reset --hard HEAD~1",
      "git restore .",
      "git revert HEAD",
      "git tag v1.0.0",
      "git rm file.txt",
    ];
    for (const cmd of writeCommands) {
      const { exitCode, output } = runHook(cmd);
      expect(exitCode, `exit code for: ${cmd}`).toBe(0);
      expect(output, `output for: ${cmd}`).not.toBeNull();
      expect(output.hookSpecificOutput.permissionDecision, `permissionDecision for: ${cmd}`).toBe("deny");
    }
  });

  it("redirect output contains GOVERNOR ROUTING with agent mcp__rks__rks_guardrails_on", () => {
    const { output } = runHook("git commit -m 'done'");
    expect(output.hookSpecificOutput.additionalContext).toMatch(/GOVERNOR ROUTING/);
    expect(output.hookSpecificOutput.additionalContext).toMatch(/agent: mcp__rks__rks_guardrails_on/);
  });

  it("redirect agentParams includes projectId", () => {
    const { output } = runHook("git push");
    const context = output.hookSpecificOutput.additionalContext;
    expect(context).toMatch(/test-project/);
  });

  it("redirect reason communicates completion intent", () => {
    const { output } = runHook("git add -A");
    const reason = output.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/done with your changes|completing the off-rail session/i);
  });
});

describe("block-git-during-off-rail — read-only commands pass through during off-rail", () => {
  it("git status passes through — no redirect, exit 0", () => {
    const { exitCode, stdout } = runHook("git status");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("git diff passes through", () => {
    const { exitCode, stdout } = runHook("git diff HEAD");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("git log passes through", () => {
    const { exitCode, stdout } = runHook("git log --oneline -5");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("git show passes through", () => {
    const { exitCode, stdout } = runHook("git show HEAD");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  it("git branch --list passes through", () => {
    const { exitCode, stdout } = runHook("git branch --list");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});

describe("block-git-during-off-rail — not active when not off-rail", () => {
  it("git add passes through when no off-rail session active", () => {
    const { exitCode, stdout } = runHook("git add .", { offRail: false });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});
