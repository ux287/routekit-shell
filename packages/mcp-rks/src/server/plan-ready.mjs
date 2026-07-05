/**
 * Plan Ready Validation
 * Validates story readiness before planning to improve first-time yield.
 */
import fs from "fs";
import path from "path";
import { parseFrontmatter, resolveNotesDir, updateField } from "../dendron.mjs";
import { PLANNABLE_PHASES, PHASE_GATE_EXEC } from "../workflow/phases.mjs";
import { findIncompleteRuns } from "../workflow/exec-state.mjs";
import { normalizeTargetFiles, resolveTargets } from "../shared/normalize-target-files.mjs";
import { parseTargetsFromMarkdown } from "../llm/targets.mjs";
import { patternExistsInFile } from "../validation/search-replace.mjs";
import { extractCreateFileDirectives } from "./planner-utils.mjs";

/**
 * Extract SEARCH blocks from markdown story body.
 * Recognizes @@SEARCH/@@REPLACE/@@END (canonical), code-fence SEARCH: blocks (legacy),
 * and heading-based #### SEARCH blocks (legacy).
 */
function extractSearchPatterns(markdown) {
  const patterns = [];

  // Canonical: @@SEARCH\n...\n@@REPLACE\n...\n@@END
  const atAtRegex = /^@@SEARCH\r?\n([\s\S]*?)^@@REPLACE\r?\n/gm;
  let match;
  while ((match = atAtRegex.exec(markdown)) !== null) {
    const text = match[1].trim();
    if (text) patterns.push(text);
  }

  // Legacy: SEARCH:\n```...\n```
  const fenceRegex = /SEARCH[:\s]*\n```(?:javascript|typescript|js|ts)?\n([\s\S]*?)```/gi;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const text = match[1].trim();
    if (text) patterns.push(text);
  }

  // Legacy: #### SEARCH\n```...\n```
  const headingRegex = /^#{3,4}\s+SEARCH\s*\n```[\w]*\n([\s\S]*?)```/gim;
  while ((match = headingRegex.exec(markdown)) !== null) {
    const text = match[1].trim();
    if (text) patterns.push(text);
  }

  return patterns;
}

/**
 * Count occurrences of pattern in file content.
 */
function countMatches(content, pattern) {
  if (!pattern) return 0; // Empty pattern = no matches (avoid infinite loop)
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(pattern, idx)) !== -1) {
    count++;
    idx += 1;
  }
  return count;
}

