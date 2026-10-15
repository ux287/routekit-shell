/**
 * Story: backlog.fix.exec-gate-phase-mismatch-v2 (KEYSTONE)
 *
 * The R1.3e v2 migration rerouted the plan writer (a successful plan advances
 * arch-approved→executing via exec_start) but left the exec gate at the v1
 * "planned", closing the plan→exec path. This locks the gate to the phase the
 * plan writer now sets ("executing"), confirms completion routes
 * executing→executed via exec_end, and guards against re-introducing the v1 gate.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_GATE_EXEC } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHASES_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../packages/mcp-rks/src/workflow/phases.mjs"),
  "utf8",
);
const EXEC_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../packages/mcp-rks/src/server/exec.mjs"),
  "utf8",
);

describe("exec gate aligned to the v2 executing phase", () => {
  it("PHASE_GATE_EXEC is 'executing' (not the v1 'planned')", () => {
    expect(PHASE_GATE_EXEC).toBe("executing");
  });

  it("the stale '(unchanged)' comment on the gate constant is gone", () => {
    expect(PHASES_SRC).not.toMatch(/required for rks_exec to run \(unchanged\)/);
    expect(PHASES_SRC).toMatch(/export const PHASE_GATE_EXEC = "executing";/);
  });

  it("the v2 phase edges hold: exec_start arch-approved→executing, exec_end executing→executed", () => {
    expect(PHASES_SRC).toMatch(/name:\s*"exec_start"[\s\S]*?from:\s*\["arch-approved"\][\s\S]*?to:\s*"executing"/);
    expect(PHASES_SRC).toMatch(/name:\s*"exec_end"[\s\S]*?from:\s*\["executing"\][\s\S]*?to:\s*"executed"/);
  });

  it("rks_exec still enforces a gate against PHASE_GATE_EXEC (flipped, not removed)", () => {
    expect(EXEC_SRC).toMatch(/currentPhase !== PHASE_GATE_EXEC/);
  });

  it("the RKS_SKIP_PHASE_CHECK escape hatch still bypasses the guard", () => {
    expect(EXEC_SRC).toMatch(/!process\.env\.RKS_SKIP_PHASE_CHECK/);
  });

  it("the phase-mismatch message is corrected (no longer the bare v1 'Run rks_plan first')", () => {
    // The old message ended exactly: expected "${PHASE_GATE_EXEC}". Run rks_plan first.
    expect(EXEC_SRC).not.toMatch(/expected "\$\{PHASE_GATE_EXEC\}"\. Run rks_plan first\./);
    expect(EXEC_SRC).toMatch(/a successful rks_plan leaves the story at/);
  });

  it("exec completion advances via exec_end, not a v1 planned→executed assumption", () => {
    expect(EXEC_SRC).toMatch(/advancePhase\([^)]*"exec_end"/);
    expect(EXEC_SRC).not.toMatch(/planned→executed edge, which v1/);
  });
});
