/**
 * Plan Ready Validation
 * Validates story readiness before planning to improve first-time yield.
 */
import fs from "fs";
import path from "path";
import { parseFrontmatter, resolveNotesDir, updateField } from "../dendron.mjs";
import { PLANNABLE_PHASES, PHASE_GATE_EXEC } from "../workflow/phases.mjs";
import { findIncompleteRuns } from "../workflow/exec-state.mjs";
import { createTargetPathsMatch, findMatchingCreateTargetPath } from "../shared/create-target-path-match.mjs";
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
import { extractCreateFileDirectives, extractCreateFileBlocks, parseCreateHeadingPath } from "./planner-utils.mjs";
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

/**
 * The planner's create-file block map for a story body: every fenced block the planner can
 * bind a create_file step from, keyed on the path EXACTLY as written in the body. Built
 * through the planner's OWN extractors, never a proximity regex — a separate matcher can
 * disagree with what the planner actually binds, which is worse than no check at all.
 */
export function buildCreateFileBlocks(body, declaredCreatePaths) {
  return new Map([
    ...parseImplementationCodeBlocks(body || ""),
    ...extractCreateFileBlocks(body || "", { declaredCreatePaths }),
  ]);
}

// backlog.fix.create-directive-binds-only-same-section — name the ACTUAL misplacement.
// Only `suggestion` reaches ARCH (server.mjs maps gate issues to {check, file, suggestion}), so
// the diagnosis lives there; `message` carries the same information. Shapes, first match wins:
//   (a) a block binds but is placeholder-only        (b) a directive sits in a fence-less section
//   (c) another directive sits between T's and the fence   (d) a `### T` section has no fence
//   (f) a `### ` heading names T with a tail the heading grammar rejects (quoted verbatim)
//   (e) none of the above (e.g. frontmatter op:create only)
// The advice never claims a directive that does not exist.
const DIRECTIVE_LINE_RE = /\/\/\s*CREATE\s+FILE:\s*(\S+)|^[^\S\n]*#{2,3}\s*CREATE\s+FILE:\s*(\S+)/gim;

function nearestHeadingBefore(body, index) {
  const before = body.slice(0, index);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// First `### ` heading line whose leading path token (bare or backticked) names `target` and
// whose remainder parseCreateHeadingPath rejects; the heading line verbatim, or null.
function findUnsupportedCreateHeading(text, target) {
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^###\s+`?([^\s`(]+)`?(.*)$/);
    if (!m) continue;
    if (!createTargetPathsMatch(m[1], target)) continue;
    if (parseCreateHeadingPath(line) !== null) continue;
    return line.replace(/\s+$/, "");
  }
  return null;
}

