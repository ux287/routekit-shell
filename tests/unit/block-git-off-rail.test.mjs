import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tmp.mjs";

// Skip the entire suite when hooks are not at their live location.
// When guardrails are off, hooks are in hooks.bak/ — that is a known, approved
// state. Running these tests then causes spurious failures and fan spin.
// Tests are only meaningful when the hook is active in its live position.
const HOOK_CANDIDATES = [
  path.resolve("./", ".routekit/hooks/system/block-git-during-off-rail.mjs"),
  path.resolve("./", ".routekit/hooks/block-git-during-off-rail.mjs"),
  path.resolve("./", ".routekit/hooks.bak/block-git-during-off-rail.mjs"),
];
const HOOK_PATH = HOOK_CANDIDATES.find(p => fs.existsSync(p));
const hooksLive = HOOK_PATH !== undefined;

/**
 * Run the hook with simulated hookData, optionally with hooks.bak/ present.
 */
function runHook(hookData, { offRail = false, projectDir } = {}) {
  if (offRail) {
    const bakDir = path.join(projectDir, ".routekit", "hooks.bak");
    fs.mkdirSync(bakDir, { recursive: true });
  }

  const result = spawnSync("node", [HOOK_PATH], {
    input: JSON.stringify(hookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
    },
    timeout: 15000,
  });

  return {
    exitCode: result.status,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

/**
 * Parse the redirect JSON from stdout.
 * Returns null if stdout is empty or not valid JSON.
 */
function parseRedirectOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

describe.skipIf(!hooksLive)("block-git-during-off-rail hook", () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeTempDir("block-git-test");
    const hooksDir = path.join(projectDir, ".routekit", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
  });

  describe("during off-rail session (hooks.bak/ exists)", () => {
    it("redirects git add (exit 0, deny JSON in stdout)", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git add ." } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects git commit", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: 'git commit -m "test"' } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects git push", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git push origin staging" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects git stash", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git stash push -m backup" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects git merge", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git merge feature-branch" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects git reset", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git reset --hard HEAD" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects destructive git checkout", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git checkout -- ." } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("redirects chained git commands and reason includes all detected ops", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git add . && git commit -m 'test'" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      expect(output?.hookSpecificOutput?.permissionDecision).toBe("deny");
      const reason = output?.hookSpecificOutput?.permissionDecisionReason || "";
      expect(reason).toMatch(/add/);
      expect(reason).toMatch(/commit/);
    });

    it("allows git status (exit 0, no redirect JSON)", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git status" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      expect(parseRedirectOutput(result.stdout)).toBeNull();
    });

    it("allows git diff", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git diff HEAD" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows git log", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git log --oneline -5" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows git branch (list)", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git branch --list" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows git show", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git show HEAD" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("when guardrails are enabled (no hooks.bak/)", () => {
    it("allows git add when not off-rail", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git add ." } },
        { offRail: false, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows git commit when not off-rail", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: 'git commit -m "test"' } },
        { offRail: false, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows git push when not off-rail", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git push origin main" } },
        { offRail: false, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("non-git commands", () => {
    it("allows non-git bash commands during off-rail", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "npm test" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });

    it("allows non-Bash tools during off-rail", () => {
      const result = runHook(
        { tool_name: "Read", tool_input: { file_path: "/some/file.txt" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("redirect output quality", () => {
    it("stdout JSON additionalContext contains rks_guardrails_on", () => {
      const result = runHook(
        { tool_name: "Bash", tool_input: { command: "git commit -m 'ship it'" } },
        { offRail: true, projectDir }
      );
      expect(result.exitCode).toBe(0);
      const output = parseRedirectOutput(result.stdout);
      const context = output?.hookSpecificOutput?.additionalContext || "";
      expect(context).toContain("rks_guardrails_on");
    });
  });
});
