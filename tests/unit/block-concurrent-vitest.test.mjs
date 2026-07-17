/**
 * Tests for block-concurrent-vitest.mjs hook
 * (backlog.feat.enforce-single-vitest-run)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const HOOK_FILE = path.join(PROJECT_ROOT, ".routekit/hooks/system/block-concurrent-vitest.mjs");

let tmpProjectDir;

beforeAll(() => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-vitest-test-"));
  fs.mkdirSync(path.join(tmpProjectDir, ".rks"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
});

function runHook(toolName, toolInput, extraEnv = {}) {
  const result = spawnSync("node", [HOOK_FILE], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmpProjectDir,
      VITEST: undefined,
      VITEST_WORKER_ID: undefined,
      ...extraEnv,
    },
    timeout: 10000,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseHookOutput(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

describe("block-concurrent-vitest — pass-through cases", () => {
  it("passes through (exit 0, no output) for a non-Bash tool", () => {
    const result = runHook("Edit", { file_path: "src/foo.ts" }, { RKS_MOCK_VITEST_RUNNING: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("passes through for a Bash command that does not contain 'vitest run'", () => {
    const result = runHook("Bash", { command: "npx vitest watch" }, { RKS_MOCK_VITEST_RUNNING: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("passes through for 'vitest run' when no vitest process is running", () => {
    const result = runHook("Bash", { command: "npx vitest run" }, { RKS_MOCK_VITEST_RUNNING: "0" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("block-concurrent-vitest — blocking case", () => {
  it("denies 'vitest run' Bash command when a vitest process is already running", () => {
    const result = runHook("Bash", { command: "npx vitest run" }, { RKS_MOCK_VITEST_RUNNING: "1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe("");
    const output = parseHookOutput(result.stdout);
    expect(output.hookEventName).toBe("PreToolUse");
    expect(output.permissionDecision).toBe("deny");
  });

  it("blocking message includes 'BLOCKED' and 'vitest process is already running'", () => {
    const result = runHook("Bash", { command: "npx vitest run" }, { RKS_MOCK_VITEST_RUNNING: "1" });
    const output = parseHookOutput(result.stdout);
    expect(output.permissionDecisionReason).toContain("BLOCKED");
    expect(output.permissionDecisionReason).toContain("vitest process is already running");
  });
});

describe("block-concurrent-vitest — resilience", () => {
  it("fails open (exit 0, no output) on malformed stdin JSON", () => {
    const result = spawnSync("node", [HOOK_FILE], {
      input: "not-valid-json{{{",
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpProjectDir },
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("block-concurrent-vitest — manifest and CLAUDE.md", () => {
  it("is registered in hooks-manifest.json under the 'system' tier", () => {
    const manifestPath = path.join(PROJECT_ROOT, ".routekit/hooks-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest["block-concurrent-vitest"]).toBeDefined();
    expect(manifest["block-concurrent-vitest"].tier).toBe("system");
  });

  it("CLAUDE.md contains a '## Test Execution' section", () => {
    const claudeMd = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("## Test Execution");
  });

  it("CLAUDE.md Test Execution section prohibits run_in_background for vitest", () => {
    const claudeMd = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("run_in_background");
  });

  it("CLAUDE.md Test Execution section prohibits monitor polling loops", () => {
    const claudeMd = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("monitor");
  });

  it("CLAUDE.md Test Execution section prohibits parallel vitest instances", () => {
    const claudeMd = fs.readFileSync(path.join(PROJECT_ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("parallel");
  });
});
