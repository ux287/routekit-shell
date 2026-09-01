/**
 * Planner Context Module
 *
 * Handles RAG snippet fetching, code context injection, and keyword extraction
 * for the planning workflow.
 */

import fs from "fs";
import path from "path";
import { getCodeSnippets, getCodeSnippetsWithScores } from "../rag-context.mjs";
import { getRagContext } from "../rag-context.mjs";
import { getTelemetryCollector } from "@routekit/telemetry";
import { getLastEmbedTime } from "@routekit/rag";
import { loadNoteContent } from "../dendron-notes.mjs";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseTargetsFromMarkdown, loadEditableTargets, resolveTargetPaths, looksLikeGlob, parseImplementationCodeBlocks } from "../llm/targets.mjs";
import { extractCreateFileBlocks } from "./planner-utils.mjs";
import { readPackageScripts, formatScriptsForPrompt, readPackageDependencies, formatDependenciesForPrompt, summarizeProblemNote, truncateText } from "./planner-prompts.mjs";
import { readLiveTargetContent } from "./planner-live-read.mjs";
import matter from "gray-matter";

const PLANNER_DEBUG = process.env.ROUTEKIT_PLANNER_DEBUG === "1";

/**
 * Story notes accumulate `### Target:` sections and `@@SEARCH/@@REPLACE` blocks
 * appended by refine passes. Once the note exceeds this threshold, these blocks
 * are pruned before planning to prevent RAG context budget exhaustion.
 */
export const PLAN_NOTE_PRUNE_THRESHOLD_BYTES = 5120;

/**
 * Decide which body-derived create-file paths (from `### Target:` headings or `// CREATE FILE:`
 * directives) may be folded into frontmatterCreateFiles. Frontmatter op:edit is authoritative —
 * an explicit edit target is never folded as a create, even when the body carries a create-signal
 * for it. Folding an edit target as create re-stamps op:edit→op:create downstream and triggers a
 * false incomplete_target_coverage rejection (see uat-calc-0629-2).
 * @param {Iterable<string>} bodyCreatePaths
 * @param {Set<string>} frontmatterEditFiles - explicit op:edit target paths
 * @returns {string[]}
 */
export function foldableCreatePaths(bodyCreatePaths, frontmatterEditFiles) {
  return [...bodyCreatePaths].filter((p) => !frontmatterEditFiles.has(p));
}

function plannerDebug(...args) {
  if (!PLANNER_DEBUG) return;
  console.error("[planner-context]", ...args);
}

/**
 * Strips accumulated refine-context blocks from a story note body when it exceeds
 * the size threshold. Removes `### Target:` sections (added by add_code_snippet)
 * and `@@SEARCH/@@REPLACE/@@END` block groups (added by add_search_pattern) while
 * preserving frontmatter and `## ` (two-hash) sections: Problem, Solution,
 * Acceptance Criteria, Target Files.
 *
 * backlog.fix.hardcap-prune-destroys-authored-anchors: @@SEARCH…@@END anchor blocks are NEVER
 * removed by this function, on either path. They were previously shed under `capMode`; that
 * destroyed author-declared anchors, which since v0.41.0 are a story's deliverable rather than
 * refine-loop sediment. An over-cap body is now returned un-shed and the fact is reported.
 *
 * @param {string} body - Story note body (may include frontmatter)
 * @param {{ threshold?: number, capMode?: boolean, report?: object }} opts - `capMode` enables the
 *   hard-cap check: when the body still exceeds `threshold` after the base prune, the body is
 *   returned UNCHANGED and, if `report` is supplied, it is populated with
 *   `{ overflow, bodyBytes, threshold, anchorBlocks, anchorsShed }`. `report` is an out-param
 *   because the return type must stay a string — the other production caller assigns it directly.
 * @returns {string} Pruned body (unchanged if under threshold)
 */
