import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLANNABLE_PHASES, OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const ROOT = path.join(fileURLToPath(import.meta.url), "../../..");
const PLANNER_PATH = path.join(ROOT, "packages/mcp-rks/src/server/planner.mjs");

const src = fs.readFileSync(PLANNER_PATH, "utf-8");

describe("planner.mjs — arch-approved phase gate", () => {
  it("planner.mjs derives its plan phase gate from PLANNABLE_PHASES", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bPLANNABLE_PHASES\b[^}]*\}\s*from\s*["']\.\.\/workflow\/phases\.mjs["']/);
    // No hand-written copy of the plannable list survives (AC6).
    expect(src).not.toMatch(/const allowedPhases\s*=/);
    expect(src).not.toMatch(/\[\s*["']ready["']\s*,\s*["']arch-approved["']\s*,\s*["']planned["']\s*,\s*["']executed["']\s*\]/);
  });

  it("planner.mjs phase gate keeps the not-ready refusal and admits exactly PLANNABLE_PHASES", () => {
    // The gate tests membership in PLANNABLE_PHASES, and a non-plannable non-draft phase
    // still falls through to the "Story not ready for planning" refusal.
    const gate = src.match(/if \(!PLANNABLE_PHASES\.includes\(currentPhase\)\) \{([\s\S]*?)\n {6}\}\n/);
    expect(gate).toBeTruthy();
    expect(gate[1]).toMatch(/if \(currentPhase === ["']draft["']\)/);
    expect(gate[1]).toMatch(/\} else \{[\s\S]*error: "Story not ready for planning"/);
    // The set it admits is the plan row's from: arch-approved included, plus the re-plan phases.
    expect(PLANNABLE_PHASES).toBe(OPERATION_TRANSITIONS.plan.from);
    expect(new Set(PLANNABLE_PHASES)).toEqual(new Set(["ready", "arch-approved", "planned", "executed"]));
    expect(PLANNABLE_PHASES).toHaveLength(4);
  });

  it("auto-promotion only applies to 'draft', not 'arch-approved'", () => {
    // The auto-promote block should only fire for draft — arch-approved must not be auto-demoted
    const autoPromoteMatch = src.match(/currentPhase === ["'](\w+)["']\s*\)\s*\{[^}]*auto-promot/s);
    expect(autoPromoteMatch?.[1]).toBe("draft");
  });
});
