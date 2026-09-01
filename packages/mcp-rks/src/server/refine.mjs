import fs from "fs/promises";
import fsSync from "node:fs";
import path from "path";
import { glob } from "glob";
import yaml from "js-yaml";
import { parseFrontmatter, updateField, resolveNotesDir, editNote, formatWithFrontmatter, writeNoteRaw } from "../dendron.mjs";
import { normalizeTargetFiles, resolveTargets } from "../shared/normalize-target-files.mjs";
import { loadStory } from "../shared/story-loader.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";
import { commitFiles } from "../utils/git.mjs";
import { getSliceWithContext } from "../llm/slices.mjs";
import { pruneRefineBlocks } from "./planner-context.mjs";

/**
 * Canonical refinement-type vocabulary — the single source of truth for every schema
 * that has to agree about what `rks_refine_apply` accepts.
 *
 * backlog.fix.refine-noop-escalation-false-positive: `server.mjs` previously hand-wrote
 * this list TWICE (the zod `z.enum` and the advertised `inputSchema` literal), and both
 * copies drifted behind the emitters. `z.enum` REJECTS rather than strips, so every
 * emitted-but-unlisted type made the refine engine capable of suggesting a refinement
 * its own tool's parser threw on — the exact class already fixed once, by hand, for
 * `fix_duplicate_frontmatter`. Deriving both from this constant is what stops it
 * happening a third time.
 *
 * SUGGESTED: emitted by `runRefineTool` via `suggestions.push`. Keep in sync by
 * construction — a new emit site must add its type name to this list.
 * CALLER_INITIATED: never suggested, only passed in by a Governor or the Dispatcher.
 * They are NOT emitters, but they must stay accepted.
 */
export const SUGGESTED_REFINEMENT_TYPES = Object.freeze([
  "fix_duplicate_frontmatter",
  "add_test_requirements",
  "fix_vague_tests",
  "add_target_files",
  "upgrade_target_files_format",
  "fix_target_files",
  "fix_search_pattern",
  "disk_fetch_context",
  "add_code_snippet",
  "create_file_directive",
  "add_test_exemplar",
  "plan_staging",
  "review_plan_output",
  "add_search_pattern",
  "verify_search_patterns",
  "fix_numeric_assertion",
  "fix_test_assertion",
]);

export const CALLER_INITIATED_REFINEMENT_TYPES = Object.freeze([
  "clarify_ac",
  "decompose",
  "acknowledge_multi_file",
  "acknowledge_destructive_rewrite",
]);

export const REFINEMENT_TYPES = Object.freeze([
  ...SUGGESTED_REFINEMENT_TYPES,
  ...CALLER_INITIATED_REFINEMENT_TYPES,
]);

/**
 * Extract every PAIRED, YAML-parseable frontmatter block from a raw story file.
 *
 * backlog.fix.refine-noop-escalation-false-positive: the detector and the applier used to
 * disagree. The detector counted bare `---` lines (`match(/^---\s*$/gm).length > 2`), so a
 * markdown horizontal rule in the body — or a `---` inside a fenced code block, routine in
 * notes that embed YAML examples — was a third delimiter and raised a `critical`. The applier
 * required paired, parseable blocks and answered "no duplicate blocks found". Critical in,
 * nothing to do out: `applied` stayed empty, which mapped to `refine_apply.noop` and killed
 * the run.
 *
 * Both sides now call this, so they cannot drift apart: two literals that merely happened to
 * agree is what produced the divergence in the first place.
 *
 * @returns {{ blocks: object[], remaining: string }} parsed frontmatter objects in document
 *   order (`length > 1` means genuinely duplicated frontmatter), plus the unconsumed tail.
 */
export function extractFrontmatterBlocks(storyContent) {
  const original = String(storyContent ?? "");
  // Mask `---` lines that sit INSIDE fenced code blocks before scanning. Story notes in this
  // repo routinely document frontmatter shapes by embedding a fenced YAML example, and those
  // delimiters are documentation, not structure. The mask is length-preserving (`-` -> `#`,
  // same width) so every offset below indexes the ORIGINAL string unchanged — `remaining` must
  // stay verbatim, because the applier uses it as the story body.
  const masked = maskFencedDelimiters(original);

  const fmPattern = /^---\s*\n([\s\S]*?)\n---\s*$/m;
  const blocks = [];
  let scan = masked;
  let rest = original;
  let match;
  while ((match = fmPattern.exec(scan)) !== null) {
    try {
      const parsed = yaml.load(match[1]);
      if (parsed && typeof parsed === "object") blocks.push(parsed);
    } catch { /* skip unparseable blocks */ }
    const consumed = match.index + match[0].length;
    scan = scan.slice(consumed);
    rest = rest.slice(consumed);
  }
  return { blocks, remaining: rest };
}

/**
 * Length-preserving mask of `---` delimiter lines inside ``` fenced regions.
 * Only the dashes on an otherwise-bare delimiter line are rewritten, so offsets and every
 * other character are byte-identical to the input.
 */
function maskFencedDelimiters(text) {
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence && /^---\s*$/.test(lines[i])) {
      lines[i] = lines[i].replace(/-/g, "#");
    }
  }
  return lines.join("\n");
}

/**
 * Coerce a `testRequirements` value to an array, tolerating the corrupted case where
 * it was persisted as a JSON-array STRING (root cause: `testRequirements` was missing
 * from dendron `ARRAY_FIELDS`, so a stringified array could be written to a note).
 *
 * Contract: an array passes through unchanged; a JSON-array string is parsed back to an
 * array; anything else (null / undefined / number / object / non-array-JSON string)
 * degrades to `[]`. The result is ALWAYS an array, so downstream `.filter` / `.map` /
 * `.some` can never throw "testRequirements.filter is not a function". This is the
 * shared robustness helper applied at both refine read sites (the analyze-path vague
 * check and the decompose-path orphaned-test scan).
 */
export function coerceTestRequirements(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not valid JSON — fall through to [] */
      }
    }
    return [];
  }
  return [];
}

/**
 * Frontmatter op is authoritative: true when `filePath` is an explicit op:edit target in the
 * story frontmatter. Stops refine from injecting CREATE FILE directives for edit targets, which
 * would re-stamp op:edit→op:create downstream and trigger a false incomplete_target_coverage
 * rejection (see uat-calc-0629-2).
 */
export function isFrontmatterEditTarget(frontmatterStr, filePath) {
  try {
    const tfs = (yaml.load(frontmatterStr) || {}).targetFiles;
    if (!Array.isArray(tfs)) return false;
    return tfs.some((t) => {
      if (!t || typeof t !== "object") return false;
      const p = t.path || t.file || t.name || t.target;
      if (p !== filePath) return false;
      const isCreate = t.op === "create" || t.action === "CREATE" || t.create === true;
      const isEdit = t.op === "edit" || t.action === "EDIT" || t.edit === true;
      return isEdit && !isCreate;
    });
  } catch {
    return false;
  }
}

/**
 * Commit newly-created child story notes to git in a single commit.
 * @param {string} projectRoot - Project root directory
 * @param {string} notesDir - Notes directory path
 * @param {string[]} childIds - Array of child story IDs to commit
 * @param {string} parentId - Parent story ID for commit message
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export async function autoCommitChildNotes(projectRoot, notesDir, childIds, parentId) {
  if (!childIds || childIds.length === 0) {
    return { success: true, message: "No child notes to commit" };
  }

  try {
    // Build file paths for all child notes
    const childNotePaths = childIds.map(id => path.join(notesDir, `${id}.md`));
    const commitMessage = `Auto-commit child stories from decompose: ${parentId}`;
    
    // Commit all child notes in one go
    await commitFiles(projectRoot, childNotePaths, commitMessage);
    
    return { success: true, message: `Committed ${childIds.length} child notes` };
  } catch (e) {
    // Non-fatal: log but don't throw
    console.warn(`autoCommitChildNotes warning: ${e.message}`);
    return { success: false, message: e.message };
  }
}

/**
 * Maximum delta for numeric assertion mismatch detection.
 * Widened from 5 to 20: real assertion mismatches (e.g. adding 8 optional fields to a
 * component) routinely produce deltas of 6–15. Delta > 20 suggests a logic error or
 * major structural change rather than a simple count-update, so we stop patching there.
 */
const MAX_NUMERIC_ASSERTION_DELTA = 20;
const MAX_NOTE_BODY_BYTES = 8192;

// backlog.fix.refine-apply-no-growth-fixed-point (direction C + the AC-7 reconciliation).
//
// On a near-cap note, add_code_snippet cannot deliver a `### Target:` section durably: the
// cap prune in the apply path strips the whole section before the write,
// and the suggester's ONLY convergence signal was the presence of that same section — so it
// re-fired forever against a byte-flat note while `applied[]` claimed an injection each time.
//
// Direction C routes those snippets OUT OF BAND instead, leaving the body alone. That removes
// the durability violation but would also remove the only durable signal that context was ever
// supplied — which `plan-ready.mjs` (no_search_pattern_for_modify suppression) and the
// add_search_pattern deadlock-recovery branch both depend on. This marker is that signal.
//
// It is deliberately ONE SHORT LINE per file, not a section: `pruneRefineBlocks` strips
// `### Target:` sections and leaves plain lines alone, so the marker survives the prune it
// exists to outlive. Growth is bounded at one line per target file (the suggester caps at 8).
const OUT_OF_BAND_MARKER_PREFIX = "<!-- rks:context-out-of-band: ";
const outOfBandMarkerFor = (file) => OUT_OF_BAND_MARKER_PREFIX + file + " -->";

/**
 * Parse test failure output for a numeric assertion mismatch of the form:
 *   Expected: N
 *   Received: M
 * where delta (M - N) is a positive integer in [1, MAX_NUMERIC_ASSERTION_DELTA].
 *
 * Does not fire on non-numeric failures, negative deltas, or deltas above the cap.
 *
 * @param {string} testOutput - Raw test failure output (Vitest/Jest stdout)
 * @returns {{ expected: number, received: number, delta: number }|null}
 */
export function detectNumericAssertionMismatch(testOutput) {
  if (!testOutput || typeof testOutput !== 'string') return null;
  // Match "Expected: N" / "Expected value: N" followed by "Received: M" / "Received value: M"
  const pattern = /Expected(?:\s+value)?:\s+(\d+)\s*\n\s*Received(?:\s+value)?:\s+(\d+)/gi;
  let match;
  while ((match = pattern.exec(testOutput)) !== null) {
    const expected = parseInt(match[1], 10);
    const received = parseInt(match[2], 10);
    const delta = received - expected;
    if (delta >= 1 && delta <= MAX_NUMERIC_ASSERTION_DELTA) {
      return { expected, received, delta };
    }
  }
  return null;
}

/**
 * Extract a test file path and line number from a stack frame in test failure output.
 * Matches patterns like:
 *   at Object.<anonymous> (src/foo.test.ts:42:3)
 *   at src/foo.test.ts:42:3
 *
 * @param {string} testOutput
 * @param {string} [projectRoot] - Used to relativize absolute paths
 * @returns {{ file: string, line: number }|null}
 */
export function extractTestStackFrame(testOutput, projectRoot) {
  if (!testOutput || typeof testOutput !== 'string') return null;
  // Pattern 1: "(path/to/file.test.ts:42:3)"
  const parenRe = /\(([^)]+\.(?:test|spec)\.[jt]sx?):(\d+):\d+\)/g;
  // Pattern 2: "at path/to/file.test.ts:42:3" (no parens)
  const bareRe = /\bat\s+([\w/.@:-]+\.(?:test|spec)\.[jt]sx?):(\d+):\d+/g;
  const m = parenRe.exec(testOutput) || bareRe.exec(testOutput);
  if (!m) return null;
  let filePath = m[1];
  const line = parseInt(m[2], 10);
  if (filePath.startsWith('/') && projectRoot) {
    filePath = path.relative(projectRoot, filePath);
  }
  return { file: filePath, line };
}

/**
 * Parse compile/transform errors from test failure log content.
 * Recognises esbuild [ERROR] lines and tsc error TS\d+: lines.
 *
 * @param {string} logContent - Raw test failure log text
 * @returns {{ file: string, line: number|null, message: string }[]}
 */
