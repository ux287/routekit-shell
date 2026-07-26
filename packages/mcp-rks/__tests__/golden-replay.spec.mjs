/**
 * Golden-Run Replay Tests
 *
 * Validates frozen plans from successful builds against the current
 * repo state. Catches regressions where code changes break existing
 * plan patterns, remove target files, or violate structural contracts.
 *
 * Scenarios are auto-discovered from __tests__/golden/scenarios/.
 * Each scenario has: golden.json (metadata), plan.json (frozen plan).
 *
 * Run: node --test __tests__/golden-replay.spec.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateGoldenPlan } from "./golden/validate.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "golden/scenarios");
const PROJECT_ROOT = path.resolve(__dirname, "../../..");

// Dynamically discover scenarios
const scenarioEntries = fs.existsSync(SCENARIOS_DIR)
  ? fs
      .readdirSync(SCENARIOS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

describe("Golden-Run Replay", () => {
  if (scenarioEntries.length === 0) {
    it("has at least one golden scenario", () => {
      assert.fail(
        "No golden scenarios found. Run: node __tests__/golden/capture.mjs <run-dir>"
      );
    });
    return;
  }

  for (const scenarioId of scenarioEntries) {
    describe(scenarioId, () => {
      const dir = path.join(SCENARIOS_DIR, scenarioId);
      let plan;
      let golden;
      let validation;

      it("loads golden scenario", () => {
        const goldenPath = path.join(dir, "golden.json");
        const planPath = path.join(dir, "plan.json");

        assert.ok(fs.existsSync(goldenPath), "golden.json must exist");
        assert.ok(fs.existsSync(planPath), "plan.json must exist");

        golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
        plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

        assert.ok(golden.id, "golden.json must have id");
        assert.ok(plan.steps, "plan must have steps");
        assert.ok(plan.steps.length > 0, "plan must have at least one step");
      });

      it("plan structure is valid", () => {
        validation = validateGoldenPlan(plan, PROJECT_ROOT);
        assert.ok(
          validation.planStructure.passed,
          `Structure issues: ${validation.planStructure.issues.join("; ")}`
        );
      });

      it("target files still exist", () => {
        if (!validation) validation = validateGoldenPlan(plan, PROJECT_ROOT);
        assert.deepStrictEqual(
          validation.targetFilesExist.missing,
          [],
          `Missing files: ${validation.targetFilesExist.missing.join(", ")}`
        );
      });

      it("search patterns still match", () => {
        if (!validation) validation = validateGoldenPlan(plan, PROJECT_ROOT);
        const errors = validation.searchPatternsValid.errors;
        assert.deepStrictEqual(
          errors,
          [],
          `Pattern errors:\n${errors.map((e) => `  ${e.step || ""}: ${e.error || JSON.stringify(e)}`).join("\n")}`
        );
      });
    });
  }
});
