import fs from "fs";
import path from "path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runLlmPlanner } from "../llm/planner.mjs";
import { ensureDir, loadProjectProtectedConfig, isProtectedPath } from "./project.mjs";
import { findFunctionSlice, replaceSlice } from "../llm/slices.mjs";
import { applySearchReplace } from "./step-apply.mjs";

/**
 * Generate a fix plan based on test failure context.
 * @param {Object} options
 * @param {string} options.projectRoot - Project root path
 * @param {string} options.runDir - Run folder path
 * @param {Object} options.originalPlan - The original plan that failed
 * @param {string[]} options.appliedFiles - Files that were modified
 * @param {string} options.testOutput - Test failure output
 * @param {number} options.attemptNumber - Current attempt number (1-based)
 * @returns {Promise<Object|null>} - Fix plan or null if generation fails
 */
export async function generateFixPlan({ projectRoot, runDir, originalPlan, appliedFiles, testOutput, attemptNumber }) {
  console.error(`[rks.exec] Generating fix plan (attempt ${attemptNumber + 1})...`);

  // Truncate test output to head + tail so both early and late failure clusters
  // survive into the repair LLM prompt. Previously this kept only the last 150
  // lines, which silently dropped failures that landed earlier in the output —
  // the planner could then never see them and generated identical 3-step plans
  // across refine cycles.
  const HEAD_LINES = 500;
  const TAIL_LINES = 500;
  const testLines = (testOutput || "").split("\n");
  let truncatedTestOutput;
  let truncationLabel;
  if (testLines.length <= HEAD_LINES + TAIL_LINES) {
    truncatedTestOutput = testLines.join("\n");
    truncationLabel = `${testLines.length} lines`;
  } else {
    const head = testLines.slice(0, HEAD_LINES);
    const tail = testLines.slice(-TAIL_LINES);
    const omitted = testLines.length - HEAD_LINES - TAIL_LINES;
    truncatedTestOutput = [
      ...head,
      `… ${omitted} lines omitted …`,
      ...tail,
    ].join("\n");
    truncationLabel = `first ${HEAD_LINES} + last ${TAIL_LINES} of ${testLines.length} lines (${omitted} omitted)`;
  }

  // Build requirements for the fix plan
  const requirements = `FIX REQUIRED: The previous plan failed verification tests.

## Original Problem
${originalPlan.problemId || "Unknown problem"}

## Plan Summary
${originalPlan.planSummary || "No summary available"}

## Files Modified
${appliedFiles.map((f) => `- ${f}`).join("\n")}

## Test Failure Output (${truncationLabel})
\`\`\`
${truncatedTestOutput}
\`\`\`

## Instructions
1. Analyze the test failure output above
2. Identify what went wrong in the previous changes
3. Generate corrective edits that fix the failing tests
4. Focus ONLY on the modified files: ${appliedFiles.join(", ")}
5. Use search_replace patterns from the CURRENT file contents (after previous edits were applied)`;

  // Build contextual refs - include the modified files for context
  const contextualRefs = appliedFiles.map((filePath) => {
    const absPath = path.join(projectRoot, filePath);
    if (fs.existsSync(absPath)) {
      const content = fs.readFileSync(absPath, "utf8");
      return {
        path: filePath,
        anchor: content.slice(0, 5000), // Include up to 5KB of each file
      };
    }
    return null;
  }).filter(Boolean);

  try {
    // Build context as a string (runLlmPlanner expects string, not object)
    const contextStr = `Fix plan for attempt ${attemptNumber + 1}. Project: ${projectRoot}. Fixing files: ${appliedFiles.join(", ")}`;

    const fixPlan = await runLlmPlanner({
      requirements,
      fullRequirements: requirements,
      context: contextStr,
      editableTargets: appliedFiles,
      contextualRefs,
      runFolder: runDir,
      useReplay: false, // Don't use replay for fix plans
      plannerMode: "full",
    });

    if (!fixPlan) {
      console.warn("[rks.exec] Fix plan generation returned null");
      return null;
    }

    // Mark this as a fix plan
    fixPlan.isFixPlan = true;
    fixPlan.attemptNumber = attemptNumber + 1;
    fixPlan.parentPlan = originalPlan.slug || path.basename(runDir);

    // Save fix plan to run folder
    const fixPlanPath = path.join(runDir, `plan-fix-${attemptNumber}.json`);
    fs.writeFileSync(fixPlanPath, JSON.stringify(fixPlan, null, 2));
    console.error(`[rks.exec] Fix plan saved to ${fixPlanPath}`);

    return fixPlan;
  } catch (error) {
    console.error(`[rks.exec] Fix plan generation failed: ${error.message}`);
    return null;
  }
}