export function pruneRefineBlocks(body, opts = {}) {
  if (!body || typeof body !== 'string') return body;
  const threshold = opts.threshold ?? PLAN_NOTE_PRUNE_THRESHOLD_BYTES;
  if (body.length <= threshold) return body;

  const lines = body.split('\n');
  const result = [];
  let skipUntilNextSection = false;
  let inAnchorBlock = false;
  let inCreateBlock = false;

  for (const line of lines) {
    // ### Target: sections appended by add_code_snippet — strip until the next header.
    // These can be hundreds of lines (full-file snapshots). Strip them.
    if (/^###\s+Target:/.test(line)) {
      skipUntilNextSection = true;
      inAnchorBlock = false;
      inCreateBlock = false;
      // backlog.fix.refine-prune-destroys-authored-create-blocks — THIS `continue` IS
      // LOAD-BEARING and must be retained. The close test below now matches any heading level,
      // including `### `, so without this early exit the opening line would immediately close
      // its own zone and the prune would become a total no-op.
      continue;
    }

    // Headers of ANY level close the skip zone — always preserve them.
    //
    // backlog.fix.refine-prune-destroys-authored-create-blocks: this used to be `/^##\s+/`,
    // which cannot match `### ` (after `##` comes `#`, not whitespace). A skip zone opened by a
    // level-3 `Target:` header therefore ran to the next LEVEL-2 header, swallowing every
    // authored level-3 section in between — including `// CREATE FILE:` blocks, which are the
    // PO-mandated shape for an op:create target. Two field instances destroyed 329 and 384
    // lines this way while the call returned ok:true.
    //
    // ADVISORY (carried from ARCH): this also matches heading-like lines INSIDE a fenced
    // snapshot and closes the zone early. That exposure exists today at level 2 and is widened
    // to levels 3-6. It errs toward preserving content, which is the safe direction for a
    // data-loss fix; the original-prune-purpose tests are the guard.
    if (/^#{2,6}\s+/.test(line)) {
      skipUntilNextSection = false;
      inAnchorBlock = false;
      inCreateBlock = false;
    }

    // `// CREATE FILE:` directives and the fenced block that follows them are the author's
    // DELIVERABLE for an op:create target, exactly as @@SEARCH groups are for an op:edit one.
    // Exempted here — above the skip check — for the same reason anchors are: they must
    // survive regardless of note size or of which zone they happen to sit in.
    if (/^\s*\/\/\s*CREATE\s+FILE\s*:/i.test(line)) {
      inCreateBlock = true;
      result.push(line);
      continue;
    }
    if (inCreateBlock) {
      result.push(line);
      // The directive's fence closes the exemption. Track open/close so the snapshot lines
      // that may follow resume skipping.
      if (/^\s*```/.test(line)) {
        if (inCreateBlock === 'open') inCreateBlock = false;
        else inCreateBlock = 'open';
      }
      continue;
    }

    // The out-of-band context marker is a single line appended at body end by refine's
    // add_code_snippet handler, and plan-ready reads it to decide context was supplied for a
    // target. When a body's final section is an unclosed `Target:` span the marker lands
    // inside the skip zone, so it needs the same exemption the content it stands in for has.
    if (/^\s*<!--\s*rks:context-out-of-band:/.test(line)) {
      result.push(line);
      continue;
    }

    // @@SEARCH/@@REPLACE/@@END corrective anchor blocks are SMALL and load-bearing — the
    // planner reads them to generate search_replace steps (stripping them makes it fall
    // through to note steps: no_search_pattern_for_modify). add_search_pattern injects them
    // INSIDE ### Target: sections (after the snapshot fence), so they land in the skip zone.
    // Emit the whole @@SEARCH…@@END group even while skipping the surrounding snapshot —
    // corrections must survive regardless of note size. @@END closes the block so the
    // snapshot lines that follow resume skipping.
    if (/^@@SEARCH\b/.test(line)) inAnchorBlock = true;
    if (inAnchorBlock) {
      result.push(line);
      if (/^@@END\b/.test(line)) inAnchorBlock = false;
      continue;
    }

    if (skipUntilNextSection) continue;

    result.push(line);
  }

  let pruned = result.join('\n');

  // ── backlog.fix.refine-prune-destroys-authored-create-blocks: COUNT WHAT WAS LOST ──────────
  //
  // These are computed as a pre/post DELTA over the real input and the real output. The field
  // they replace, `anchorsShed`, was the literal `0` — a constant that could not report loss in
  // the one case it existed to describe, and which sat beside a message asserting nothing had
  // been shed from a note that had just lost 13KB.
  //
  // Populated whenever a report out-param is supplied AND the base prune ran, not only inside
  // the capMode overflow branch below: a prune that removes content and then lands under
  // threshold reported nothing at all, which is the field profile.
  if (opts.report && typeof opts.report === 'object') {
    const countIn = (text, re) => (text.match(re) || []).length;
    const CREATE_RE = /^\s*\/\/\s*CREATE\s+FILE\s*:/gim;
    const FENCE_RE = /^\s*```/gm;
    const ANCHOR_RE = /^@@SEARCH\b/gm;

    opts.report.linesShed = body.split('\n').length - pruned.split('\n').length;
    opts.report.createDirectivesShed = countIn(body, CREATE_RE) - countIn(pruned, CREATE_RE);
    opts.report.fencesShed = countIn(body, FENCE_RE) - countIn(pruned, FENCE_RE);
    opts.report.anchorsShed = countIn(body, ANCHOR_RE) - countIn(pruned, ANCHOR_RE);
  }

  // ── backlog.fix.hardcap-prune-destroys-authored-anchors: REFUSE AND REPORT ───────────────────
  //
  // This branch used to call shedOldestAnchorBlocks, which spliced @@SEARCH…@@END groups
  // oldest-first and kept only the LAST block in document order. That function is deleted.
  //
  // WHY IT WAS WRONG. It was written for refine-loop sediment — accumulated corrective anchors
  // where "the youngest is the live fix" is a sound heuristic. v0.41.0's
  // backlog.fix.po-prompt-edit-target-anchor-obligation made PO author an @@SEARCH anchor for
  // EVERY op:edit target, so a note's anchors are now the author's DELIVERABLE, co-equal and
  // simultaneous. There is no timestamp, no provenance and no age metadata anywhere on this path
  // — "oldest" was only ever document position. Applying a recency heuristic to a set with no
  // recency ordering deleted N-1 of N and called it garbage collection. A child project lost 4 of
  // 5 while rks_refine_apply returned ok: true.
  //
  // WHY REFUSING IS SAFE. An oversized note is recoverable; a destroyed one is not. The base
  // prune above already strips `### Target:` snapshots, which are the actual bloat source
  // (hundreds of lines of full-file content). Anchor blocks are small. A note still over cap
  // after that strip is unusual and worth surfacing, not worth silently mutilating.
  //
  // The return type is UNCHANGED — still a string. planner-context.mjs's other production caller
  // does `planningText = pruneRefineBlocks(planningText)` and several tests pin the return shape,
  // so the overflow fact travels by out-param instead.
  if (opts.capMode && pruned.length > threshold) {
    if (opts.report && typeof opts.report === 'object') {
      opts.report.overflow = true;
      opts.report.bodyBytes = pruned.length;
      opts.report.threshold = threshold;
      // A census of SURVIVORS. Named so it cannot be mistaken for a damage report — the four
      // *Shed counters above carry the loss, and are set on every reporting call.
      opts.report.anchorBlocks = countAnchorBlocks(pruned);
    }
  }

  return pruned;
}

/**
 * Count complete @@SEARCH…@@END anchor blocks in a body.
 *
 * backlog.fix.hardcap-prune-destroys-authored-anchors: reported alongside an overflow so a caller
 * can say how much authored content it declined to touch, rather than reporting only a byte count.
 *
 * @param {string} body
 * @returns {number}
 */
function countAnchorBlocks(body) {
  let count = 0;
  let open = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^@@SEARCH\b/.test(line)) open = true;
    else if (open && /^@@END\b/.test(line)) { count++; open = false; }
  }
  return count;
}