export async function runPlanReadyTool({ projectId, problemId, projectRoot }) {
  const issues = [];
  const warnings = [];

  // 1. Resolve and read the story file
  const notesDir = resolveNotesDir(projectRoot);
  const storyPath = path.join(notesDir, `${problemId}.md`);
  
  if (!fs.existsSync(storyPath)) {
    return { ready: false, issues: [{ check: "story_exists", message: `Story not found: ${problemId}` }] };
  }

  const content = fs.readFileSync(storyPath, "utf8");
  const { data: frontmatter, content: body } = parseFrontmatter(content);

  // 2. Check phase is valid for planning (not draft)
  let currentPhase = frontmatter.phase || "draft";

  // Self-heal a STALE `executing` phase: a test-failed rollback or interrupted exec can strand
  // the story at 'executing' (excluded from PLANNABLE_PHASES), wedging every re-plan with
  // state_transition_failed. If there is NO live exec run for this story, reset it to
  // 'arch-approved' so planning proceeds. If a run IS in flight, leave it — don't clobber a
  // live exec (the phase_status rejection below still fires).
  if (currentPhase === PHASE_GATE_EXEC) {
    const liveRun = findIncompleteRuns(projectRoot).some((r) => r.state?.storyId === problemId);
    if (!liveRun) {
      updateField(notesDir, problemId, "phase", "arch-approved");
      currentPhase = "arch-approved";
      warnings.push({
        check: "stale_executing_self_heal",
        message: "Story was stranded at 'executing' with no live exec run — reset to 'arch-approved' for re-planning.",
      });
    }
  }

  const allowedPhases = PLANNABLE_PHASES;
  if (!allowedPhases.includes(currentPhase)) {
    issues.push({
      check: "phase_status",
      currentPhase,
      allowedPhases,
      message: `Story phase is "${currentPhase}", must be one of: ${allowedPhases.join(", ")}`,
      suggestion: "Update phase to 'ready' when story is complete"
    });
  }

  // 3. Check frontmatter has targetFiles
  const normalizedTargets = normalizeTargetFiles(frontmatter.targetFiles);
  const fmTargets = normalizedTargets.map(t => t.path);
  const fmCreateFiles = new Set(
    normalizedTargets
      .filter(t => t.op === 'create' || t.action === 'CREATE' || t.create === true)
      .map(t => t.path)
  );
  const bodyTargets = parseTargetsFromMarkdown(body);
  const allTargets = [...new Set([...fmTargets, ...bodyTargets])];

  if (allTargets.length === 0) {
    issues.push({ 
      check: "target_files", 
      message: "No targetFiles in frontmatter or ## Target Files section",
      suggestion: "Add targetFiles to frontmatter or ## Target Files section with paths to edit"
    });
  }

  // 3. Verify each target file exists - missing files MUST have CREATE FILE directive
  const createFileDirectives = extractCreateFileDirectives(body);
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    if (!fs.existsSync(targetPath)) {
      // Check if there's a CREATE FILE directive in body OR op: create in frontmatter
      const hasDirective = fmCreateFiles.has(target) || createFileDirectives.some(d =>
        d === target || d.endsWith(target) || target.endsWith(d)
      );
      if (hasDirective) {
        // Valid: file will be created
        warnings.push({
          check: "file_will_be_created",
          file: target,
          message: `Target file will be created: ${target}`,
          suggestion: "CREATE FILE directive found"
        });
      } else {
        // Invalid: missing file without CREATE FILE directive
        issues.push({
          check: "missing_create_directive",
          file: target,
          message: `Target file does not exist and has no CREATE FILE directive: ${target}`,
          suggestion: `Add "// CREATE FILE: ${target}" to story body`
        });
      }
    }
  }

  // 4. Extract and validate SEARCH patterns
  // Each pattern must exist in AT LEAST ONE target file (not all)
  const searchPatterns = extractSearchPatterns(body);

  for (const pattern of searchPatterns) {
    if (!pattern) continue; // Skip empty patterns (CREATE FILE blocks)

    let foundInAnyTarget = false;
    let lastSuggestion = null;

    for (const target of allTargets) {
      const targetPath = path.resolve(projectRoot, target);
      if (!fs.existsSync(targetPath)) continue;

      const result = patternExistsInFile(projectRoot, target, pattern);

      if (result.found) {
        foundInAnyTarget = true;
        // Check for ambiguous patterns (multiple matches)
        const fileContent = fs.readFileSync(targetPath, "utf8");
        const matchCount = countMatches(fileContent, pattern);
        if (matchCount > 1) {
          warnings.push({
            check: "pattern_unique",
            file: target,
            pattern: pattern.slice(0, 100) + (pattern.length > 100 ? "..." : ""),
            message: `SEARCH pattern matches ${matchCount} times in ${target}`,
            suggestion: "Add more context to make pattern unique"
          });
        }
        break; // Found in one target, no need to check others
      } else {
        lastSuggestion = result.suggestion;
      }
    }

    if (!foundInAnyTarget) {
      issues.push({
        check: "pattern_exists",
        pattern: pattern.slice(0, 100) + (pattern.length > 100 ? "..." : ""),
        message: `SEARCH pattern not found in any target file`,
        suggestion: lastSuggestion ? `Similar content found:\n${lastSuggestion}` : "Pattern may be outdated"
      });
    }
  }

  // 4b. Check existing MODIFY targets have modification specs (SEARCH/REPLACE or code blocks)
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    // Only check files that exist on disk and are NOT marked as create
    if (!fs.existsSync(targetPath)) continue;
    if (fmCreateFiles.has(target)) continue;

    // Check if body has SEARCH patterns that match this file
    const hasSearchPattern = searchPatterns.length > 0 && searchPatterns.some(pattern => {
      const result = patternExistsInFile(projectRoot, target, pattern);
      return result.found;
    });

    const hasInjectedSnippet = body.includes(`### Target: ${target}`);

    if (!hasSearchPattern && !hasInjectedSnippet) {
      issues.push({
        check: "no_search_pattern_for_modify",
        file: target,
        message: `Existing target file "${target}" has no SEARCH pattern — modify targets require at least one SEARCH block with exact code to find`,
        suggestion: `Add SEARCH/REPLACE blocks showing the exact code to find and replace in ${target}`
      });
    }
  }

  // 5. Check acceptance criteria quality
  const hasCheckboxes = /- \[ \]/.test(body);
  if (!hasCheckboxes) {
    warnings.push({
      check: "acceptance_criteria",
      message: "No checkbox items found in acceptance criteria",
      suggestion: "Add specific testable criteria with - [ ] format"
    });
  }

  // 6. Validate CREATE FILE directive syntax
  const createFileMatches = body.match(/\/\/\s*CREATE\s+FILE:\s*(.+)/gi) || [];
  for (const match of createFileMatches) {
    const pathPart = match.replace(/\/\/\s*CREATE\s+FILE:\s*/i, "").trim();
    if (pathPart.includes(" ") && !pathPart.startsWith("//")) {
      // Path contains spaces - likely has description mixed in
      const firstWord = pathPart.split(/\s+/)[0];
      warnings.push({
        check: "create_file_syntax",
        message: `CREATE FILE path may contain description: "${pathPart.slice(0, 50)}..."`,
        suggestion: `Use "// CREATE FILE: ${firstWord}" (path only, no description after)`
      });
    }
  }

  // 7. BLOCKING: Check for Telemetry section (unless opted out)
  const hasTelemetrySection = /^#+ Telemetry/m.test(body);
  const skipTelemetry = frontmatter.skipTelemetry === true || frontmatter.skipTelemetry === "true";
  if (!hasTelemetrySection && !skipTelemetry) {
    warnings.push({
      check: "missing_telemetry",
      message: "No ## Telemetry section found",
      suggestion: "Add a ## Telemetry section with events to emit, or add skipTelemetry: true to frontmatter if not applicable"
    });
  }

  // 8. BLOCKING: Check for Testing Requirements section
  // Accepts: ## Testing Requirements, ## Test Cases, testFile frontmatter, or testExempt: true
  const hasTestingSection = /^#+ (Testing Requirements|Test Cases)/m.test(body);
  const hasTestRequirements = frontmatter.testRequirements && frontmatter.testRequirements.length > 0;
  const hasTestFile = frontmatter.testFile && String(frontmatter.testFile).trim().length > 0;
  const isTestExempt = frontmatter.testExempt === true || frontmatter.testExempt === "true";

  const hasTestStory = frontmatter.testStory && String(frontmatter.testStory).trim().length > 0;

  if (!hasTestingSection && !hasTestRequirements && !hasTestFile && !isTestExempt && !hasTestStory) {
    issues.push({
      check: "missing_testing_requirements",
      message: "Missing ## Testing Requirements section - all stories must specify what tests are needed",
      suggestion: "Add a ## Testing Requirements section, a testFile frontmatter field, testExempt: true for doc-only stories, or testStory: '<storyId>' for paired story linkage"
    });
  }

  // 8b. QUALITY: Check testing requirements depth and error-path coverage
  if (hasTestingSection && !isTestExempt) {
    // Extract the Testing Requirements section content (heading to next heading or end)
    const headingMatch = body.match(/^#+ (?:Testing Requirements|Test Cases)\s*$/m);
    if (headingMatch) {
      const startIdx = headingMatch.index + headingMatch[0].length;
      const rest = body.slice(startIdx);
      const nextHeading = rest.search(/\n#+ /);
      const testSection = nextHeading !== -1 ? rest.slice(0, nextHeading) : rest;
      const checkboxItems = (testSection.match(/- \[ \]/g) || []).length;
      if (checkboxItems < 2) {
        warnings.push({
          check: "shallow_testing_requirements",
          checkboxCount: checkboxItems,
          message: `Testing Requirements has only ${checkboxItems} checkbox item(s) — minimum 2 recommended (happy path + error path)`,
          suggestion: "Add at least one error-path test scenario (e.g., 'Test that X fails gracefully when Y is missing')"
        });
      }

      // Check for error-path keywords in testing requirements
      const errorPathKeywords = /\b(error|fail|invalid|missing|reject|throw|edge case|boundary|undefined|null|empty|corrupt|malform|timeout|broken)\b/i;
      if (!errorPathKeywords.test(testSection)) {
        warnings.push({
          check: "no_error_path_tests",
          message: "Testing Requirements has no error-path or edge-case scenarios",
          suggestion: "Add at least one test for failure handling (e.g., 'Test that function throws when input is invalid')"
        });
      }
    }
  }

  // 7. Check for test files in targetFiles
  // Test files match patterns: .test., .spec., __tests__/, tests/
  const testFilePatterns = ['.test.', '.spec.', '__tests__/', 'tests/', '.test.ts', '.test.tsx', '.test.js', '.spec.ts', '.spec.tsx', '.spec.js'];
  const hasTestFileInTargets = allTargets.some(target => {
    const normalizedTarget = typeof target === 'string' ? target : (target.path || '');
    return testFilePatterns.some(pattern => normalizedTarget.includes(pattern));
  });

  // Also check Testing Requirements section for test file references
  const testFileInBody = testFilePatterns.some(pattern => body.includes(pattern));

  if (!hasTestFileInTargets && !testFileInBody && !hasTestStory) {
    warnings.push({
      check: "no_test_files",
      message: "No test files specified in targetFiles or Testing Requirements section",
      suggestion: "Add a test file to targetFiles (e.g., src/Component.test.tsx with action: CREATE) or reference test files in Testing Requirements"
    });
  }

  // 10. Check for malformed SEARCH/REPLACE blocks (markers inside code fences)
  if (/```[\w]*\n\s*\/\/\s*SEARCH:/i.test(body)) {
    warnings.push({
      check: "search_replace_format",
      message: "SEARCH marker found INSIDE code block — planner expects markers OUTSIDE code fences",
      suggestion: "Correct format:\n\nSEARCH:\n```javascript\ncode to find\n```\n\nREPLACE:\n```javascript\nnew code\n```"
    });
  }

  // 11. Block multi-file stories (>2 targets) unless explicitly acknowledged
  if (allTargets.length >= 3) {
    const acknowledged = frontmatter.multiFileAcknowledged === true || frontmatter.multiFileAcknowledged === "true";
    if (acknowledged) {
      warnings.push({
        check: "multi_file_story",
        targetCount: allTargets.length,
        message: `Story has ${allTargets.length} target files (multiFileAcknowledged) - proceed with caution`,
        suggestion: "Multi-file stories have higher partial failure rates"
      });
    } else {
      issues.push({
        check: "multi_file_blocked",
        targetCount: allTargets.length,
        message: `Story has ${allTargets.length} target files - multi-file stories are blocked (>2 targets)`,
        suggestion: "Decompose into smaller stories with 1-2 target files each, or call rks_refine_apply with type: acknowledge_multi_file to set multiFileAcknowledged: true programmatically"
      });
    }
  }

  const ready = issues.length === 0;
  return {
    ready,
    currentPhase,
    issues,
    warnings,
    summary: ready
      ? `Story ready for planning (${allTargets.length} targets, ${searchPatterns.length} patterns validated)`
      : `Story needs refinement: ${issues.length} issues found`
  };
}
