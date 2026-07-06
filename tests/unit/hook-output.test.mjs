import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Test that all redirect hooks produce structured JSON output (Pattern A)
 * with governor routing fields.
 *
 * Each hook is invoked via spawnSync with simulated hookData. We verify:
 * 1. Exit code 0 (not 2)
 * 2. stdout contains valid JSON with hookSpecificOutput
 * 3. permissionDecision is "deny"
 * 4. additionalContext contains REDIRECT ORDER and GOVERNOR ROUTING
 *
 * Hooks check .rks/guardrails-state.json (via guard-state.mjs) to decide
 * whether to enforce. We create a temp project dir with guardrails active
 * so tests are isolated from the real project's guardrails state.
 *
 * @see backlog.governor.hook-routing
 */

// Hooks may be in hooks/ or hooks.bak/ depending on guardrails state
const HOOKS_DIR = fs.existsSync(path.resolve("./", ".routekit/hooks"))
  ? path.resolve("./", ".routekit/hooks")
  : path.resolve("./", ".routekit/hooks.bak");

let tmpProjectDir;

beforeAll(() => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rks-hook-test-"));
  fs.mkdirSync(path.join(tmpProjectDir, ".rks"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpProjectDir, ".rks", "guardrails-state.json"),
    JSON.stringify({ active: true, disabledTiers: [] }),
  );
  const manifestSrc = path.resolve("./", ".routekit/hooks-manifest.json");
  if (fs.existsSync(manifestSrc)) {
    fs.mkdirSync(path.join(tmpProjectDir, ".routekit"), { recursive: true });
    fs.copyFileSync(manifestSrc, path.join(tmpProjectDir, ".routekit", "hooks-manifest.json"));
  }
});

afterAll(() => {
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
});

function runHook(hookFile, hookData) {
  const tiers = ["system", "write", "read"];
  let hookPath = path.join(HOOKS_DIR, hookFile);
  for (const tier of tiers) {
    const tierPath = path.join(HOOKS_DIR, tier, hookFile);
    if (fs.existsSync(tierPath)) { hookPath = tierPath; break; }
  }
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(hookData),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpProjectDir,
      RKS_GUARDRAILS: "on",
      RKS_PROJECT_ID: "test-project",
    },
    timeout: 10000,
  });

  return {
    exitCode: result.status,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

function parseOutput(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.hookSpecificOutput;
}

function assertPatternA(result, expectedAgent) {
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toBe("");

  const output = parseOutput(result.stdout);
  expect(output.hookEventName).toBe("PreToolUse");
  expect(output.permissionDecision).toBe("deny");
  expect(output.permissionDecisionReason).toBeTruthy();
  expect(output.additionalContext).toContain("REDIRECT ORDER:");
  expect(output.additionalContext).toContain(expectedAgent);
  expect(output.additionalContext).toContain("GOVERNOR ROUTING:");
  expect(output.additionalContext).toContain("project:");
}

describe("hook-output: structured redirect format", () => {
  it("redirect-git-tools-to-agent outputs Pattern A with governor routing", () => {
    const result = runHook("redirect-git-tools-to-agent.mjs", {
      tool_name: "mcp__rks__rks_git_commit",
      tool_input: { projectId: "test-project", message: "test commit" },
    });
    assertPatternA(result, "mcp__rks__rks_agent_git");
  });

  it("redirect-dendron-tools-to-agent outputs Pattern A with governor routing", () => {
    const result = runHook("redirect-dendron-tools-to-agent.mjs", {
      tool_name: "mcp__rks__dendron_create_note",
      tool_input: { projectId: "test-project", name: "test-note" },
    });
    assertPatternA(result, "mcp__rks__rks_agent_dendron");
  });

  it("redirect-rag-tools-to-agent outputs Pattern A with governor routing", () => {
    const result = runHook("redirect-rag-tools-to-agent.mjs", {
      tool_name: "mcp__rks__rks_rag_query",
      tool_input: { projectId: "test-project", query: "test query" },
    });
    assertPatternA(result, "mcp__rks__rks_agent_research");
  });

  it("redirect-validate-story-to-agent outputs Pattern A with governor routing", () => {
    const result = runHook("redirect-validate-story-to-agent.mjs", {
      tool_name: "mcp__rks__rks_validate_story",
      tool_input: { projectId: "test-project", problemId: "backlog.test" },
    });
    assertPatternA(result, "mcp__rks__rks_agent_validate_story");
  });

  it("redirect-websearch-to-agent outputs Pattern A with governor routing", () => {
    const result = runHook("redirect-websearch-to-agent.mjs", {
      tool_name: "WebSearch",
      tool_input: { query: "test search" },
    });
    assertPatternA(result, "mcp__rks__rks_agent_external_research");
  });

  it("non-matching tools pass through with exit 0 and no output", () => {
    const result = runHook("redirect-git-tools-to-agent.mjs", {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.txt" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("governor routing includes project field", () => {
    const result = runHook("redirect-dendron-tools-to-agent.mjs", {
      tool_name: "mcp__rks__dendron_edit_note",
      tool_input: { projectId: "my-project", noteId: "test" },
    });
    const output = parseOutput(result.stdout);
    expect(output.additionalContext).toContain("project: my-project");
  });
});
