/**
 * backlog.fix.plan-exec-start-phase-write-durability — exhaustiveness.
 *
 * The phase routing in planner-persistence.mjs handled `note_only`/`quality_failed` and
 * `executable` with NO else. classifyPlanStatus also returns `needs_refinement` and
 * `error`, and planner.mjs downgrades executable → needs_refinement on any search/replace
 * validation error — so those fell through: no phase write, no telemetry, no error, and
 * ok:true returned anyway.
 *
 * These tests are driven off PLAN_STATUS_VALUES rather than a hardcoded list, so adding a
 * fifth status reddens them until it is routed. Enumerating today's four would pass today
 * and let the identical defect recur.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLAN_STATUS_VALUES,
  classifyPlanStatus,
} from "../../packages/mcp-rks/src/server/planner-prompts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROMPTS_SRC = fs.readFileSync(
  path.join(ROOT, "packages/mcp-rks/src/server/planner-prompts.mjs"), "utf8",
);
const PERSIST_SRC = fs.readFileSync(
  path.join(ROOT, "packages/mcp-rks/src/server/planner-persistence.mjs"), "utf8",
);

/** Slice a named function's body out of source, fail-loud on a missing landmark. */
function functionBody(src, signature) {
  const start = src.indexOf(signature);
  expect(start, `landmark not found: ${signature}`).toBeGreaterThan(-1);
  // Start AFTER the parameter list. classifyPlanStatus destructures its argument, so the
  // first `{` after the signature is the param object, not the body — scanning from there
  // returns the destructuring pattern and finds zero return literals.
  const bodyOpen = src.indexOf(") {", start);
  expect(bodyOpen, `parameter list end not found for ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  let open = -1;
  for (let i = bodyOpen + 2; i < src.length; i += 1) {
    if (src[i] === "{") { if (open === -1) open = i; depth += 1; }
    else if (src[i] === "}") { depth -= 1; if (depth === 0 && open !== -1) return src.slice(open, i + 1); }
  }
  throw new Error(`unbalanced body for ${signature}`);
}

describe("PLAN_STATUS_VALUES is the single source of truth", () => {
  it("is frozen, so a caller cannot mutate the contract at runtime", () => {
    expect(Object.isFrozen(PLAN_STATUS_VALUES)).toBe(true);
  });

  it("TR5: every literal classifyPlanStatus can return is a member", () => {
    // The escape hatch this closes: adding a new return value without adding it to the
    // constant would leave TR4 iterating a stale list and passing vacuously.
    const body = functionBody(PROMPTS_SRC, "export function classifyPlanStatus(");
    const returned = [...body.matchAll(/return\s+"([^"]+)"/g)].map((m) => m[1]);
    const ternary = [...body.matchAll(/\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)].flatMap((m) => [m[1], m[2]]);
    const all = [...new Set([...returned, ...ternary])];

    expect(all.length, "no return literals found — the extractor is broken").toBeGreaterThan(0);
    for (const status of all) {
      expect(PLAN_STATUS_VALUES, `classifyPlanStatus can return "${status}"`).toContain(status);
    }
  });

  it("classifyPlanStatus only ever returns members of the constant, behaviourally", () => {
    const cases = [
      { steps: [], llmStatus: "error" },
      { steps: [{ action: "note" }], llmStatus: "ok" },
      { steps: [{ action: "create_file", path: "a.mjs", content: "x" }], llmStatus: "ok" },
      { steps: [], llmStatus: "ok" },
      { steps: [{ action: "search_replace", path: "a.mjs", edits: [{}] }], llmStatus: "ok" },
    ];
    for (const c of cases) {
      expect(PLAN_STATUS_VALUES).toContain(classifyPlanStatus(c));
    }
  });
});

describe("TR4: phase routing is exhaustive over PLAN_STATUS_VALUES", () => {
  it("routes every status — no member falls through unhandled", () => {
    const start = PERSIST_SRC.indexOf("// Phase routing.");
    expect(start, "phase-routing landmark not found").toBeGreaterThan(-1);
    const end = PERSIST_SRC.indexOf("// Coverage checks", start);
    expect(end, "phase-routing end landmark not found").toBeGreaterThan(start);
    const region = PERSIST_SRC.slice(start, end);

    // A catch-all tail is what makes this exhaustive for statuses added later. Without
    // it, a new status silently skips the phase write — the original defect exactly.
    const hasCatchAllTail = /}\s*else\s*{/.test(region);
    expect(hasCatchAllTail, "routing has no final else — a new status would fall through").toBe(true);

    for (const status of PLAN_STATUS_VALUES) {
      const namedExplicitly = region.includes(`"${status}"`);
      expect(
        namedExplicitly || hasCatchAllTail,
        `status "${status}" is neither named nor covered by a catch-all`,
      ).toBe(true);
    }
  });

  it("the catch-all names the status it skipped rather than skipping silently", () => {
    // The defect was not merely the missing write — it was the SILENCE. A fall-through
    // that emits nothing is indistinguishable from success from every caller's position.
    expect(PERSIST_SRC).toContain("plan_status_");
    expect(PERSIST_SRC).toContain("story.phase.exec_start_skipped");
  });

  it("TR2: a failed phase write is not reported as success", () => {
    expect(PERSIST_SRC).toContain("phase_write_failed");
    // And the bare swallowing catch is gone.
    expect(PERSIST_SRC).not.toContain("[planner] phase routing failed");
  });

  it("TR3: the failure path RETAINS the plan artifacts", () => {
    // A result that fails hard and discards a valid run folder is its own defect: the
    // plan was good, only the state write failed.
    const start = PERSIST_SRC.indexOf("const planFailure =");
    expect(start, "planFailure landmark not found").toBeGreaterThan(-1);
    const region = PERSIST_SRC.slice(start, start + 900);
    for (const field of ["runFolder", "planPath", "planJsonPath", "runId"]) {
      expect(region, `planFailure must retain ${field}`).toContain(field);
    }
  });
});
