import fs from 'fs';

/**
 * Check plan completeness using cheap heuristics
 * Compares acceptance criteria count vs plan step count
 */
// backlog.fix.planner-greenfield-body-synthesis
// ---------------------------------------------------------------------------------------------
// THE single shared answer to "is this step content a REAL file body, or prose/placeholder?".
// Before this existed, four load-bearing sites each rolled their own check and DISAGREED: the
// create-coverage gate counted any non-empty string as covered (so LLM prose passed as a real
// create and the loud structural failure was skipped), while the quality gate rejected that same
// prose — dumping the plan into a soft retry loop that could never converge. Greenfield builds
// failed 3x and never ran.
//
// DESIGN — CONSERVATIVE / FAIL-SAFE. A false negative here is far worse than a false positive:
// the coverage gate turns "not a real body" into an UNREFINABLE hard failure. So this returns
// TRUE (real body) by default and only returns FALSE for narrow, high-precision cases. When in
// doubt: TRUE.
//
// Returns FALSE for exactly three classes:
//   1. Empty / whitespace-only.
//   2. Placeholder-ONLY — a WHOLE-BODY test: after stripping comments and whitespace, nothing of
//      substance remains. This is deliberately NOT a substring match. A real 200-line component
//      that happens to contain `// TODO: handle divide-by-zero` is a REAL BODY. LLM-authored code
//      routinely carries TODO comments; treating an incidental TODO as "not a body" would hard-fail
//      correct work. Applies to ALL extensions — the whole-body rule (not the extension carve-out)
//      is what keeps a real README containing "replace this", or a real .yml containing
//      `# TODO: tune this`, classified as REAL.
//   3. Prose narration — but ONLY for code files, and only when the body contains NO code
//      punctuation at all AND reads like sentences ("create a Calculator component that handles
//      four operations..."). Non-code content (.md/.json/.html/.css/.yml/.txt/unknown) is exempt:
//      prose is a legitimate body there.
// ---------------------------------------------------------------------------------------------

// Extensions whose legitimate content is prose-shaped or declarative — never judged by rule 3.
const PROSE_EXEMPT_EXTS = new Set([
  "md", "markdown", "json", "html", "htm", "css", "scss", "sass", "less",
  "yml", "yaml", "txt", "xml", "svg", "toml", "ini", "csv", "env",
]);

// Extensions where `//` is a real comment (mirrors the historical allowsSlashComments list).
const SLASH_COMMENT_EXTS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "scss", "sass", "css", "less",
  "go", "java", "c", "cpp", "h", "hpp", "rs", "swift", "kt", "cs",
]);

function extOf(filePath) {
  const base = String(filePath || "").split("/").pop() || "";
  if (!base.includes(".")) return "";
  return base.split(".").pop().toLowerCase();
}

