/**
 * Search/Replace Pattern Validation
 *
 * Validates that search_replace plan steps have patterns that actually
 * exist in the target files. This prevents "not found" errors during
 * routekit apply.
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const VALIDATION_DEBUG = process.env.ROUTEKIT_VALIDATION_DEBUG === "1";

function validationDebug(...args) {
  if (!VALIDATION_DEBUG) return;
  console.error("[validation-debug]", ...args);
}

const MODULE_LOAD_TS = Date.now();

/**
 * Normalize whitespace and decorative character runs for comparison.
 * MUST match the logic in plan-quality.mjs for consistent detection/correction.
 * - Convert CRLF to LF
 * - Collapse runs of 3+ identical non-alphanumeric, non-whitespace chars (e.g. ───, ===, ---)
 * - Collapse runs of whitespace within lines to single space
 * - Trim lines and remove leading/trailing blank lines
 */
function normalizeWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/([^\w\s])\1{2,}/g, '$1$1$1')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n+/g, '\n')
    .trim();
}

/**
 * Normalize a single line for comparison.
 * Collapses internal whitespace, decorative character runs, and trims both ends.
 */
function normalizeLine(line) {
  if (typeof line !== 'string') return '';
  return line
    .replace(/([^\w\s])\1{2,}/g, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the correctly-whitespaced version of a pattern in file content.
 *
 * When a pattern matches only after normalization, this function finds
 * the actual text in the file with correct whitespace and returns it.
 *
 * @param {string} fileContent - The actual file content
 * @param {string} searchPattern - The pattern with potentially wrong whitespace
 * @returns {string|null} - The corrected pattern, or null if not found
 */
function findCorrectWhitespacePattern(fileContent, searchPattern) {
  const fileLines = fileContent.split('\n');
  const patternLines = searchPattern.split('\n').filter(l => l.trim() !== '');

  if (patternLines.length === 0) return null;

  // Normalize pattern lines for comparison (same as normalizeWhitespace logic)
  const normalizedPatternLines = patternLines.map(normalizeLine);

  // Search for matching sequence of lines in the file
  for (let i = 0; i <= fileLines.length - patternLines.length; i++) {
    let allMatch = true;
    let matchedFileLineIndices = [];

    // Try to match pattern lines to consecutive non-empty file lines
    let fileLineIdx = i;
    for (let j = 0; j < patternLines.length; j++) {
      // Skip empty file lines
      while (fileLineIdx < fileLines.length && fileLines[fileLineIdx].trim() === '') {
        fileLineIdx++;
      }

      if (fileLineIdx >= fileLines.length) {
        allMatch = false;
        break;
      }

      const normalizedFileLine = normalizeLine(fileLines[fileLineIdx]);

      if (normalizedFileLine !== normalizedPatternLines[j]) {
        allMatch = false;
        break;
      }

      matchedFileLineIndices.push(fileLineIdx);
      fileLineIdx++;
    }

    if (allMatch && matchedFileLineIndices.length === patternLines.length) {
      // Found matching sequence - extract with correct whitespace
      const startIdx = matchedFileLineIndices[0];
      const endIdx = matchedFileLineIndices[matchedFileLineIndices.length - 1];
      const correctedLines = fileLines.slice(startIdx, endIdx + 1);
      return correctedLines.join('\n');
    }
  }

  return null;
}


function wasFileRecentlyModified(projectRoot, filePath) {
  try {
    const rel = path.relative(projectRoot, filePath);
    // Try a git-based check first: if git diff lists the file it was modified
    try {
      const out = execSync(`git diff --name-only HEAD -- ${rel}`, { cwd: projectRoot, stdio: ['pipe','pipe','ignore'] }).toString().trim();
      if (out) return true;
    } catch (err) {
      // ignore git errors (e.g., no HEAD or not a git repo)
    }

    // Fallback: consider the file recently modified if its mtime is within the last 60s
    try {
      const stats = fs.statSync(path.resolve(projectRoot, filePath));
      if (Date.now() - stats.mtimeMs < 60 * 1000) return true;
    } catch (err) {
      // ignore stat errors
    }
  } catch (err) {
    // ignore all
  }
  return false;
}

/**
 * Pattern Exists Helper Function
 *
 * Checks whether a search pattern exists in a file and returns nearby context
 * when not found.
 *
 * @param {string} projectRoot
 * @param {string} filePath
 * @param {string} searchPattern
 * @returns {{found: boolean, suggestion?: string}}
 */
export function patternExistsInFile(projectRoot, filePath, searchPattern) {
  const fsPath = path.resolve(projectRoot, filePath);
  let fileContent;
  try {
    fileContent = fs.readFileSync(fsPath, "utf8");
  } catch (err) {
    return { found: false, suggestion: `unable to read file: ${err.message}` };
  }

  if (fileContent.includes(searchPattern)) {
    return { found: true };
  }

  // Check for whitespace mismatch - pattern matches only after normalization
  // This is NOT a success because execution requires exact match
  const normalizedContent = normalizeWhitespace(fileContent);
  const normalizedPattern = normalizeWhitespace(searchPattern);
  if (normalizedContent.includes(normalizedPattern)) {
    validationDebug(`Whitespace mismatch detected - pattern matches only after normalization`);
    return {
      found: false,
      whitespaceMismatch: true,
      suggestion: "Pattern matches after normalizing whitespace but execution requires exact match. Copy the ragSnippet verbatim including all leading indentation."
    };
  }


  // Build a suggestion with up to 5 lines of context around the best-matching line.
  const lines = fileContent.split(/\r?\n/);
  const tokens = (searchPattern || "").split(/[^A-Za-z0-9_]+/).filter(Boolean).filter(t => t.length >= 3);

  let bestIdx = -1;
  let bestScore = 0;

  if (tokens.length === 0) {
    // fallback: return start of file
    return { found: false, suggestion: lines.slice(0, 5).join("\n") };
  }

  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    const line = lines[i];
    for (const tok of tokens) {
      if (line.includes(tok)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) {
    return { found: false, suggestion: lines.slice(0, 5).join("\n") };
  }

  const start = Math.max(0, bestIdx - 5);
  const end = Math.min(lines.length, bestIdx + 6);
  const excerpt = lines.slice(start, end).join("\n");
  return { found: false, suggestion: excerpt };
}

/**
 * Validates search_replace steps in a plan against actual file contents.
 *
 * @param {Object} plan - The plan object with steps array
 * @param {string} projectRoot - The project root directory
 * @returns {Object} - The plan with validationErrors and possibly updated status
 */
export function validateSearchReplacePatterns(plan, projectRoot, createdPaths) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    validationDebug("No steps to validate");
    return plan;
  }

  const validationErrors = [];

  for (const [i, step] of plan.steps.entries()) {
    if (!step || typeof step !== "object") continue;
    if (step.action !== "search_replace") continue;

    const target = step.target || step.path;
    const stepContext = `step-${step.id || i + 1} (target=${target})`;

    // Validate target path exists
    if (!target || typeof target !== "string") {
      validationErrors.push({
        step: stepContext,
        error: "missing or invalid target path for search_replace step",
      });
      continue;
    }

    // Validate edits array exists
    if (!Array.isArray(step.edits) || step.edits.length === 0) {
      validationErrors.push({
        step: stepContext,
        error: "search_replace step has no edits",
      });
      continue;
    }

    // Same-plan-created-path exemption (N2 Option 1): a search_replace targeting a
    // file that a create_file step earlier in THIS plan will produce can't be
    // validated on disk yet — the file is written at apply time (create runs
    // before edit, and the edit anchors against the just-written content). Skip
    // the on-disk read/anchor check for in-plan-created paths.
    if (createdPaths && createdPaths.has(target)) {
      continue;
    }

    // Read the target file
    const fsPath = path.resolve(projectRoot, target);
    let fileContent;
    try {
      fileContent = fs.readFileSync(fsPath, "utf8");
    } catch (err) {
      validationErrors.push({
        step: stepContext,
        error: `unable to read file at ${target}: ${err.message}`,
      });
      continue;
    }

    // Validate each edit's search pattern exists in the file
    for (const [j, edit] of step.edits.entries()) {
      if (!edit || typeof edit.search !== "string") {
        validationErrors.push({
          step: stepContext,
          edit: j,
          error: "missing 'search' string in edit",
        });
        continue;
      }

      const searchText = edit.search;
      // Try exact match first
      let matched = fileContent.includes(searchText);
      
      // Check for whitespace mismatch - pattern matches only after normalization
      // This is a validation FAILURE because execution requires exact match
      if (!matched) {
        const normalizedContent = normalizeWhitespace(fileContent);
        const normalizedPattern = normalizeWhitespace(searchText);
        if (normalizedContent.includes(normalizedPattern)) {
          // Pattern would match if whitespace was correct - this needs refinement
          const excerpt = searchText.length > 100
            ? searchText.slice(0, 100) + "...<truncated>"
            : searchText;
          validationErrors.push({
            step: stepContext,
            edit: j,
            error: `whitespace mismatch in ${target}`,
            pattern: excerpt,
            hint: "Pattern matches after normalizing whitespace but execution requires exact match. Copy the ragSnippet verbatim including all leading indentation.",
            refinementType: "whitespace_mismatch"
          });
          validationDebug(`Whitespace mismatch detected in ${target} - pattern matches only after normalization`);
          continue; // Skip to next edit, this one already has an error
        }
      }

      if (!matched) {
        // Provide a concise excerpt for the error message
        const excerpt = searchText.length > 100
          ? searchText.slice(0, 100) + "...<truncated>"
          : searchText;

        // Check whether the target file was recently modified (git diff or mtime heuristic)
        let possiblyStale = false;
        try {
          possiblyStale = wasFileRecentlyModified(projectRoot, target);
        } catch (err) {
          // ignore helper errors
        }

        const errObj = {
          step: stepContext,
          edit: j,
          error: `search pattern not found in ${target}`,
          pattern: excerpt,
        };

        if (possiblyStale) {
          errObj.possiblyStale = true;
          errObj.message = "Pattern not found but file was recently modified. Check if functionality already implemented.";
        }

        validationErrors.push(errObj);
      } else {
        // Count occurrences — multiple matches mean the pattern is ambiguous
        let occurrenceCount = 0;
        let pos = 0;
        while ((pos = fileContent.indexOf(searchText, pos)) !== -1) {
          occurrenceCount++;
          pos += searchText.length;
        }
        if (occurrenceCount > 1) {
          const excerpt = searchText.length > 100
            ? searchText.slice(0, 100) + "...<truncated>"
            : searchText;
          validationErrors.push({
            step: stepContext,
            edit: j,
            error: `ambiguous search pattern in ${target} (${occurrenceCount} occurrences)`,
            pattern: excerpt,
            refinementType: "ambiguous_pattern",
            hint: `Pattern matches ${occurrenceCount} locations. Extend the SEARCH block with surrounding context lines to make it unique. Example:\n<<<SEARCH>>>\nCREATE TABLE discrepancies (\n  id INTEGER PRIMARY KEY,\n  description TEXT,\n<<<REPLACE>>>\nCREATE TABLE discrepancies (\n  id INTEGER PRIMARY KEY,\n  description VARCHAR(255),`,
          });
        } else {
          validationDebug(`Pattern verified in ${target}: ${searchText.slice(0, 50)}...`);
        }
      }
    }
  }

  // Update plan status based on validation results
  if (validationErrors.length > 0) {
    const hasPossiblyStale = validationErrors.some(e => e && e.possiblyStale);
    plan.status = hasPossiblyStale ? "possibly_implemented" : "needs_refinement";
    plan.validationErrors = (plan.validationErrors || []).concat(validationErrors);

    // Log validation failures
    console.error("[validation] search_replace patterns failed validation:");
    for (const err of validationErrors) {
      console.error(`  - ${err.step}: ${err.error}`);
      if (err.pattern) {
        console.error(`    Pattern: ${err.pattern}`);
      }
    }
  } else {
    validationDebug("All search_replace patterns verified successfully");
  }

  return plan;
}

/**
 * Standalone validation function for use in CLI or testing
 *
 * @param {string} planPath - Path to plan.yaml or plan.json
 * @param {string} projectRoot - Project root directory
 * @returns {Object} - Validation result with errors array and ok boolean
 */
export async function validatePlanFile(planPath, projectRoot) {
  let plan;

  try {
    const content = fs.readFileSync(planPath, "utf8");
    if (planPath.endsWith(".yaml") || planPath.endsWith(".yml")) {
      const yaml = await import("js-yaml");
      plan = yaml.default.load(content);
    } else {
      plan = JSON.parse(content);
    }
  } catch (err) {
    return {
      ok: false,
      errors: [{ error: `Failed to read/parse plan: ${err.message}` }],
    };
  }

  const validatedPlan = validateSearchReplacePatterns(plan, projectRoot);

  return {
    ok: validatedPlan.status !== "needs_refinement",
    errors: validatedPlan.validationErrors || [],
    plan: validatedPlan,
  };
}

/**
 * Auto-correct whitespace in search_replace patterns.
 *
 * When the LLM generates patterns with incorrect whitespace (a common failure mode),
 * this function finds the correct whitespace version in the actual file and updates
 * the pattern to match exactly.
 *
 * @param {Object} plan - The plan object with steps array
 * @param {string} projectRoot - The project root directory
 * @returns {Object} - The plan with corrected patterns and correction metadata
 */
export function autoCorrectSearchPatterns(plan, projectRoot) {
  if (!plan || typeof plan !== "object") {
    return plan;
  }

  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return plan;
  }

  const corrections = [];

  for (const step of plan.steps) {
    if (!step || typeof step !== "object") continue;
    if (step.action !== "search_replace") continue;

    const target = step.target || step.path;
    if (!target || typeof target !== "string") continue;
    if (!Array.isArray(step.edits) || step.edits.length === 0) continue;

    // Read the target file
    const fsPath = path.resolve(projectRoot, target);
    let fileContent;
    try {
      fileContent = fs.readFileSync(fsPath, "utf8");
    } catch (err) {
      continue; // Skip files that can't be read
    }

    for (const edit of step.edits) {
      if (!edit || typeof edit.search !== "string") continue;

      const searchText = edit.search;

      // Check if exact match already works
      if (fileContent.includes(searchText)) {
        continue; // Pattern is already correct
      }

      // Check for whitespace mismatch
      const normalizedContent = normalizeWhitespace(fileContent);
      const normalizedPattern = normalizeWhitespace(searchText);

      if (normalizedContent.includes(normalizedPattern)) {
        // Try to find and fix the whitespace
        const corrected = findCorrectWhitespacePattern(fileContent, searchText);

        if (corrected && corrected !== searchText) {
          validationDebug(`Auto-correcting whitespace in ${target}`);
          validationDebug(`  Original (${searchText.split('\n').length} lines): ${searchText.slice(0, 60)}...`);
          validationDebug(`  Corrected: ${corrected.slice(0, 60)}...`);

          // Store original for debugging
          const originalPattern = edit.search;
          edit.search = corrected;

          corrections.push({
            target,
            originalPreview: originalPattern.slice(0, 100),
            correctedPreview: corrected.slice(0, 100),
            lineCount: corrected.split('\n').length
          });
        }
      }
    }
  }

  if (corrections.length > 0) {
    plan._whitespaceCorrections = corrections;
    console.error(`[validation] Auto-corrected ${corrections.length} whitespace mismatch(es)`);
  }

  return plan;
}

export default {
  validateSearchReplacePatterns,
  validatePlanFile,
  patternExistsInFile,
  autoCorrectSearchPatterns,
};
