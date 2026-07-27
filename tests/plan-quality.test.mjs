import { describe, it, expect } from "vitest";
import { reviewPlan } from "../packages/mcp-rks/src/server/plan-quality.mjs";

// checkExecutableSteps must be true to trigger the no-executable-steps gate.
// It defaults to false so the planner's internal reviewPlan call is unaffected.
// Pass it explicitly in tests that verify the gate, and omit it for regression tests.

function makeStep(action, extra = {}) {
  return { action, file: "src/foo.mjs", ...extra };
}

describe("reviewPlan — no_executable_steps check", () => {
  it("returns ok: false when plan.steps contains only note steps", async () => {
    const plan = { steps: [makeStep("note"), makeStep("note")] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    expect(result.ok).toBe(false);
    const err = result.errors.find(e => e.type === "no_executable_steps");
    expect(err).toBeDefined();
    expect(err.severity).toBe("error");
  });

  it("returns ok: false when plan.steps is an empty array", async () => {
    const plan = { steps: [] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.type === "no_executable_steps")).toBe(true);
  });

  it("returns ok: false when plan.steps is missing (undefined)", async () => {
    const plan = {};
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.type === "no_executable_steps")).toBe(true);
  });

  it("error message references rks_refine", async () => {
    const plan = { steps: [makeStep("note")] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    const err = result.errors.find(e => e.type === "no_executable_steps");
    expect(err.message).toMatch(/rks_refine/i);
  });

  it("returns ok: true when plan.steps contains at least one executable step (edit_file)", async () => {
    const plan = { steps: [makeStep("edit_file", { search: "x", replace: "y" })] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    const noExecErr = result.errors.find(e => e.type === "no_executable_steps");
    expect(noExecErr).toBeUndefined();
  });

  it("returns ok: true for plan mixing note steps with executable steps (no false rejection)", async () => {
    const plan = { steps: [makeStep("note"), makeStep("search_replace", { search: "a", replace: "b" })] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    const noExecErr = result.errors.find(e => e.type === "no_executable_steps");
    expect(noExecErr).toBeUndefined();
  });

  it("single create_file step is treated as executable (no no_executable_steps error)", async () => {
    const plan = {
      steps: [{ action: "create_file", file: "src/new.mjs", content: "export const x = 1;\n" }],
    };
    const result = await reviewPlan({ projectRoot: "/tmp", plan, checkExecutableSteps: true });
    const noExecErr = result.errors.find(e => e.type === "no_executable_steps");
    expect(noExecErr).toBeUndefined();
  });

  it("note-only plan does NOT fail reviewPlan when checkExecutableSteps is false (planner internal path)", async () => {
    const plan = { steps: [makeStep("note"), makeStep("note")] };
    const result = await reviewPlan({ projectRoot: "/tmp", plan }); // default: checkExecutableSteps=false
    const noExecErr = result.errors.find(e => e.type === "no_executable_steps");
    expect(noExecErr).toBeUndefined();
  });
});