/** Strip comments so we can ask "is that ALL there is?" — the whole-body test for rule 2. */
function stripComments(content, ext) {
  let out = String(content);
  out = out.replace(/\/\*[\s\S]*?\*\//g, " ");          // /* block */
  if (SLASH_COMMENT_EXTS.has(ext) || !ext) {
    out = out.replace(/^\s*\/\/.*$/gm, " ");             // // line
  }
  if (!SLASH_COMMENT_EXTS.has(ext)) {
    out = out.replace(/^\s*#.*$/gm, " ");                // # line (yml, sh, ini, ...)
  }
  out = out.replace(/<!--[\s\S]*?-->/g, " ");            // <!-- html -->
  return out;
}

/**
 * Is `content` a real file body (vs prose/placeholder)? Conservative: TRUE unless clearly not.
 * @param {string} content
 * @param {string} [filePath] used only for extension-aware carve-outs
 * @returns {boolean}
 */
export function isSynthesizedBody(content, filePath) {
  if (typeof content !== "string") return false;
  // 1. Empty / whitespace-only.
  if (!content.trim()) return false;

  const ext = extOf(filePath);
  const stripped = stripComments(content, ext).trim();

  // 2. Placeholder-ONLY (whole-body). Nothing but comments/whitespace → not a body.
  if (!stripped) return false;
  // ...or the only substance left IS the placeholder vocabulary itself (e.g. a bare
  // "TODO: implement this" with no comment marker). Incidental placeholder text inside real
  // content survives this — that is the whole point.
  const substantive = stripped
    .replace(/^\s*(TODO|FIXME)\b.*$/gim, " ")
    .replace(/\b(placeholder text|integration logic)\b/gi, " ")
    .trim();
  if (!substantive) return false;

  // 3. Prose narration — code files only; non-code content is exempt (prose is valid there).
  if (ext && !PROSE_EXEMPT_EXTS.has(ext)) {
    const hasCodeShape =
      /[{}();=[\]<>]|=>|\b(function|const|let|var|import|export|class|return|def|fn|package|public|private)\b/.test(
        substantive,
      );
    const readsLikeNarration =
      /\b(create|implement|add|build|update|handle|render|define|write)\b[\s\S]{0,120}\b(component|function|file|module|class|method|test|logic|hook|page)\b/i.test(
        substantive,
      ) || /^[A-Z][^{};=()\n]{20,}\.\s*$/m.test(substantive);

    // A shapeless body that is just plain English sentences ("Create a Calculator.") is narration
    // too — the two patterns above miss short imperatives. Every clause here is required to keep
    // this from eating real code: it fires ONLY on a body with no code punctuation or keywords at
    // all, that starts with a capital, ends in sentence punctuation, and is short. Real source
    // that lacks ALL code shape is already vanishingly rare, and shapeless non-prose (a bare SQL
    // `SELECT * FROM users`, a fixture wordlist) has no terminal period and survives.
    const looksLikePlainSentences =
      substantive.length < 400 &&
      /^[A-Z]/.test(substantive) &&
      /[.!?]\s*$/.test(substantive) &&
      /\s/.test(substantive);

    if (!hasCodeShape && (readsLikeNarration || looksLikePlainSentences)) return false;
  }

  return true; // fail-safe default
}

export function checkPlanCompleteness(problemContent, plan) {
  if (!problemContent) {
    return { severity: 'ok', triggerSemanticCheck: false };
  }

  const criteriaCount = (problemContent.match(/- \[ \]/g) || []).length;
  const stepCount = plan.steps?.length || 0;

  // Rule 1: 1 step for 3+ criteria = likely incomplete
  if (criteriaCount >= 3 && stepCount <= 1) {
    return {
      severity: 'warning',
      triggerSemanticCheck: true,
      message: `Plan has ${stepCount} step(s) for ${criteriaCount} acceptance criteria`
    };
  }

  // Rule 2: Steps < criteria/2 = suspicious
  if (criteriaCount > 0 && stepCount < Math.ceil(criteriaCount / 2)) {
    return {
      severity: 'warning',
      triggerSemanticCheck: true,
      message: `Plan has ${stepCount} steps for ${criteriaCount} criteria - may be incomplete`
    };
  }

  return { severity: 'ok', triggerSemanticCheck: false };
}

import path from 'path';
import { createHash } from 'crypto';
import { builtinModules } from 'module';
import { readPackageDependencies } from './planner-prompts.mjs';

/**
 * Compute SHA256 hash of plan for integrity verification
 */
export function computePlanHash(plan) {
  const content = typeof plan === 'string' ? plan : JSON.stringify(plan);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize whitespace and decorative character runs for comparison:
 * - convert CRLF to LF
 * - collapse runs of 3+ identical non-alphanumeric, non-whitespace chars (e.g. ───, ===, ---)
 * - collapse runs of whitespace within lines to single space
 * - trim lines and remove leading/trailing blank lines
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
 * Aggressively collapse ALL whitespace (including newlines) to single spaces.
 * Used as a final fallback when the LLM reformats single-line code as multi-line
 * (or vice versa) in search_replace patterns.
 */
function flattenWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Find the closest matching region in file content for a search pattern.
 * Uses first-line matching to locate the approximate area, then returns
 * surrounding context lines so the planner can see what the file actually contains.
 *
 * @param {string} content - Full file content
 * @param {string} search - The search pattern that wasn't found
 * @returns {string|null} The closest matching region, or null if nothing is close
 */
function findClosestMatch(content, search) {
  if (!content || !search) return null;

  const contentLines = content.split('\n');
  const searchLines = search.split('\n');
  const firstSearchLine = (searchLines[0] || '').trim();
  if (!firstSearchLine) return null;

  // Try progressively shorter prefixes of the first line to find a near-match
  let bestIdx = -1;
  const minLen = Math.min(20, firstSearchLine.length);
  for (let len = firstSearchLine.length; len >= minLen; len -= 5) {
    const prefix = firstSearchLine.slice(0, len);
    bestIdx = contentLines.findIndex(l => l.includes(prefix));
    if (bestIdx >= 0) break;
  }

  // Fallback: try matching any search line (not just the first)
  if (bestIdx < 0) {
    for (const sl of searchLines) {
      const trimmed = sl.trim();
      if (trimmed.length < 10) continue;
      bestIdx = contentLines.findIndex(l => l.includes(trimmed));
      if (bestIdx >= 0) break;
    }
  }

  if (bestIdx < 0) return null;

  // Return context around the match (same number of lines as the search pattern + padding)
  const contextSize = Math.max(searchLines.length + 2, 5);
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(contentLines.length, start + contextSize);
  return contentLines.slice(start, end).join('\n');
}

/**
 * Find the 0-indexed line number where a search pattern starts in content.
 * Returns -1 if not found. Falls back to normalized-whitespace matching.
 */
function findLineIndex(content, search) {
  if (!content || !search) return -1;
  const idx = content.indexOf(search);
  if (idx !== -1) return content.slice(0, idx).split('\n').length - 1;
  // Fallback: normalized match
  const normContent = normalizeWhitespace(content);
  const normSearch = normalizeWhitespace(search);
  const normIdx = normContent.indexOf(normSearch);
  if (normIdx === -1) return -1;
  return normContent.slice(0, normIdx).split('\n').length - 1;
}

/**
 * Count non-overlapping occurrences of search in text
 */
function countOccurrences(text, search) {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + search.length;
  }
  return count;
}

/**
 * LLM-based semantic coverage check
 * Only called when heuristics flag a concern
 */
export async function semanticCoverageCheck(problemContent, plan, llmCall) {
  const stepsText = (plan.steps || [])
    .map((s, i) => `${i + 1}. ${s.title}: ${s.description || ''}`)
    .join('\n');

  const prompt = `You are validating whether a generated plan addresses its requirements.

## Problem Statement & Acceptance Criteria
${problemContent}

## Generated Plan Steps
${stepsText}

## Task
Score this plan's completeness from 1-5:
- 5: All acceptance criteria clearly addressed by plan steps
- 4: Most criteria covered, minor gaps
- 3: Partial coverage, some criteria unaddressed
- 2: Significant gaps, plan misses key requirements
- 1: Plan does not address the problem or is severely incomplete

Return JSON only:
{"score": <1-5>, "reasoning": "<brief explanation>", "missingCriteria": ["<criterion not covered>"], "suggestion": "decompose" | "add_detail" | "acceptable"}`;

  try {
    if (typeof llmCall !== 'function') {
      throw new Error('No llmCall provided');
    }

    const result = await llmCall(prompt);
    const score = typeof result?.score === 'number' ? result.score : null;

    if (score === null) {
      return { severity: 'warning', message: 'LLM returned unexpected format' };
    }

    if (score <= 2) {
      return {
        severity: 'error',
        message: `Plan completeness score: ${score}/5 - ${result.reasoning || ''}`,
        missingCriteria: result.missingCriteria || [],
        suggestion: result.suggestion || 'decompose'
      };
    }

    if (score === 3) {
      return {
        severity: 'warning',
        message: `Plan completeness score: ${score}/5 - ${result.reasoning || ''}`,
        missingCriteria: result.missingCriteria || []
      };
    }

    return { severity: 'ok' };
  } catch (err) {
    return {
      severity: 'warning',
      message: `LLM semantic check unavailable: ${err?.message || 'error'}`
    };
  }
}

/**
 * Extract export names from JavaScript source
 */
function extractExports(source) {
  const exports = [];
  // export function name
  const funcMatches = source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
  for (const m of funcMatches) exports.push(m[1]);
  // export const/let/var name
  const varMatches = source.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g);
  for (const m of varMatches) exports.push(m[1]);
  // export { name1, name2 }
  const namedMatches = source.matchAll(/export\s*\{([^}]+)\}/g);
  for (const m of namedMatches) {
    const names = m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    exports.push(...names.filter(Boolean));
  }
  return exports;
}