export function detectCompileErrors(logContent) {
  if (!logContent || typeof logContent !== 'string') return [];
  const errors = [];

  // esbuild: /path/to/file.tsx:267:6: ERROR: <message>
  const esbuildRe = /([^\s:]+\.[jt]sx?):(\d+):\d+:\s+ERROR:\s+(.+)/g;
  let m;
  while ((m = esbuildRe.exec(logContent)) !== null) {
    errors.push({ file: m[1], line: parseInt(m[2], 10), message: m[3].trim() });
  }

  // tsc: file.ts(42,8): error TS2345: <message>
  // or: error TS2345: <message>  (no location)
  const tscRe = /(?:([^\s(]+\.[jt]sx?)\((\d+),\d+\):\s+)?error\s+(TS\d+):\s+(.+)/g;
  while ((m = tscRe.exec(logContent)) !== null) {
    errors.push({
      file: m[1] || null,
      line: m[2] ? parseInt(m[2], 10) : null,
      message: `${m[3]}: ${m[4].trim()}`,
    });
  }

  return errors;
}

/**
 * Analyze a backlog story and suggest refinements based on trigger type.
 * @param {Object} params
 * @param {string} params.projectRoot - Project root directory
 * @param {string} params.problemId - Backlog item ID (e.g., backlog.foo.bar)
 * @param {string} [params.trigger] - What triggered refinement: plan_failed, exec_failed, test_failed, design
 * @param {string} [params.context] - Optional failure output or additional context
 * @param {string} [params.testOutput] - Raw test failure output (used when trigger is test_failed)
 * @param {string} [params.projectId] - Project identifier for telemetry
 */
export async function runRefineTool({ projectRoot, problemId, trigger, context, testOutput, projectId }) {
  const refineStartMs = Date.now();
  try {
    if (!projectRoot) throw new Error("projectRoot is required");
    if (!problemId) throw new Error("problemId is required");

    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.start", projectId, { problemId, trigger: trigger || "manual" });
    } catch (e) { /* telemetry is best-effort */ }

    // Load story via shared loader
    let story;
    try {
      story = loadStory(projectRoot, problemId);
    } catch (err) {
      return { ok: false, error: `Story not found: ${problemId}` };
    }
    const { frontmatter: parsedData, body, rawContent: storyContent, targetFiles: normalized, path: storyPath } = story;

    // Check for duplicate frontmatter blocks. backlog.fix.refine-noop-escalation-false-positive:
    // this counted bare `---` lines, so a body horizontal rule or a fenced YAML example raised a
    // `critical` the applier then reported as "no duplicate blocks found" — a false no-op that
    // terminated the run. Now uses the applier's own test, via the shared helper.
    const hasDuplicateFrontmatter = extractFrontmatterBlocks(storyContent).blocks.length > 1;

    // Analysis results
    const analysis = {
      hasDuplicateFrontmatter: !!hasDuplicateFrontmatter,
      hasTargetFiles: false,
      targetFiles: [],
      hasCodeSnippets: false,
      codeSnippetCount: 0,
      hasAcceptanceCriteria: false,
      acceptanceCriteriaCount: 0,
      estimatedComplexity: "low",
      bodyLength: body.length,
      hasChildStories: false,
    };

    analysis.createFiles = new Set(normalized.filter(t => t.action === 'CREATE').map(t => t.path));
    analysis.hasTargetFiles = normalized.length > 0;
    analysis.targetFiles = normalized.map(t => t.path);

    // Detect legacy format (simple string array vs structured objects)
    analysis.isLegacyFormat = analysis.hasTargetFiles &&
      Array.isArray(parsedData.targetFiles) &&
      parsedData.targetFiles.length > 0 &&
      typeof parsedData.targetFiles[0] === 'string';

    // Check for testRequirements in frontmatter
    const testRequirements = coerceTestRequirements(parsedData.testRequirements || parsedData.testCases);
    const hasTestRequirements = Array.isArray(testRequirements) && testRequirements.length > 0;
    analysis.hasTestRequirements = hasTestRequirements;
    analysis.testRequirements = testRequirements;

    // Validate test requirements aren't too vague
    const vaguePatterns = [
      /^add tests?$/i,
      /^write tests?$/i,
      /^test this$/i,
      /^verify it works$/i,
      /^should work$/i,
    ];
    const vagueRequirements = testRequirements.filter(req => 
      typeof req === 'string' && vaguePatterns.some(p => p.test(req.trim()))
    );
    analysis.hasVagueTestRequirements = vagueRequirements.length > 0;
    analysis.vagueRequirements = vagueRequirements;

    // Check for code snippets (fenced code blocks)
    const codeBlocks = body.match(/```[\s\S]*?```/g) || [];
    analysis.hasCodeSnippets = codeBlocks.length > 0;
    analysis.codeSnippetCount = codeBlocks.length;

    // Validate search/replace patterns against target files
    const snippetIssues = [];
    if (analysis.hasCodeSnippets && analysis.hasTargetFiles) {
      // Extract search patterns from markdown headers like: ### file.mjs - description (search/replace)
      const searchReplacePattern = /###\s+([^\s(]+)[^(]*\(search\/replace\)\s*\n+(?:Search\s+for:\s*\n)?```[\w]*\n([\s\S]*?)```/gi;
      let srMatch;
      while ((srMatch = searchReplacePattern.exec(body)) !== null) {
        const targetFile = srMatch[1].trim();
        const searchPattern = srMatch[2].trim();
        if (searchPattern.length < 10) continue; // Skip tiny patterns

        // Find matching target file
        const matchedTarget = analysis.targetFiles.find(tf => tf.endsWith(targetFile) || targetFile.endsWith(path.basename(tf)));
        if (matchedTarget) {
          try {
            const fileContent = await fs.readFile(path.join(projectRoot, matchedTarget), "utf8");
            const occurrences = fileContent.split(searchPattern).length - 1;
            if (occurrences === 0) {
              snippetIssues.push({ file: matchedTarget, pattern: searchPattern.slice(0, 60), issue: "not_found" });
            } else if (occurrences > 1) {
              snippetIssues.push({ file: matchedTarget, pattern: searchPattern.slice(0, 60), issue: "ambiguous", count: occurrences });
            }
          } catch { /* file not found - covered by targetFiles validation */ }
        }
      }
    }
    analysis.snippetIssues = snippetIssues;

    // Check for acceptance criteria
    const acMatches = body.match(/- \[[ x]\]/g) || [];
    analysis.hasAcceptanceCriteria = acMatches.length > 0;
    analysis.acceptanceCriteriaCount = acMatches.length;

    // Check for child stories (wiki links)
    const childLinks = body.match(/\[\[backlog\.[^\]]+\]\]/g) || [];
    analysis.hasChildStories = childLinks.length > 0;

    // Classify TDD applicability based on story type
    const storyType = parsedData.storyType || inferStoryType(problemId, body);
    analysis.storyType = storyType;

    // TDD fit classification
    const strongTddFit = ['bugfix', 'fix', 'api', 'contract', 'validation', 'behavior'];
    const moderateTddFit = ['feature', 'refactor'];
    const poorTddFit = ['spike', 'exploration', 'ui', 'visual', 'performance', 'infrastructure', 'llm'];

    if (strongTddFit.includes(storyType)) {
      analysis.tddApplicable = 'strong';
      analysis.tddReason = 'Clear input/output contract - write tests first';
    } else if (moderateTddFit.includes(storyType)) {
      analysis.tddApplicable = 'moderate';
      analysis.tddReason = 'Tests valuable but may need iteration on design first';
    } else if (poorTddFit.includes(storyType)) {
      analysis.tddApplicable = 'poor';
      analysis.tddReason = 'Exploratory work - defer testing until design stabilizes';
    } else {
      analysis.tddApplicable = 'moderate';
      analysis.tddReason = 'Unknown type - default to moderate TDD approach';
    }

    // Estimate complexity — factor in AC count, body length, AND target file count
    const targetFileCount = analysis.targetFiles?.length || 0;

    // Child stories (parsedData.parent set) are exempt from all decompose signals.
    // A child was already scoped by PO + QA during parent decomposition — refine must not
    // override that evaluation and produce grandchildren. Skip the entire complexity
    // evaluation so no path through this code produces estimatedComplexity = "high" for a child.
    const editTargets = normalized.filter(t => t.action === 'EDIT');
    const createTargets = normalized.filter(t => t.action === 'CREATE');
    const editCount = editTargets.length;
    const hasCreateAndEdit = createTargets.length > 0 && editCount > 0;
    const allEditOnly = createTargets.length === 0 && editCount > 0;

    // Concern-scoring signals — computed for ALL stories (parent or not).
    // For child stories, signals surface as decomposeSuggested instead of triggering auto-decomp.
    // AC count and body length removed: they measure specification thoroughness, not scope.
    // A well-specified atomic story can have 5+ ACs or exceed 2500 bytes (e.g. @@SEARCH blocks).
    const signals = [];
    if (targetFileCount > 5) signals.push(`${targetFileCount} target files`);

    // op:edit-only stories have bounded scope — the files exist and ACs define a contained
    // change. The editCount > 1 threshold was designed for op:create stories where the file
    // doesn't exist yet and scope is genuinely unbounded. For op:edit-only stories raise the
    // threshold to >5 files before editCount triggers a decompose suggestion, preventing
    // spurious decomposition of routine multi-file edits (e.g. refactors touching 2-3 files).
    // op:edit-only: threshold 5 (bounded scope, files exist, ACs define contained change).
    // create+edit mix: threshold 3 (source+test is the canonical atom; decompose only when
    // genuinely bundling multiple independent concerns — editCount > 3 with mixed targets).
    const editCountThreshold = allEditOnly ? 5 : 3;
    if (editCount > editCountThreshold) signals.push(`${editCount} separate files being edited (multiple independent concerns)`);
    // hasCreateAndEdit is threshold-gated: source+test (editCount=2) is one atom, not a complexity signal.
    if (hasCreateAndEdit && editCount > 3) signals.push(`bundled create+edit targets with ${editCount} edit targets (implementation mixed with wiring)`);
    for (const target of editTargets) {
      try {
        const absPath = path.join(projectRoot, target.path);
        if (fsSync.existsSync(absPath)) {
          const lineCount = fsSync.readFileSync(absPath, 'utf8').split('\n').length;
          if (lineCount >= 300) {
            signals.push(`large file edit: ${target.path} has ${lineCount} lines`);
            break;
          }
        }
      } catch (e) { /* file may not exist in all environments */ }
    }
    // Check op:create targets that already exist on disk — story frontmatter is wrong
    // and the planner will generate a create_file step that destroys the existing file.
    for (const target of createTargets) {
      try {
        const absPath = path.join(projectRoot, target.path);
        if (fsSync.existsSync(absPath)) {
          const lineCount = fsSync.readFileSync(absPath, 'utf8').split('\n').length;
          if (lineCount >= 300) {
            signals.push(`op:create target already exists on disk at ${lineCount} lines — story frontmatter is wrong, planner will generate create_file and destroy the file: ${target.path}`);
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (parsedData.parent) {
      // Child stories: never trigger auto-decomp regardless of signal count.
      // A child was already scoped by PO + QA during parent decomposition.
      // Surface signals as a suggestion only when 2+ signals agree.
      analysis.decomposeReasons = [];
      if (signals.length >= 2) {
        analysis.decomposeSuggested = true;
        analysis.decomposeSuggestedReasons = signals;
      }
    } else {
      analysis.decomposeReasons = signals;
      // AND gate: require 2+ independent signals to agree before flagging high complexity.
      // A single signal firing in isolation (e.g. fileCount=6 but short body, few targets)
      // is not sufficient evidence of genuine scope overload. Two signals agreeing is.
      if (signals.length >= 2) {
        analysis.estimatedComplexity = "high";
      }
    }

    if (analysis.estimatedComplexity !== "high" &&
        (analysis.acceptanceCriteriaCount > 2 || analysis.bodyLength > 1200 || targetFileCount > 3)) {
      analysis.estimatedComplexity = "medium";
    }

    // Detect truncation root cause — when context contains RAG truncation markers,
    // prefer disk-fetch context injection over story note inflation.
    const TRUNCATION_MARKER_RE = /\/\/ \.\.\. \(\d+ lines omitted\) \.\.\./;
    const hasTruncationContext = !!(context && TRUNCATION_MARKER_RE.test(context));

    // Warn when story note body exceeds 5KB — note inflation crowds out file content
    // in the planner context and makes truncation progressively worse on each retry.
    const NOTE_BODY_SIZE_WARN_BYTES = 5120;
    if (analysis.bodyLength > NOTE_BODY_SIZE_WARN_BYTES) {
      analysis.noteSizeWarning = `Story note body is ${Math.round(analysis.bodyLength / 1024)}KB — exceeds 5KB threshold; note inflation may crowd out file context in planner`;
    }

    // Build suggestions based on analysis and trigger
    const suggestions = [];
    // backlog.fix.refine-plan-staging-advisory-channel: entries here are ADVICE,
    // not work items. They are never passed to rks_refine_apply — it has no handler
    // for them, so applying one produced a guaranteed decline that surfaced as
    // refine_noop, and any Governor obeying the Build prompt's STOP rule then killed
    // a healthy run on a suggestion that was never actionable.
    const advisory = [];

    // Collect telemetry
    const collector = getTelemetryCollector();
    collector.emit("refine.analyze", projectId, {
      problemId,
      trigger: trigger || "manual",
      hasTargetFiles: analysis.hasTargetFiles,
      targetFileCount: analysis.targetFiles?.length || 0,
      suggestionCount: 0 // Will be updated after suggestions are built
    });

    // Critical: flag duplicate frontmatter before anything else
    if (analysis.hasDuplicateFrontmatter) {
      suggestions.push({
        type: "fix_duplicate_frontmatter",
        priority: "critical",
        reason: "Note has duplicate frontmatter blocks — updateField and phase advancement will malfunction",
        hint: "Merge duplicate frontmatter blocks into a single valid block",
      });
    }

    // Suggest test requirements if missing
    if (!hasTestRequirements) {
      suggestions.push({
        type: "add_test_requirements",
        priority: "high",
        reason: "No testRequirements in frontmatter - tests will lack direction",
        hint: "Add testRequirements array with specific, behavior-focused test cases",
        suggestedFormat: `testRequirements:
  - "Verify [action] returns [expected] when [condition]"
  - "Test that [error case] throws/returns [error]"
  - "Edge case: [boundary condition]"`,
      });
    }

    // Warn about vague test requirements
    if (vagueRequirements.length > 0) {
      suggestions.push({
        type: "fix_vague_tests",
        priority: "high",
        reason: `Test requirements are too vague: ${vagueRequirements.join(', ')}`,
        hint: "Replace with specific behavior assertions like 'Verify login fails with invalid password'",
        vagueItems: vagueRequirements,
      });
    }

    // Suggest targetFiles if missing
    if (!analysis.hasTargetFiles) {
      const possibleFiles = await inferTargetFiles(projectRoot, body);
      suggestions.push({
        type: "add_target_files",
        priority: "high",
        reason: "No targetFiles in frontmatter - planner needs explicit file paths",
        suggestedFiles: possibleFiles.slice(0, 5),
        frontmatterFormat: `targetFiles:\n${possibleFiles.slice(0, 3).map(f => `  - "${f}"`).join('\n')}`,
      });
    }

    // Suggest upgrading legacy targetFiles format
    if (analysis.isLegacyFormat) {
      suggestions.push({
        type: "upgrade_target_files_format",
        priority: "medium",
        reason: "targetFiles uses legacy string[] format — upgrade to structured { path, op, desc } for contract compliance",
        currentFormat: parsedData.targetFiles,
      });
    }

    // Check if targetFiles actually exist in the project
    // Skip validation for files marked with CREATE FILE directive in story body
    if (analysis.hasTargetFiles && analysis.targetFiles.length > 0) {
      // Parse CREATE FILE directives from story body (multiple formats)
      const createFilePattern = /\/\/\s*CREATE\s+FILE[:\s]*(\S+)/gi;
      const createFilePaths = new Set();
      let match;
      while ((match = createFilePattern.exec(body)) !== null) {
        createFilePaths.add(match[1].trim());
      }
      // Markdown code block headers: ### path/to/file.mjs (CREATE FILE)
      const headerPattern = /^###\s+([^\s(]+)\s*\((?:CREATE\s+FILE|new\s+file)\)/gim;
      while ((match = headerPattern.exec(body)) !== null) {
        createFilePaths.add(match[1].trim());
      }
      // PO bullet annotations: `path/to/file.ts` — CREATE FILE — description
      const bulletPattern = /^-\s+`([^`]+)`\s*—\s*CREATE\s+FILE/gim;
      while ((match = bulletPattern.exec(body)) !== null) {
        createFilePaths.add(match[1].trim());
      }

      const missingFiles = [];
      for (const targetFile of analysis.targetFiles) {
        // Skip validation if marked as CREATE FILE in body or create: true in frontmatter
        if (createFilePaths.has(targetFile) || analysis.createFiles.has(targetFile)) {
          continue;
        }
        const fullPath = path.join(projectRoot, targetFile);
        try {
          await fs.stat(fullPath);
        } catch {
          missingFiles.push(targetFile);
        }
      }
      if (missingFiles.length > 0) {
        suggestions.push({
          type: "fix_target_files",
          priority: "high",
          reason: `targetFiles reference non-existent paths: ${missingFiles.join(', ')}`,
          missingFiles,
          hint: "Update targetFiles to reference existing paths, or add // CREATE FILE: <path> directive for new files",
        });
      }
    }

    // Report snippet pattern issues found during validation
    if (analysis.snippetIssues && analysis.snippetIssues.length > 0) {
      for (const issue of analysis.snippetIssues) {
        if (issue.issue === "not_found") {
          suggestions.push({
            type: "fix_search_pattern",
            priority: "high",
            reason: `Search pattern not found in ${issue.file}`,
            pattern: issue.pattern + "...",
            hint: "Read the file and copy the exact current content for the SEARCH block",
          });
        } else if (issue.issue === "ambiguous") {
          suggestions.push({
            type: "fix_search_pattern",
            priority: "high",
            reason: `Search pattern matches ${issue.count} times in ${issue.file} (ambiguous)`,
            pattern: issue.pattern + "...",
            hint: "Add more unique context (function name, nearby comments) to the SEARCH block",
          });
        }
      }
    }

    // Inject code context from ALL existing target files into the story.
    // The planner needs actual source code to generate accurate search_replace patterns.
    // Check per-file whether the story already contains a snippet for it.
    // When truncation is the detected root cause, prefer disk_fetch_context over note
    // injection — this avoids growing the story note body which worsens context crowding.
    if (analysis.hasTargetFiles) {
      for (const targetFile of analysis.targetFiles.slice(0, 8)) {
        // Skip if story already has a code snippet header for this file — or if a previous
        // call already delivered it out of band. Without the marker clause this loop has no
        // convergence signal on a near-cap note and re-suggests the same file forever.
        if (
          body.includes("### Target: " + targetFile) ||
          body.includes("### Code Snippet: " + targetFile) ||
          body.includes(outOfBandMarkerFor(targetFile))
        ) continue;
        const fullPath = path.join(projectRoot, targetFile);
        try {
          await fs.stat(fullPath); // exists check
          // Near-cap notes take the out-of-band path too, not just truncation-triggered ones:
          // injecting a section that the cap prune is guaranteed to strip is the fixed point.
          if (hasTruncationContext || body.length > MAX_NOTE_BODY_BYTES) {
            // Truncation detected — fetch from disk as out-of-band context so story
            // note body stays stable and doesn't crowd out future file retrievals.
            suggestions.push({
              type: "disk_fetch_context",
              priority: "high",
              reason: hasTruncationContext
                ? `${targetFile} — truncation detected; fetching from disk bypasses RAG and avoids growing story note body`
                : `${targetFile} — note body is already over the ${MAX_NOTE_BODY_BYTES}-byte cap; an injected section would be pruned before the write, so fetching from disk instead`,
              file: targetFile,
            });
          } else {
            suggestions.push({
              type: "add_code_snippet",
              priority: "high",
              reason: `${targetFile} - planner needs current source code for accurate search patterns`,
              file: targetFile,
              hint: "Inject current file content so planner can generate precise edits",
            });
          }
        } catch {
          // File doesn't exist — emit create_file_directive if op:create in frontmatter
          const isCreateTarget = (normalized || []).some(t =>
            t.path === targetFile && (t.op === "create" || t.action === "CREATE" || t.create === true)
          );
          if (isCreateTarget && !body.includes("// CREATE FILE: " + targetFile)) {
            suggestions.push({
              type: "create_file_directive",
              priority: "high",
              reason: `${targetFile} — op:create target has no CREATE FILE directive; planner will skip this file`,
              file: targetFile,
              hint: "Inject CREATE FILE directive so planner generates a create_file step for this path",
            });
          }
        }
      }
    }

    // Inject test exemplar for CREATE FILE test targets.
    // When a story creates new test files, the planner needs to see real test patterns
    // (imports, describe/it structure, assertion syntax) to generate complete tests.
    // Skip when story has testStory link — tests will be built in the paired test story.
    if (analysis.hasTargetFiles && analysis.createFiles.size > 0 && !parsedData.testStory) {
      const testFilePatterns = ['.test.', '.spec.', '__tests__'];
      const editTargetDirs = analysis.targetFiles
        .filter(f => !analysis.createFiles.has(f))
        .map(f => path.dirname(f));

      for (const createFile of analysis.createFiles) {
        const isTest = testFilePatterns.some(p => createFile.includes(p)) || createFile.includes('/tests/');
        if (!isTest) continue;
        // backlog.fix.build-governor-self-heal: the suggester no longer pre-judges. It PROPOSES; the
        // apply side DECIDES.
        //
        // This used to be `body.includes("### Test Exemplar:")` — a bare header check, so ANY prior
        // exemplar permanently suppressed EVERY future suggestion. And it cannot be answered here
        // anyway: the section the apply handler writes names the exemplar it COPIES FROM, which is
        // only chosen down there. Guessing at it from up here is what produced a correction that was
        // never emitted, an apply that was never handed anything, and a retry loop that could not
        // converge no matter how many times it ran.
        //
        // If the proposal turns out to change nothing, the apply side now says so — loudly, and
        // without telling anyone to re-plan an unchanged story.

        suggestions.push({
          type: "add_test_exemplar",
          priority: "high",
          reason: `${createFile} is a CREATE FILE test target — planner needs test patterns to generate complete assertions`,
          file: createFile,
          editTargetDirs,
          hint: "Inject a similar existing test file as an exemplar for the planner",
        });
      }
    }

    // Tractability pressure (Axis B) resolves at the PLAN level, NOT by sibling stories.
    // Per the story-sizing contract (design.story-sizing-contract.md §3b), the size signals
    // collected above measure plan tractability, not value coherence — a size signal ALONE never
    // justifies sibling stories. Surface plan-level staging guidance instead of a sibling
    // decompose. Sibling stories require an INDEPENDENT-CONCERN break (Axis A), which is the PO's
    // determination (governor-po.md) and is enforced at apply-time by the independent_value_gate,
    // not by a size threshold here. (backlog.feat.reconcile-story-sizing-po-arch-planner)
    if (analysis.estimatedComplexity === "high" && !analysis.hasChildStories) {
      const stagingReason = analysis.decomposeReasons?.length > 0
        ? analysis.decomposeReasons.join('; ')
        : `Story has ${analysis.acceptanceCriteriaCount} acceptance criteria and ${Math.round(analysis.bodyLength / 1000)}KB of content`;
      // ADVISORY, not a suggestion. rks_refine_apply has no plan_staging handler, so
      // emitting it into suggestions[] made every staging-only refine end in a
      // guaranteed decline reported as refine_noop. priority is preserved because
      // refine-decompose.test.mjs pins it.
      advisory.push({
        type: "plan_staging",
        priority: "medium",
        applicable: false,
        applicableReason: "rks_refine_apply has no handler for plan_staging; applying it can only produce a decline. Act on the hint directly.",
        reason: stagingReason,
        hint: "Size / tractability pressure — land this ONE story via a multi-step plan or staged commits (refine-in-place), NOT sibling stories. Sibling stories require an independent-concern break (Axis A), not a size threshold. See design.story-sizing-contract.md.",
      });
    }

    // Trigger-specific suggestions
    if (trigger === "plan_failed" || trigger === "plan_rejected") {
      // Check for recent run logs
      const runsDir = path.join(projectRoot, ".rks", "runs");
      const recentRun = await findRecentRunForProblem(runsDir, problemId);
      if (recentRun) {
        suggestions.push({
          type: "review_plan_output",
          priority: "high",
          reason: "Plan failed - review LLM output for specific needs",
          runDir: recentRun,
          hint: "Check llm-output.json for needs_code_context requests",
        });
      }

      // Deadlock detection: snippets already injected but no SEARCH anchor available.
      // Fires when context says no_search_pattern_for_modify, ### Target: sections exist,
      // and no add_code_snippet suggestions were generated (all snippets already present).
      // The out-of-band marker counts as "context was supplied for this file". Without it this
      // recovery branch is dead on exactly the over-cap notes that need it most, since under
      // direction C those notes never receive a `### Target:` section at all.
      if (
        context && context.includes("no_search_pattern_for_modify") &&
        (body.includes("### Target: ") || body.includes(OUT_OF_BAND_MARKER_PREFIX)) &&
        !suggestions.some(s => s.type === "add_code_snippet")
      ) {
        const targetFilesWithSnippets = analysis.targetFiles.filter(
          f => body.includes("### Target: " + f) || body.includes(outOfBandMarkerFor(f))
        );
        for (const targetFile of targetFilesWithSnippets) {
          suggestions.push({
            type: "add_search_pattern",
            priority: "high",
            reason: `${targetFile} — snippets injected but no SEARCH anchor available; extracting patterns from existing snippet content`,
            file: targetFile,
            hint: "Extracts anchor patterns from injected ### Target: section and writes codeSnippets to frontmatter",
          });
        }
      }
    }

    if (trigger === "exec_failed") {
      suggestions.push({
        type: "verify_search_patterns",
        priority: "high",
        reason: "Exec failed - search patterns likely don't match current code",
        hint: "Read target files and update SEARCH blocks with exact current content",
      });
    }

    if (trigger === "test_failed" && (testOutput || context)) {
      const logContent = testOutput || context;
      let concreteTestSuggestionFired = false;
      const testFilePatterns = ['.test.', '.spec.', '/tests/', '/test/'];
      const storyTestFiles = analysis.targetFiles.filter(f =>
        testFilePatterns.some(p => f.includes(p))
      );

      // Path 0: compile/transform errors (esbuild, tsc) — most actionable signal
      const compileErrors = detectCompileErrors(logContent);
      if (compileErrors.length > 0) {
        for (const err of compileErrors) {
          // Relativize absolute paths
          const relFile = err.file && err.file.startsWith('/') && projectRoot
            ? path.relative(projectRoot, err.file)
            : err.file;
          const location = relFile
            ? (err.line ? `${relFile}:${err.line}` : relFile)
            : 'unknown location';
          suggestions.push({
            type: "add_search_pattern",
            priority: "critical",
            reason: `Compile error at ${location} — planner-inferred structural change produced invalid syntax (${err.message}). Add explicit @@SEARCH/@@REPLACE blocks for this change instead of relying on LLM inference.`,
            file: relFile || undefined,
            line: err.line || undefined,
          });
        }
        concreteTestSuggestionFired = true;
      }

      // Path 1: numeric assertion mismatch — generate fix_numeric_assertion
      if (!concreteTestSuggestionFired) {
        const mismatch = detectNumericAssertionMismatch(logContent);
        if (mismatch && storyTestFiles.length > 0) {
          for (const testFile of storyTestFiles) {
            suggestions.push({
              type: "fix_numeric_assertion",
              priority: "high",
              reason: `Test asserts ${mismatch.expected}, actual is ${mismatch.received} (delta +${mismatch.delta}) — update count assertion in test file`,
              file: testFile,
              expected: mismatch.expected,
              received: mismatch.received,
              delta: mismatch.delta,
            });
          }
          concreteTestSuggestionFired = true;
        }
      }

      // Path 2: file+line stack frame — generate fix_test_assertion when no numeric match
      if (!concreteTestSuggestionFired) {
        const frame = extractTestStackFrame(logContent, projectRoot);
        if (frame) {
          // Only suggest for test files the story owns or the frame file directly
          const frameOwned = storyTestFiles.some(f =>
            f === frame.file || frame.file.endsWith(f) || f.endsWith(frame.file)
          );
          if (frameOwned || storyTestFiles.length === 0) {
            suggestions.push({
              type: "fix_test_assertion",
              priority: "high",
              reason: `Test failure at ${frame.file}:${frame.line} — assertion needs updating`,
              file: frame.file,
              line: frame.line,
            });
            concreteTestSuggestionFired = true;
          }
        }
      }

      // Emit telemetry when test_failed trigger falls through to note_only
      if (!concreteTestSuggestionFired) {
        try {
          const collector = getTelemetryCollector();
          collector.emit("refine.note_only_fallback", projectId, {
            problemId,
            trigger,
            reason: "test_failed_no_concrete_suggestion",
          });
        } catch (e) { /* telemetry is best-effort */ }
      }
    }

    // Find related patterns (implemented stories with similar targets)
    const notesDir = path.join(projectRoot, "notes");
    const relatedPatterns = await findRelatedPatterns(notesDir, analysis.targetFiles);

    // Emit telemetry
    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.analyze", projectId, {
        problemId,
        trigger: trigger || "manual",
        hasTargetFiles: analysis.hasTargetFiles,
        targetFileCount: analysis.targetFiles?.length || 0,
        suggestionCount: suggestions.length,
      });
    } catch (e) { /* telemetry is best-effort */ }

    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.complete", projectId, { problemId, trigger: trigger || "manual", action: trigger || "manual", suggestionsGenerated: suggestions.length, durationMs: Date.now() - refineStartMs });
    } catch (e) { /* telemetry is best-effort */ }

    return {
      ok: true,
      problemId,
      trigger: trigger || "manual",
      analysis,
      suggestions,
      // Always present, empty or not, so a consumer never has to distinguish
      // "absent" from "none". The notice travels in-band because no prompt or
      // caller reads this channel yet.
      advisory,
      advisoryNotice:
        "advisory[] entries are ADVICE, not work items. Do NOT pass them to rks_refine_apply — it has no handler for them and will decline. Act on each entry's hint directly.",
      relatedPatterns: relatedPatterns.slice(0, 3),
      // With plan_staging moved out of suggestions[], a staging-only refine now
      // takes the false branch to rks_plan instead of rks_refine_apply. That flip
      // is the cure, not a regression — it is what stops the guaranteed decline
      // from ever being requested.
      requiredNext: suggestions.length > 0
        ? `rks_refine_apply { "projectId": "${projectId}", "problemId": "${problemId}" }`
        : `rks_plan { "projectId": "${projectId}", "problemId": "${problemId}" }`,
    };
  } catch (err) {
    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.failed", projectId, { problemId, trigger: trigger || "manual", durationMs: Date.now() - refineStartMs, error: err.message || String(err) });
    } catch (e) { /* telemetry is best-effort */ }
    return { ok: false, error: err.message || String(err) };
  }
}

