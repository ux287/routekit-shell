import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const PLANNER_PATH = path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs");

const src = fs.readFileSync(PLANNER_PATH, "utf-8");

describe("planner.mjs — arch-approved phase gate", () => {
  it("allowedPhases in runPlanTool includes 'arch-approved'", () => {
    const match = src.match(/const allowedPhases = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const phases = match[1].split(",").map((s) => s.trim().replace(/['"]/g, ""));
    expect(phases).toContain("arch-approved");
  });

  it("allowedPhases includes 'ready', 'planned', and 'executed' (regression)", () => {
    const match = src.match(/const allowedPhases = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const phases = match[1].split(",").map((s) => s.trim().replace(/['"]/g, ""));
    expect(phases).toContain("ready");
    expect(phases).toContain("planned");
    expect(phases).toContain("executed");
  });

  it("auto-promotion only applies to 'draft', not 'arch-approved'", () => {
    // The auto-promote block should only fire for draft — arch-approved must not be auto-demoted
    const autoPromoteMatch = src.match(/currentPhase === ["'](\w+)["']\s*\)\s*\{[^}]*auto-promot/s);
    expect(autoPromoteMatch?.[1]).toBe("draft");
  });
});
