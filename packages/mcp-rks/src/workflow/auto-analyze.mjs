/**
 * Auto-Analyze Module
 * Pre-planning validation that runs plan_ready checks and provides structured feedback.
 * Called by planner.mjs before LLM generation to fail fast on issues.
 */
import { runPlanReadyTool } from "../server/plan-ready.mjs";
import { validateStory } from "../server/story-validator-v2.mjs";
import { getTelemetryCollector } from "../server/telemetry/collector.mjs";

/**
 * Run pre-planning analysis on a story.
 * Validates story readiness before planning to improve first-time yield.
 *
 * @param {string} projectId - Project identifier
 * @param {string} problemId - Story/problem identifier (e.g., "backlog.feat.foo")
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} options - Optional configuration
 * @returns {Promise<{ready: boolean, issues: Array, warnings: Array, suggestion?: string}>}
 */
export async function runAutoAnalyze(projectId, problemId, projectRoot, options = {}) {
  const collector = getTelemetryCollector();

  try {
    collector.emit("auto_analyze.start", projectId, { problemId });

    // Run plan_ready validation
    const result = await runPlanReadyTool({ projectId, problemId, projectRoot });

    if (!result.ready) {
      collector.emit("auto_analyze.failed", projectId, {
        problemId,
        issueCount: result.issues?.length || 0,
        issues: result.issues?.map(i => i.check) || []
      });

      // Build suggestion from issues
      const suggestions = result.issues
        ?.map(i => i.suggestion)
        .filter(Boolean)
        .join("\n- ");

      return {
        ready: false,
        phase: result.currentPhase,
        issues: result.issues || [],
        warnings: result.warnings || [],
        suggestion: suggestions ? `To fix:\n- ${suggestions}` : undefined,
        summary: result.summary || `Story not ready: ${result.issues?.length || 0} issues found`
      };
    }

    // Run story-validator-v2 quality/completeness scoring
    const allIssues = [...(result.issues || [])];
    const allWarnings = [...(result.warnings || [])];
    try {
      const validation = await validateStory({ projectId, problemId, projectRoot });
      if (validation && !validation.ready) {
        const gaps = validation.gaps || [];
        if (validation.qualityScore < 0.7) {
          allIssues.push({
            check: "story_quality_low",
            score: validation.qualityScore,
            gaps: gaps.filter(g => g.category === 'quality'),
            message: `Story quality score ${validation.qualityScore.toFixed(2)} is below threshold 0.7`,
            suggestion: "Improve story specificity: add code snippets, SEARCH/REPLACE blocks, and precise acceptance criteria"
          });
        }
        if (validation.completenessScore < 0.8) {
          allIssues.push({
            check: "story_completeness_low",
            score: validation.completenessScore,
            gaps: gaps.filter(g => g.category === 'completeness'),
            message: `Story completeness score ${validation.completenessScore.toFixed(2)} is below threshold 0.8`,
            suggestion: "Add missing fields: targetFiles, testFile, acceptance criteria, parent link"
          });
        }
      }
    } catch (validatorError) {
      allIssues.push({
        check: "story_validator_error",
        message: `Story validator failed: ${validatorError.message}`,
        suggestion: "Check story frontmatter and body format"
      });
    }

    if (allIssues.length > 0) {
      collector.emit("auto_analyze.failed", projectId, {
        problemId,
        issueCount: allIssues.length,
        issues: allIssues.map(i => i.check)
      });
      const suggestions = allIssues
        .map(i => i.suggestion)
        .filter(Boolean)
        .join("\n- ");
      return {
        ready: false,
        phase: result.currentPhase,
        issues: allIssues,
        warnings: allWarnings,
        suggestion: suggestions ? `To fix:\n- ${suggestions}` : undefined,
        summary: `Story not ready: ${allIssues.length} issues found`
      };
    }

    collector.emit("auto_analyze.passed", projectId, {
      problemId,
      warningCount: allWarnings.length
    });

    return {
      ready: true,
      phase: result.currentPhase,
      issues: [],
      warnings: allWarnings,
      summary: result.summary
    };

  } catch (error) {
    collector.emit("auto_analyze.error", projectId, {
      problemId,
      error: error.message
    });

    // On error, return not ready with the error as an issue
    return {
      ready: false,
      issues: [{
        check: "analysis_error",
        message: `Auto-analyze failed: ${error.message}`,
        suggestion: "Check that the story file exists and has valid frontmatter"
      }],
      warnings: [],
      summary: `Analysis error: ${error.message}`
    };
  }
}

/**
 * Check if auto-analyze should be skipped for this invocation.
 * Useful for retry attempts or when explicitly bypassed.
 */
export function shouldSkipAnalysis(options = {}) {
  // Skip if explicitly disabled
  if (options.skipAnalysis === true) return true;

  // Skip on retry attempts (already analyzed on first try)
  if (options.retryAttempt > 0) return true;

  // Skip if running in apply-only mode
  if (options.applyOnly === true) return true;

  return false;
}
