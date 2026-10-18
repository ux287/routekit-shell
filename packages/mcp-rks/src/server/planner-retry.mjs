/**
 * Progressive retry strategies for LLM parse failures
 * 
 * Phase 1: Helper module with retry strategies
 * Phase 2: Integration into planner.mjs retry loop (separate story)
 */

/**
 * Get modified prompt for retry attempt based on failure history
 * @param {string} originalPrompt - The original prompt
 * @param {number} attempt - Current attempt number (1-based)
 * @param {Array} previousErrors - Array of previous error messages
 * @returns {string} Modified prompt for retry
 */
export function getRetryPrompt(originalPrompt, attempt, previousErrors = []) {
  switch (attempt) {
    case 1:
      // Add explicit formatting reminder
      return `${originalPrompt}

CRITICAL: Your response MUST be valid JSON. Respond ONLY with a single JSON object that matches the schema. Do not include markdown code fences or any text outside the JSON.`;
    
    case 2:
      // Simplify and be more explicit
      return `${originalPrompt}

IMPORTANT: Previous response failed to parse. Please respond with ONLY valid JSON in this exact format:

{
  "planSummary": "short summary",
  "steps": [
    {
      "title": "short step title",
      "description": "one or two sentences",
      "action": "search_replace",
      "path": "path/to/file.js",
      "edits": [{"search": "exact text", "replace": "new text"}]
    }
  ]
}

No explanations, no markdown, just JSON.`;
    
    case 3:
      // Last attempt - minimal prompt
      return `Generate a JSON plan with planSummary and steps array. Each step needs: title, description, action (search_replace or create_file), path, and either content or edits array. Respond with ONLY the JSON, nothing else.

Original request: ${extractCoreRequest(originalPrompt)}`;
    
    default:
      return originalPrompt;
  }
}

/**
 * Extract core request from full prompt for simplified retry
 */
function extractCoreRequest(prompt) {
  // Look for problem description section
  const problemMatch = prompt.match(/# Problem\n([\s\S]*?)(?=\n#|\n##|$)/);
  if (problemMatch) {
    return problemMatch[1].trim().slice(0, 500);
  }
  // Fallback: first 500 chars
  return prompt.slice(0, 500);
}

/**
 * Determine if we should escalate to refine
 * @param {number} attempt - Current attempt number
 * @param {string} errorType - Type of error encountered
 * @returns {boolean} Whether to escalate to refine
 */
export function shouldEscalateToRefine(attempt, errorType) {
  // After 3 parse failures, escalate
  if (attempt >= 3 && (errorType === "parse_failed" || errorType === "invalid_json")) {
    return true;
  }
  return false;
}

/**
 * Build refine context from failed attempts
 * @param {Array} attempts - Array of failed attempt info
 * @returns {object} Context for refine tool
 */
export function buildRefineContext(attempts) {
  return {
    trigger: "planner_parse_failures",
    failedAttempts: attempts.length,
    lastError: attempts[attempts.length - 1]?.error,
    suggestion: "Story may need more explicit SEARCH/REPLACE blocks or simpler structure"
  };
}