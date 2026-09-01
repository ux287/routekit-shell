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
import { parseTargetsFromMarkdown, parseImplementationCodeBlocks } from "../llm/targets.mjs";
import {
  patternExistsInFile,
  isIdentityHunk,
  patternPresenceInContent,
} from "../validation/search-replace.mjs";
import { AMBIGUITY_POLICY, extractExplicitEdits } from "../llm/reviewer.mjs";

// Re-exported deliberately, not incidentally. The two validators disagreeing about whether a
// non-unique pattern is fatal is the defect recorded in
// notes/research.2026.08.29.dual-search-validator-asymmetry.md; re-exporting the single shared
// constant makes "they agree" an assertable fact rather than a claim about an import statement.
export { AMBIGUITY_POLICY };
import { extractCreateFileDirectives, extractCreateFileBlocks } from "./planner-utils.mjs";
import { isSynthesizedBody } from "./plan-quality.mjs";

/**
 * Is there a plan run for this story that has NOT been consumed by an exec?
 *
 * "Consumed" is the presence of exec-state.json in the run directory — NOT the mere
 * existence of the directory. That distinction is the whole point: findIncompleteRuns
 * treats terminal `failed`/`aborted` as not-live, so a rolled-back or interrupted exec
 * yields liveRun === false while still leaving exec-state.json on disk. Keying on the
 * directory would misread those as fresh, suppress the self-heal, and reopen the
 * stranding this heal exists to fix.
 *
 * Fails CLOSED (returns false → the self-heal still fires) so a read error can never
 * strand a story at 'executing'.
 */
function hasFreshUnconsumedPlanRun(projectRoot, problemId) {
  try {
    const runsDir = path.join(projectRoot, ".rks", "runs");
    if (!fs.existsSync(runsDir)) return false;
    const slug = String(problemId).replace(/\./g, "-");
    return fs.readdirSync(runsDir).some((name) => {
      if (!name.endsWith(`_${slug}`)) return false;
      const dir = path.join(runsDir, name);
      if (!fs.existsSync(path.join(dir, "plan.json"))) return false;
      return !fs.existsSync(path.join(dir, "exec-state.json"));
    });
  } catch {
    return false;
  }
}

/**
 * Extract SEARCH blocks from markdown story body.
 * Recognizes @@SEARCH/@@REPLACE/@@END (canonical), code-fence SEARCH: blocks (legacy),
 * and heading-based #### SEARCH blocks (legacy).
 */
/**
 * Extract canonical @@SEARCH/@@REPLACE/@@END blocks as PAIRS.
 *
 * extractSearchPatterns below terminates its match at the @@REPLACE marker, so
 * the REPLACE body is structurally unreachable there. This returns both sides
 * so an anchor-only target can be distinguished from a specified change.
 * Legacy fence and heading forms carry no REPLACE side and are not returned.
 */
function extractSearchReplacePairs(markdown) {
  const pairs = [];
  const re = /^@@SEARCH\r?\n([\s\S]*?)^@@REPLACE\r?\n([\s\S]*?)^@@END\s*$/gm;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    pairs.push({ search: m[1].trim(), replace: m[2].trim() });
  }
  return pairs;
}

