import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const execPath = path.resolve("packages/mcp-rks/src/server/exec.mjs");
const typesPath = path.resolve("packages/mcp-rks/src/server/telemetry/types.mjs");

describe("exec divergence telemetry", () => {
  const execSource = fs.readFileSync(execPath, "utf8");
  const typesSource = fs.readFileSync(typesPath, "utf8");

  it("exec.mjs emits exec.guardrails_off when guardrails are disabled", () => {
    expect(execSource).toContain('emit("exec.guardrails_off"');
  });

  it("exec.mjs emits exec.guardrails_on when guardrails are re-enabled", () => {
    expect(execSource).toContain('emit("exec.guardrails_on"');
  });

  it("exec.mjs emits exec.divergence_detected on per-step divergence", () => {
    expect(execSource).toContain('emit("exec.divergence_detected"');
  });

  it("no references to exec.off_rail.start remain in exec.mjs", () => {
    expect(execSource).not.toContain("exec.off_rail.start");
  });

  it("no references to exec.off_rail.complete remain in exec.mjs", () => {
    expect(execSource).not.toContain("exec.off_rail.complete");
  });

  it("types.mjs defines EXEC_GUARDRAILS_OFF constant", () => {
    expect(typesSource).toContain('EXEC_GUARDRAILS_OFF: "exec.guardrails_off"');
  });

  it("types.mjs defines EXEC_GUARDRAILS_ON constant", () => {
    expect(typesSource).toContain('EXEC_GUARDRAILS_ON: "exec.guardrails_on"');
  });

  it("types.mjs defines EXEC_DIVERGENCE_DETECTED constant", () => {
    expect(typesSource).toContain('EXEC_DIVERGENCE_DETECTED: "exec.divergence_detected"');
  });

  it("no references to off_rail remain in types.mjs", () => {
    expect(typesSource).not.toContain("off_rail");
  });
});