/**
 * Extract import module names from JavaScript source
 */
function extractImports(source) {
  const imports = [];
  const matches = source.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g);
  for (const m of matches) imports.push(m[1]);
  return imports;
}

/**
 * Given a story's meta + declared targetFiles, return the set of target paths explicitly
 * authorized for a full-file rewrite. Two per-target sources (never plan-wide):
 *  - `storyMeta.destructiveRewriteFiles` — a list set by the `acknowledge_destructive_rewrite`
 *    refinement (story-level field, but scoped to the listed paths).
 *  - a declared targetFile flagged `rewrite: true`.
 */
export function computeAuthorizedRewriteFiles(storyMeta, targetFiles) {
  const authorized = new Set();
  const list = storyMeta?.destructiveRewriteFiles;
  if (Array.isArray(list)) {
    for (const p of list) if (typeof p === 'string') authorized.add(p);
  }
  const tfs = Array.isArray(targetFiles) ? targetFiles : [];
  for (const tf of tfs) {
    if (tf && typeof tf === 'object' && tf.rewrite === true && typeof tf.path === 'string') {
      authorized.add(tf.path);
    }
  }
  return authorized;
}

/**
 * Check for destructive edit_file on large existing files.
 * `authorizedRewriteFiles` (a Set of paths) exempts specific targets that the story has
 * explicitly authorized as full-file rewrites — the exemption is per-target, never plan-wide.
 */
export function checkDestructiveEdit(projectRoot, step, authorizedRewriteFiles = new Set()) {
  if (step.action !== 'edit_file') return [];

  const target = step.path || step.target;
  if (!target) return [];

  const absPath = path.join(projectRoot, target);
  if (!fs.existsSync(absPath)) return []; // New file is fine

  const original = fs.readFileSync(absPath, 'utf8');
  const originalLines = original.split('\n').length;

  // Files >100 lines MUST use search_replace — UNLESS this specific target is a
  // story-authorized full-file rewrite (acknowledge_destructive_rewrite refinement, or a
  // targetFile flagged rewrite:true). Authorization is per-target; an un-authorized large
  // edit_file still ERRORs exactly as before.
  if (originalLines > 100) {
    const authorized = authorizedRewriteFiles instanceof Set
      ? authorizedRewriteFiles.has(target)
      : Array.isArray(authorizedRewriteFiles) && authorizedRewriteFiles.includes(target);
    if (authorized) return []; // authorized rewrite — allow the large edit_file
    return [{
      check: 'destructive_edit',
      severity: 'error',
      file: target,
      message: `edit_file would replace ${originalLines}-line file. Use search_replace instead.`,
      suggestion: 'Break change into targeted search_replace edits, or authorize a full-file rewrite for this target with the acknowledge_destructive_rewrite refinement.'
    }];
  }

  // Files 50-100 lines: warning
  if (originalLines > 50) {
    return [{
      check: 'large_edit',
      severity: 'warning',
      file: target,
      message: `edit_file on ${originalLines}-line file. Consider search_replace for safer edits.`
    }];
  }

  return [];
}

/**
 * Check for missing exports/imports in replacement content
 */
function checkSemanticPreservation(projectRoot, step) {
  if (step.action !== 'edit_file') return [];

  const target = step.path || step.target;
  if (!target) return [];

  const absPath = path.join(projectRoot, target);
  if (!fs.existsSync(absPath)) return [];

  const original = fs.readFileSync(absPath, 'utf8');
  const warnings = [];

  const originalExports = extractExports(original);
  const newExports = extractExports(step.content || '');
  const missingExports = originalExports.filter(e => !newExports.includes(e));

  if (missingExports.length > 0) {
    warnings.push({
      check: 'missing_exports',
      severity: 'warning',
      file: target,
      message: `Would remove exports: ${missingExports.join(', ')}`
    });
  }

  const originalImports = extractImports(original);
  const newImports = extractImports(step.content || '');
  const missingImports = originalImports.filter(i => !newImports.includes(i));

  if (missingImports.length > 0) {
    warnings.push({
      check: 'missing_imports',
      severity: 'warning',
      file: target,
      message: `Would remove imports: ${missingImports.join(', ')}`
    });
  }

  return warnings;
}

/**
 * Check if plan modifying code lacks test coverage (Layer 2)
 * Skips check when story has a linked testStory (paired story pattern).
 */
function checkTestCoverage(plan, { testStory } = {}) {
  if (testStory) return []; // Paired story — tests come in the linked test story
  const codeSteps = (plan.steps || []).filter(s => {
    const target = s.path || s.target;
    return target && !target.includes('.test.') && !target.includes('/tests/') &&
           (target.endsWith('.js') || target.endsWith('.mjs') || target.endsWith('.ts'));
  });

  const testSteps = (plan.steps || []).filter(s => {
    const target = s.path || s.target;
    return target && (target.includes('.test.') || target.includes('/tests/'));
  });

  if (codeSteps.length > 0 && testSteps.length === 0) {
    return [{
      check: 'no_test_coverage',
      severity: 'warning',
      message: `Plan modifies ${codeSteps.length} code file(s) but includes no test files`,
      suggestion: 'Consider adding test files to verify new functionality'
    }];
  }

  return [];
}

