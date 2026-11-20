#!/usr/bin/env node

/**
 * Golden Scenario Capture Script
 *
 * Captures a successful run as a golden scenario for replay testing.
 *
 * Usage:
 *   node __tests__/golden/capture.mjs <run-dir-path> [scenario-id]
 *
 * Examples:
 *   node __tests__/golden/capture.mjs .rks/runs/2026-02-15T20-19-51-426Z_dashboard-health-api-v3
 *   node __tests__/golden/capture.mjs .rks/runs/2026-02-15T20-19-51-426Z_dashboard-health-api-v3 my-custom-id
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateGoldenPlan } from "./validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, "scenarios");
const PROJECT_ROOT = path.resolve(__dirname, "../../../..");

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node capture.mjs <run-dir-path> [scenario-id]");
    console.error("  run-dir-path: path to a .rks/runs/ directory (absolute or relative to project root)");
    console.error("  scenario-id:  optional custom ID (defaults to run slug)");
    process.exit(1);
  }

  const runDirArg = args[0];
  const runDir = path.isAbsolute(runDirArg)
    ? runDirArg
    : path.resolve(PROJECT_ROOT, runDirArg);

  if (!fs.existsSync(runDir)) {
    console.error(`Run directory not found: ${runDir}`);
    process.exit(1);
  }

  // Read run.json
  const runJsonPath = path.join(runDir, "run.json");
  if (!fs.existsSync(runJsonPath)) {
    console.error(`run.json not found in ${runDir}`);
    process.exit(1);
  }
  const runJson = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));

  // Verify run was successful
  const validStatuses = ["executable", "applied", "complete"];
  if (!validStatuses.includes(runJson.status)) {
    console.error(`Run status is "${runJson.status}" — only ${validStatuses.join(", ")} runs can be captured`);
    process.exit(1);
  }

  // Read plan.json
  const planJsonPath = path.join(runDir, "plan.json");
  if (!fs.existsSync(planJsonPath)) {
    console.error(`plan.json not found in ${runDir}`);
    process.exit(1);
  }
  const planJson = JSON.parse(fs.readFileSync(planJsonPath, "utf8"));

  // Determine scenario ID
  const scenarioId = args[1] || runJson.slug || path.basename(runDir).replace(/^\d{4}-.*?Z_/, "");

  // Create scenario directory
  const scenarioDir = path.join(SCENARIOS_DIR, scenarioId);
  if (fs.existsSync(scenarioDir)) {
    console.error(`Scenario "${scenarioId}" already exists at ${scenarioDir}`);
    console.error("Delete it first if you want to re-capture.");
    process.exit(1);
  }
  fs.mkdirSync(scenarioDir, { recursive: true });

  // Copy plan.json
  fs.copyFileSync(planJsonPath, path.join(scenarioDir, "plan.json"));

  // Copy problem.yaml if it exists
  const problemPath = path.join(runDir, "problem.yaml");
  if (fs.existsSync(problemPath)) {
    fs.copyFileSync(problemPath, path.join(scenarioDir, "problem.yaml"));
  }

  // Generate golden.json metadata
  const golden = {
    id: scenarioId,
    sourceRun: runJson.runId,
    sourceStatus: runJson.status,
    projectId: runJson.projectId,
    capturedAt: new Date().toISOString(),
    description: runJson.summary || planJson.planSummary || `Captured from ${runJson.runId}`,
    stepsCount: (planJson.steps || []).length,
    problemId: runJson.problemId || null,
  };
  fs.writeFileSync(
    path.join(scenarioDir, "golden.json"),
    JSON.stringify(golden, null, 2) + "\n"
  );

  // Validate at capture time
  console.log(`\nCapturing golden scenario: ${scenarioId}`);
  console.log(`  Source: ${runJson.runId}`);
  console.log(`  Steps: ${golden.stepsCount}`);
  console.log(`  Status: ${runJson.status}`);
  console.log();

  const validation = validateGoldenPlan(planJson, PROJECT_ROOT);

  if (validation.passed) {
    console.log("  Validation: PASSED");
  } else {
    console.log("  Validation: FAILED (scenario captured but may need attention)");
    if (!validation.planStructure.passed) {
      console.log(`    Structure: ${validation.planStructure.issues.join("; ")}`);
    }
    if (!validation.targetFilesExist.passed) {
      console.log(`    Missing files: ${validation.targetFilesExist.missing.join(", ")}`);
    }
    if (!validation.searchPatternsValid.passed) {
      for (const err of validation.searchPatternsValid.errors) {
        console.log(`    Pattern error: ${err.step || ""} — ${err.error || JSON.stringify(err)}`);
      }
    }
  }

  console.log(`\n  Saved to: ${scenarioDir}`);
  console.log(`  Run 'npm run test:golden' to verify.\n`);
}

main();