export async function runRksReadyTool({ projectRoot, problemId, projectId }) {
  try {
    if (!projectRoot) throw new Error("projectRoot is required");
    if (!problemId) throw new Error("problemId is required");

    // Reuse runRefineTool to get analysis/suggestions
    const res = await runRefineTool({ projectRoot, problemId, projectId });
    if (!res || !res.ok) {
      return { ok: false, phase: "draft", error: res ? res.error : "runRefineTool failed" };
    }

    const analysis = res.analysis || {};
    const issues = [];

    // Validate presence of targetFiles
    if (!analysis.hasTargetFiles || !Array.isArray(analysis.targetFiles) || analysis.targetFiles.length === 0) {
      issues.push("Missing targetFiles in frontmatter");
    }

    // Check target files exist
    const missingFiles = [];
    if (analysis.hasTargetFiles && Array.isArray(analysis.targetFiles)) {
      for (const targetFile of analysis.targetFiles) {
        try {
          await fs.stat(path.join(projectRoot, targetFile));
        } catch {
          missingFiles.push(targetFile);
        }
      }
      if (missingFiles.length > 0) {
        issues.push(`targetFiles reference non-existent paths: ${missingFiles.join(', ')}`);
      }
    }

    // Acceptance criteria
    if (!analysis.hasAcceptanceCriteria) {
      issues.push("Missing acceptance criteria");
    }

    if (issues.length > 0) {
      // Emit telemetry
      try {
        const collector = getTelemetryCollector();
        collector.emit("refine.ready", projectId, {
          problemId,
          issueCount: issues.length,
          success: false,
        });
      } catch (e) { /* telemetry is best-effort */ }
      return { ok: false, phase: "draft", issues, hint: "Fix issues and retry rks_ready" };
    }

    // Update the story phase to ready using dendron primitives
    let storyForReady;
    try {
      storyForReady = loadStory(projectRoot, problemId);
    } catch (err) {
      return { ok: false, phase: "draft", issues: [`Story not found: ${problemId}`], hint: "Ensure the note exists under notes/" };
    }
    const previousPhase = storyForReady.frontmatter.phase || null;
    const notesDir = resolveNotesDir(projectRoot);
    const storyFilename = `${problemId}.md`;

    // Update phase using dendron primitive
    await updateField(notesDir, storyFilename, "phase", "ready");

    // Emit telemetry
    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.ready", projectId, {
        problemId,
        previousPhase,
        success: true,
      });
    } catch (e) { /* telemetry is best-effort */ }

    return { ok: true, phase: "ready", previousPhase };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Infer story type from problem ID and body content
 */