/**
 * Check that search_replace patterns exist in target files
 */
function checkSearchReplacePatterns(projectRoot, step, createdPaths) {
  if (step.action !== 'search_replace') return [];

  const target = step.path;
  if (!target) return [];

  // Same-plan-created-path exemption (N2 Option 1): a search_replace on a path a
  // create_file step in this plan will produce won't exist on disk until apply.
  if (createdPaths && createdPaths.has(target)) return [];

  const absPath = path.join(projectRoot, target);
  if (!fs.existsSync(absPath)) {
    return [{
      check: 'target_file_not_found',
      severity: 'error',
      file: target,
      message: `Target file not found: ${target}`,
      suggestion: 'Verify file path in backlog story ## Target Files section'
    }];
  }

  const content = fs.readFileSync(absPath, 'utf8');
  const errors = [];

  // Attempt exact match first to preserve sensitivity to whitespace/newlines.
  // If the exact pattern is not found, fall back to the existing normalized-whitespace check.
  for (const editItem of step.edits || []) {
    const search = editItem?.search || "";
    if (!search) continue;

    // First try an exact (verbatim) match in the file content
    if (countOccurrences(content, search) === 0) {
      // Fallback: try normalized whitespace match
      const normContent = normalizeWhitespace(content);
      const normSearch = normalizeWhitespace(search);
      if (countOccurrences(normContent, normSearch) === 0) {
        // Final fallback: collapse all whitespace (handles LLM reformatting
        // single-line code as multi-line in search_replace patterns)
        const flatContent = flattenWhitespace(content);
        const flatSearch = flattenWhitespace(search);
        if (countOccurrences(flatContent, flatSearch) === 0) {
          // Find closest matching region to help planner self-correct on retry
          const closest = findClosestMatch(content, search);
          errors.push({
            check: 'search_pattern_not_found',
            severity: 'error',
            file: target,
            message: `Search pattern not found (exact or normalized): ${search.slice(0, 200)}`,
            closest_match: closest || '',
          });
        }
      }
    }
  }

  for (const edit of step.edits || []) {
    if (!edit.search) continue;

    if (edit.search && !content.includes(edit.search)) {
      // try normalized whitespace match
      const normalizedContent = normalizeWhitespace(content);
      const normalizedSearch = normalizeWhitespace(edit.search);
      if (normalizedSearch && normalizedContent.includes(normalizedSearch)) {
        errors.push({
          check: 'search_pattern_whitespace_mismatch',
          severity: 'error',
          file: target,
          message: `Search pattern not found due to whitespace mismatch in ${target}`,
          patternPreview: edit.search.slice(0, 80) + (edit.search.length > 80 ? '...' : ''),
          suggestion: 'Adjust search pattern whitespace to match file; planner may have hallucinated indentation'
        });
        continue;
      }

      // Final fallback: collapse all whitespace (handles multi-line vs single-line)
      const flatContent = flattenWhitespace(content);
      const flatSearch = flattenWhitespace(edit.search);
      if (flatSearch && flatContent.includes(flatSearch)) {
        // Flattened match found — this is a formatting difference, not a missing pattern.
        // Downgrade to warning instead of blocking error.
        continue;
      }

      errors.push({
        check: 'search_pattern_not_found',
        severity: 'error',
        file: target,
        message: `Search pattern not found in ${target}`,
        patternPreview: edit.search.slice(0, 80) + (edit.search.length > 80 ? '...' : ''),
        suggestion: 'Update backlog story with correct search pattern from actual file content'
      });
      continue;
    }

    // exact match found - check for ambiguity (multiple matches)
    const occurrences = countOccurrences(content, edit.search);
    if (occurrences > 1) {
      errors.push({
        check: 'search_pattern_ambiguous',
        severity: 'error',
        file: target,
        message: `Search pattern matches ${occurrences} times in ${target} - ambiguous`,
        patternPreview: edit.search.slice(0, 80) + (edit.search.length > 80 ? '...' : ''),
        suggestion: 'Make search pattern more specific to target only one location'
      });
    }
  }

  return errors;
}

/**
 * Validate a create_file step: non-empty content, path set, warn if file already exists.
 */
function checkCreateFileStep(projectRoot, step) {
  const issues = [];
  const target = step.path || step.target;

  if (!target) {
    issues.push({
      check: 'create_file_missing_path',
      severity: 'error',
      message: 'create_file step is missing path/target',
    });
  }

  if (!step.content || !String(step.content).trim()) {
    issues.push({
      check: 'create_file_empty_content',
      severity: 'error',
      message: `create_file step for "${target}" has empty or missing content`,
      target,
    });
  }

  if (target && projectRoot && fs.existsSync(path.join(projectRoot, target))) {
    issues.push({
      check: 'create_file_already_exists',
      severity: 'error',
      message: `create_file target "${target}" already exists on disk — use search_replace instead`,
      target,
    });
  }

  return issues;
}

/**
 * Detect RAG truncation markers in plan step content.
 * When the planner reads large files via RAG, truncated content arrives as
 * "// ... (N lines omitted) ..." markers. If these get copied verbatim into
 * create_file or search_replace steps, exec writes syntactically broken files.
 */
