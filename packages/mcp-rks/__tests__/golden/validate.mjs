/**
 * Golden-Run Validation
 *
 * Validates a frozen plan.json against the current repo state.
 * Reuses the same validation infrastructure used in the build pipeline.
 *
 * Checks:
 * 1. Plan structure (steps array, required fields)
 * 2. Target files exist in repo
 * 3. Search patterns in search_replace steps still match file contents
 *
 * Note: runGuardrails() operates on plan.actions (legacy format), not
 * plan.steps (current format). Guardrail checks are skipped for now.
 */

import { validateSearchReplacePatterns } from "../../src/validation/search-replace.mjs";
import fs from "fs";
import path from "path";

/**
 * Validate a frozen golden plan against the current project root.
 * Returns a results object with per-check details and an overall passed flag.
 */
export function validateGoldenPlan(plan, projectRoot) {
  const results = {
    planStructure: checkPlanStructure(plan),
    targetFilesExist: checkTargetFiles(plan, projectRoot),
    searchPatternsValid: checkSearchPatterns(plan, projectRoot),
  };

  results.passed =
    results.planStructure.passed &&
    results.targetFilesExist.passed &&
    results.searchPatternsValid.passed;

  return results;
}

/**
 * Verify plan has required structural elements.
 */
function checkPlanStructure(plan) {
  const issues = [];

  if (!plan || typeof plan !== "object") {
    return { passed: false, issues: ["plan is not an object"] };
  }
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    issues.push("missing or empty steps array");
  }
  if (!plan.projectId) {
    issues.push("missing projectId");
  }

  for (const step of plan.steps || []) {
    if (!step.action) {
      issues.push(`step ${step.id || "?"} missing action`);
    }
    if (!step.path && step.action !== "run_command") {
      issues.push(`step ${step.id || "?"} missing path`);
    }
  }

  return { passed: issues.length === 0, issues };
}

/**
 * Verify all files referenced by plan steps exist in the repo.
 * Skips create_file steps — those files are expected to NOT exist yet.
 */
function checkTargetFiles(plan, projectRoot) {
  const missing = [];
  const CREATE_ACTIONS = new Set(["create_file", "create"]);

  for (const step of plan.steps || []) {
    if (CREATE_ACTIONS.has(step.action)) continue;

    const target = step.path || step.target;
    if (!target) continue;

    const fullPath = path.resolve(projectRoot, target);
    if (!fs.existsSync(fullPath)) {
      missing.push(target);
    }
  }

  return { passed: missing.length === 0, missing };
}

/**
 * Verify search patterns in search_replace steps still match file contents.
 * Uses the same validateSearchReplacePatterns() used in the build pipeline.
 */
function checkSearchPatterns(plan, projectRoot) {
  // validateSearchReplacePatterns mutates plan by adding validationErrors
  // Work on a deep copy to avoid side effects
  const planCopy = JSON.parse(JSON.stringify(plan));
  const validated = validateSearchReplacePatterns(planCopy, projectRoot);

  const errors = validated.validationErrors || [];
  return { passed: errors.length === 0, errors };
}
