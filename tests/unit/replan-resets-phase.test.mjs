/**
 * P0-3 source/import guards (unit tier — lightweight, no runPlanTool).
 *
 * The reset-before-exec_start fix lives in planner-persistence.mjs: reset a re-plan target
 * (planned/executing/executed) to arch-approved before advancePhase('exec_start'), so a bare
 * re-plan is idempotent — NOT a broadening of exec_start.from. These guards verify the fix
 * shape + the regression guard without driving runPlanTool.
 *
 * The behavioral runPlanTool cases live in tests/e2e/replan-resets-phase.test.mjs (gated e2e
 * tier) — they trigger live RAG embedding and must stay out of the unit shard.
 *
 * Story: backlog.fix.replan-resets-phase-test-misplaced-in-unit-tier
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const persistenceSrc = fs.readFileSync(
  path.join(repoRoot, "packages/mcp-rks/src/server/planner-persistence.mjs"),
  "utf8",
);
// The reset-then-advance sequence MOVED to exec-start-durability.mjs
// (backlog.fix.plan-exec-start-phase-write-durability): the phase write now lives beside
// the decision table so the detached worker and the parent-side durability net share one
// implementation. The guarantee this file pins is unchanged — reset BEFORE advance — so
// the pin follows the code to its new home rather than being deleted.
const durabilitySrc = fs.readFileSync(
  path.join(repoRoot, "packages/mcp-rks/src/server/exec-start-durability.mjs"),
  "utf8",
);

describe("P0-3: re-plan resets phase before exec_start (source guards)", () => {
  it("regression guard: exec_start.from is still ['arch-approved'] (reset approach, not broaden-from)", () => {
    expect(OPERATION_TRANSITIONS.exec_start.from).toEqual(["arch-approved"]);
    expect(OPERATION_TRANSITIONS.exec_start.to).toBe("executing");
  });

  it("exec-start-durability resets phase to arch-approved BEFORE advancePhase('exec_start')", () => {
    const resetIdx = durabilitySrc.indexOf('updateField(dir, problemId, "phase", "arch-approved")');
    const advanceIdx = durabilitySrc.indexOf('advancePhase(projectRoot, problemId, "exec_start"');
    expect(resetIdx, "reset write not found in exec-start-durability.mjs").toBeGreaterThan(-1);
    expect(advanceIdx, "advancePhase call not found in exec-start-durability.mjs").toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(advanceIdx);
  });

  it("planner-persistence routes exec_start through the shared durability module", () => {
    // Anti-vacuity: the guarantee above is worthless if persistence stopped calling it.
    expect(persistenceSrc).toContain("ensureExecStartPhase");
    expect(persistenceSrc).toContain("exec-start-durability.mjs");
  });
});