function inferStoryType(problemId, body) {
  // Check problem ID patterns
  if (problemId.includes('.fix.') || problemId.includes('.bug.')) return 'bugfix';
  if (problemId.includes('.feat.')) return 'feature';
  if (problemId.includes('.refactor.')) return 'refactor';
  if (problemId.includes('.spike.') || problemId.includes('.explore.')) return 'exploration';
  if (problemId.includes('.perf.')) return 'performance';
  if (problemId.includes('.infra.')) return 'infrastructure';

  // Check body content patterns
  const bodyLower = body.toLowerCase();
  if (bodyLower.includes('bug') && bodyLower.includes('fix')) return 'bugfix';
  if (bodyLower.includes('api') && bodyLower.includes('contract')) return 'api';
  if (bodyLower.includes('validation') || bodyLower.includes('validate')) return 'validation';
  if (bodyLower.includes('refactor')) return 'refactor';
  if (bodyLower.includes('spike') || bodyLower.includes('explore')) return 'exploration';

  return 'feature'; // Default
}

/**
 * Infer likely target files from story body content
 */
async function inferTargetFiles(projectRoot, body) {
  const files = [];

  // Look for file path patterns in the body
  const pathPatterns = body.match(/(?:packages|src|scripts|tests?)\/[\w\-\/]+\.(?:mjs|js|ts|tsx|json)/g) || [];
  files.push(...pathPatterns);

  // Look for specific file mentions
  const fileRefs = body.match(/`([^`]+\.(?:mjs|js|ts|tsx|json))`/g) || [];
  files.push(...fileRefs.map(f => f.replace(/`/g, '')));

  // Deduplicate and verify existence
  const unique = [...new Set(files)];
  const verified = [];
  for (const file of unique.slice(0, 10)) {
    try {
      await fs.access(path.join(projectRoot, file));
      verified.push(file);
    } catch {
      // File doesn't exist, might be new file - still include
      if (file.includes('packages/') || file.includes('src/')) {
        verified.push(file);
      }
    }
  }

  return verified;
}

/**
 * Find the most recent run directory for a problem
 */