/**
 * Apply a fix plan to the project.
 * Uses the same logic as runApplyTool but operates on a specific plan object.
 */
export async function applyFixPlan({ projectId, projectRoot, plan, runDir, attemptNumber }) {
  const applyDir = path.join(runDir, "apply");
  ensureDir(applyDir);
  const applyLogPath = path.join(applyDir, `attempt-${attemptNumber}.log`);
  const logLines = [];
  const writeLog = (line) => logLines.push(line);

  const appliedFiles = [];
  const stepsApplied = [];

  const getTargetPath = (step) => step?.target || step?.path || null;

  try {
    const protectedConfig = loadProjectProtectedConfig(projectRoot);
    const protectedPatterns = [
      ...(protectedConfig.protected || []),
      ...(protectedConfig.projectProtected || []),
    ];

    const backlogNotesToMark = [];
    for (const step of plan.steps || []) {
      if (!step || !step.action) continue;
      const action = step.action;
      const target = getTargetPath(step);

      if (action === "note" || action === "run_command") {
        if (action === "note" && target) {
          // Defer marking backlog notes until the apply completes successfully.
          // Collect target(s) so they can be updated after all steps succeed.
          backlogNotesToMark.push(target);
          writeLog(`defer-mark: ${target}`);
        } else {
          writeLog(`skip: ${action}`);
        }
        continue;
      }

      if (!target || typeof target !== "string" || !target.trim()) {
        throw new McpError(ErrorCode.InvalidParams, "Step missing path/target");
      }

      const absPath = path.join(projectRoot, target);

      if (isProtectedPath(target, protectedPatterns)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Attempted to edit protected file: ${target}. See .rks/protected-files.yml.`
        );
      }

      if (action === "create_file") {
        ensureDir(path.dirname(absPath));
        const content = step.content ?? "";
        fs.writeFileSync(absPath, content, "utf8");
        writeLog(`wrote: ${target}`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else if (action === "edit_file") {
        if (!fs.existsSync(absPath)) {
          throw new McpError(ErrorCode.InvalidParams, `Cannot edit missing file: ${target}`);
        }
        if (!step.content || !String(step.content).trim()) {
          throw new McpError(ErrorCode.InvalidParams, `edit_file step missing content for ${target}`);
        }
        const scope = step.scope || "file";
        if (!step.scope || scope === "file") {
          fs.writeFileSync(absPath, step.content, "utf8");
          writeLog(`wrote: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else if (scope === "function" && step.targetId) {
          const sourceText = fs.readFileSync(absPath, "utf8");
          const slice = findFunctionSlice(sourceText, step.targetId);
          if (!slice) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Function ${step.targetId} not found or ambiguous in ${target}`
            );
          }
          const updated = replaceSlice(sourceText, slice, step.content);
          fs.writeFileSync(absPath, updated, "utf8");
          writeLog(`wrote function slice: ${target} (${step.targetId})`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          throw new McpError(ErrorCode.InvalidParams, `Unsupported edit scope for ${target}: ${scope}`);
        }
      } else if (action === "delete_file") {
        if (fs.existsSync(absPath)) {
          fs.rmSync(absPath, { force: true });
          writeLog(`deleted: ${target}`);
          appliedFiles.push(target);
          stepsApplied.push(action);
        } else {
          writeLog(`skip delete (missing): ${target}`);
        }
      } else if (action === "search_replace") {
        if (!Array.isArray(step.edits) || step.edits.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, `search_replace step missing edits for ${target}`);
        }
        const result = applySearchReplace(absPath, step.edits);
        writeLog(`search_replace: ${target} (${result.applied} edits)`);
        appliedFiles.push(target);
        stepsApplied.push(action);
      } else {
        writeLog(`skip unsupported action: ${action}`);
      }
    }

    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n`, "utf8");
    console.error(`[rks.exec] Fix plan applied, log at ${applyLogPath}`);

    return {
      ok: true,
      stepsApplied: stepsApplied.length,
      appliedFiles,
    };
  } catch (error) {
    fs.writeFileSync(applyLogPath, `${logLines.join("\n")}\n${error.message}\n`, "utf8");
    console.error(`[rks.exec] Fix plan apply failed: ${error.message}`);
    return {
      ok: false,
      error: error.message,
      appliedFiles,
    };
  }
}