export function extractSearchPatterns(markdown) {
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
  // NARROWED. Once rks_plan lands a DURABLE arch-approved → executing transition, a story
  // sits legitimately at 'executing' for the whole window between plan and exec — and an
  // unnarrowed self-heal would reset it right back, reopening the deadlock it was never
  // meant to cause. So also require that there is no fresh, UN-CONSUMED plan run.
  //
  // "Un-consumed" is the ABSENCE of exec-state.json, not the absence of a run directory.
  // findIncompleteRuns excludes terminal `failed`/`aborted` states, so a rolled-back or
  // interrupted exec leaves liveRun false but DOES leave exec-state.json behind — those
  // are exactly the stranding cases this heal exists for, and they still heal.
  //
  // Pure conjunction: strictly reduces when the reset fires, never widens it.
  if (currentPhase === PHASE_GATE_EXEC) {
    const liveRun = findIncompleteRuns(projectRoot).some((r) => r.state?.storyId === problemId);
    const freshUnconsumedRun = !liveRun && hasFreshUnconsumedPlanRun(projectRoot, problemId);
    if (!liveRun && !freshUnconsumedRun) {
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
  // A directive alone is NOT enough. The planner binds a create_file step from the FENCED
  // BLOCK that follows the directive; with no block it falls through to the LLM, and when
  // that produces nothing usable the failure is `failureClass: "structural"` with
  // `refinable: false` — an unrecoverable dead end discovered only after a full LLM pass.
  // Catching it here costs nothing and is why this is an issue, not a warning: readiness
  // short-circuits BEFORE any planner spawn.
  //
  // Bind through the planner's OWN extractors, never a proximity regex — a separate matcher
  // can disagree with what the planner actually binds, which is worse than no check at all.
  // Hoisted above the loop: both scan the whole body once.
  const createFileBlocks = new Map([
    ...parseImplementationCodeBlocks(body),
    ...extractCreateFileBlocks(body),
  ]);
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

        // Both extractors key their Maps on the path EXACTLY as written in the body, while
        // the directive match above is suffix-tolerant. Look the block up the SAME way, or a
        // story whose fence path differs in prefix from its frontmatter path is falsely
        // blocked — a false positive that would wedge projects harder than the bug this
        // check exists to catch. Never `createFileBlocks.has(target)`.
        const blockKey = [...createFileBlocks.keys()].find(k =>
          k === target || k.endsWith(target) || target.endsWith(k)
        );
        // isSynthesizedBody(undefined, …) is false, so a missing block and a placeholder-only
        // block fail through the same branch. A fence is necessary but not sufficient.
        if (!isSynthesizedBody(blockKey === undefined ? undefined : createFileBlocks.get(blockKey), target)) {
          issues.push({
            check: "create_target_no_authorable_block",
            file: target,
            message: `Create target has a directive but no authorable code block: ${target}`,
            suggestion: `Add a fenced code block containing real file content immediately after "// CREATE FILE: ${target}" (same "###" section), or under "### Target: ${target}". A directive alone leaves the planner to author the file from prose, which fails with failureClass "structural" and cannot be refined.`
          });
        }
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
  // Canonical blocks as PAIRS. STORY-scoped, exactly like searchPatterns above, so it
  // MUST be attributed to a target before any per-target predicate is applied — see 4b.
  const replacePairs = extractSearchReplacePairs(body);

  // REPORTED COUNT EQUALS COUNT ACTUALLY SUBMITTED. `searchPatterns.length` is the EXTRACTION
  // array length; patterns skipped below (empty CREATE-FILE blocks, or every target absent) are
  // never submitted to the matcher. Reporting the extraction length as "patterns validated" is a
  // number naming something it did not observe.
  let submittedPatterns = 0;

  for (const pattern of searchPatterns) {
    if (!pattern) continue; // Skip empty patterns (CREATE FILE blocks)

    let foundInAnyTarget = false;
    let lastSuggestion = null;
    let checkedAnyTarget = false;

    for (const target of allTargets) {
      const targetPath = path.resolve(projectRoot, target);
      if (!fs.existsSync(targetPath)) continue;

      checkedAnyTarget = true;
      const result = patternExistsInFile(projectRoot, target, pattern);

      if (result.found) {
        foundInAnyTarget = true;
        // Check for ambiguous patterns (multiple matches)
        const fileContent = fs.readFileSync(targetPath, "utf8");
        const matchCount = countMatches(fileContent, pattern);
        if (matchCount > 1) {
          // RECONCILED with packages/mcp-rks/src/llm/reviewer.mjs: a non-unique pattern
          // is FATAL in both validators. It used to warn here and fail there, so a story
          // could pass this readiness gate and then be rejected by the planner for the
          // very pattern this gate had just approved.
          issues.push({
            check: "pattern_unique",
            file: target,
            pattern: pattern.slice(0, 100) + (pattern.length > 100 ? "..." : ""),
            message: `SEARCH pattern matches ${matchCount} times in ${target}`,
            suggestion: "Add more context to make pattern unique",
            ambiguityPolicy: AMBIGUITY_POLICY
          });
        }
        break; // Found in one target, no need to check others
      } else {
        lastSuggestion = result.suggestion;
      }
    }

    if (checkedAnyTarget) submittedPatterns++;

    if (!foundInAnyTarget) {
      issues.push({
        check: "pattern_exists",
        pattern: pattern.slice(0, 100) + (pattern.length > 100 ? "..." : ""),
        message: `SEARCH pattern not found in any target file`,
        suggestion: lastSuggestion ? `Similar content found:\n${lastSuggestion}` : "Pattern may be outdated"
      });
    }
  }

  // 4a-bis. FILE-ATTRIBUTED PRESENCE — the reconciliation.
  //
  // The loop above is STORY-scoped: it asks "is this pattern present in ANY declared target?"
  // The planner reviewer is FILE-scoped: validateExplicitEdits reads path.join(projectRoot,
  // targetFile) and asks "is it present in THE file this edit names?". A pattern declared
  // against file A but present only in file B therefore passed this gate and was then rejected
  // by the reviewer as pattern_not_found — ready:true followed by "N of M explicit edits failed
  // validation", with byte-identical extraction and identical exact-bytes matching on both
  // sides. That is the defect, and it is why a story could clear readiness and never plan.
  //
  // Attribution comes from extractExplicitEdits — the reviewer's OWN extractor — so the two
  // gates cannot disagree about which file an edit names. Presence comes from
  // patternPresenceInContent, the one shared matcher both now use.
  //
  // PROHIBITED: do NOT raise an issue for a target that does not exist on disk. `op: create`
  // targets are deliberately WARNED (file_will_be_created), never failed; failing them here
  // would red the readiness gate for every story that creates a file.
  for (const edit of extractExplicitEdits(body, projectRoot, allTargets)) {
    if (!edit?.search || !edit?.file) continue;
    const attributedPath = path.resolve(projectRoot, edit.file);
    if (!fs.existsSync(attributedPath)) continue; // create target — warned elsewhere, never failed
    let attributedContent;
    try {
      attributedContent = fs.readFileSync(attributedPath, "utf8");
    } catch {
      continue; // unreadable is not "absent"; the reviewer reports file_not_found for this
    }
    const presence = patternPresenceInContent(attributedContent, edit.search);
    if (presence.found) continue;
    issues.push({
      check: "pattern_exists_in_named_file",
      file: edit.file,
      pattern: edit.search.slice(0, 100) + (edit.search.length > 100 ? "..." : ""),
      tiers: presence.tiers,
      whitespaceMismatch: presence.whitespaceMismatch === true,
      message: `SEARCH pattern not found in ${edit.file}, the file this edit names`,
      suggestion: presence.whitespaceMismatch
        ? "Pattern matches only after normalizing whitespace; copy the anchor verbatim including indentation."
        : "The pattern may exist in a different declared target. Attribute the edit to the file that actually contains it."
    });
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

    // backlog.fix.refine-apply-no-growth-fixed-point: on a note over the size cap, refine
    // delivers code context OUT OF BAND rather than injecting a `### Target:` section the cap
    // prune would strip. The one-line marker is the durable record that context was supplied.
    // Without this clause the suppression below is permanently false on exactly those notes,
    // and no_search_pattern_for_modify is raised forever.
    const hasInjectedSnippet =
      body.includes(`### Target: ${target}`) ||
      body.includes(`<!-- rks:context-out-of-band: ${target} -->`);

    // backlog.fix.identity-hunk-passes-as-change-spec: an identity hunk satisfies
    // no_search_pattern_for_modify below (it IS a valid anchor) while specifying
    // no change. WARN, never block — refine's add_search_pattern injects identity
    // anchors deliberately (server/refine.mjs:1801), and blocking would wedge the
    // very recovery loop that injection exists to drive.
    //
    // replacePairs is STORY-scoped, so attribute to THIS target FIRST — the same
    // content-matching compensation hasSearchPattern applies above. Testing the raw
    // story-wide list with .every() would ask "is every block in the STORY identity",
    // which never fires on a story mixing an anchor-only target with a real edit.
    const pairsForTarget = replacePairs.filter(
      (p) => patternExistsInFile(projectRoot, target, p.search).found
    );
    if (
      pairsForTarget.length > 0 &&
      pairsForTarget.every((p) => isIdentityHunk(p.search, p.replace))
    ) {
      warnings.push({
        check: "anchor_only_target",
        file: target,
        message: `Existing target file "${target}" has only identity SEARCH/REPLACE blocks — every block anchors a location but specifies no change`,
        suggestion: `Give at least one block for ${target} a REPLACE side that differs from its SEARCH side, or state in the target's desc why the planner must author the change.`
      });
    }

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
      ? `Story ready for planning (${allTargets.length} targets, ${submittedPatterns} patterns validated)`
      : `Story needs refinement: ${issues.length} issues found`
  };
}