async function findRecentRunForProblem(runsDir, problemId) {
  try {
    const entries = await fs.readdir(runsDir);
    const slug = problemId.replace(/\./g, "-");
    const matching = entries
      .filter(e => e.includes(slug))
      .sort()
      .reverse();
    return matching[0] ? path.join(runsDir, matching[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Find related implemented stories with similar target files
 */
async function findRelatedPatterns(notesDir, targetFiles) {
  try {
    const implemented = await glob("z_implemented.*.md", { cwd: notesDir });
    const related = [];

    for (const file of implemented.slice(0, 20)) {
      const content = await fs.readFile(path.join(notesDir, file), "utf8");
      for (const target of targetFiles) {
        if (content.includes(target)) {
          related.push(file.replace(".md", ""));
          break;
        }
      }
    }

    return related;
  } catch {
    return [];
  }
}

/**
 * Extract 2-4 anchor patterns from code content suitable for SEARCH blocks.
 * Looks for function signatures, export statements, and class declarations.
 * @param {string} codeContent - The source code to extract anchors from
 * @returns {string[]} Array of anchor pattern strings
 */
function extractAnchorPatterns(codeContent) {
  const anchors = [];
  const lines = codeContent.split("\n");
  const patterns = [
    /^export\s+async\s+function\s+\w+/,
    /^export\s+function\s+\w+/,
    /^export\s+class\s+\w+/,
    /^export\s+const\s+\w+/,
    /^export\s+default\s+/,
    /^async\s+function\s+\w+/,
    /^function\s+\w+/,
    /^class\s+\w+/,
  ];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && patterns.some(p => p.test(trimmed))) {
      anchors.push(trimmed);
      if (anchors.length >= 4) break;
    }
  }
  return anchors;
}

/**
 * Validate that a string is a valid kebab-case slug for use as a child story ID suffix.
 * Accepts lowercase letters, digits, and hyphens. No leading/trailing hyphens.
 * Used by the decompose handler to accept LLM-provided semantic slugs.
 * Expected data shape: { type: "decompose", data: { children: [{ slug: "form-shell" }, ...] } }
 * @param {string} str
 * @returns {boolean}
 */
export function isValidKebabSlug(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(str);
}

/**
 * Derive a kebab-case slug from a list of acceptance criteria strings.
 * Extracts the first 2-3 significant words (skipping stopwords), joins with hyphens.
 * Returns null if no significant words found (caller should fall back to child-N).
 * @param {string[]} acList
 * @returns {string|null}
 */
export function deriveSlugFromACs(acList) {
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'is', 'are', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'be', 'has', 'it', 'its', 'that', 'this',
    'when', 'after', 'each', 'all', 'no', 'not', 'only', 'via', 'per', 'than',
    'so', 'if', 'can', 'new', 'any', 'does', 'do', 'was', 'were', 'will', 'have',
    'should', 'must', 'once', 'into', 'adds', 'add', 'renders', 'returns',
    'without', 'within', 'across', 'before', 'during', 'exactly', 'least',
    'most', 'more', 'less', 'two', 'three', 'four', 'five',
  ]);
  const combined = acList
    .join(' ')
    .replace(/- \[[ x]\] /g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const seen = new Set();
  const slugWords = [];
  for (const w of combined.split(' ')) {
    if (w.length > 2 && !stopwords.has(w) && !seen.has(w)) {
      seen.add(w);
      slugWords.push(w);
      if (slugWords.length >= 3) break;
    }
  }
  if (slugWords.length === 0) return null;
  return slugWords.join('-').slice(0, 40);
}

/**
 * Markdown code fence used by every section this module WRITES.
 *
 * backlog.fix.disk-fetch-test-helpers-drift-from-source: exported because tests
 * were re-typing it, so a change here would have left them measuring a framing
 * the writer no longer emits — silently, with every assertion still green.
 *
 * This is the EMISSION fence only. The fence PARSERS elsewhere in this file are a
 * separate concern and deliberately untouched.
 */
export const FENCE = "```";

const LANG_BY_EXT = { mjs: "javascript", js: "javascript", ts: "typescript", tsx: "tsx", json: "json", yaml: "yaml", yml: "yaml" };

/** The language tag the writer puts on a file's opening fence. */
export function fenceLangFor(filePath) {
  const ext = path.extname(filePath).slice(1) || "javascript";
  return LANG_BY_EXT[ext] || ext;
}

/**
 * The `### Target:` section the add_code_snippet writer appends.
 *
 * ONE definition, shared by the writer and by the tests that measure it.
 * `targetSectionFor(file, "")` is exactly the non-payload cost of the section —
 * which is what the projective headroom guard adds to the body length, so the
 * guard and its witnesses cannot disagree about what framing costs.
 */
export function targetSectionFor(filePath, payload) {
  return "\n\n### Target: " + filePath + "\n\nCurrent source (use for search_replace patterns):\n\n"
    + FENCE + fenceLangFor(filePath) + "\n" + payload + "\n" + FENCE + "\n";
}

/**
 * Apply refinements to a backlog story
 */
export async function runRefineApplyTool({ projectRoot, problemId, refinements, projectId = "unknown" }) {
  try {
    if (!projectRoot) throw new Error("projectRoot is required");
    if (!problemId) throw new Error("problemId is required");
    if (!refinements || !Array.isArray(refinements) || refinements.length === 0) {
      throw new Error("refinements array is required");
    }

    const notesDir = path.join(projectRoot, "notes");
    const storyFilename = problemId + ".md";
    const storyPath = path.join(notesDir, storyFilename);

    let storyContent;
    try {
      storyContent = await fs.readFile(storyPath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return { ok: false, error: "Story not found: " + storyFilename };
      }
      throw err;
    }

    const frontmatterMatch = storyContent.match(/^---\n([\s\S]*?)\n---/);
    let frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
    let body = frontmatterMatch ? storyContent.slice(frontmatterMatch[0].length) : storyContent;

    const applied = [];
    const historyLines = [];

    // backlog.fix.build-governor-self-heal: capture the note BEFORE the refinement loop, so we can
    // tell whether the refinements actually DID anything.
    //
    // Captured HERE, not later: everything below the loop mutates the note for reasons that have
    // nothing to do with the refinements — the legacy-targetFiles auto-upgrade rewrites frontmatter,
    // the size-cap prune rewrites the body, and the writeback stamps `phase` and `updated =
    // Date.now()` on EVERY call. Compare against any of those and every call reads as "changed", the
    // no-op is never detected, and the escalation below is dead code. Compare from inside the loop
    // and a targetFiles-only refinement reads as unchanged and FALSELY escalates a successful apply.
    const bodyBeforeRefinements = body;
    const frontmatterBeforeRefinements = frontmatter;
    // Declared here rather than at the disk_fetch_context loop below: add_code_snippet also
    // routes out of band on a near-cap note, and that runs earlier than the loop did.
    const outOfBandContextItems = [];

    // backlog.fix.hardcap-prune-destroys-authored-anchors: populated by the size-cap block below
    // when the body exceeds the cap. Declared here so it is in scope at the return site far below.
    let noteSizeOverflow = null;
    // backlog.fix.refine-prune-destroys-authored-create-blocks — AC6/AC7 state, set by the
    // cap-prune block below. `prunePreservedEverything` gates the reassurance message;
    // `pruneDestroyedAuthoredContent` escalates the call to a failure.
    let pruneDestroyedAuthoredContent = false;
    let prunePreservedEverything = true;
    let prunelossReport = null;

    for (const refinement of refinements) {
      const { type, data: rawData, ...topLevel } = refinement;
      // Merge: handler code can use data.X — top-level fields (from suggestions) are also accessible.
      // backlog.fix.refine-noop-escalation-false-positive: this merge was DEAD CODE through MCP until
      // refineApplySchema stopped stripping unknown keys — zod deleted `topLevel` one frame earlier.
      const data = { ...topLevel, ...rawData };
      // Ledger watermark: every refinement handed in must leave a record. Captured per-iteration and
      // compared at the bottom of the loop, so records stay in INPUT ORDER with no pre-seeding —
      // tests/unit/refine-snippet-function-aware.test.mjs indexes `result.applied?.[0]` positionally.
      const appliedCountBefore = applied.length;

      if (type === "fix_duplicate_frontmatter") {
        // Detect and merge duplicate frontmatter blocks — shared helper, same test the
        // analyze-side detector uses, so the two cannot disagree.
        const { blocks, remaining } = extractFrontmatterBlocks(storyContent);
        if (blocks.length > 1) {
          // Merge all blocks — later blocks win on conflicts (caller's intent)
          const merged = Object.assign({}, ...blocks);
          frontmatter = yaml.dump(merged, { lineWidth: -1 }).trim();
          // Body is whatever remains after stripping all frontmatter blocks
          body = remaining.trim() ? "\n" + remaining.trim() : body;
          applied.push({ type, result: `merged ${blocks.length} frontmatter blocks into one` });
          historyLines.push(`- Merged ${blocks.length} duplicate frontmatter blocks`);
        } else {
          applied.push({ type, result: "no duplicate blocks found" });
        }
      }

      if (type === "add_target_files") {
        const files = data?.files || data?.suggestedFiles || [];
        if (files.length > 0) {
          // Parse frontmatter, normalize existing + new, merge, serialize back
          let fmObj;
          try { fmObj = yaml.load(frontmatter) || {}; } catch { fmObj = {}; }
          const existing = normalizeTargetFiles(fmObj.targetFiles);
          const incoming = normalizeTargetFiles(files);
          // Merge: deduplicate by path, incoming wins
          const byPath = new Map(existing.map(t => [t.path, t]));
          for (const t of incoming) byPath.set(t.path, t);
          fmObj.targetFiles = [...byPath.values()].map(t => {
            const obj = { path: t.path, op: t.action?.toLowerCase() || 'edit' };
            if (t.desc) obj.desc = t.desc;
            if (t.reason) obj.reason = t.reason;
            return obj;
          });
          frontmatter = yaml.dump(fmObj, { lineWidth: -1 }).trim();
          applied.push({ type: type, result: "added " + files.length + " target files" });
          historyLines.push("- Added targetFiles: " + incoming.map(t => t.path).join(", "));
        }
      }

      if (type === "add_code_snippet") {
        const snippetFile = data?.file;
        if (snippetFile) {
          // Skip if story body already has context for this file — unless it's a stale truncated snippet
          const targetHeader = "### Target: " + snippetFile;
          const snippetHeader = "### Code Snippet: " + snippetFile;
          const existingHeaderIdx = body.indexOf(targetHeader) !== -1 ? body.indexOf(targetHeader) : body.indexOf(snippetHeader);
          if (existingHeaderIdx !== -1) {
            // Check if the existing section is a stale head+tail injection
            const sectionText = body.slice(existingHeaderIdx);
            const nextSectionIdx = sectionText.indexOf("\n### ", 1);
            const sectionContent = nextSectionIdx !== -1 ? sectionText.slice(0, nextSectionIdx) : sectionText;
            if (!sectionContent.includes("lines omitted")) {
              applied.push({ type: type, result: "skipped (already present) " + snippetFile });
              continue;
            }
            // Stale truncated snippet — strip it and re-inject fresh
            const endIdx = nextSectionIdx !== -1 ? existingHeaderIdx + nextSectionIdx : body.length;
            body = body.slice(0, existingHeaderIdx).trimEnd() + body.slice(endIdx);
          }
          let snippet = null;
          let snippetNote = null;
          try {
            const fullPath = path.join(projectRoot, snippetFile);
            const fileContent = await fs.readFile(fullPath, "utf8");
            const allLines = fileContent.split("\n");
            const MAX_LINES = 120;
            if (allLines.length <= MAX_LINES) {
              snippet = fileContent;
            } else {
              // Try function-aware extraction: find function name from matching targetFiles desc
              let funcName = null;
              try {
                let fmObj;
                try { fmObj = yaml.load(frontmatter) || {}; } catch { fmObj = {}; }
                const targets = Array.isArray(fmObj.targetFiles) ? fmObj.targetFiles : [];
                const matchingTarget = targets.find(t => t.path === snippetFile || t.path === snippetFile.replace(/^\//, ""));
                if (matchingTarget?.desc) {
                  // Extract backtick-quoted identifier first (most precise)
                  const btMatch = matchingTarget.desc.match(/`([a-zA-Z_$][a-zA-Z0-9_$]*)`/);
                  if (btMatch) {
                    funcName = btMatch[1];
                  } else {
                    // Try "function/method/handler <name>"
                    const kwMatch = matchingTarget.desc.match(/\b(?:function|method|handler)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/i);
                    if (kwMatch) funcName = kwMatch[1];
                  }
                }
              } catch { /* ignore — fall through to head+tail */ }

              if (funcName) {
                const sliceResult = getSliceWithContext(fileContent, funcName, 5);
                if (sliceResult) {
                  snippet = `// Slice: function ${funcName} (lines ${sliceResult.startLine}–${sliceResult.endLine} of ${sliceResult.totalLines})\n` + sliceResult.text;
                  snippetNote = `function-aware slice for ${funcName}`;
                }
              }

              if (!snippet) {
                // Function body extraction: find declaration by name, extract full body via brace-depth counting
                try {
                  let fmObj2;
                  try { fmObj2 = yaml.load(frontmatter) || {}; } catch { fmObj2 = {}; }
                  const targets2 = Array.isArray(fmObj2.targetFiles) ? fmObj2.targetFiles : [];
                  const matchingTarget2 = targets2.find(t => t.path === snippetFile || t.path === snippetFile.replace(/^\//, ""));
                  const desc2 = matchingTarget2?.desc || "";
                  if (desc2) {
                    const candidates2 = new Set();
                    for (const m of desc2.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g)) candidates2.add(m[1]);
                    for (const m of desc2.matchAll(/\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g)) candidates2.add(m[1]);
                    const nameList = [...candidates2].filter(k => k.length > 3);
                    const declPatterns = (name) => [
                      new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
                      new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=`),
                      new RegExp(`^\\s*(?:export\\s+default\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
                      new RegExp(`^\\s*(?:export\\s+)?class\\s+${name}\\b`),
                    ];
                    let fbMatchLine = -1; let fbMatchName = "";
                    outer2: for (const name of nameList) {
                      const pats = declPatterns(name);
                      for (let i = 0; i < allLines.length; i++) {
                        if (pats.some(p => p.test(allLines[i]))) { fbMatchLine = i; fbMatchName = name; break outer2; }
                      }
                    }
                    if (fbMatchLine >= 0) {
                      let depth = 0; let started = false; let endLine = fbMatchLine;
                      for (let i = fbMatchLine; i < allLines.length; i++) {
                        for (const ch of allLines[i]) {
                          if (ch === "{") { depth++; started = true; } else if (ch === "}") { depth--; }
                        }
                        if (started && depth === 0) { endLine = i; break; }
                      }
                      if (started) {
                        snippet = `// Context: function body for "${fbMatchName}" (lines ${fbMatchLine + 1}–${endLine + 1} of ${allLines.length})\n` + allLines.slice(fbMatchLine, endLine + 1).join("\n");
                        snippetNote = `function body for "${fbMatchName}" (lines ${fbMatchLine + 1}–${endLine + 1})`;
                      }
                    }
                  }
                } catch { /* fall through to keyword injection */ }
              }

              if (!snippet) {
                // Keyword-based context injection: extract candidate keywords from desc,
                // find first line in file containing any keyword, inject surrounding context.
                try {
                  let fmObj;
                  try { fmObj = yaml.load(frontmatter) || {}; } catch { fmObj = {}; }
                  const targets = Array.isArray(fmObj.targetFiles) ? fmObj.targetFiles : [];
                  const matchingTarget = targets.find(t => t.path === snippetFile || t.path === snippetFile.replace(/^\//, ""));
                  const desc = matchingTarget?.desc || "";
                  if (desc) {
                    // Extract backtick-quoted identifiers and camelCase words from desc
                    const candidates = new Set();
                    for (const m of desc.matchAll(/`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g)) candidates.add(m[1]);
                    for (const m of desc.matchAll(/\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g)) candidates.add(m[1]);
                    const keywordList = [...candidates].filter(k => k.length > 3);
                    if (keywordList.length > 0) {
                      let matchLine = -1;
                      let matchKeyword = "";
                      for (let i = 0; i < allLines.length; i++) {
                        if (allLines[i].trimStart().startsWith("import ")) continue;
                        for (const kw of keywordList) {
                          if (allLines[i].includes(kw)) { matchLine = i; matchKeyword = kw; break; }
                        }
                        if (matchLine >= 0) break;
                      }
                      if (matchLine >= 0) {
                        const CONTEXT = 15;
                        const start = Math.max(0, matchLine - CONTEXT);
                        const end = Math.min(allLines.length - 1, matchLine + CONTEXT);
                        snippet = `// Context: keyword match for "${matchKeyword}" (lines ${start + 1}–${end + 1} of ${allLines.length})\n` + allLines.slice(start, end + 1).join("\n");
                        snippetNote = `keyword-match context for "${matchKeyword}" (lines ${start + 1}–${end + 1})`;
                      }
                    }
                  }
                } catch { /* ignore — fall through to head+tail */ }
              }

              if (!snippet) {
                // Fall back: first 80 lines (imports, structure) + last 30 lines (exports, module boundary)
                const head = allLines.slice(0, 80).join("\n");
                const tail = allLines.slice(-30).join("\n");
                snippet = head + "\n\n// ... (" + (allLines.length - 110) + " lines omitted) ...\n\n" + tail;
              }
            }
          } catch (e) {
            snippet = "// Could not read " + snippetFile;
          }
          if (snippet) {
            // A NO-OP MUST NEVER REPORT SUCCESS — and neither must a write that will not survive.
            //
            // If the body is already over the cap, the prune below is GUARANTEED to strip a
            // `### Target:` section before the note is written (bodyThreshold is always strictly
            // below the byte count the gate measures). Injecting here would push an `applied[]`
            // entry claiming an injection that disk will not hold, and — because the suggester's
            // convergence signal is that same section — guarantee the suggestion re-fires next
            // round. Deliver the snippet out of band instead and say so.
            // backlog.fix.refine-projective-headroom-guard: the test is PROJECTIVE.
            //
            // It used to compare the PRE-injection body against the cap, which left
            // a note that fits today but not after the injection passing the guard:
            // the section was written, the prune below stripped it before the write,
            // and the ledger entry was labelled NOT DURABLE. Observed on a 7,448-byte
            // body with 744 bytes of headroom. The headroom test omitted the size of
            // what it was about to add.
            //
            // The framing term is built from the SAME string the writer below
            // interpolates — sectionFor("") is exactly the non-payload cost — so it
            // cannot drift from an estimate. The payload term is the extracted
            // `snippet`, never the file on disk: the extractor bounds large targets
            // near 110 lines, so a whole-file measurement would over-estimate by an
            // order of magnitude in the direction that arms the guard.
            //
            // All three terms use String.prototype.length, matching the existing
            // `body.length` operand this replaces. Comparison stays strictly-greater
            // so the boundary is unchanged.
            const projectedBodyLength = body.length + targetSectionFor(snippetFile, "").length + snippet.length;

            if (projectedBodyLength > MAX_NOTE_BODY_BYTES) {
              outOfBandContextItems.push({ file: snippetFile, content: snippet });
              const marker = outOfBandMarkerFor(snippetFile);
              if (!body.includes(marker)) body = body.trim() + "\n\n" + marker + "\n";
              const oobMsg =
                "delivered code context for " + snippetFile +
                " out of band (note body would exceed the " + MAX_NOTE_BODY_BYTES +
                "-byte cap once the section is added; an injected section would not survive the prune)";
              applied.push({ type: type, result: oobMsg, outOfBand: true, file: snippetFile });
              historyLines.push("- Delivered code context for " + snippetFile + " out of band (note over size cap)");
            } else {
              body = body.trim() + targetSectionFor(snippetFile, snippet);
              const resultMsg = snippetNote ? "injected " + snippetNote + " from " + snippetFile : "injected code context from " + snippetFile;
              applied.push({ type: type, result: resultMsg, injectedHeader: "### Target: " + snippetFile });
              historyLines.push("- " + resultMsg.charAt(0).toUpperCase() + resultMsg.slice(1));
            }
          }
        }
      }

      if (type === "add_test_exemplar") {
        const editTargetDirs = data?.editTargetDirs || [];
        // backlog.fix.build-governor-self-heal: the dedup moved DOWN, to where the section that would
        // be written is actually known.
        //
        // It used to sit here as `body.includes("### Test Exemplar:")` — a bare header check, so ANY
        // prior exemplar suppressed EVERY future injection forever, and the caller was told "skipped
        // (already present)" while being handed `ok: true` and "now go re-plan". That is the loop.
        //
        // It cannot be answered here: the header this handler writes names the exemplar it COPIES
        // FROM (`### Test Exemplar: <chosen exemplar>`), not the target file — so the correct
        // question ("would this change anything?") is only answerable once `best` is chosen, below.
        // Its two siblings in this file already work this way: add_code_snippet re-injects when the
        // existing section is a stub, add_search_pattern filters to genuinely-new anchors. This was
        // the lone presence-based outlier.
        // Find a similar existing test file — prefer one testing code in the same directory
        let exemplar = null;
        try {
          // Search broadly across common test extensions (.mjs, .ts, .tsx, .js)
          const allTestFiles = await Promise.all([
            glob("tests/unit/*.test.mjs", { cwd: projectRoot }),
            glob("tests/unit/*.test.ts", { cwd: projectRoot }),
            glob("tests/unit/*.test.tsx", { cwd: projectRoot }),
            glob("tests/unit/*.test.js", { cwd: projectRoot }),
            glob("src/**/*.test.ts", { cwd: projectRoot }),
            glob("src/**/*.spec.ts", { cwd: projectRoot }),
          ]);
          const testFiles = [...new Set(allTestFiles.flat())];
          if (testFiles.length > 0) {
            // Score each test: prefer tests whose name overlaps with edit target dirs
            let best = testFiles[0];
            let bestScore = 0;
            for (const tf of testFiles) {
              let score = 0;
              const tfLower = tf.toLowerCase();
              for (const dir of editTargetDirs) {
                // Extract meaningful segments from dir (e.g., "server" from "packages/mcp-rks/src/server")
                const segments = dir.split("/").filter(s => s && s !== "src" && s !== "packages");
                for (const seg of segments) {
                  if (tfLower.includes(seg.toLowerCase())) score += 2;
                }
              }
              // Prefer medium-sized files (not too big, not too small)
              try {
                const stat = await fs.stat(path.join(projectRoot, tf));
                if (stat.size > 500 && stat.size < 8000) score += 1;
              } catch { /* skip */ }
              if (score > bestScore) { bestScore = score; best = tf; }
            }
            // backlog.fix.build-governor-self-heal: EFFECT-AWARE dedup. `best` is the exemplar we are
            // about to copy from, and it is what the section header names — so THIS is the only place
            // the question "would writing it change anything?" can honestly be answered. If that exact
            // section is already in the body, injecting it is a genuine no-op, and the caller is told
            // so (and, crucially, is NOT told to go re-plan an unchanged story).
            if (body.includes("### Test Exemplar: " + best)) {
              applied.push({ type, result: `skipped (exemplar from ${best} already present)` });
              continue;
            }
            const content = await fs.readFile(path.join(projectRoot, best), "utf8");
            const lines = content.split("\n");
            const MAX_EXEMPLAR_LINES = 80;
            exemplar = lines.length <= MAX_EXEMPLAR_LINES
              ? content
              : lines.slice(0, MAX_EXEMPLAR_LINES).join("\n") + "\n// ... (" + (lines.length - MAX_EXEMPLAR_LINES) + " lines truncated)";
            const ext = path.extname(best).slice(1) || "javascript";
            const langMap = { mjs: "javascript", js: "javascript", ts: "typescript", tsx: "tsx" };
            const lang = langMap[ext] || ext;
            body = body.trim() + "\n\n### Test Exemplar: " + best + "\n\nUse this existing test as a pattern for imports, describe/it structure, and assertion syntax:\n\n" + FENCE + lang + "\n" + exemplar + "\n" + FENCE + "\n";
            applied.push({ type, result: "injected test exemplar from " + best });
            historyLines.push("- Injected test exemplar from " + best);
          } else {
            // No existing test files — inject a minimal framework-specific fallback template
            let framework = "vitest";
            try {
              const pkgJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
              const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
              if (allDeps["jest"] || allDeps["@jest/globals"]) framework = "jest";
              else if (allDeps["vitest"]) framework = "vitest";
            } catch { /* default to vitest */ }

            const fallbackTemplates = {
              vitest: `import { describe, it, expect } from 'vitest';

describe('TODO: replace with subject under test', () => {
  it('TODO: replace with test description', () => {
    // Arrange
    const input = undefined; // TODO: set up test input

    // Act
    const result = input; // TODO: call the function under test

    // Assert
    expect(result).toBeDefined(); // TODO: replace with real assertion
  });
});`,
              jest: `const { describe, it, expect } = require('@jest/globals');

describe('TODO: replace with subject under test', () => {
  it('TODO: replace with test description', () => {
    // Arrange
    const input = undefined; // TODO: set up test input

    // Act
    const result = input; // TODO: call the function under test

    // Assert
    expect(result).toBeDefined(); // TODO: replace with real assertion
  });
});`,
            };
            const template = fallbackTemplates[framework] || fallbackTemplates.vitest;
            const lang = framework === "jest" ? "javascript" : "typescript";
            body = body.trim() + "\n\n### Test Exemplar: (framework fallback — " + framework + ")\n\nUse this as a pattern for imports, describe/it structure, and assertion syntax:\n\n" + FENCE + lang + "\n" + template + "\n" + FENCE + "\n";
            applied.push({ type, result: "injected framework fallback template (" + framework + ")" });
            historyLines.push("- Injected framework fallback template (" + framework + ")");
          }
        } catch (e) {
          applied.push({ type, result: "exemplar search failed: " + e.message });
        }
      }

      if (type === "add_search_pattern") {
        const targetFile = data?.file;
        if (!targetFile) {
          applied.push({ type, result: "skipped — no file specified", inapplicable: true, cause: "absent_payload" });
          continue;
        }

        // Find the ### Target: <file> section in the body
        const sectionHeader = "### Target: " + targetFile;
        const sectionStart = body.indexOf(sectionHeader);
        if (sectionStart === -1) {
          applied.push({ type, result: "skipped — no ### Target: section found for " + targetFile, manual: true, hint: "Add a ### Target: " + targetFile + " section with the file content first" });
          continue;
        }

        // Extract code content from the fenced block within this section
        const sectionText = body.slice(sectionStart);
        const fenceMatch = sectionText.match(/```[\w]*\n([\s\S]*?)```/);
        if (!fenceMatch) {
          applied.push({ type, result: "skipped — no code fence found in ### Target: section for " + targetFile, manual: true, hint: "The snippet content appears to be missing or malformed" });
          continue;
        }

        const codeContent = fenceMatch[1];
        // Use caller-provided anchors verbatim when supplied — they may contain JSX markers,
        // comment anchors, or other insertion-point patterns that extractAnchorPatterns()
        // cannot detect (it only matches function/class/export signatures).
        const anchors = (Array.isArray(data?.anchors) && data.anchors.length > 0)
          ? data.anchors
          : extractAnchorPatterns(codeContent);

        if (anchors.length === 0) {
          // Fallback: read the actual file from disk and scan for the first export declaration
          let fallbackAnchor = null;
          try {
            const fullSource = await fs.readFile(path.join(projectRoot, targetFile), "utf8");
            const exportPatterns = [
              /^export\s+async\s+function\s+\w+/,
              /^export\s+function\s+\w+/,
              /^export\s+class\s+\w+/,
              /^export\s+const\s+\w+/,
              /^export\s+default\s+/,
            ];
            for (const line of fullSource.split("\n")) {
              const trimmed = line.trim();
              if (trimmed && exportPatterns.some(p => p.test(trimmed))) {
                fallbackAnchor = trimmed;
                break;
              }
            }
          } catch { /* file read error — fall through to manual:true */ }

          if (!fallbackAnchor) {
            applied.push({ type, result: "no extractable anchors found in " + targetFile, manual: true, hint: "Add SEARCH patterns manually — look for function signatures, export statements, or class declarations near the target edit location" });
            historyLines.push("- add_search_pattern: no anchors found in " + targetFile + " snippet or file — manual review needed");
            continue;
          }

          if (body.includes(`@@SEARCH\n${fallbackAnchor}\n`)) {
            applied.push({ type, result: "skipped — fallback anchor already present for " + targetFile, anchors: [fallbackAnchor] });
            continue;
          }
          const fallbackBlock = "\n\n### " + targetFile + "\n\n@@SEARCH\n" + fallbackAnchor + "\n@@REPLACE\n" + fallbackAnchor + "\n@@END";
          const fenceEndOffsetFallback = sectionStart + fenceMatch.index + fenceMatch[0].length;
          body = body.slice(0, fenceEndOffsetFallback) + fallbackBlock + body.slice(fenceEndOffsetFallback);
          applied.push({ type, result: "injected 1 fallback SEARCH anchor for " + targetFile + " (read from disk)", anchors: [fallbackAnchor] });
          historyLines.push("- Injected fallback anchor for " + targetFile + " (from disk read): " + fallbackAnchor);
          continue;
        }

        // Inject complete @@SEARCH/@@REPLACE/@@END blocks — one per anchor.
        // Skip anchors that already have a @@SEARCH block in the body to prevent duplication.
        const newAnchors = anchors.filter(anchor => !body.includes(`@@SEARCH\n${anchor}\n`));
        if (newAnchors.length === 0) {
          applied.push({ type, result: "skipped — all " + anchors.length + " anchor(s) already present in " + targetFile });
          continue;
        }
        const searchBlocksText = "\n\n" + newAnchors.map(anchor =>
          `### ${targetFile}\n\n@@SEARCH\n${anchor}\n@@REPLACE\n${anchor}\n@@END`
        ).join("\n\n");
        const fenceEndOffset = sectionStart + fenceMatch.index + fenceMatch[0].length;
        body = body.slice(0, fenceEndOffset) + searchBlocksText + body.slice(fenceEndOffset);

        const skippedCount = anchors.length - newAnchors.length;
        const skippedNote = skippedCount > 0 ? ` (${skippedCount} skipped — already present)` : "";
        applied.push({ type, result: "injected " + newAnchors.length + " SEARCH anchor patterns for " + targetFile + skippedNote, anchors: newAnchors });
        historyLines.push("- Injected " + newAnchors.length + " SEARCH anchors for " + targetFile + ": " + newAnchors.slice(0, 2).join(", "));
      }

      if (type === "clarify_ac") {
        const criteria = data?.criteria;
        if (criteria && Array.isArray(criteria)) {
          const newCriteria = criteria.map(function(c) { return "- [ ] " + c; }).join("\n");
          body = body.trim() + "\n" + newCriteria + "\n";
          applied.push({ type: type, result: "added " + criteria.length + " acceptance criteria" });
          historyLines.push("- Added " + criteria.length + " acceptance criteria");
        }
      }

      if (type === "create_file_directive") {
        const filePath = data?.file;
        if (!filePath) continue;
        // Frontmatter op:edit wins — don't inject a CREATE FILE directive for an edit target
        // (it would re-stamp op:edit→op:create downstream; see uat-calc-0629-2).
        if (isFrontmatterEditTarget(frontmatter, filePath)) {
          applied.push({ type, result: "skipped — " + filePath + " is op:edit (frontmatter op wins)" });
          continue;
        }
        if (body.includes("// CREATE FILE: " + filePath)) {
          applied.push({ type, result: "directive already present for " + filePath });
          continue;
        }
        const directive = "// CREATE FILE: " + filePath;
        if (body.includes("## Files to Create")) {
          body = body.replace(/(## Files to Create\n+)/, "$1" + directive + "\n");
        } else {
          const insertPoint = body.indexOf("## Code Changes");
          if (insertPoint > 0) {
            body = body.slice(0, insertPoint) + "## Files to Create\n\n" + directive + "\n\n" + body.slice(insertPoint);
          } else {
            body = body.trim() + "\n\n## Files to Create\n\n" + directive + "\n";
          }
        }
        applied.push({ type, result: "injected CREATE FILE directive for " + filePath });
        historyLines.push("- Injected CREATE FILE directive: " + filePath);
      }

      if (type === "acknowledge_multi_file") {
        try {
          const fmObj = yaml.load(frontmatter) || {};
          fmObj.multiFileAcknowledged = true;
          frontmatter = yaml.dump(fmObj, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
          applied.push({ type, result: "set multiFileAcknowledged: true in frontmatter" });
          historyLines.push("- Acknowledged multi-file story (multiFileAcknowledged: true)");
        } catch { applied.push({ type, result: "failed to parse frontmatter" }); }
      }

      if (type === "acknowledge_destructive_rewrite") {
        // Authorize specific target paths for a full-file rewrite so checkDestructiveEdit
        // permits a >100-line edit_file on them (mirrors acknowledge_multi_file). Per-target,
        // never plan-wide: use the refinement's explicit `files` list, else all op:edit targets.
        try {
          const fmObj = yaml.load(frontmatter) || {};
          let files = Array.isArray(data?.files) ? data.files.filter((f) => typeof f === "string") : [];
          if (files.length === 0) {
            const tfs = Array.isArray(fmObj.targetFiles) ? fmObj.targetFiles : [];
            files = tfs
              .filter((tf) => tf && typeof tf === "object" && (tf.op === "edit" || tf.action === "EDIT"))
              .map((tf) => tf.path)
              .filter((p) => typeof p === "string");
          }
          const existing = Array.isArray(fmObj.destructiveRewriteFiles) ? fmObj.destructiveRewriteFiles : [];
          fmObj.destructiveRewriteFiles = [...new Set([...existing, ...files])];
          frontmatter = yaml.dump(fmObj, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
          applied.push({ type, result: `authorized destructive rewrite for ${fmObj.destructiveRewriteFiles.length} file(s)` });
          historyLines.push(`- Authorized destructive rewrite (destructiveRewriteFiles: ${fmObj.destructiveRewriteFiles.join(", ")})`);
        } catch { applied.push({ type, result: "failed to parse frontmatter" }); }
      }

      if (type === "fix_target_files") {
        // Frontmatter op:edit wins — never inject CREATE FILE directives for edit targets.
        const missingFiles = (data?.missingFiles || []).filter(f => !isFrontmatterEditTarget(frontmatter, f));
        if (missingFiles.length > 0) {
          // Add CREATE FILE directives for each missing file
          const directives = missingFiles.map(f => "// CREATE FILE: " + f).join("\n");
          // Check if section already exists
          if (body.includes("## Files to Create")) {
            // Append to existing section
            body = body.replace(/(## Files to Create\n+)/, "$1" + directives + "\n");
          } else {
            // Add new section before Code Changes or at end
            const insertPoint = body.indexOf("## Code Changes");
            if (insertPoint > 0) {
              body = body.slice(0, insertPoint) + "## Files to Create\n\n" + directives + "\n\n" + body.slice(insertPoint);
            } else {
              body = body.trim() + "\n\n## Files to Create\n\n" + directives + "\n";
            }
          }
          applied.push({ type: type, result: "added CREATE FILE directives for " + missingFiles.length + " files" });
          historyLines.push("- Added CREATE FILE directives: " + missingFiles.join(", "));
        }
      }

      if (type === "decompose") {
        // Parse acceptance criteria from body
        const acPattern = /- \[[ x]\] .+/g;
        const allACs = body.match(acPattern) || [];
        const maxPerChild = data?.maxAcPerChild || 4;

        if (allACs.length <= maxPerChild) {
          applied.push({ type, result: "no decomposition needed — AC count within threshold" });
          continue;
        }

        // Split ACs into balanced groups
        const numChildren = Math.ceil(allACs.length / maxPerChild);
        const baseSize = Math.floor(allACs.length / numChildren);
        const remainder = allACs.length % numChildren;

        const chunks = [];
        let idx = 0;
        for (let i = 0; i < numChildren; i++) {
          const size = baseSize + (i < remainder ? 1 : 0);
          chunks.push(allACs.slice(idx, idx + size));
          idx += size;
        }

        // Independent-value gate: reject any child explicitly marked as contingent on a sibling.
        // Callers set children[i].independentValue = false when the child only has value because
        // another child will finish it. The gate surfaces feedback rather than silently skipping.
        if (Array.isArray(data?.children)) {
          const failing = [];
          for (let i = 0; i < chunks.length; i++) {
            const childDef = data.children[i];
            if (childDef && childDef.independentValue === false) {
              const slug = isValidKebabSlug(childDef.slug) ? childDef.slug : `child-${i + 1}`;
              failing.push({ index: i + 1, slug });
            }
          }
          if (failing.length > 0) {
            const slugList = failing.map(f => f.slug).join(", ");
            return {
              ok: false,
              error: "independent_value_gate",
              message: `Decomposition rejected: ${slugList} ${failing.length === 1 ? 'is' : 'are'} only valuable contingent on a sibling completing. ` +
                `Each child must independently deliver verifiable value. ` +
                `Re-scope so every child passes: "if this shipped alone, would anything be verifiably better?"`,
              failingChildren: failing,
            };
          }
        }

        // Read parent frontmatter for inheritance
        const parentFm = yaml.load(frontmatter) || {};
        const parentTitle = parentFm.title || problemId;
        const parentType = parentFm.type || "feat";
        const parentTargetFiles = parentFm.targetFiles || [];

        const childIds = [];
        const childSummaries = [];
        const notesDir = path.join(projectRoot, "notes");
        const usedSlugs = new Set();

        // F5: compute honest orphanedTests — parent testRequirements that no child's
        // scope covers. Coverage = deterministic case-insensitive token overlap between
        // a requirement and the union of all children's vocabularies (targetFile basenames
        // with + without extension + child-title words, minus generic stopwords). The
        // dangerous direction is false-clean, so coverage requires a positive token hit.
        const ORPHAN_STOPWORDS = new Set(["the", "a", "of", "and", "child", "story", "part", "parent", "test", "tests"]);
        const childCoverageVocab = new Set();
        const addChildVocab = (targetFiles, title) => {
          for (const t of (targetFiles || [])) {
            const base = path.basename(t.path || "").toLowerCase();
            if (!base) continue;
            childCoverageVocab.add(base);                       // with extension, e.g. refine.mjs
            const noExt = base.replace(/\.[^.]+$/, "");
            if (noExt) childCoverageVocab.add(noExt);           // without extension, e.g. refine
          }
          for (const w of String(title || "").toLowerCase().split(/[^a-z0-9]+/)) {
            if (w && !ORPHAN_STOPWORDS.has(w)) childCoverageVocab.add(w);
          }
        };

        for (let i = 0; i < chunks.length; i++) {
          const childNum = i + 1;
          // Use LLM-provided semantic slug when valid kebab-case; fall back to child-N.
          // Callers pass slugs via: data.children[i].slug (e.g. "form-shell", "sqlite-write").
          const providedSlug = data?.children?.[i]?.slug;
          const derivedSlug = isValidKebabSlug(providedSlug) ? null : deriveSlugFromACs(chunks[i]);
          let childSuffix = isValidKebabSlug(providedSlug)
            ? providedSlug
            : (isValidKebabSlug(derivedSlug) ? derivedSlug : "child-" + childNum);
          // Detect and resolve slug collisions: if the derived slug was already used, fall back to child-N
          if (usedSlugs.has(childSuffix)) {
            childSuffix = "child-" + childNum;
          }
          usedSlugs.add(childSuffix);
          const childId = problemId + "." + childSuffix;
          // semanticLabel drives the title — use the actual (possibly collision-corrected) childSuffix
          const semanticLabel = childSuffix.startsWith("child-") ? null : childSuffix;
          const childTitle = semanticLabel
            ? parentTitle + " — " + semanticLabel.replace(/-/g, " ")
            : parentTitle + " (Part " + childNum + "/" + numChildren + ")";
          const childACs = chunks[i].map(function(ac) { return ac.replace(/- \[x\] /, "- [ ] "); }).join("\n");

          const childFmData = {
            id: childId,
            title: childTitle,
            desc: "Child story " + childNum + " of " + numChildren + " decomposed from " + problemId,
            type: parentType,
            parent: problemId,
            phase: "draft",
            created: Date.now(),
            updated: Date.now(),
          };

          if (parentTargetFiles.length > 0) {
            // Override op:create → op:edit for targets that already exist on disk
            const resolvedParentFiles = parentTargetFiles.map(t => {
              if (t.op === 'create' && fsSync.existsSync(path.join(projectRoot, t.path))) {
                return { ...t, op: 'edit' };
              }
              return t;
            });

            if (numChildren === 1 || resolvedParentFiles.length <= 1) {
              // Single child or single file: pass all files through unchanged
              childFmData.targetFiles = resolvedParentFiles;
            } else {
              // Split files across children: test-pattern files → last child, impl → earlier children
              const isTestPattern = f => /\.test\.|\.spec\.|\/tests\/|\/test\//.test(f.path);
              const implFiles = resolvedParentFiles.filter(f => !isTestPattern(f));
              const testFiles = resolvedParentFiles.filter(f => isTestPattern(f));

              if (implFiles.length > 0 && testFiles.length > 0) {
                // Mixed: impl to earlier children (round-robin), test to last child
                if (i === numChildren - 1) {
                  childFmData.targetFiles = testFiles;
                } else {
                  // Distribute impl files round-robin across non-last children
                  const implChildCount = numChildren - 1;
                  childFmData.targetFiles = implFiles.filter((_, idx) => idx % implChildCount === i);
                  if (childFmData.targetFiles.length === 0) {
                    childFmData.targetFiles = implFiles.slice(i, i + 1);
                  }
                }
              } else {
                // All same type: round-robin distribution
                childFmData.targetFiles = resolvedParentFiles.filter((_, idx) => idx % numChildren === i);
                if (childFmData.targetFiles.length === 0) {
                  childFmData.targetFiles = resolvedParentFiles.slice(i, i + 1);
                }
              }
            }
          }

          addChildVocab(childFmData.targetFiles, childTitle);

          const childBody = "## Acceptance Criteria\n\n" + childACs + "\n";
          const childContent = formatWithFrontmatter(childFmData, childBody);
          const childPath = path.join(notesDir, childId + ".md");
          await fs.writeFile(childPath, childContent, "utf8");

            childIds.push(childId);
              childSummaries.push({ id: childId, title: childTitle, acCount: chunks[i].length });
            }

            // Auto-commit all child notes after loop completes
            await autoCommitChildNotes(projectRoot, notesDir, childIds, problemId);

            // Update parent frontmatter with childStories and phase
            parentFm.childStories = childIds;
        parentFm.decomposed = true;
        parentFm.phase = "decomposed";
        parentFm.updated = Date.now();
        frontmatter = yaml.dump(parentFm, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();

        // Write parent and return early
        const decomposedContent = "---\n" + frontmatter.trim() + "\n---\n" + body;
        await fs.writeFile(storyPath, decomposedContent, "utf8");

        // Emit telemetry
        try {
          const collector = getTelemetryCollector();
          collector.emit("refine.decompose", projectId, {
            problemId,
            childCount: numChildren,
            totalACs: allACs.length,
            maxPerChild,
          });
        } catch (e) { /* telemetry is best-effort */ }

        // F5: a parent testRequirement is orphaned when none of its (non-stopword)
        // tokens appear in any child's coverage vocabulary. Requirements with only
        // stopword tokens are treated as covered (not reported).
        const orphanedTests = coerceTestRequirements(parentFm.testRequirements).filter((req) => {
          const reqToks = String(req || "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w && !ORPHAN_STOPWORDS.has(w));
          return reqToks.length > 0 && !reqToks.some((t) => childCoverageVocab.has(t));
        });

        return {
          ok: true,
          decomposed: true,
          problemId: problemId,
          children: childSummaries,
          orphanedTests,
          applied: [{ type: "decompose", result: "decomposed into " + numChildren + " child stories" }],
        };
      }

      // ── backlog.fix.refine-noop-escalation-false-positive: NO SILENT DROPS ──
      //
      // Every `data?.file` / `data?.files` handler above guards on a resolvable path with no `else`.
      // A refinement whose payload did not survive — or that names no file at all — used to fall out
      // of this loop having pushed NOTHING. `applied` stayed empty, the `skipped` filter below
      // filtered an empty array to an empty array, and the caller was told three refinements did
      // nothing with zero reason given for any of them. That empty ledger is what made a false
      // `refine_noop` indistinguishable from a real one.
      //
      // Fixed as a class rather than per-handler: if an iteration recorded nothing, record why.
      // DEFERRED_TYPES are handled by the dedicated single-type loops further down, which write
      // their own records — recording them here too would double-count them.
      const DEFERRED_TYPES = new Set(["fix_numeric_assertion", "fix_test_assertion", "disk_fetch_context"]);
      if (applied.length === appliedCountBefore && !DEFERRED_TYPES.has(type)) {
        const namesAFile = data?.file !== undefined || data?.files !== undefined
          || data?.suggestedFiles !== undefined;

        // backlog.fix.refine-inapplicable-status: arms 1 and 3 are OBSERVATIONS —
        // the type is not in the vocabulary, or no payload field was supplied at
        // all. Arm 2 is NOT. `namesAFile` tests only that a field was PRESENT; it
        // never observes that the file was empty or unresolvable. A handler that
        // ran against a real file and correctly wrote nothing lands here, and
        // stamping it would assert a quantity nobody measured — R1 of
        // notes/design.evidence-bound-reporting-invariant.md, the defect this
        // status exists to remove. So arm 2 declines without a marker.
        let reason;
        let cause = null;
        if (!REFINEMENT_TYPES.includes(type)) {
          reason = `skipped — unrecognized refinement type "${type}"`;
          cause = "unrecognized_type";
        } else if (namesAFile) {
          reason = "skipped — payload named no usable file (empty or unresolvable)";
        } else {
          reason = "skipped — refinement carried no payload; suggestion fields (file/files) were absent";
          cause = "absent_payload";
        }
        applied.push(cause ? { type, result: reason, inapplicable: true, cause } : { type, result: reason });
      }
    }

    // ── backlog.fix.build-governor-self-heal: DID THE REFINEMENTS ACTUALLY CHANGE ANYTHING? ──
    //
    // THE BUG THIS EXISTS TO KILL: this function used to return `ok: true` AND `requiredNext:
    // rks_plan` after changing NOTHING. It told the Build Governor "success — now go re-plan", the
    // Governor obediently re-planned a BYTE-IDENTICAL story, got the identical failure, refined
    // again, was told "success" again… forever. The retry could never converge, because the feedback
    // never changed the input. A greenfield UAT only completed because a human stepped in.
    //
    // A no-op that reports success is the defect. The dedup was merely how it got there. This is the
    // third instance of this exact class in this project (v0.27.0: the planner named nothing it had
    // dropped; v0.27.1: the task-mode guard never fired), so it is fixed as a class: if we changed
    // nothing, we SAY SO, loudly and machine-readably, and we do NOT tell anyone to re-plan.
    //
    // FOUR CLAUSES, and all four are load-bearing in BOTH directions — a false escalation breaks
    // successful applies just as badly as a missed one leaves the loop spinning:
    //   1. zero body delta
    //   2. zero refinement-driven frontmatter delta
    //   3. zero outOfBandContext        — `disk_fetch_context` deliberately does not touch the note
    //                                     ("Story note body is NOT modified"), yet it really did work
    //   4. no disk-side effect          — `fix_numeric_assertion` patches the TEST FILE on disk and
    //                                     leaves the note alone. Real effect, zero note delta.
    // Without (3) and (4), a note-delta-only detector would escalate on a SUCCESSFUL apply.
    // Clauses 1 and 2, captured HERE — this is the only point where `body`/`frontmatter` still hold
    // exactly what the refinements did and nothing else. Everything below rewrites them for its own
    // reasons. The verdict is USED further down, once clauses 3 and 4 exist.
    const DISK_EFFECT_TYPES = new Set(["fix_numeric_assertion"]);
    const hadDiskSideEffect = applied.some(
      (a) => DISK_EFFECT_TYPES.has(a?.type) && !String(a?.result || "").startsWith("skipped"),
    );
    // TWO KINDS OF "NOTHING HAPPENED" ARE NOT NO-OPS, and conflating them is the over-detection
    // direction — a false escalation kills a healthy build exactly as surely as a missed one loops:
    //
    //   - `manual: true` is a real, actionable outcome: "I cannot do this automatically, a human must
    //     add the pattern." The Build Governor already has a dedicated recovery branch for it.
    //
    //   - a `decompose` that declines is a DECISION, not a failed mutation: "this story is small
    //     enough, no decomposition needed." The story is unchanged because it did not need changing,
    //     and re-planning after it is exactly right.
    //
    // Neither is a story that cannot converge. Only a refinement that MEANT to change the story and
    // failed to is.
    const hadManualRequest = applied.some((a) => a?.manual === true);
    const hadDecision = applied.some((a) => a?.type === "decompose");
    const refinementsChangedNote =
      body !== bodyBeforeRefinements || frontmatter !== frontmatterBeforeRefinements;

    // ── backlog.fix.refine-prune-destroys-authored-create-blocks: AC4 ─────────────────────────
    //
    // SNAPSHOTTED HERE, NOT AT THE GATE. This is the whole fix, and the position is the fix.
    //
    // Between :1283 (where bodyBeforeRefinements is taken) and this line, every write to `body`
    // is a refinement handler. Immediately BELOW this line the history append rewrites `body`
    // unconditionally whenever any handler pushed a history line — and acknowledge_multi_file,
    // whose handler touches frontmatter ONLY, pushes one. So the same comparison evaluated at
    // the cap gate is TRUE for a refinement that changed no body content, the gate opens, and
    // the prune destroys authored create blocks. That is the 384-line field instance.
    //
    // MUST NOT reuse refinementsChangedNote above: it is body-OR-frontmatter, so it is true for
    // that same case. This is the body half alone, read before the bookkeeping append.
    const bodyDirty = body !== bodyBeforeRefinements;

    if (historyLines.length > 0) {
      const newHistoryLines = historyLines.filter(line => !body.includes(line));
      if (newHistoryLines.length > 0) {
        const timestamp = new Date().toISOString().split("T")[0];
        body = body.trim() + "\n\n## Refinement History (" + timestamp + ")\n" + newHistoryLines.join("\n") + "\n";
      }
    }

    // Auto-upgrade legacy targetFiles format to structured
    try {
      const fmParsed = yaml.load(frontmatter);
      if (Array.isArray(fmParsed?.targetFiles) && fmParsed.targetFiles.length > 0 && typeof fmParsed.targetFiles[0] === 'string') {
        // Parse CREATE FILE directives from body to determine op (multiple formats)
        const createPattern = /\/\/\s*CREATE\s+FILE[:\s]*(\S+)/gi;
        const headerPattern = /^###\s+([^\s(]+)\s*\((?:CREATE\s+FILE|new\s+file)\)/gim;
        const bulletPattern = /^-\s+`([^`]+)`\s*—\s*CREATE\s+FILE/gim;
        const createSet = new Set();
        let cm;
        while ((cm = createPattern.exec(body)) !== null) createSet.add(cm[1].trim());
        while ((cm = headerPattern.exec(body)) !== null) createSet.add(cm[1].trim());
        while ((cm = bulletPattern.exec(body)) !== null) createSet.add(cm[1].trim());

        fmParsed.targetFiles = fmParsed.targetFiles.map(f => {
          const cleanPath = (f.startsWith('"') && f.endsWith('"')) ? f.slice(1, -1) : f;
          return {
            path: cleanPath,
            op: createSet.has(cleanPath) ? 'create' : 'edit',
            desc: `${createSet.has(cleanPath) ? 'Create' : 'Modify'} ${path.basename(cleanPath)}`,
          };
        });
        frontmatter = yaml.dump(fmParsed, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
      }
    } catch { /* preserve original frontmatter if upgrade fails */ }

    // Handle fix_numeric_assertion: directly patch the test file's count assertion.
    // This is a concrete file-level fix (not a story note injection) — the assertion
    // integer is updated in-place so the next exec run passes without re-planning.
    for (const refinement of refinements) {
      const { type, data: rawData, ...topLevel } = refinement;
      if (type !== "fix_numeric_assertion") continue;
      const data = { ...topLevel, ...rawData };
      const testFile = data?.file;
      const expected = data?.expected;
      const received = data?.received;
      if (!testFile || expected === undefined || received === undefined) {
        applied.push({ type, result: "skipped — missing file, expected, or received field", inapplicable: true, cause: "absent_payload" });
        continue;
      }
      const absPath = path.join(projectRoot, testFile);
      let testContent;
      try {
        testContent = await fs.readFile(absPath, "utf8");
      } catch {
        applied.push({ type, result: `skipped — test file not found: ${testFile}`, inapplicable: true, cause: "unusable_payload" });
        continue;
      }
      // Replace the first occurrence of the literal expected value in an assertion context.
      // Patterns: .toBe(N) / .toEqual(N) / toHaveLength(N) / (N) in assertion position.
      const assertionRe = new RegExp(`(\\bto(?:Be|Equal|HaveLength|HaveBeenCalledTimes)\\s*\\()\\s*${expected}\\s*(\\))`, 'g');
      if (!assertionRe.test(testContent)) {
        applied.push({ type, result: `skipped — assertion pattern toBe/toEqual/toHaveLength(${expected}) not found in ${testFile}` });
        continue;
      }
      assertionRe.lastIndex = 0;
      const patchedContent = testContent.replace(assertionRe, `$1${received}$2`);
      try {
        await fs.writeFile(absPath, patchedContent, "utf8");
        applied.push({ type, result: `patched assertion in ${testFile}: ${expected} → ${received}` });
        historyLines.push(`- Fixed numeric assertion in ${testFile}: ${expected} → ${received}`);
      } catch (e) {
        applied.push({ type, result: `failed to write ${testFile}: ${e.message}`, inapplicable: true, cause: "io_error" });
      }
    }

    // Handle fix_test_assertion: write a focused hint to the story note pointing at
    // the specific test file and line that failed. More targeted than add_code_snippet —
    // no full file content injected, just a precise location marker.
    for (const refinement of refinements) {
      const { type, data: rawData, ...topLevel } = refinement;
      if (type !== "fix_test_assertion") continue;
      const data = { ...topLevel, ...rawData };
      const testFile = data?.file;
      const line = data?.line;
      const reason = data?.reason;
      if (!testFile) {
        applied.push({ type, result: "skipped — no file specified", inapplicable: true, cause: "absent_payload" });
        continue;
      }
      const sectionHeader = `### Test Fix Required: ${testFile}${line ? ` (line ${line})` : ''}`;
      if (body.includes(sectionHeader)) {
        applied.push({ type, result: `skipped — fix note already present for ${testFile}` });
        continue;
      }
      const focusedSection = `\n\n${sectionHeader}\n\n${reason || 'Test assertion needs updating.'}\n`;
      body = body.trimEnd() + focusedSection;
      historyLines.push(`- Test assertion fix needed: ${testFile}${line ? ':' + line : ''}`);
      applied.push({ type, result: `added focused test fix note for ${testFile}${line ? ':' + line : ''}` });
    }

    // Handle disk_fetch_context: read file from disk and return as out-of-band context.
    // Story note body is NOT modified — this prevents note inflation from worsening
    // the truncation problem on subsequent plan attempts.
    for (const refinement of refinements) {
      const { type, data: rawData, ...topLevel } = refinement;
      if (type !== "disk_fetch_context") continue;
      const data = { ...topLevel, ...rawData };
      const diskFile = data?.file;
      if (!diskFile) {
        applied.push({ type, result: "skipped — no file specified", inapplicable: true, cause: "absent_payload" });
        continue;
      }
      try {
        const content = await fs.readFile(path.join(projectRoot, diskFile), "utf8");
        outOfBandContextItems.push({ file: diskFile, content });
        applied.push({ type, result: `disk-fetched ${diskFile} (${content.length} bytes, story note unchanged)` });
      } catch (e) {
        applied.push({ type, result: `failed to read ${diskFile}: ${e.message}`, inapplicable: true, cause: "io_error" });
      }
    }

    // Apply size cap before writing.
    //
    // backlog.fix.hardcap-prune-destroys-authored-anchors: this comment used to justify the prune
    // on the premise that the presence of @@SEARCH proves "the planner has already consumed the
    // injected code snippets" — i.e. that anchors are spent residue. THAT PREMISE IS FALSE as of
    // v0.41.0. backlog.fix.po-prompt-edit-target-anchor-obligation requires PO to author an
    // @@SEARCH anchor for EVERY op:edit target, so the sentinel that used to mean "safe to shed"
    // now means "the author's deliverable is in here". The predicate below is deliberately
    // UNCHANGED — the destruction lived in the shed, not the gate, and gating on tool-generated
    // markers would stop the `### Target:` strip running on author-anchored notes, which is out
    // of scope here. What changed is that pruneRefineBlocks no longer sheds anchors at all.
    // `bodyDirty` is PREPENDED, keeping the existing conjunction contiguous — a source-text pin
    // at tests/unit/refine-note-size-cap-search-gate.test.mjs:44 requires
    // `MAX_NOTE_BODY_BYTES && body.includes` to stay adjacent and breaks on a mid-conjunct
    // insertion. A refinement that changed no body content has nothing to prune.
    if (bodyDirty && body.length > MAX_NOTE_BODY_BYTES && body.includes('@@SEARCH')) {
      // The cap bounds the FULL written note (frontmatter block + body), not the body alone,
      // so reserve room for the frontmatter. The phase edit below re-dumps and slightly grows
      // frontmatter, hence the safety margin.
      //
      // NOTE the asymmetry, which is live and load-bearing: the GATE above measures body.length,
      // while this threshold subtracts frontmatter. A large frontmatter drives bodyThreshold to
      // the 1024 floor — making the cap most aggressive on exactly the notes carrying the most
      // authored anchors. That is why refusing rather than shedding matters here specifically.
      const fmBlockLen = ('---\n' + frontmatter.trim() + '\n---\n').length;
      const bodyThreshold = Math.max(1024, MAX_NOTE_BODY_BYTES - fmBlockLen - 128);
      const pruneReport = {};
      body = pruneRefineBlocks(body, { capMode: true, threshold: bodyThreshold, report: pruneReport });
      if (fmBlockLen + body.length > MAX_NOTE_BODY_BYTES) {
        // Retained IN ADDITION to the result field below, never replaced by it — stderr is the
        // only signal an operator watching the server sees.
        process.stderr.write(`[refine] WARNING: note body still exceeds ${MAX_NOTE_BODY_BYTES} bytes after pruning (${fmBlockLen + body.length} bytes) — writing un-shed version, anchors preserved\n`);
      }
      // AC7 — a prune that removed an authored deliverable is a FAILURE, not an advisory.
      // `// CREATE FILE:` directives, their fences and anchor groups are what a PO authored for
      // a targetFile; losing one silently is the defect this story exists to close.
      // Keyed on create directives and anchor groups ONLY — deliberately NOT on fencesShed.
      // AC7 covers "a fence BELONGING TO" a CREATE FILE directive, and a create block is now
      // exempt wholesale, so its fence cannot be shed while the directive survives. A non-zero
      // fencesShed therefore means a `### Target:` snapshot fence was removed, which is the
      // prune's original and intended purpose. Escalating on it would refuse every legitimate
      // snapshot strip. fencesShed remains reported (AC5) so the loss is still visible.
      pruneDestroyedAuthoredContent =
        (pruneReport.createDirectivesShed || 0) > 0 ||
        (pruneReport.anchorsShed || 0) > 0;
      prunePreservedEverything =
        !pruneDestroyedAuthoredContent && (pruneReport.linesShed || 0) === 0;
      prunelossReport = pruneReport;

      if (pruneReport.overflow) {
        // Reported in BODY bytes, matching what the gate measures and what the caller can act on.
        // The stderr line above reports whole-file bytes; the two differ by fmBlockLen and are
        // deliberately named differently so neither can be mistaken for the other.
        noteSizeOverflow = {
          bodyBytes: pruneReport.bodyBytes,
          threshold: pruneReport.threshold,
          maxNoteBodyBytes: MAX_NOTE_BODY_BYTES,
          anchorBlocks: pruneReport.anchorBlocks,
          anchorsShed: pruneReport.anchorsShed,
          createDirectivesShed: pruneReport.createDirectivesShed,
          fencesShed: pruneReport.fencesShed,
          linesShed: pruneReport.linesShed,
          // AC6 — the reassurance is emitted ONLY when it is true. It previously accompanied a
          // note that had just lost 13KB, which is how a destructive write read as an all-clear.
          // Conditional, never a blanket deletion: when nothing was shed the string is unchanged.
          ...(prunePreservedEverything
            ? { note: 'Body exceeds the size cap. Anchor blocks were PRESERVED, not shed — the note was written un-shed. Reduce body size by moving prose into frontmatter (desc, targetFiles[].desc, testRequirements); the gate measures body length only.' }
            : {}),
        };
      }
    }

    // ── backlog.fix.refine-apply-no-growth-fixed-point: DIRECTION A ──
    //
    // `refinementsChangedNote` above is snapshotted BEFORE the prune. That is deliberate and
    // correct for the auto-upgrade, the history append and the `updated` stamp — comparing
    // against those would make every call a no-op. It is WRONG for the prune, which can delete
    // an entire injected section: the call then writes a byte-identical note and still returns
    // ok:true with requiredNext: rks_plan. That is the silent half of this defect.
    //
    // Reconcile against the FINAL body, and only against it. An `applied[]` entry may not claim
    // a header the written note does not hold (AC 5). Direction C above means this should no
    // longer fire for add_code_snippet on a near-cap note; it stays as the general guard, since
    // any future injector that grows the body inherits exactly the same hazard.
    const claimedInjections = applied.filter((a) => a?.injectedHeader);
    const lostInjections = claimedInjections.filter((a) => !body.includes(a.injectedHeader));
    for (const entry of lostInjections) {
      entry.result = "NOT DURABLE — " + entry.result + "; the size-cap prune removed it before the write";
      entry.durable = false;
      entry.inapplicable = true;
      entry.cause = "prune_removed";
    }
    // Every claimed injection was stripped, and nothing else productive was applied: the note
    // that lands is the note we started with, so this call must not report success.
    const allInjectionsLost =
      claimedInjections.length > 0 && lostInjections.length === claimedInjections.length;
    const hasProductiveApplied = applied.some(
      (a) => a?.durable !== false && !String(a?.result || "").startsWith("skipped")
    );

    // ── backlog.fix.build-governor-self-heal: A NO-OP MUST NEVER REPORT SUCCESS ──
    //
    // THE BUG: this function used to return `ok: true` AND `requiredNext: rks_plan` after changing
    // NOTHING. It told the Build Governor "success — now go re-plan", the Governor obediently
    // re-planned a BYTE-IDENTICAL story, got the identical failure, refined again, was told "success"
    // again… forever. The retry could never converge, because the feedback never changed the input.
    // A greenfield UAT only finished because a human stepped in and hand-edited the story.
    //
    // A no-op that reports success is the defect; the dedup was merely how it got there. This is the
    // THIRD instance of this class in this project (v0.27.0: the planner named nothing it dropped;
    // v0.27.1: the task-mode guard never fired), so it is fixed as a class: if we changed nothing, we
    // SAY SO — machine-readably — and we do NOT tell anyone to re-plan.
    //
    // FOUR CLAUSES, all load-bearing in BOTH directions. A FALSE escalation breaks successful applies
    // exactly as badly as a MISSED one leaves the loop spinning:
    //   1+2. the refinements changed neither body nor frontmatter (captured before the loop, because
    //        the auto-upgrade, the size-cap prune and the `updated = Date.now()` stamp below all
    //        rewrite the note on EVERY call — compare against those and nothing is ever a no-op).
    //   3.   no outOfBandContext — `disk_fetch_context` deliberately leaves the note alone ("Story
    //        note body is NOT modified") yet genuinely did work.
    //   4.   no disk side-effect — `fix_numeric_assertion` patches the TEST FILE and leaves the note
    //        alone. Real effect, zero note delta.
    // Without 3 and 4 a note-delta-only detector escalates on a SUCCESSFUL apply.
    // Clause 0 (`allInjectionsLost && !hasProductiveApplied`) is the post-prune reconciliation:
    // the pre-prune snapshot says "changed", the written note says otherwise, and the written
    // note is what the caller will read back. Clauses 1–4 below are unchanged.
    const isNoop =
      (!refinementsChangedNote || (allInjectionsLost && !hasProductiveApplied)) &&
      outOfBandContextItems.length === 0 &&
      !hadDiskSideEffect &&
      !hadManualRequest &&
      !hadDecision;

    if (isNoop) {
      const skipped = applied.filter((a) => String(a?.result || "").startsWith("skipped"));

      // backlog.fix.refine-inapplicable-status.
      //
      // `refine_noop` means "the story was already correct". Using it for "this
      // refinement could never have been applied" names the wrong observation, and
      // the two have different remedies: the first says stop, the second says the
      // suggestion was unactionable and the run is healthy. A Governor obeying the
      // Build prompt's STOP rule on the second kills a run that was fine.
      //
      // Computed off the LEDGER, never off the refinement's `type` — a type says
      // what was asked for, not what was observed. Every entry must carry a marker
      // stamped at the site that made the observation; a MIXED call is still a
      // no-op, because something in it did run and decline on its merits.
      const allInapplicable = applied.length > 0 && applied.every((a) => a?.inapplicable === true);
      const status = allInapplicable ? "refine_inapplicable" : "refine_noop";
      const causes = allInapplicable
        ? [...new Set(applied.map((a) => a?.cause).filter(Boolean))]
        : [];

      try {
        const collector = getTelemetryCollector();
        collector.emit("refine.apply", projectId, {
          problemId, appliedCount: applied.length, success: false, reason: status,
        });
      } catch (e) { /* telemetry is best-effort */ }

      // Note is NOT written back: there is nothing to write. The phase stamp below is skipped too —
      // stamping `arch-approved` on a story we did not change would be a third lie.
      return {
        ok: false,
        status,
        problemId,
        applied,
        // The dissent that was always here and that nothing ever read. Now it is the headline.
        historyAppended: false,
        reason: allInapplicable
          ? "refine_apply changed nothing because EVERY refinement handed in was unactionable — " +
            `cause${causes.length > 1 ? "s" : ""}: ${causes.join(", ")}. ` +
            "This is NOT a stuck story and NOT a no-op: the story was never evaluated on its merits, " +
            "so re-planning it is neither required nor forbidden by this result. " +
            "Fix the named cause in the refinement payload and apply again, or proceed with the run. " +
            "Read `escalation.skipped` for the per-refinement cause."
          :
          "refine_apply changed NOTHING — the story is byte-identical. Re-planning it unchanged would " +
          "produce the identical plan and the identical failure. " +
          (skipped.length
            ? `Every refinement was skipped: ${skipped.map((s) => `${s.type} (${s.result})`).join("; ")}. `
            : "No refinement produced an effect. ") +
          // backlog.fix.refine-noop-escalation-false-positive: this used to assert "not recoverable
          // by retrying" unconditionally. That is now false for a FIRST no-op — the state machine
          // self-loops and only escalates on a consecutive repeat, precisely because a no-op is
          // often a false positive whose cause is named in `skipped` below. This function cannot
          // see the streak counter (it lives on the Governor session), so it must not claim
          // terminality it cannot know.
          "Read `escalation.skipped` for the per-refinement cause before deciding what to do next.",
        escalation: {
          kind: status,
          // Every refinement handed in is now accounted for here — a declined one is recorded with
          // its reason rather than dropped, so an empty `skipped` alongside a non-empty
          // `refinements` input is no longer reachable.
          skipped: skipped.map((s) => ({ type: s.type, result: s.result })),
          nextTool: "rks_refine_apply",
          guidance: allInapplicable
            ? "Every refinement was unactionable, so nothing was learned about the story itself. " +
              "This does NOT count toward the consecutive-no-op streak and must NOT be reported as " +
              "a no-op. Fix the named cause in the payload and apply again, or continue the run."
            :
            "Do NOT re-plan the story unchanged — that input cannot produce a different outcome. " +
            "Each entry in `skipped` names why that refinement did nothing; fix the cause and apply " +
            "again. A second consecutive no-op escalates the run, at which point abort with " +
            "rks_exec_abort and hand back to a human.",
        },
        // DELIBERATELY ABSENT: `requiredNext: rks_plan`. Telling the caller to re-plan an input we did
        // not change IS the infinite loop. Its absence is the fix.
      };
    }

    // Companion to R1.3e: set phase=arch-approved for non-decompose amendments so the
    // Build Governor's refine→re-plan flow works under the v2 model. The decompose
    // branch returns early at ~L1698, so this only runs on non-decompose paths.
    try {
      const parsedFm = yaml.load(frontmatter);
      if (parsedFm && typeof parsedFm === "object") {
        parsedFm.phase = "arch-approved";
        parsedFm.updated = Date.now();
        frontmatter = yaml.dump(parsedFm, { lineWidth: -1, quotingType: '"', forceQuotes: true }).trim();
      }
    } catch { /* preserve original frontmatter if phase write fails */ }

    // ── backlog.fix.refine-prune-destroys-authored-create-blocks: AC7 ────────────────────────
    //
    // REFUSE BEFORE WRITING. If the prune removed an authored deliverable — a `// CREATE FILE:`
    // directive, a fence belonging to one, or an anchor group — the mutilated body is NOT
    // written and the call fails. An oversized note is recoverable; a destroyed one is not,
    // and the two field instances were destructive precisely because this path returned
    // ok:true and wrote anyway.
    if (pruneDestroyedAuthoredContent) {
      try {
        const collector = getTelemetryCollector();
        collector.emit("refine.apply", projectId, {
          problemId, appliedCount: applied.length, success: false, reason: "prune_destroyed_authored_content",
        });
      } catch (e) { /* telemetry is best-effort */ }
      return {
        ok: false,
        status: "prune_destroyed_authored_content",
        message:
          "The size-cap prune would have removed authored content from this note, so it was NOT written. " +
          `Removed: ${prunelossReport?.createDirectivesShed || 0} CREATE FILE directive(s), ` +
          `${prunelossReport?.fencesShed || 0} fence line(s), ${prunelossReport?.anchorsShed || 0} anchor group(s), ` +
          `${prunelossReport?.linesShed || 0} line(s) total. The note on disk is unchanged.`,
        escalation: {
          kind: "prune_destroyed_authored_content",
          shed: {
            createDirectivesShed: prunelossReport?.createDirectivesShed || 0,
            fencesShed: prunelossReport?.fencesShed || 0,
            anchorsShed: prunelossReport?.anchorsShed || 0,
            linesShed: prunelossReport?.linesShed || 0,
          },
          guidance:
            "Reduce the note's body size by moving prose into frontmatter (desc, targetFiles[].desc, " +
            "testRequirements) rather than letting the prune choose what to delete. Authored " +
            "CREATE FILE blocks and @@SEARCH anchors are deliverables and are never safe to shed.",
        },
      };
    }

    // Write back with modified frontmatter (editNote would lose frontmatter changes)
    const updatedContent = "---\n" + frontmatter.trim() + "\n---\n" + body;
    await fs.writeFile(storyPath, updatedContent, "utf8");

    // Emit telemetry
    try {
      const collector = getTelemetryCollector();
      collector.emit("refine.apply", projectId, {
        problemId,
        appliedCount: applied.length,
        success: true,
      });
    } catch (e) { /* telemetry is best-effort */ }

    return {
      ok: true,
      problemId: problemId,
      applied: applied,
      historyAppended: historyLines.length > 0,
      ...(outOfBandContextItems.length > 0 ? { outOfBandContext: outOfBandContextItems } : {}),
      // backlog.fix.hardcap-prune-destroys-authored-anchors: the size-cap outcome must reach the
      // CALLER, not only process.stderr. Nothing on this path reads the note back after writing,
      // so before this field the only record that a note had been mutilated was a stderr line no
      // MCP client ever sees — which is how a child project lost four authored anchors against an
      // ok:true result.
      ...(noteSizeOverflow ? { noteSizeOverflow } : {}),
      requiredNext: `rks_plan { "projectId": "${projectId}", "problemId": "${problemId}" }`,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