/**
 * Thin wrapper around rag-context.getCodeSnippets with planner debug logging
 * and telemetry emission.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} targetPath - Target file path relative to project root
 * @param {string} queryText - Query text for RAG search
 * @param {number} k - Number of snippets to return (default: 3)
 * @param {string} projectId - Project identifier for telemetry
 * @param {string} slug - Run slug for telemetry
 * @returns {Promise<string[]>} Array of code snippets
 */
export async function fetchCodeSnippets(projectRoot, targetPath, queryText, k = 3, projectId = null, slug = null) {
  const startTime = Date.now();
  try {
    plannerDebug(`fetchCodeSnippets: targetPath=${targetPath}, queryText.length=${queryText?.length || 0}, k=${k}`);
    const scoredSnippets = await getCodeSnippetsWithScores(projectRoot, targetPath, queryText, k);
    const snippets = scoredSnippets.map(s => s.text);

    // Emit telemetry for snippet fetch
    try {
      const collector = getTelemetryCollector();
      collector.emit("planning.snippets", projectId || "unknown", {
        targetFile: targetPath,
        queryText: (queryText || "").slice(0, 100),
        snippetsReturned: snippets.length,
        relevanceScores: scoredSnippets.map(s => s.score),
        slug: slug || "unknown",
        duration_ms: Date.now() - startTime,
        status: "success"
      });
    } catch (e) { /* telemetry is best-effort */ }

    plannerDebug(`fetchCodeSnippets: got ${snippets.length} snippets for ${targetPath}`);
    if (snippets.length > 0) {
      plannerDebug(`first snippet preview: ${snippets[0]?.slice(0, 100)}...`);
    }
    return snippets;
  } catch (error) {
    console.error(`[planner-context] fetchCodeSnippets failed for ${targetPath}: ${error.message}`);

    // Emit failure telemetry
    try {
      const collector = getTelemetryCollector();
      collector.emit("planning.snippets", projectId || "unknown", {
        targetFile: targetPath,
        snippetsReturned: 0,
        slug: slug || "unknown",
        duration_ms: Date.now() - startTime,
        status: "failed",
        error: error.message
      });
    } catch (e) { /* telemetry is best-effort */ }

    return [];
  }
}

/**
 * Inject code snippets into an array of prompt parts. Call this from prompt-building when
 * adding context for search_replace guidance.
 *
 * This enhanced variant also appends basic file information (line counts) and a warning when
 * the target file appears large (>500 lines). The extra context nudges the LLM to prefer
 * search_replace steps, require anchor markers for edit_file, or split edits into smaller steps.
 *
 * @param {string[]} parts - Array of prompt parts to append to
 * @param {string} projectRoot - Project root directory
 * @param {string} targetPath - Target file path relative to project root
 * @param {string} queryText - Query text for RAG search
 * @param {number} k - Number of snippets to fetch (default: 3)
 */
