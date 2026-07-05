import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOOK = path.join(ROOT, ".routekit", "hooks", "system", "block-plan-mode.mjs");
const TEMPLATE_HOOK = path.join(ROOT, "templates", "generic", ".routekit", "hooks", "system", "block-plan-mode.mjs");

function runHook(stdinData) {
  const input = typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("block-plan-mode hook", () => {
  it("exits with code 2 when tool_name is EnterPlanMode", () => {
    const result = runHook({ tool_name: "EnterPlanMode" });
    expect(result.status).toBe(2);
  });

  it("outputs a message containing '/research' when blocking EnterPlanMode", () => {
    const result = runHook({ tool_name: "EnterPlanMode" });
    expect(result.stderr + result.stdout).toContain("/research");
  });

  it("output references '/pipeline' as an alternative path", () => {
    const result = runHook({ tool_name: "EnterPlanMode" });
    expect(result.stderr + result.stdout).toContain("/pipeline");
  });

  it("exits 0 (pass-through) for tool_name Bash", () => {
    const result = runHook({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(result.status).toBe(0);
  });

  it("exits 0 (pass-through) for tool_name Edit", () => {
    const result = runHook({ tool_name: "Edit" });
    expect(result.status).toBe(0);
  });

  it("exits 0 (pass-through) for any unknown tool", () => {
    const result = runHook({ tool_name: "SomeFutureTool" });
    expect(result.status).toBe(0);
  });

  it("fails open (exits 0) when stdin is empty", () => {
    const result = runHook("");
    expect(result.status).toBe(0);
  });

  it("fails open (exits 0) when stdin is malformed JSON", () => {
    const result = runHook("not valid json {{{");
    expect(result.status).toBe(0);
  });

  it("hook file exists at .routekit/hooks/system/block-plan-mode.mjs", () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  it("hook file exists at templates/generic/.routekit/hooks/system/block-plan-mode.mjs", () => {
    expect(existsSync(TEMPLATE_HOOK)).toBe(true);
  });
});