function checkTruncatedContent(step) {
  const TRUNCATION_RE = /\/\/ \.\.\. \(\d+ lines omitted\) \.\.\./;
  const issues = [];
  const target = step.path || step.target;

  if (step.action === 'create_file') {
    const content = step.content ? String(step.content) : '';
    if (TRUNCATION_RE.test(content)) {
      issues.push({
        check: 'truncated_content',
        type: 'truncated_content',
        severity: 'error',
        step: step.action,
        file: target,
        message: `create_file step for "${target}" contains a RAG truncation marker — file content was incomplete at plan time. Re-plan after RAG re-embed or use a smaller target.`,
      });
    }
  }

  if (step.action === 'search_replace') {
    for (const editItem of step.edits || []) {
      const replace = editItem.replace ? String(editItem.replace) : '';
      if (TRUNCATION_RE.test(replace)) {
        issues.push({
          check: 'truncated_content',
          type: 'truncated_content',
          severity: 'error',
          step: step.action,
          file: target,
          message: `search_replace step for "${target}" contains a RAG truncation marker in replace content — content was incomplete at plan time. Re-plan after RAG re-embed.`,
        });
        break; // one error per step is sufficient
      }
    }
  }

  return issues;
}

/**
 * Assert that no create_file step targets a file whose targetFile entry has op:edit.
 * When RAG context is missing or truncated, the planner may default to create_file
 * for an existing file — which would destructively overwrite it.
 *
 * Returns ALL violations so the caller can filter them all out in one pass.
 *
 * @param {Array} steps - Plan steps (each with action and path/target)
 * @param {Array} targetFiles - Story targetFiles from frontmatter (objects with path + op)
 * @returns {Array<{ type: 'op_mismatch', step, targetFile, message }>} Array of violations (empty if none)
 */
export function checkOpMatch(steps, targetFiles) {
  if (!Array.isArray(steps) || !Array.isArray(targetFiles)) return [];
  const violations = [];
  for (const step of steps) {
    if (step.action !== 'create_file') continue;
    const stepPath = step.path || step.target;
    if (!stepPath) continue;
    const targetFile = targetFiles.find(tf => {
      const tfPath = typeof tf === 'string' ? tf : tf?.path;
      return tfPath === stepPath;
    });
    if (targetFile && typeof targetFile === 'object' && targetFile.op === 'edit') {
      violations.push({
        type: 'op_mismatch',
        step,
        targetFile,
        message: `create_file generated for op:edit target "${stepPath}" — use search_replace instead`,
      });
    }
  }
  return violations;
}

/**
 * Detect overlapping or dependent search_replace edit regions on the same file.
 *
 * Two failure modes are checked for each pair of search_replace edits from
 * different steps that target the same file:
 *
 * (a) Dependent-output overlap: the REPLACE of edit A (normalized) contains a
 *     30+ char substring that appears in the SEARCH of edit B — meaning edit B
 *     searches for code that edit A would create, violating the DEPENDENT CHAINS rule.
 *
 * (b) Adjacent/overlapping line ranges: the two edits' SEARCH regions are within
 *     3 lines of each other (or overlap) on the current file — sequential edits to
 *     the same structural region risk producing invalid intermediate state.
 *
 * @param {object} plan - Plan object with steps array
 * @param {string} [projectRoot] - Project root for reading files (needed for check b)
 * @returns {Array<{check, severity, file, message, suggestion}>}
 */