export async function injectCodeSnippetsIntoPrompt(parts, projectRoot, targetPath, queryText, k = 3) {
  const snippets = await fetchCodeSnippets(projectRoot, targetPath, queryText, k);
  if (snippets && snippets.length) {
    parts.push("\n--- Begin RAG code snippets ---\n");
    for (const s of snippets) parts.push(s);
    parts.push("\n--- End RAG code snippets ---\n");
  }

  // Append lightweight file info and planner guidance to help the LLM choose safer edit strategies
  try {
    if (targetPath) {
      const p = path.join(projectRoot, targetPath);
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        const lines = content.split("\n").length;
        parts.push(`\n[FILE_INFO] path=${targetPath}, lines=${lines}\n`);
        if (lines > 500) {
          parts.push("\n[PLANNER_WARN] Target file appears large (>500 lines). Prefer search_replace and split edits. If proposing edit_file, include unique anchor/marker blocks and a brief justification.\n");
        }
      }
    }
  } catch (e) {
    console.error(`[planner-context] injectCodeSnippetsIntoPrompt file-size check failed for ${targetPath}: ${e?.message}`);
  }
}

/**
 * Extract keywords from story content for RAG query construction.
 * Focuses on function names, class names, and technical terms.
 *
 * @param {string} storyContent - Raw story content
 * @returns {string[]} Array of extracted keywords (max 15)
 */