function diagnoseCreateTarget(body, target) {
  const text = String(body || "");
  const directives = [];
  DIRECTIVE_LINE_RE.lastIndex = 0;
  let m;
  while ((m = DIRECTIVE_LINE_RE.exec(text)) !== null) {
    directives.push({ path: (m[1] || m[2]).trim(), index: m.index, end: m.index + m[0].length });
  }
  const mine = directives.find((d) => createTargetPathsMatch(d.path, target));
  if (mine) {
    // The directive's ### section ends at the next `### ` line.
    const nextSection = text.slice(mine.end).search(/^###\s/m);
    const sectionEnd = nextSection === -1 ? text.length : mine.end + nextSection;
    const rest = text.slice(mine.end, sectionEnd);
    const fenceAt = rest.indexOf("```");
    const heading = nearestHeadingBefore(text, mine.index);
    const where = heading ? `the "${heading}" section` : "the body before the first ### heading";
    if (fenceAt !== -1) {
      const other = directives.find((d) => d !== mine && d.index > mine.index && d.index < mine.end + fenceAt);
      if (other) {
        return {
          shape: "c",
          text: `The create directive for ${target} in ${where} is followed by another create directive (${other.path}) before any fenced block, so that fence belongs to ${other.path} and ${target} has none. Use one fence per directive: put a fenced block of real content directly after the directive for ${target}, or add a "### ${target}" section holding it.`,
        };
      }
    }
    return {
      shape: "b",
      text: `A create directive for ${target} was found in ${where}, but that section has no fenced block after it. Put a fenced block of real file content directly after the directive in that section, or add a "### ${target}" section holding the fence.`,
    };
  }
  const headingSection = text.split(/^(?=###\s)/m).find((sec) => parseCreateHeadingPath(sec.split("\n", 1)[0]) === target);
  if (headingSection !== undefined) {
    return {
      shape: "d",
      text: `There is no create directive for ${target}; a "### ${target}" section exists but has no fenced block. Add a fenced block of real file content in that section.`,
    };
  }
  // backlog.fix.create-target-grammar-drift-refine-and-po-prompt — a `### ` heading that names
  // the target but carries a tail parseCreateHeadingPath rejects (e.g. an em-dash then "create")
  // binds no block. Name that heading and the accepted forms instead of the generic advice. The
  // grammar is NOT widened: the heading still binds nothing.
  const unsupported = findUnsupportedCreateHeading(text, target);
  if (unsupported !== null) {
    return {
      shape: "f",
      text: `The heading "${unsupported}" names ${target} but its trailing text is not an accepted create-heading form, so no fenced block binds to ${target}. Accepted forms: "### ${target}", "### ${target} (create)", "### ${target} (create file)" or "### ${target} (new file)" (the path may be wrapped in backticks), with nothing else on the line, followed directly by a fenced block of real file content.`,
    };
  }
  return {
    shape: "e",
    text: `There is no create directive for ${target} and no "### ${target}" section in the story body. Add a "### ${target}" section holding a fenced block of real file content.`,
  };
}

/**
 * Shared create-target readiness predicate for ONE create target (a missing path that has a
 * directive or op:create). Returns the `create_target_no_authorable_block` issue, or null
 * when an authorable block binds to the target.
 *
 * Exported so rks_arch_verdict runs the SAME predicate plan_ready runs — the two gates must
 * not disagree about buildability (backlog.fix.arch-verdict-enforces-plan-ready-create-gate).
 */
export function createTargetNoAuthorableBlockIssue(createFileBlocks, target, { body, declaredCreatePaths } = {}) {
  // Both extractors key their Maps on the path EXACTLY as written in the body, while
  // the directive match is suffix-tolerant. Look the block up the SAME way, or a
  // story whose fence path differs in prefix from its frontmatter path is falsely
  // blocked — a false positive that would wedge projects harder than the bug this
  // check exists to catch. Never `createFileBlocks.has(target)`.
  const blockKey = findMatchingCreateTargetPath(createFileBlocks.keys(), target);
  // isSynthesizedBody(undefined, …) is false, so a missing block and a placeholder-only
  // block fail through the same branch. A fence is necessary but not sufficient.
  if (isSynthesizedBody(blockKey === undefined ? undefined : createFileBlocks.get(blockKey), target)) {
    return null;
  }
  // With the body, name the actual shape (a)-(e); without it (legacy two-argument callers),
  // keep the generic advice. ONE issue literal either way — the check id is raised once.
  let message = `Create target has a directive but no authorable code block: ${target}`;
  let suggestion = `Add a fenced code block containing real file content immediately after "// CREATE FILE: ${target}" (same "###" section), or under a "### ${target}" heading. A directive alone leaves the planner to author the file from prose, which fails with failureClass "structural" and cannot be refined.`;
  if (body !== undefined) {
    // (a) a block bound, so it failed only because it is placeholder-only.
    const d = blockKey !== undefined
      ? { shape: "a", text: `The fenced block for ${target} holds only placeholder content. Replace it with real file content: valid JSON, or a module with a genuine import or export.` }
      : diagnoseCreateTarget(body, target);
    message = `Create target has no authorable code block (${d.shape}): ${d.text}`;
    suggestion = d.text;
  }
  return {
    check: "create_target_no_authorable_block",
    file: target,
    message,
    suggestion,
  };
}

/**
 * Story-level form of the shared predicate: every `create_target_no_authorable_block` issue
 * plan_ready raises for this note, in the same order. Target selection mirrors
 * runPlanReadyTool's existence loop exactly — frontmatter and body targets, absent on disk
 * under projectRoot, declared create by op:create or a body directive — and the block check
 * is createTargetNoAuthorableBlockIssue. No other plan_ready check is evaluated here.
 *
 * Deliberately not wrapped in a try/catch: a failure must surface to the caller rather than
 * be read as "no issues".
 */
export function findCreateTargetNoAuthorableBlockIssues({ frontmatter, body, projectRoot }) {
  const normalizedTargets = normalizeTargetFiles(frontmatter?.targetFiles);
  const fmCreateFiles = new Set(
    normalizedTargets
      .filter(t => t.op === 'create' || t.action === 'CREATE' || t.create === true)
      .map(t => t.path)
  );
  const allTargets = [...new Set([
    ...normalizedTargets.map(t => t.path),
    ...parseTargetsFromMarkdown(body || ""),
  ])];
  const createFileDirectives = extractCreateFileDirectives(body || "");
  const createFileBlocks = buildCreateFileBlocks(body, fmCreateFiles);
  const found = [];
  for (const target of allTargets) {
    if (fs.existsSync(path.resolve(projectRoot, target))) continue;
    const hasDirective =
      fmCreateFiles.has(target) || createFileDirectives.some((d) => createTargetPathsMatch(d, target));
    if (!hasDirective) continue;
    const issue = createTargetNoAuthorableBlockIssue(createFileBlocks, target, { body: body || "", declaredCreatePaths: fmCreateFiles });
    if (issue) found.push(issue);
  }
  return found;
}

// backlog.fix.governor-state-tool-admission-gaps — dispatch selection for the rks_plan_ready
// handler. Pure: true iff `session` is a non-null object whose flowType is anything other than
// 'story'. Only a story-flow (Build) Governor may let the readiness probe self-heal a stranded
// `executing` phase; every other flow (open, qa, ship, ops) gets the read-only probe. No session
// (no token, or an invalid one) returns false and keeps the default healing behaviour.
export function isPlanReadyReadOnly(session) {
  return session != null && typeof session === "object" && session.flowType !== "story";
}

export async function runPlanReadyTool({ projectId, problemId, projectRoot, readOnly = false }) {
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
    if (!liveRun && !freshUnconsumedRun && readOnly) {
      // READ-ONLY probe (non-story callers): report the stranded condition, decided from the
      // same liveRun / freshUnconsumedRun observation, but never write the note. currentPhase
      // stays 'executing', so the phase_status issue below still fires — that is expected.
      warnings.push({
        check: "stale_executing_detected",
        message: "Story is stranded at 'executing' with no live exec run and no fresh un-consumed plan run. Read-only probe: phase NOT reset (a story-flow rks_plan_ready or rks_plan would reset it to 'arch-approved').",
      });
    } else if (!liveRun && !freshUnconsumedRun) {
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

  // Re-validate the FRONTMATTER entries against disk on every readiness check.
  //
  // resolveTargets was imported and never called — the resolution machinery, including its
  // 'EDIT but file does not exist' and 'CREATE but file exists' mismatch strings, was dead.
  // It must run over frontmatter.targetFiles and NOT over `allTargets`: `fmTargets` above
  // discards the op one line after normalizing, so by the time the existence loop runs only
  // strings remain, which is exactly why a stale op:edit path was being diagnosed as a
  // missing create directive.
  //
  // Nothing here re-validates when the tree moves under an approved story, so a story can
  // sit at arch-approved naming paths that no longer exist. This check runs immediately
  // before the planner spawns, so its answer cannot expire.
  const resolvedTargets = resolveTargets(projectRoot, frontmatter.targetFiles);
  const staleEditTargets = new Set(
    resolvedTargets.filter(t => t.mismatch === 'EDIT but file does not exist').map(t => t.path)
  );

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
  const createFileBlocks = buildCreateFileBlocks(body, fmCreateFiles);
  for (const target of allTargets) {
    const targetPath = path.resolve(projectRoot, target);
    if (!fs.existsSync(targetPath)) {
      // Check if there's a CREATE FILE directive in body OR op: create in frontmatter
      // Both sources are evaluated INDEPENDENTLY, never short-circuited into one flag.
      // `||` would make the suggestion below unable to name which source actually
      // satisfied the check, which is the intent-sourced-status defect this story removes:
      // a story whose op:create came from frontmatter alone was told "CREATE FILE directive
      // found", and an operator spent three diagnostic rounds chasing a body directive that
      // was never there.
      const fromFrontmatter = fmCreateFiles.has(target);
      const fromBodyDirective = createFileDirectives.some((d) => createTargetPathsMatch(d, target));
      const hasDirective = fromFrontmatter || fromBodyDirective;
      if (hasDirective) {
        // Valid: file will be created
        warnings.push({
          check: "file_will_be_created",
          file: target,
          message: `Target file will be created: ${target}`,
          suggestion: fromBodyDirective
            ? (fromFrontmatter
                ? "CREATE FILE directive found in the body, and op: create declared in frontmatter"
                : "CREATE FILE directive found in the body")
            : "op: create declared in frontmatter; no CREATE FILE directive found in the body",
        });

        // The block check is the SHARED predicate (createTargetNoAuthorableBlockIssue below),
        // the same function rks_arch_verdict's gate runs, so ARCH and plan_ready cannot
        // disagree about whether a create target is buildable.
        const noBlockIssue = createTargetNoAuthorableBlockIssue(createFileBlocks, target, { body, declaredCreatePaths: fmCreateFiles });
        if (noBlockIssue) issues.push(noBlockIssue);
      } else if (staleEditTargets.has(target)) {
        // A frontmatter op:edit target whose path does not resolve. Previously this fell
        // into missing_create_directive below, whose suggestion is actively harmful here:
        // it tells the author to add a CREATE FILE directive, which would turn a typo'd or
        // moved path into a NEWLY CREATED empty file rather than surfacing the stale
        // reference. Same array, same severity — corrected identity and suggestion.
        issues.push({
          check: "stale_target_path",
          file: target,
          message: `targetFiles declares op:edit for a path that does not exist: ${target}`,
          suggestion: `Correct the path in targetFiles, or change its op to "create" if the file is genuinely new. Do NOT add a "// CREATE FILE:" directive to satisfy this — that would create an empty file instead of fixing the reference.`
        });
      } else {
        // Body-derived prose paths keep the original diagnosis: they carry no op, so a
        // create directive genuinely is the thing they are missing.
        issues.push({
          check: "missing_create_directive",
          file: target,
          message: `Target file does not exist and has no CREATE FILE directive: ${target}`,
          suggestion: `Add "// CREATE FILE: ${target}" to story body`
        });
      }
    }
  }

  // A create target whose file ALREADY exists. resolveTargets computes this mismatch, but
  // the existence loop above only enters its branch when the file is ABSENT, so a create/
  // exists collision fell through silently. A warning, not an issue: no story that passes
  // the gate today becomes newly blocked.
  for (const t of resolvedTargets) {
    if (t.mismatch === 'CREATE but file exists') {
      warnings.push({
        check: "create_target_exists",
        file: t.path,
        message: `targetFiles declares op:create for a path that already exists: ${t.path}`,
        suggestion: `Change its op to "edit", or remove the file first if it is meant to be regenerated.`
      });
    }
  }

  // A desc citing a line number is unverifiable and rots silently. Deliberately NOT range
  // checked: every recorded instance of this drift cited an offset that was still IN RANGE
  // for its file, so a range check returns clean on exactly the cases that matter. This
  // never claims an offset is wrong — only that a line number cannot be verified, and that
  // a verbatim anchor string can. Shape-based, so a version number or port in a desc is a
  // known false positive; that is why it is a warning and not a gate.
  for (const t of resolvedTargets) {
    // `:1118` or `:264-290` — the form this repo actually uses to cite a line. Requires the
    // colon, so a bare "8192" cap or a "0.51.0" version in prose does not trip it.
    if (typeof t.desc === "string" && /:\d{2,}(-\d+)?\b/.test(t.desc)) {
      warnings.push({
        check: "desc_cites_line_offset",
        file: t.path,
        message: `targetFiles desc for ${t.path} cites a line number, which cannot be verified and goes stale when the file moves`,
        suggestion: `Cite a verbatim anchor string from the file instead of a line offset. Content-keyed references survive edits above them; line numbers do not.`
      });
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
  //
  // Hoisted: 4b below asks the SAME extractor whether a target has a bindable edit, so both
  // checks read one extraction and cannot disagree about which file an edit names.
  const explicitEdits = extractExplicitEdits(body, projectRoot, allTargets);
  for (const [blockIndex, edit] of explicitEdits.entries()) {
    // A block that bound to NO file was previously skipped here in silence — `path.resolve`
    // cannot run on a null, so readiness returned true and the planner then rejected the same
    // block. That is the ready:true-then-refuse sequence this section exists to close, and it
    // was still open for the attribution case.
    //
    // Refuse it here instead, before a worker spawns. Deliberately NOT create-scoped: the
    // measured field failure was an op:edit target whose SEARCH text was a substring of four
    // declared targets, which a create-only rule leaves broken. The rule is that a block must
    // bind to EXACTLY ONE declared target.
    if (edit?.search && !edit?.file) {
      const fragment = String(edit.search).split("\n").find((l) => l.trim()) || "";
      issues.push({
        check: "search_block_unattributed",
        blockIndex,
        searchFragment: fragment.trim().slice(0, 80),
        message: `SEARCH block #${blockIndex} could not be attributed to any declared target`,
        suggestion: `Add a "### <path>" heading immediately above the block, naming a path exactly as it appears in targetFiles. Write the path alone — a "Target: " label is accepted, but prose in the heading is not.`
      });
      continue;
    }
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
    //
    // backlog.fix.plan-ready-heading-only-edit-target-false-ready: a heading that merely NAMES
    // the target no longer suppresses this check. It used to — any `### <path>` or
    // `### Target: <path>` line resolving to the target was sufficient on its own, even with
    // nothing beneath it, so plan_ready reported ready for a target the planner then could
    // not bind a step to (coverage_gap). The suppression now requires a BINDABLE edit: the
    // planner's own extractor (extractExplicitEdits, hoisted above 4a-bis) must yield at
    // least one edit attributed to this target. No separate heading or block regex decides
    // it, so plan_ready and the planner cannot disagree about what binds.
    //
    // hasSearchPattern above stays an INDEPENDENT clearing term in the raise condition and
    // must not be folded into or gated by this one: refine's add_search_pattern apply
    // injects IDENTITY blocks, which extractExplicitEdits drops, so recovery converges only
    // through hasSearchPattern seeing the anchor in the target's content.
    //
    // The out-of-band marker path is unchanged (see the size-cap note above).
    const hasBindableEdit = explicitEdits.some((e) => e?.file === target);
    const hasInjectedSnippet =
      hasBindableEdit ||
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
  // Both grammars, per backlog.fix.create-file-directive-grammar-not-reconciled. The
  // .replace() must be broadened with the .match() or a heading-form line survives the
  // strip, firstWord becomes the literal "###", and the remediation is nonsense.
  const createFileMatches =
    body.match(/(?:\/\/\s*CREATE\s+FILE:\s*(.+))|(?:^[^\S\n]*#{2,3}\s*CREATE\s+FILE:\s*(.+))/gim) || [];
  for (const match of createFileMatches) {
    const pathPart = match.replace(/^[^\S\n]*(?:\/\/|#{2,3})\s*CREATE\s+FILE:\s*/i, "").trim();
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
  // Report the comparison that was performed, not only its result. Without this a caller
  // cannot distinguish "every frontmatter target was resolved and all were fine" from
  // "no frontmatter targets were resolved at all" — both present as an absence of issues.
  const targetResolution = {
    checked: resolvedTargets.length,
    stale: resolvedTargets.filter(t => t.mismatch === 'EDIT but file does not exist').map(t => t.path),
    createCollisions: resolvedTargets.filter(t => t.mismatch === 'CREATE but file exists').map(t => t.path),
  };
  return {
    ready,
    currentPhase,
    issues,
    warnings,
    targetResolution,
    summary: ready
      ? `Story ready for planning (${allTargets.length} targets, ${submittedPatterns} patterns validated)`
      : `Story needs refinement: ${issues.length} issues found`
  };
}