export function checkOverlappingEditRegions(plan, projectRoot) {
  const issues = [];
  const steps = plan.steps || [];

  // Collect all search_replace edits in order, grouped by file path
  const editsByFile = {};
  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    if (step.action !== 'search_replace') continue;
    const filePath = step.path;
    if (!filePath) continue;
    if (!editsByFile[filePath]) editsByFile[filePath] = [];
    for (const edit of step.edits || []) {
      if (!edit.search || !edit.replace) continue;
      editsByFile[filePath].push({
        stepIdx: si,
        stepOrder: step.order || si + 1,
        stepTitle: step.title || `Step ${si + 1}`,
        search: edit.search,
        replace: edit.replace,
      });
    }
  }

  for (const [filePath, edits] of Object.entries(editsByFile)) {
    if (edits.length < 2) continue;

    // Read file content for line-range estimation (check b)
    let fileContent = null;
    if (projectRoot) {
      const absPath = path.join(projectRoot, filePath);
      if (fs.existsSync(absPath)) {
        try { fileContent = fs.readFileSync(absPath, 'utf8'); } catch { /* skip line-range check */ }
      }
    }

    for (let i = 0; i < edits.length; i++) {
      for (let j = i + 1; j < edits.length; j++) {
        const a = edits[i];
        const b = edits[j];
        if (a.stepIdx === b.stepIdx) continue; // same-step edits are applied atomically

        // (a) Dependent-output overlap: does normalized REPLACE(a) contain a
        //     30+ char substring that appears in normalized SEARCH(b)?
        //     Guard: only flag when SEARCH(b) is NOT found in the current file —
        //     if SEARCH(b) already exists on disk, edit B is independent of A
        //     regardless of shared patterns (common Tailwind/JSX snippets etc.).
        const normReplace = normalizeWhitespace(a.replace);
        const normSearch = normalizeWhitespace(b.search);
        const MIN_OVERLAP = 30;
        let dependentMatch = false;
        for (let k = 0; k <= normReplace.length - MIN_OVERLAP; k++) {
          const sub = normReplace.slice(k, k + MIN_OVERLAP);
          if (sub.trim().length >= MIN_OVERLAP - 5 && normSearch.includes(sub)) {
            dependentMatch = true;
            break;
          }
        }
        if (dependentMatch) {
          // If the file is readable and SEARCH(b) is found in it, B is independent — skip.
          if (fileContent) {
            const searchFoundInFile =
              countOccurrences(fileContent, b.search) > 0 ||
              countOccurrences(normalizeWhitespace(fileContent), normSearch) > 0;
            if (searchFoundInFile) {
              dependentMatch = false;
            }
          }
        }
        if (dependentMatch) {
          issues.push({
            check: 'overlapping_edit_regions',
            severity: 'error',
            file: filePath,
            message: `Steps "${a.stepTitle}" (step ${a.stepOrder}) and "${b.stepTitle}" (step ${b.stepOrder}) have dependent edit regions on "${filePath}": the REPLACE of step ${a.stepOrder} contains text that appears in the SEARCH of step ${b.stepOrder}. Step ${b.stepOrder} is searching for code that step ${a.stepOrder} would create — violating the DEPENDENT CHAINS rule.`,
            suggestion: `Merge the overlapping edits from steps ${a.stepOrder} and ${b.stepOrder} into a single search_replace covering the full affected region on "${filePath}".`,
          });
          continue; // report once per pair
        }

        // (b) Overlapping line ranges only (gap < 0).
        // Adjacent sections (gap >= 0) are legitimate independent replacements —
        // only actual overlap (two edits targeting the same lines) is flagged.
        if (!fileContent) continue;
        const aLine = findLineIndex(fileContent, a.search);
        const bLine = findLineIndex(fileContent, b.search);
        if (aLine === -1 || bLine === -1) continue;

        const aLen = a.search.split('\n').length;
        const bLen = b.search.split('\n').length;
        // Determine which edit region comes first in the file
        const [firstLine, firstLen, secondLine] = aLine <= bLine
          ? [aLine, aLen, bLine]
          : [bLine, bLen, aLine];
        const gap = secondLine - (firstLine + firstLen); // negative = overlap

        if (gap < 0) {
          issues.push({
            check: 'overlapping_edit_regions',
            severity: 'error',
            file: filePath,
            message: `Steps "${a.stepTitle}" (step ${a.stepOrder}) and "${b.stepTitle}" (step ${b.stepOrder}) have overlapping edit regions on "${filePath}" (overlap: ${Math.abs(gap)} line(s)). Sequential edits to the same structural region will produce invalid intermediate file state.`,
            suggestion: `Merge the overlapping edits from steps ${a.stepOrder} and ${b.stepOrder} into a single search_replace covering the full affected region on "${filePath}".`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Review a plan for quality issues
 */
// ── Import grounding (backlog.fix.planner-ground-imports-in-package-json) ──────────
// The planner sometimes generates imports from ecosystem CONVENTION (what a stack "usually"
// has) rather than the project's ACTUAL declared dependencies — e.g. emitting
// `import userEvent from '@testing-library/user-event'` when only @testing-library/react is
// declared. That import fails module resolution at exec (0 tests run). This check flags any
// generated import whose base package is neither declared in package.json (deps + devDeps),
// a Node built-in, a relative/local path, nor covered by an explicit dependency-add step in
// the same plan.

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve an import specifier to its base package name.
 *  '@scope/name/sub' -> '@scope/name'; 'lodash/merge' -> 'lodash'. */
function basePackageName(spec) {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0];
}

/** True for Node core modules ('fs', 'path', 'node:fs', 'stream/promises', ...). */
function isBuiltinModule(spec) {
  if (spec.startsWith('node:')) return true;
  return builtinModules.includes(spec.split('/')[0]);
}

/** Strip a version suffix from an install token: 'pkg@1.2.3' -> 'pkg', '@scope/pkg@1' -> '@scope/pkg'. */
function stripVersionSpec(tok) {
  if (tok.startsWith('@')) {
    const at = tok.indexOf('@', 1);
    return at === -1 ? tok : tok.slice(0, at);
  }
  const at = tok.indexOf('@');
  return at === -1 ? tok : tok.slice(0, at);
}

/** Extract all imported module specifiers from a source string (ESM import, dynamic import, require). */
function extractImportedSpecifiers(content) {
  const specs = new Set();
  const text = String(content || '');
  const patterns = [
    /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g, // import x from 'p' | import {a} from 'p' | import 'p'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                 // dynamic import('p')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                // require('p')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * Collect packages the plan explicitly adds — via an install run_command or a package.json edit.
 *
 * backlog.fix.dependency-add-contract-executable: EXPORTED, because exec's scope guards need it too.
 * The exemption that lets an `npm install` step's manifest writes through the scope guard must key on
 * THE PLAN STEP — "does this plan genuinely add a dependency?" — and never on the filename. Keying on
 * the filename would let any plan silently rewrite package.json and be waved through, which is a hole
 * in a guard whose whole job is to catch exactly that.
 *
 * One rule, one implementation, used by the quality gate AND by both exec guards. There were already
 * three copies of the scope set-difference in this codebase and two of them disagreed; a fourth was
 * not the answer.
 */
export function collectDependencyAdditions(plan) {
  const added = new Set();
  let pkgJsonContent = '';
  for (const step of plan.steps || []) {
    if (step.action === 'run_command') {
      const cmd = String(step.command || step.cmd || '');
      const m = cmd.match(/\b(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+(?:install|add)|bun\s+add)\b(.*)/);
      if (m) {
        for (const tok of m[1].split(/\s+/)) {
          const t = tok.trim();
          if (!t || t.startsWith('-')) continue;
          added.add(stripVersionSpec(t));
        }
      }
    }
    const target = step.path || step.target;
    if (target && /(^|\/)package\.json$/.test(target)) {
      if (step.action === 'create_file') pkgJsonContent += '\n' + String(step.content || '');
      if (step.action === 'search_replace') {
        for (const e of step.edits || []) pkgJsonContent += '\n' + String(e.replace || '');
      }
    }
  }
  return { added, pkgJsonContent };
}

/**
 * backlog.fix.dependency-add-contract-executable: does this plan add a dependency, and which ones?
 *
 * `collectDependencyAdditions` returns `{ added, pkgJsonContent }` and parses package.json edits into
 * a separate blob — awkward for callers that just want "the set of packages this plan declares it is
 * adding". This is that set: install-command packages, PLUS any dependency key introduced by a
 * package.json create/edit step. It is the ONE predicate both exec scope guards and the
 * redundant-add check key on, so a plan step — never a filename — decides the exemption.
 */
export function planDependencyAdditions(plan) {
  const { added, pkgJsonContent } = collectDependencyAdditions(plan);
  const names = new Set(added);
  if (pkgJsonContent) {
    // Any bareword `"pkg": "range"` line an edited/created package.json introduces.
    const re = /["']([^"'\s]+)["']\s*:\s*["'][^"']+["']/g;
    let m;
    while ((m = re.exec(pkgJsonContent)) !== null) {
      const key = m[1];
      // Skip the manifest's own non-dependency keys.
      if (["name", "version", "description", "main", "type", "license", "author"].includes(key)) continue;
      if (key.includes("/") || /^[@a-z0-9._-]+$/i.test(key)) names.add(key);
    }
  }
  return names;
}

/** Flag generated imports of packages that are not declared in package.json and not add-covered. */
/**
 * backlog.fix.dependency-add-contract-executable: the OTHER direction — installing what is already
 * there.
 *
 * `checkImportGrounding` catches a plan that imports a package it never declared. This catches the
 * mirror image: a plan that "installs" a package package.json ALREADY declares. It happened — the
 * planner emitted package.json + package-lock.json edits to add a test dependency that was already
 * present, and exec's scope guard rolled the whole plan back.
 *
 * Both are the same illness: the plan is not reasoning about what is actually declared. The gate only
 * ever looked one way.
 */
function checkRedundantDependencyAdds(projectRoot, plan) {
  const issues = [];
  const added = planDependencyAdditions(plan);
  if (!added.size) return issues;

  const declared = readPackageDependencies(projectRoot);
  if (!declared || !Object.keys(declared).length) return issues;

  for (const pkg of added) {
    if (!Object.prototype.hasOwnProperty.call(declared, pkg)) continue;
    issues.push({
      check: 'redundant_dependency_add',
      type: 'redundant_dependency_add',
      severity: 'error',
      package: pkg,
      message:
        `The plan adds "${pkg}" as a dependency, but package.json already declares it ` +
        `(${declared[pkg]}). Installing an already-declared package rewrites package.json and the ` +
        `lockfile for no reason — and those rewrites will trip exec's scope guard and roll the whole ` +
        `plan back. Drop the dependency-add step; the package is already available to import.`,
      suggestion: 'remove_redundant_dependency_add',
    });
  }
  return issues;
}

function checkImportGrounding(projectRoot, plan) {
  const issues = [];
  if (!projectRoot) return issues;
  const deps = readPackageDependencies(projectRoot);
  if (!deps) return issues; // no package.json / no declared deps → safe no-op
  const declared = new Set(Object.keys(deps));
  const additions = collectDependencyAdditions(plan);
  const seen = new Set(); // dedupe by target::base

  for (const step of plan.steps || []) {
    const target = step.path || step.target;
    const contents = [];
    if (step.action === 'create_file') contents.push(String(step.content || ''));
    if (step.action === 'search_replace') {
      for (const e of step.edits || []) contents.push(String(e.replace || ''));
    }
    for (const content of contents) {
      for (const spec of extractImportedSpecifiers(content)) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue; // relative / absolute-local
        if (isBuiltinModule(spec)) continue;
        const base = basePackageName(spec);
        if (declared.has(base)) continue;
        if (additions.added.has(base)) continue;
        if (additions.pkgJsonContent &&
            new RegExp(`["']${escapeRegExp(base)}["']`).test(additions.pkgJsonContent)) continue;
        const key = `${target}::${base}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          check: 'import_not_declared',
          type: 'import_not_declared',
          severity: 'error',
          file: target,
          package: base,
          specifier: spec,
          message: `Generated import of "${base}" (from \`${spec}\`) in "${target}" is not declared in package.json (dependencies or devDependencies), and the plan has no dependency-add step for it — this will fail module resolution at exec. Import only declared packages, or emit an explicit dependency-add step (npm install / package.json edit) in the same plan.`,
          suggestion: 'ground_imports',
        });
      }
    }
  }
  return issues;
}

export async function reviewPlan({ projectRoot, plan, problemContent, llmCall, storyMeta, targetFiles, checkExecutableSteps = false }) {
  const issues = [];
  const warnings = [];

  // Layer 0 (backlog.fix.plan-review-validates-target-coverage): every declared targetFile must
  // have a covering step — op:create by a create_file step, op:edit by search_replace/edit_file.
  // This catches the planner silently dropping create_file steps (which otherwise passes review,
  // since every other check only inspects steps that ARE present). No-op when no targetFiles are
  // declared, so existing callers that don't pass targetFiles are unaffected.
  const declaredTargets = Array.isArray(targetFiles) ? targetFiles : [];
  if (declaredTargets.length > 0) {
    const steps = plan.steps || [];
    const createPaths = new Set(steps.filter(s => s.action === 'create_file').map(s => s.path || s.target).filter(Boolean));
    const editPaths = new Set(steps.filter(s => s.action === 'search_replace' || s.action === 'edit_file').map(s => s.path || s.target).filter(Boolean));
    const anyExecPaths = new Set(steps.filter(s => s.action && s.action !== 'note').map(s => s.path || s.target).filter(Boolean));
    const uncovered = [];
    for (const tf of declaredTargets) {
      const tfPath = typeof tf === 'string' ? tf : tf?.path;
      if (!tfPath) continue;
      const isCreate = typeof tf === 'object' && tf !== null && (tf.op === 'create' || tf.action === 'CREATE' || tf.create === true);
      const isEdit = typeof tf === 'object' && tf !== null && (tf.op === 'edit' || tf.action === 'EDIT');
      const covered = isCreate ? createPaths.has(tfPath)
        : isEdit ? editPaths.has(tfPath)
        : anyExecPaths.has(tfPath);
      if (!covered) uncovered.push({ path: tfPath, op: isCreate ? 'create' : 'edit' });
    }
    if (uncovered.length > 0) {
      issues.push({
        check: 'incomplete_target_coverage',
        severity: 'error',
        type: 'incomplete_target_coverage',
        message: `Plan is missing a covering step for ${uncovered.length} declared targetFile(s): ${uncovered.map(u => `${u.path} (op:${u.op})`).join(', ')}. The planner dropped these targets — re-plan.`,
        uncovered,
        suggestion: 'replan',
      });
    }
  }

  // Layer 1 (optional): Reject plans with no executable steps (note-only or empty).
  // Only applied when checkExecutableSteps=true (i.e. from rks_plan_review MCP handler).
  // NOT applied for the planner's internal quality check — the planner already handles
  // note-only plans via its retry loop and returns them as-is after exhausting retries.
  if (checkExecutableSteps) {
    const hasExecutable = (plan.steps || []).some(s => s?.action !== 'note');
    if (!hasExecutable) {
      issues.push({
        check: 'no_executable_steps',
        severity: 'error',
        type: 'no_executable_steps',
        message: 'Plan contains only note step(s) and no executable actions. Run rks_refine to resolve the outstanding notes, then retry rks_plan.',
        suggestion: 'refine',
      });
    }
  }

  // Layer 2: Check test coverage (skip when paired story has a linked testStory)
  const testCoverageIssues = checkTestCoverage(plan, { testStory: storyMeta?.testStory });
  warnings.push(...testCoverageIssues);

  // Paths this plan's create_file steps will produce — exempt from the on-disk
  // SEARCH-anchor check below (the file is created at apply time). (N2 Option 1)
  const createdPaths = new Set(
    (plan.steps || [])
      .filter((s) => s && s.action === 'create_file')
      .map((s) => s.path || s.target)
      .filter(Boolean),
  );

  // Per-target rewrite authorizations for this story (empty set → gate behaves as before).
  const authorizedRewriteFiles = computeAuthorizedRewriteFiles(storyMeta, targetFiles);

  for (const step of plan.steps || []) {
    issues.push(...checkDestructiveEdit(projectRoot, step, authorizedRewriteFiles));
    issues.push(...checkTruncatedContent(step));
    if (step.action === 'create_file') {
      issues.push(...checkCreateFileStep(projectRoot, step));
    }
    issues.push(...checkSearchReplacePatterns(projectRoot, step, createdPaths));
    warnings.push(...checkSemanticPreservation(projectRoot, step));
  }

  // Cross-step: detect overlapping/dependent edit regions on the same file
  issues.push(...checkOverlappingEditRegions(plan, projectRoot));

  // Cross-step: flag generated imports of packages not declared in package.json (and not
  // covered by a dependency-add step) — they fail module resolution at exec.
  issues.push(...checkImportGrounding(projectRoot, plan));
  issues.push(...checkRedundantDependencyAdds(projectRoot, plan));

  // Phase 1: Completeness heuristics
  if (problemContent) {
    const heuristic = checkPlanCompleteness(problemContent, plan);

    if (heuristic.triggerSemanticCheck && llmCall) {
      try {
        // Phase 2: LLM semantic check
        const semantic = await semanticCoverageCheck(problemContent, plan, llmCall);

        if (semantic.severity === 'error') {
          issues.push({
            check: 'incomplete_plan',
            severity: 'error',
            message: semantic.message,
            missingCriteria: semantic.missingCriteria,
            suggestion: semantic.suggestion
          });
        } else if (semantic.severity === 'warning') {
          warnings.push({
            check: 'sparse_plan',
            severity: 'warning',
            message: semantic.message
          });
        }
        // severity 'ok' -> heuristic was false positive, skip
      } catch (e) {
        // LLM failed - fall back to heuristic warning only
        if (heuristic.severity === 'warning') {
          warnings.push({
            check: 'incomplete_plan_heuristic',
            severity: 'warning',
            message: heuristic.message
          });
        }
      }
    } else if (heuristic.severity === 'warning') {
      // No LLM available, use heuristic warning only
      warnings.push({
        check: 'incomplete_plan_heuristic',
        severity: 'warning',
        message: heuristic.message
      });
    }
  }

  // Separate errors from warnings
  const errors = issues.filter(i => i.severity === 'error');
  const allWarnings = [...issues.filter(i => i.severity === 'warning'), ...warnings];

  return {
    ok: errors.length === 0,
    errors,
    warnings: allWarnings,
    // backlog.fix.dependency-add-contract-executable: DERIVE the advice from what actually went wrong.
    //
    // This used to return a hardcoded [decompose, use_search_replace] for ANY error — and the checks
    // had already computed the right answer. `checkImportGrounding` attaches `suggestion:
    // 'ground_imports'` to each issue it raises, and this line threw it away.
    //
    // The advice is not decoration. It travels: planner-persistence copies these into the plan-failure
    // marker, and server.mjs splices them into the response the Build Governor reads. So a plan
    // rejected for importing an undeclared package told the Governor to "decompose" and "use
    // search_replace" — neither of which can possibly declare a dependency. The Governor followed
    // advice that could not work, and a greenfield build burned two identical retries on it.
    suggestions: deriveSuggestions(errors),
    hash: computePlanHash(plan)
  };
}

/** The remedies the failing checks themselves named, de-duplicated. Never a hardcoded guess. */
const SUGGESTION_DETAIL = {
  ground_imports:
    'Import only packages declared in package.json, or emit an explicit dependency-add step ' +
    '(an `npm install <pkg>` run_command, or a package.json edit) in the SAME plan.',
  remove_redundant_dependency_add:
    'The package is already declared in package.json — drop the dependency-add step. Installing an ' +
    'already-declared package rewrites the manifest for no reason and trips the scope guard.',
  decompose: 'Break into smaller stories with single-file scope',
  use_search_replace: 'Specify search_replace patterns in requirements',
};

export function deriveSuggestions(errors) {
  if (!errors?.length) return [];
  const types = [];
  for (const e of errors) {
    if (e?.suggestion && !types.includes(e.suggestion)) types.push(e.suggestion);
  }
  // Only when no check named a remedy do we fall back to the generic pair — and even then it is a
  // guess, so it is the LAST resort rather than the only answer.
  if (types.length === 0) types.push('decompose', 'use_search_replace');
  return types.map((type) => ({ type, detail: SUGGESTION_DETAIL[type] || type }));
}

export default { reviewPlan, computePlanHash };