export function extractKeywordsFromStory(storyContent) {
  if (!storyContent) return [];
  const keywords = new Set();

  // Extract function/method names (common patterns)
  const funcPatterns = storyContent.match(/\b(?:function|async function|const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/g) || [];
  for (const match of funcPatterns) {
    const name = match.replace(/^(?:function|async function|const|let|var)\s+/, '');
    if (name.length > 2) keywords.add(name);
  }

  // Extract mentioned function names in prose (e.g., "modify runFoo function")
  const proseFunc = storyContent.match(/\b(run[A-Z][a-zA-Z0-9]*|get[A-Z][a-zA-Z0-9]*|set[A-Z][a-zA-Z0-9]*|handle[A-Z][a-zA-Z0-9]*|on[A-Z][a-zA-Z0-9]*|fetch[A-Z][a-zA-Z0-9]*|build[A-Z][a-zA-Z0-9]*)\b/g) || [];
  for (const name of proseFunc) {
    if (name.length > 3) keywords.add(name);
  }

  // Extract CamelCase identifiers (likely class/function names)
  const camelCase = storyContent.match(/\b([A-Z][a-z]+[A-Z][a-zA-Z0-9]*)\b/g) || [];
  for (const name of camelCase) {
    if (name.length > 3 && !['JavaScript', 'TypeScript'].includes(name)) {
      keywords.add(name);
    }
  }

  // Extract quoted strings that look like identifiers
  const quoted = storyContent.match(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g) || [];
  for (const q of quoted) {
    const name = q.replace(/`/g, '');
    if (name.length > 2 && !['const', 'let', 'var', 'function'].includes(name)) {
      keywords.add(name);
    }
  }

  // Extract technical terms from acceptance criteria
  const acTerms = storyContent.match(/- \[[ x]\]\s+(.+)/g) || [];
  for (const ac of acTerms) {
    const terms = ac.match(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\b/g) || [];
    for (const term of terms) {
      if (!['should', 'must', 'when', 'that', 'with', 'from', 'this', 'each', 'file', 'code'].includes(term.toLowerCase())) {
        keywords.add(term);
      }
    }
  }

  return [...keywords].slice(0, 15); // Limit to 15 most relevant keywords
}

/**
 * Get code context for a target file — RAG first, file-read fallback.
 *
 * Unified code context retrieval for all consumers (planner, refine, etc.).
 * Tries RAG semantic search first. If RAG returns empty or errors,
 * falls back to reading the file directly from disk.
 *
 * @param {string} projectRoot - Project root directory
 * @param {string} targetPath - Target file path relative to project root
 * @param {string} queryText - Query text for RAG search (optional for file-read fallback)
 * @param {{ k?: number, projectId?: string, slug?: string, maxLines?: number }} opts
 * @returns {Promise<{ source: 'rag'|'file'|'none', snippets: string[], content?: string }>}
 */
export async function getCodeContext(projectRoot, targetPath, queryText, { k = 3, projectId = null, slug = null, maxLines = 200 } = {}) {
  // Try RAG first
  try {
    const snippets = await fetchCodeSnippets(projectRoot, targetPath, queryText || targetPath, k, projectId, slug);
    if (snippets && snippets.length > 0) {
      plannerDebug(`getCodeContext: RAG returned ${snippets.length} snippets for ${targetPath}`);
      return { source: 'rag', snippets };
    }
  } catch (e) {
    plannerDebug(`getCodeContext: RAG failed for ${targetPath}: ${e.message}`);
  }

  // Fallback: read file directly
  try {
    const absPath = path.join(projectRoot, targetPath);
    if (fs.existsSync(absPath)) {
      const content = fs.readFileSync(absPath, "utf8");
      const lines = content.split("\n");
      const truncated = lines.length > maxLines
        ? lines.slice(0, maxLines).join("\n") + `\n// ... (${lines.length - maxLines} more lines)`
        : content;
      plannerDebug(`getCodeContext: file-read fallback for ${targetPath} (${lines.length} lines)`);
      return { source: 'file', snippets: [truncated], content: truncated };
    }
  } catch (e) {
    plannerDebug(`getCodeContext: file-read fallback failed for ${targetPath}: ${e.message}`);
  }

  return { source: 'none', snippets: [] };
}

/**
 * Check if RAG index is fresh (all notes and code files are older than last embed).
 */
export function isRagIndexFresh(projectRoot, notesDir) {
  try {
    const lastEmbedMs = getLastEmbedTime(projectRoot);
    if (!lastEmbedMs) return false;
    const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
    for (const f of noteFiles) {
      const noteStat = fs.statSync(path.join(notesDir, f));
      if (noteStat.mtimeMs > lastEmbedMs) return false;
    }
    const codeDirs = ["src", "packages", "scripts"];
    for (const topDir of codeDirs) {
      const absDir = path.join(projectRoot, topDir);
      if (!fs.existsSync(absDir)) continue;
      if (fs.statSync(absDir).mtimeMs > lastEmbedMs) return false;
      try {
        for (const sub of fs.readdirSync(absDir)) {
          const subPath = path.join(absDir, sub);
          try {
            const st = fs.statSync(subPath);
            if (st.isDirectory() && st.mtimeMs > lastEmbedMs) return false;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    return true;
  } catch { return false; }
}

/**
 * Get list of notes changed since last RAG embed.
 */
export function getChangedNotesSinceEmbed(projectRoot, notesDir) {
  try {
    const lastEmbedMs = getLastEmbedTime(projectRoot);
    if (!lastEmbedMs) return null;
    const changed = [];
    const noteFiles = fs.readdirSync(notesDir).filter(f => f.endsWith(".md"));
    for (const f of noteFiles) {
      const noteStat = fs.statSync(path.join(notesDir, f));
      if (noteStat.mtimeMs > lastEmbedMs) changed.push(f);
    }
    return changed;
  } catch { return null; }
}

/**
 * Gather all target context for planning: load problem note, resolve targets,
 * fetch RAG snippets, build planning text. Extracted from runPlanTool Phase 2.
 *
 * @param {object} ctx - Planning context from Phase 1
 * @param {string} ctx.projectRoot
 * @param {string} ctx.projectId
 * @param {string|null} ctx.normalizedProblem
 * @param {string|null} ctx.normalizedTask
 * @param {object} ctx.context - Project context from loadContext()
 * @param {string} ctx.finalSlug
 * @param {string|null} ctx._enhancedContext - Enhanced context for note-only retries
 * @returns {Promise<object>} Target context with problemNote, planningText, enhancedEditableTargets, etc.
 */
export async function gatherTargetContext({ projectRoot, projectId, normalizedProblem, normalizedTask, context, finalSlug, _enhancedContext }) {
  const collector = getTelemetryCollector();

  // Load problem note
  let problemNote = null;
  if (normalizedProblem) {
    try {
      problemNote = loadNoteContent(projectRoot, normalizedProblem);
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, error.message || `Problem note not found: ${normalizedProblem}`);
    }
    // Check if already implemented — skip planning
    const fmMatch = problemNote?.content?.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch && fmMatch[1]) {
      const statusMatch = fmMatch[1].match(/^status:\s*(.+)$/m);
      if (statusMatch && statusMatch[1].trim().toLowerCase() === "implemented") {
        console.error(`[rks.plan] skipping ${normalizedProblem} - status: implemented`);
        return { skipped: true, reason: "already-implemented", problemId: normalizedProblem };
      }
    }
  }

  // Build planning text
  let planningText = normalizedTask || problemNote?.content || "";
  if (_enhancedContext) {
    planningText = planningText + "\n\n" + _enhancedContext;
  }
  if (!planningText) {
    throw new McpError(ErrorCode.InvalidParams, "Unable to derive planning context from task or problem note.");
  }

  // Prune accumulated refine-context blocks before passing to RAG and prompt construction.
  // Prevents note bloat from consuming the planner's context budget after multiple refine passes.
  planningText = pruneRefineBlocks(planningText);

  // Fetch RAG context
  const ragContext = await getRagContext(projectRoot, planningText);
  console.error(`[rks.plan] project=${projectId} rag hits: notes=${ragContext.notes.length} code=${ragContext.code.length} kg=${ragContext.kg.length}`);

  const pkgScripts = readPackageScripts(projectRoot);
  const pkgDeps = readPackageDependencies(projectRoot);
  const analysis = null; // Analysis loaded separately if needed

  // Build context prompt
  const sections = [];
  if (planningText) sections.push(planningText);
  sections.push(...formatScriptsForPrompt(pkgScripts));
  sections.push(...formatDependenciesForPrompt(pkgDeps));
  const addSection = (items, label) => {
    if (!items?.length) return;
    const lines = items.slice(0, 3).map((item) => `- ${item.path || item.slug}: ${truncateText(item.text)}`);
    sections.push(`${label}:\n${lines.join("\n")}`);
  };
  addSection(ragContext.notes, "RAG notes");
  addSection(ragContext.code, "RAG code");
  addSection(ragContext.kg, "RAG kg");
  const planningSource = sections.join("\n\n");
  const planSummary = summarizeProblemNote(problemNote?.content || planningText);

  // Extract targetFiles from frontmatter
  let frontmatterTargets = [];
  let frontmatterCreateFiles = new Set();
  // Frontmatter op is the source of truth: explicit op:edit targets must never be re-stamped
  // op:create by body create-signals (### Target: headings, // CREATE FILE: directives).
  const frontmatterEditFiles = new Set();
  let targetFilesFormat = "none";
  let storyMeta = null;
  if (problemNote?.content) {
    try {
      const parsed = matter(String(problemNote.content));
      if (parsed.data?.testStory || parsed.data?.codeStory) {
        storyMeta = { testStory: parsed.data.testStory, codeStory: parsed.data.codeStory };
      }
      const tfData = parsed.data?.targetFiles;
      if (Array.isArray(tfData) && tfData.length > 0) {
        frontmatterTargets = tfData.map(f => {
          if (typeof f === 'object' && f !== null) {
            if (f.path && typeof f.path === 'string') {
              const isCreate = f.action === "CREATE" || f.create === true || f.op === "create";
              if (isCreate) frontmatterCreateFiles.add(f.path);
              else if (f.op === "edit" || f.action === "EDIT" || f.edit === true) frontmatterEditFiles.add(f.path);
              return f.path;
            }
            const altPath = f.file || f.name || f.target;
            if (altPath && typeof altPath === 'string') {
              const isCreate = f.action === "CREATE" || f.create === true || f.op === "create";
              if (isCreate) frontmatterCreateFiles.add(altPath);
              else if (f.op === "edit" || f.action === "EDIT" || f.edit === true) frontmatterEditFiles.add(altPath);
              return altPath;
            }
            for (const key of Object.keys(f)) {
              const val = f[key];
              if (typeof val === 'string' && (val.includes('/') || val.includes('.'))) return val;
            }
            return null;
          }
          if (typeof f === 'string') {
            if ((f.startsWith('"') && f.endsWith('"')) || (f.startsWith("'") && f.endsWith("'"))) return f.slice(1, -1);
            return f;
          }
          return null;
        }).filter(Boolean);
        targetFilesFormat = "array";
      } else if (typeof tfData === 'string' && tfData.trim()) {
        frontmatterTargets = [tfData.trim()];
        targetFilesFormat = "single-line";
      }
    } catch (e) {
      console.error(`[planner] failed to parse targetFiles from frontmatter: ${e?.message}`);
    }
  }

  // Parse CREATE FILE directives from story body
  const automatedSteps = [];
  if (problemNote?.content) {
    const createFileBlocks = extractCreateFileBlocks(problemNote.content);
    const implementationBlocks = parseImplementationCodeBlocks(problemNote.content);
    const allCreateBlocks = new Map([...implementationBlocks, ...createFileBlocks]);
    // Frontmatter op:edit wins — never let a body create-signal re-stamp an explicit edit
    // target as op:create (caused a false incomplete_target_coverage; see uat-calc-0629-2).
    for (const filePath of foldableCreatePaths(createFileBlocks.keys(), frontmatterEditFiles)) {
      frontmatterCreateFiles.add(filePath);
    }
    let stepOrder = 1;
    for (const [filePath, content] of allCreateBlocks) {
      if (content) {
        automatedSteps.push({
          id: `create-${stepOrder}`,
          action: "create_file",
          path: filePath,
          content,
          title: `Create ${filePath}`,
          description: `Create new file from story code block`,
          order: stepOrder,
        });
        stepOrder++;
      }
    }
    for (const filePath of frontmatterCreateFiles) {
      if (!allCreateBlocks.has(filePath)) {
        console.error(`[planner] create file ${filePath} has no matching code block`);
      }
    }
    if (automatedSteps.length > 0) {
      console.error(`[planner] Generated ${automatedSteps.length} create_file steps from story code blocks`);
    }
  }

  // Emit telemetry for targetFiles parsing
  try {
    collector.emit("plan.targetfiles.parsed", projectId, {
      count: frontmatterTargets.length,
      format: targetFilesFormat,
      slug: finalSlug,
    });
  } catch { /* telemetry is best-effort */ }

  // Resolve target paths and load editable targets
  const plannerMode = process.env.RKS_PLANNER_MODE || "full";
  const markdownTargets = parseTargetsFromMarkdown(problemNote?.content || planningText);
  const editableTargetPaths = [...new Set([...frontmatterTargets, ...markdownTargets])];
  const resolvedTargets = resolveTargetPaths(projectRoot, editableTargetPaths, { maxFiles: 80 });
  const editableTargets = loadEditableTargets(projectRoot, editableTargetPaths, { plannerMode, maxFiles: 80 });

  // Merge non-existent targets as create_file candidates
  const existingPaths = new Set(editableTargets.map((t) => t.path));
  const createTargets = (resolvedTargets.allowPatterns || [])
    .filter((p) => !existingPaths.has(p) && !looksLikeGlob(p))
    .map((p) => {
      const abs = path.join(projectRoot, p);
      if (fs.existsSync(abs)) {
        // File exists on disk — regardless of frontmatter op, treat as existing
        return { path: p, summary: "(existing file - use search_replace for edits)", content: "" };
      }
      if (frontmatterCreateFiles.has(p)) {
        return { path: p, summary: "(new file - to be created, marked create:true in frontmatter)", content: "" };
      }
      return { path: p, summary: "(new file - to be created)", content: "" };
    });
  const allEditableTargets = [...editableTargets, ...createTargets];

  // Enhance targets with RAG code snippets
  let targetsNotFound = 0;
  let targetsToCreate = 0;
  const storyKeywords = extractKeywordsFromStory(problemNote?.content || planningText);
  const enhancedEditableTargets = await Promise.all(
    allEditableTargets.map(async (target) => {
      if (!target.path) return target;
      if (target.summary?.includes("to be created")) {
        targetsToCreate++;
        return target;
      }
      const keywordStr = storyKeywords.length > 0 ? storyKeywords.slice(0, 8).join(' ') + ' ' : '';
      const queryText = `${keywordStr}in ${target.path}`;
      try {
        collector.emit("plan.rag.query_built", projectId, {
          targetFile: target.path, keywords: storyKeywords.slice(0, 8),
          queryLength: queryText.length, slug: finalSlug,
        });
      } catch { /* telemetry */ }

      const snippets = await fetchCodeSnippets(projectRoot, target.path, queryText, 10, projectId, finalSlug);
      if (snippets && snippets.length > 0) {
        const keywordsLower = storyKeywords.map(kw => kw.toLowerCase());
        const relevantSnippets = snippets.filter(s => keywordsLower.some(kw => s.toLowerCase().includes(kw)));
        const matchedKeywords = keywordsLower.filter(kw => snippets.some(s => s.toLowerCase().includes(kw)));
        try {
          collector.emit("plan.rag.relevance_check", projectId, {
            targetFile: target.path, snippetsReturned: snippets.length,
            snippetsWithKeywords: relevantSnippets.length, keywordsMatched: matchedKeywords, slug: finalSlug,
          });
          if (relevantSnippets.length === 0 && storyKeywords.length > 0) {
            collector.emit("plan.rag.low_relevance", projectId, {
              targetFile: target.path, keywords: storyKeywords.slice(0, 8),
              snippetsReturned: snippets.length, slug: finalSlug,
            });
          }
        } catch { /* telemetry */ }
        return { ...target, ragSnippets: snippets, summary: target.summary ? `${target.summary} (has ${snippets.length} RAG snippets)` : `(has ${snippets.length} RAG snippets)` };
      } else {
        targetsNotFound++;
        const MAX_DIRECT_READ_LINES = 2000;
        try {
          const abs = path.join(projectRoot, target.path);
          if (fs.existsSync(abs)) {
            const fileContent = fs.readFileSync(abs, "utf8");
            const lineCount = fileContent.split("\n").length;
            if (lineCount <= MAX_DIRECT_READ_LINES) {
              try { collector.emit("plan.snippets.fetch_failed", projectId, { targetFile: target.path, reason: "no_snippets", fallback: "direct_read", lineCount, slug: finalSlug }); } catch { }
              return { ...target, ragSnippets: [fileContent], summary: target.summary ? `${target.summary} (has 1 direct-read snippet)` : `(has 1 direct-read snippet)` };
            }
          }
        } catch { /* direct read failed */ }
        try { collector.emit("plan.snippets.fetch_failed", projectId, { targetFile: target.path, reason: "no_snippets", fallback: "none", slug: finalSlug }); } catch { }
        return target;
      }
    })
  );

  // Telemetry summary
  const withSnippets = enhancedEditableTargets.filter((t) => t.ragSnippets?.length > 0);
  try {
    collector.emit("plan.snippets.summary", projectId, { totalTargets: enhancedEditableTargets.length, targetsWithSnippets: withSnippets.length, totalSnippets: withSnippets.reduce((sum, t) => sum + (t.ragSnippets?.length || 0), 0), slug: finalSlug });
    collector.emit("plan.targetfiles.processed", projectId, { total: enhancedEditableTargets.length, withSnippets: withSnippets.length, notFound: targetsNotFound, toCreate: targetsToCreate, slug: finalSlug });
  } catch { /* telemetry */ }

  // Augment edit targets with verbatim live disk content (RAG-guided line-range read).
  // This gives the LLM authoritative current file content rather than story-baked snapshots
  // that may have gone stale if a sibling story modified the file.
  // Skip live read only when the file genuinely does not exist on disk — use fs.existsSync
  // rather than summary string matching, which can be wrong when frontmatter op:create
  // is applied to an existing file.
  const enhancedWithLiveContent = enhancedEditableTargets.map(target => {
    if (!target.path) return target;
    if (!fs.existsSync(path.join(projectRoot, target.path))) return target; // genuinely new file
    const liveRead = readLiveTargetContent(projectRoot, target.path, target.ragSnippets || []);
    if (!liveRead) return target;
    return { ...target, liveContent: liveRead };
  });

  return {
    problemNote,
    planningText,
    planningSource,
    planSummary,
    ragContext,
    pkgScripts,
    frontmatterTargets,
    frontmatterCreateFiles,
    editableTargetPaths,
    resolvedTargets,
    enhancedEditableTargets: enhancedWithLiveContent,
    automatedSteps,
    storyMeta,
    targetFilesFormat,
  };
}

/**
 * Detects truncation markers in RAG-retrieved content.
 * Truncation occurs when a file is too large for the RAG index to store in full.
 * Pattern: `// ... (N lines omitted) ...`
 *
 * @param {string} content - RAG-injected context string
 * @returns {boolean} true if any truncation marker is present
 */
export function hasRagTruncation(content) {
  if (!content || typeof content !== "string") return false;
  return /\/\/ \.\.\. \(\d+ lines omitted\) \.\.\./.test(content);
}

/**
 * Extracts @@SEARCH/@@REPLACE/@@END blocks from a story note for a specific target file.
 *
 * Expected format in story note:
 * ```
 * ### path/to/file
 * @@SEARCH
 * <search pattern>
 * @@REPLACE
 * <replacement content>
 * @@END
 * ```
 *
 * Multiple blocks per file section are supported.
 * File matching: exact path, or suffix match (e.g. "exec.mjs" matches "packages/.../exec.mjs").
 *
 * @param {string} storyContent - Full story note content
 * @param {string} targetFile - Target file path to extract blocks for
 * @returns {{ search: string, replace: string }[]} Array of search/replace pairs
 */
export function extractSearchReplaceBlocks(storyContent, targetFile) {
  if (!storyContent || typeof storyContent !== "string") return [];
  if (!targetFile) return [];

  const lines = storyContent.split("\n");
  const blocks = [];
  let inTargetSection = false;
  let inBlock = false;
  let inReplace = false;
  let searchLines = null;
  let replaceLines = null;

  for (const line of lines) {
    // Section header: ### some/path
    const headerMatch = line.match(/^###\s+(.+)/);
    if (headerMatch) {
      const headerPath = headerMatch[1].trim();
      inTargetSection =
        headerPath === targetFile ||
        headerPath.endsWith("/" + targetFile) ||
        targetFile.endsWith("/" + headerPath);
      // Reset block state on section change
      inBlock = false;
      inReplace = false;
      searchLines = null;
      replaceLines = null;
      continue;
    }

    if (!inTargetSection) continue;

    if (line === "@@SEARCH") {
      inBlock = true;
      inReplace = false;
      searchLines = [];
      replaceLines = null;
      continue;
    }

    if (line === "@@REPLACE" && inBlock) {
      inReplace = true;
      replaceLines = [];
      continue;
    }

    if (line === "@@END" && inBlock) {
      if (searchLines !== null && replaceLines !== null) {
        blocks.push({
          search: searchLines.join("\n"),
          replace: replaceLines.join("\n"),
        });
      }
      inBlock = false;
      inReplace = false;
      searchLines = null;
      replaceLines = null;
      continue;
    }

    if (inBlock) {
      if (inReplace) {
        replaceLines.push(line);
      } else {
        searchLines.push(line);
      }
    }
  }

  return blocks;
}

export default {
  fetchCodeSnippets,
  injectCodeSnippetsIntoPrompt,
  extractKeywordsFromStory,
  getCodeContext,
  isRagIndexFresh,
  getChangedNotesSinceEmbed,
  gatherTargetContext,
  hasRagTruncation,
  extractSearchReplaceBlocks,
};
