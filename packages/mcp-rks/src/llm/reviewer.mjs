/**
 * Planner Reviewer Mode
 *
 * When stories contain explicit SEARCH/REPLACE blocks, this module
 * validates them rather than regenerating code from scratch.
 *
 * Benefits:
 * - Faster (no full code generation)
 * - More accurate (uses author's patterns, not RAG snippets)
 * - Still adds value via completeness checking
 */

import fs from "fs";
import path from "path";

/**
 * Detect if a story is "implementation-ready" - has explicit edit blocks
 * that can be extracted and validated without LLM regeneration.
 */
export function isImplementationReady(storyContent) {
  if (!storyContent || typeof storyContent !== "string") return false;

  // Look for explicit edit patterns
  const patterns = [
    // Canonical custom markers
    /^@@SEARCH\s*$/m,
    /^@@REPLACE\s*$/m,
    // SEARCH/REPLACE markers (code-fence format)
    /SEARCH:\s*```/i,
    /```\s*\n\s*REPLACE:/i,
    // SEARCH/REPLACE markers (heading format from PO Governor stories)
    /^#{3,4}\s+SEARCH\s*$/m,
    /^#{3,4}\s+REPLACE\s*$/m,
    // SEARCH/REPLACE markers (conflict-marker format from story templates)
    /^<{7}\s*SEARCH\b/m,
    /^>{7}\s*REPLACE\b/m,
    // "Add after X" with code block
    /Add (?:after|before|to)\s+[`'"]?[\w\-.\/]+[`'"]?\s*(?:tool definition|section|line|function|class)?[:\s]*\n\s*```/i,
    // "Replace X with" patterns
    /Replace\s+.*?with[:\s]*\n\s*```/i,
    // Explicit edit section headers
    /^## (?:Edits|Implementation|Code Changes)/im,
  ];

  return patterns.some(p => p.test(storyContent));
}

/**
 * Extract explicit edit blocks from story markdown.
 * Returns array of { file, search, replace, description } objects.
 */
export function extractExplicitEdits(storyContent, projectRoot = null) {
  const edits = [];
  let currentFile = null;
  if (!storyContent) return edits;

  // Pattern 1: ## Edit <filepath> sections with N bare SEARCH/REPLACE blocks
  // Handles any heading level (##, ###, ####, etc.) and any number of pairs per section.
  // Format:
  // ## Edit src/js/file.js        ← any heading level, optional colon
  //
  // SEARCH:
  // ```javascript
  // code to find
  // ```
  // REPLACE:
  // ```javascript
  // new code
  // ```
  //
  // SEARCH:                       ← second pair under same heading — all captured
  // ```javascript
  // more code
  // ```
  // REPLACE:
  // ```javascript
  // replacement
  // ```
  const editSectionRegex = /^#{2,6}\s+Edit:?\s+(\S+[/.]\S*[^\s])/gim;
  const barePairRegex = /SEARCH:\s*```[\w]*\n([\s\S]*?)\n```\s*\nREPLACE:\s*```[\w]*\n([\s\S]*?)\n```/g;

  const editSections = [];
  let sectionMatch;
  while ((sectionMatch = editSectionRegex.exec(storyContent)) !== null) {
    editSections.push({ file: sectionMatch[1].trim(), index: sectionMatch.index + sectionMatch[0].length });
  }
  for (let i = 0; i < editSections.length; i++) {
    const { file, index } = editSections[i];
    const end = i + 1 < editSections.length ? editSections[i + 1].index : storyContent.length;
    const section = storyContent.slice(index, end);
    currentFile = file;
    barePairRegex.lastIndex = 0;
    let pairMatch;
    while ((pairMatch = barePairRegex.exec(section)) !== null) {
      const [, search, replace] = pairMatch;
      if (search && replace !== undefined) {
        edits.push({
          description: "Edit",
          file,
          search: search.trimEnd(),
          replace: replace.trimEnd(),
          source: "search_replace_block"
        });
      }
    }
  }

  // Pattern 1b: legacy ### Edit N: description + File: line format (regression support)
  // Kept for stories using explicit "File: path" lines or numbered edit headings.
  const searchReplaceRegex = /###?\s*(?:Edit\s*\d*:?\s*)?([^\n]*)\n\s*(?:(?:File|Target):\s*([^\n]+)\n\s*)?SEARCH:\s*```[\w]*\n([\s\S]*?)\n```\s*\n\s*REPLACE:\s*```[\w]*\n([\s\S]*?)\n```/gi;

  let match;
  while ((match = searchReplaceRegex.exec(storyContent)) !== null) {
    const [, description, filePath, search, replace] = match;
    const descTrimmed = description?.trim() || '';
    const fileFromDesc = !filePath && /[/.]/.test(descTrimmed) && !/\s/.test(descTrimmed) ? descTrimmed : null;
    const resolvedFile = filePath?.trim() || fileFromDesc || currentFile || null;
    if (resolvedFile) currentFile = resolvedFile;
    // Skip if already captured by Pattern 1
    if (search && replace !== undefined && !edits.some(e => e.search === search.trimEnd())) {
      edits.push({
        description: fileFromDesc ? "Edit" : (descTrimmed || "Edit"),
        file: resolvedFile,
        search: search.trimEnd(),
        replace: replace.trimEnd(),
        source: "search_replace_block"
      });
    }
  }

  // Pattern 1b: SEARCH/REPLACE blocks (heading format from PO Governor)
  // Format:
  // ### EDIT: path/to/file.js
  //
  // #### SEARCH
  // ```javascript
  // code to find
  // ```
  //
  // #### REPLACE
  // ```javascript
  // new code
  // ```
  const headingSearchReplaceRegex = /###?\s*EDIT:\s*([^\n]+)\n\s*####\s*SEARCH\s*\n\s*```[\w]*\n([\s\S]*?)\n```\s*\n\s*####\s*REPLACE\s*\n\s*```[\w]*\n([\s\S]*?)\n```/gi;

  while ((match = headingSearchReplaceRegex.exec(storyContent)) !== null) {
    const [, filePath, search, replace] = match;
    if (filePath) {
      currentFile = filePath.trim();
    }
    if (search && replace !== undefined) {
      edits.push({
        description: `Edit ${filePath?.trim() || currentFile || "file"}`,
        file: filePath?.trim() || currentFile || null,
        search: search.trimEnd(),
        replace: replace.trimEnd(),
        source: "search_replace_block"
      });
    }
  }

  // Pattern 2: "Add after X" with code block
  // Format:
  // Add after `rks_git_branch` tool definition (around line 684):
  // ```javascript
  // { name: "rks_stash", ... }
  // ```
  const addAfterRegex = /Add (?:after|following)\s+[`'"]?([^`'":\n]+)[`'"]?\s*(?:tool definition|section|line|function|class)?[^:]*:\s*\n\s*```[\w]*\n([\s\S]*?)```/gi;

  while ((match = addAfterRegex.exec(storyContent)) !== null) {
    const [, anchor, newCode] = match;
    if (anchor && newCode) {
      edits.push({
        description: `Add after ${anchor.trim()}`,
        file: null,  // Will need to be inferred from targetFiles
        anchor: anchor.trim(),
        newCode: newCode.trimEnd(),
        action: "add_after",
        source: "add_after_block"
      });
    }
  }

  // Pattern 3: "Add before X" with code block
  const addBeforeRegex = /Add (?:before|preceding)\s+[`'"]?([^`'":\n]+)[`'"]?\s*(?:tool definition|section|line|function|class)?[^:]*:\s*\n\s*```[\w]*\n([\s\S]*?)```/gi;

  while ((match = addBeforeRegex.exec(storyContent)) !== null) {
    const [, anchor, newCode] = match;
    if (anchor && newCode) {
      edits.push({
        description: `Add before ${anchor.trim()}`,
        file: null,
        anchor: anchor.trim(),
        newCode: newCode.trimEnd(),
        action: "add_before",
        source: "add_before_block"
      });
    }
  }

  // Pattern 4: CREATE FILE blocks
  // Format:
  // ### CREATE FILE: path/to/file.js
  // ```javascript
  // file content
  // ```
  const createFileRegex = /###?\s*CREATE\s+FILE:\s*([^\n]+)\n\s*```[\w]*\n([\s\S]*?)```/gi;

  while ((match = createFileRegex.exec(storyContent)) !== null) {
    const [, filePath, content] = match;
    if (filePath && content !== undefined) {
      edits.push({
        description: `Create file ${filePath.trim()}`,
        file: filePath.trim(),
        content: content.trimEnd(),
        action: "create",
        source: "create_file_block"
      });
    }
  }

  // Pattern 5: Canonical @@SEARCH/@@REPLACE/@@END blocks
  // Format:
  // [optional] File: path/to/file.js  OR  ### services/sqliteService.ts
  // @@SEARCH
  // exact text to find
  // @@REPLACE
  // replacement text
  // @@END
  //
  // Strip markdown code fences before extraction so that fenced @@SEARCH blocks
  // (e.g. wrapped in ```...```) still resolve their file target correctly.
  // The file heading appears before the fence; after stripping the fence line,
  // the heading is adjacent to @@SEARCH again and the capture group fires.
  const stripCodeFences = (text) => text.replace(/^```[\w]*\s*$/gm, '');
  const storyContentStripped = stripCodeFences(storyContent);

  const atAtRegex = /(?:(?:(?:File|Target):\s*([^\n]+)|^#{1,6}\s+([^\n]+))\n\s*)?^@@SEARCH\r?\n([\s\S]*?)^@@REPLACE\r?\n([\s\S]*?)^@@END\s*$/gm;

  while ((match = atAtRegex.exec(storyContentStripped)) !== null) {
    const [, fileFromFileLine, fileFromHeading, search, replace] = match;
    const resolvedFileRaw = fileFromFileLine?.trim() || fileFromHeading?.trim() || null;
    // Only use heading as file if it looks like a file path (has / or .)
    const resolvedFile = resolvedFileRaw && /[/.]/.test(resolvedFileRaw) ? resolvedFileRaw : (currentFile || null);
    if (resolvedFile) currentFile = resolvedFile;
    if (search !== undefined && replace !== undefined) {
      const searchTrimmed = search.trimEnd();
      const replaceTrimmed = replace.trimEnd();
      // Skip identity transforms (search === replace) — these are plan_ready
      // validation markers only, confirming a pattern exists in the file.
      // They are not executable edits and must not become plan steps.
      if (searchTrimmed === replaceTrimmed) continue;
      if (!edits.some(e => e.search === searchTrimmed)) {
        edits.push({
          description: "Edit (@@SEARCH block)",
          file: resolvedFile || currentFile || null,
          search: searchTrimmed,
          replace: replaceTrimmed,
          source: "at_marker_block"
        });
      }
    }
  }

  // Pattern 6: Conflict-marker SEARCH/REPLACE blocks (from story template docs)
  // Format:
  // <<<<<<< SEARCH
  // code to find
  // =======
  // replacement code
  // >>>>>>> REPLACE
  //
  // Optionally preceded by a File: line or ## Edit header.
  // This format is common in .njk and template files where code-fence
  // format can conflict with template syntax.
  const conflictMarkerRegex = /(?:(?:File|Target):\s*([^\n]+)\n\s*)?^<{7}\s*SEARCH\s*\n([\s\S]*?)^={7}\s*\n([\s\S]*?)^>{7}\s*REPLACE\s*$/gm;

  while ((match = conflictMarkerRegex.exec(storyContent)) !== null) {
    const [, filePath, search, replace] = match;
    if (filePath) {
      currentFile = filePath.trim();
    }
    if (search !== undefined && replace !== undefined) {
      edits.push({
        description: "Edit (conflict-marker block)",
        file: filePath?.trim() || currentFile || null,
        search: search.trimEnd(),
        replace: replace.trimEnd(),
        source: "conflict_marker_block"
      });
    }
  }

  return edits;
}

/**
 * Validate extracted edits against actual file content.
 * Returns validation result with issues found.
 */
export function validateExplicitEdits(edits, projectRoot, targetFiles = []) {
  const result = {
    valid: true,
    issues: [],
    validatedEdits: [],
  };

  for (const edit of edits) {
    const editResult = {
      ...edit,
      validation: { passed: true, checks: [] }
    };

    // Determine target file
    let targetFile = edit.file;
    if (!targetFile && targetFiles.length === 1) {
      targetFile = targetFiles[0];
    }
    // When file is still unresolved and multiple targets exist, try to match
    // the SEARCH pattern against each existing (non-create) target file.
    // Auto-assign if exactly one matches — handles @@SEARCH blocks written
    // without a ### Target: heading in the story note.
    if (!targetFile && targetFiles.length > 1 && edit.search) {
      const matches = targetFiles.filter(tf => {
        const tfPath = path.join(projectRoot, tf);
        if (!fs.existsSync(tfPath)) return false;
        const content = fs.readFileSync(tfPath, "utf8");
        return content.includes(edit.search.trim()) ||
          content.replace(/\s+/g, " ").includes(edit.search.trim().replace(/\s+/g, " "));
      });
      if (matches.length === 1) targetFile = matches[0];
    }

    if (!targetFile) {
      editResult.validation.passed = false;
      editResult.validation.checks.push({
        check: "file_specified",
        passed: false,
        message: "Could not determine target file for edit"
      });
      result.valid = false;
      result.issues.push({
        type: "missing_file",
        edit: edit.description,
        message: "Target file not specified and could not be inferred"
      });
      result.validatedEdits.push(editResult);
      continue;
    }

    editResult.file = targetFile;

    // Read file content
    const filePath = path.join(projectRoot, targetFile);
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
      editResult.validation.checks.push({
        check: "file_exists",
        passed: true,
        message: `File exists: ${targetFile}`
      });
    } catch (err) {
      // File doesn't exist - might be a create operation
      if (edit.action === "create") {
        editResult.validation.checks.push({
          check: "file_exists",
          passed: true,
          message: `File will be created: ${targetFile}`
        });
        result.validatedEdits.push(editResult);
        continue;
      }

      editResult.validation.passed = false;
      editResult.validation.checks.push({
        check: "file_exists",
        passed: false,
        message: `File not found: ${targetFile}`
      });
      result.valid = false;
      result.issues.push({
        type: "file_not_found",
        file: targetFile,
        message: `Cannot find file: ${filePath}`
      });
      result.validatedEdits.push(editResult);
      continue;
    }

    // For search/replace edits, validate the search pattern
    if (edit.search) {
      const searchPattern = edit.search;
      const occurrences = countOccurrences(content, searchPattern);

      if (occurrences === 0) {
        editResult.validation.passed = false;
        editResult.validation.checks.push({
          check: "pattern_exists",
          passed: false,
          message: `Search pattern not found in ${targetFile}`,
          searchPreview: searchPattern.slice(0, 100)
        });
        result.valid = false;
        result.issues.push({
          type: "pattern_not_found",
          file: targetFile,
          pattern: searchPattern.slice(0, 100),
          message: "Search pattern does not exist in file"
        });
      } else if (occurrences > 1) {
        editResult.validation.passed = false;
        editResult.validation.checks.push({
          check: "pattern_unique",
          passed: false,
          message: `Search pattern matches ${occurrences} times (must be unique)`,
          occurrences
        });
        result.valid = false;
        result.issues.push({
          type: "pattern_ambiguous",
          file: targetFile,
          occurrences,
          message: `Search pattern matches ${occurrences} times - add more context to make unique`
        });
      } else {
        editResult.validation.checks.push({
          check: "pattern_exists",
          passed: true,
          message: "Search pattern found"
        });
        editResult.validation.checks.push({
          check: "pattern_unique",
          passed: true,
          message: "Search pattern is unique"
        });
      }
    }

    // For anchor-based edits, validate the anchor exists
    if (edit.anchor) {
      const anchorExists = content.includes(edit.anchor);
      if (!anchorExists) {
        editResult.validation.passed = false;
        editResult.validation.checks.push({
          check: "anchor_exists",
          passed: false,
          message: `Anchor "${edit.anchor}" not found in ${targetFile}`
        });
        result.valid = false;
        result.issues.push({
          type: "anchor_not_found",
          file: targetFile,
          anchor: edit.anchor,
          message: `Anchor text not found in file`
        });
      } else {
        editResult.validation.checks.push({
          check: "anchor_exists",
          passed: true,
          message: `Anchor found: ${edit.anchor}`
        });
      }
    }

    result.validatedEdits.push(editResult);
  }

  return result;
}

/**
 * Convert validated explicit edits to plan steps.
 */
export function editsToSteps(validatedEdits, projectRoot) {
  const steps = [];
  let order = 1;

  for (const edit of validatedEdits) {
    if (!edit.validation.passed) continue;

    const step = {
      id: `step-${String(order).padStart(3, "0")}`,
      title: edit.description || `Edit ${edit.file}`,
      description: edit.description,
      order: order++,
      _reviewerMode: true,
      _source: edit.source,
    };

    if (edit.search !== undefined) {
      // Search/replace edit
      step.action = "search_replace";
      step.path = edit.file;
      step.edits = [{
        search: edit.search,
        replace: edit.replace
      }];
    } else if (edit.action === "add_after" || edit.action === "add_before") {
      // Anchor-based edit - convert to search_replace
      step.action = "search_replace";
      step.path = edit.file;

      // Find the full line containing the anchor and use it as search
      const filePath = path.join(projectRoot, edit.file);
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        const anchorLine = lines.find(l => l.includes(edit.anchor));

        if (anchorLine) {
          if (edit.action === "add_after") {
            step.edits = [{
              search: anchorLine,
              replace: `${anchorLine}\n${edit.newCode}`
            }];
          } else {
            step.edits = [{
              search: anchorLine,
              replace: `${edit.newCode}\n${anchorLine}`
            }];
          }
        } else {
          // Fall back to note if we can't resolve anchor
          step.action = "note";
          step.content = `Could not resolve anchor "${edit.anchor}" for: ${edit.description}`;
        }
      } catch {
        step.action = "note";
        step.content = `Could not read file for anchor resolution: ${edit.file}`;
      }
    } else if (edit.action === "create") {
      step.action = "create_file";
      step.path = edit.file;
      if (!edit.content || !String(edit.content).trim()) {
        step.action = "note";
        step.content = `create_file step for "${edit.file}" has no content — LLM did not generate file body. Re-run rks_plan with more code context injected via rks_refine.`;
      } else {
        step.content = edit.content;
      }
    }

    steps.push(step);
  }

  return steps;
}

/**
 * Build completeness check prompt for LLM.
 * This is a smaller, focused prompt that asks the LLM to review
 * the extracted edits for completeness, not generate new code.
 */
export function buildCompletenessCheckPrompt({ storyContent, extractedEdits, targetFiles }) {
  const editsSummary = extractedEdits.map((e, i) =>
    `${i + 1}. ${e.description} (${e.file || 'file TBD'}): ${e.action || 'search_replace'}`
  ).join("\n");

  return `You are reviewing a code change plan for completeness.

## Story Requirements
${storyContent.slice(0, 4000)}

## Target Files
${targetFiles.join(", ")}

## Extracted Edits (from story)
${editsSummary}

## Your Task
Review if these edits FULLY implement the story requirements.

Respond with JSON only:
{
  "complete": true/false,
  "missingPieces": [
    { "description": "what's missing", "file": "affected file", "reason": "why it's needed" }
  ],
  "notes": "any other observations"
}

Rules:
- If edits cover all acceptance criteria, return { "complete": true, "missingPieces": [], "notes": "..." }
- Only flag ACTUAL gaps, not style preferences
- Common missing pieces to check:
  - Handler added but tool definition missing (or vice versa)
  - Function exported but not imported where used
  - Test file updated but assertions incomplete
`;
}

/**
 * Count occurrences of a substring in content.
 */
function countOccurrences(content, search) {
  if (!content || !search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++;
    pos += 1;
  }
  return count;
}

/**
 * Main reviewer mode entry point.
 * Returns a plan result in the same format as runLlmPlanner.
 */
export async function runReviewerMode({
  storyContent,
  projectRoot,
  targetFiles = [],
  runFolder,
  checkCompleteness = true,
}) {
  const startTime = Date.now();

  // Step 1: Extract explicit edits from story
  const explicitEdits = extractExplicitEdits(storyContent, projectRoot);

  if (explicitEdits.length === 0) {
    return {
      mode: "reviewer",
      status: "no_explicit_edits",
      error: "Story has no extractable SEARCH/REPLACE blocks",
      actions: [],
      validation: { passed: false, issues: [{ type: "no_edits", message: "No explicit edits found" }] },
    };
  }

  // Step 2: Validate edits against files
  const validation = validateExplicitEdits(explicitEdits, projectRoot, targetFiles);

  // Step 3: Convert to steps
  const steps = editsToSteps(validation.validatedEdits, projectRoot);

  // Step 4: Optional completeness check via LLM
  let completenessCheck = null;
  if (checkCompleteness && process.env.ANTHROPIC_API_KEY) {
    // TODO: Implement lightweight LLM call for completeness check
    // For now, skip this and rely on validation
    completenessCheck = {
      checked: false,
      reason: "LLM completeness check not yet implemented"
    };
  }

  const elapsed = Date.now() - startTime;

  // Check if all edits are valid - fail if any patterns are stale
  const validCount = validation.validatedEdits.filter(e => e.validation.passed).length;
  const totalCount = explicitEdits.length;

  if (validCount < totalCount) {
    return {
      mode: "reviewer",
      status: "stale_patterns",
      ok: false,
      refinementRequired: true,
      error: `${totalCount - validCount} of ${totalCount} SEARCH patterns not found in current code`,
      staleEdits: validation.issues,
      hint: "Patterns are stale. Run rks_refine to update, then retry rks_plan.",
      validation: {
        passed: false,
        issues: validation.issues,
        editsExtracted: explicitEdits.length,
        editsValid: validCount,
      },
    };
  }

  return {
    mode: "reviewer",
    status: validation.valid ? "executable" : "validation_failed",
    validation: {
      passed: validation.valid,
      issues: validation.issues,
      editsExtracted: explicitEdits.length,
      editsValid: validation.validatedEdits.filter(e => e.validation.passed).length,
    },
    completenessCheck,
    actions: steps,
    hasExecutableWithContent: steps.some(s => s.action !== "note"),
    planSummary: `Reviewer mode: ${steps.length} steps from ${explicitEdits.length} explicit edits`,
    meta: {
      mode: "reviewer",
      elapsedMs: elapsed,
      explicitEditsFound: explicitEdits.length,
      validationPassed: validation.valid,
    },
  };
}

export default {
  isImplementationReady,
  extractExplicitEdits,
  validateExplicitEdits,
  editsToSteps,
  runReviewerMode,
};
