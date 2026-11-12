/**
 * Planner Utilities Module
 *
 * Contains utility functions for the planner: snippet reading, codemap management,
 * framework detection, plan status classification, and path helpers.
 */

import fs from "fs";
import path from "path";
import { getLastEmbedTime } from "@routekit/rag";
import { ensureDir, listRelativeFiles } from "./project.mjs";
import { truncateText } from "./planner-note-steps.mjs";
import { CREATE_HEADING_SUFFIX_SOURCE } from "../llm/targets.mjs";

export const MAX_SNIPPET_LINES = 80;

/**
 * Check if RAG index is fresh (all notes were embedded after their last modification)
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
    return true;
  } catch { return false; }
}

/**
 * Write JSON data to a file, ensuring parent directory exists
 */
export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Extract a summary from a problem note markdown
 * Tries: frontmatter title, first heading, or first paragraph
 */
export function summarizeProblemNote(markdown) {
  if (!markdown) return null;
  const frontMatterMatch = markdown.match(/^---\s*[\r\n]+([\s\S]*?)\n---/);
  if (frontMatterMatch) {
    const frontLines = frontMatterMatch[1].split(/\r?\n/);
    const titleLine = frontLines.find((line) => line.trim().toLowerCase().startsWith("title:"));
    if (titleLine) {
      const [, rawTitle = ""] = titleLine.split(":");
      const cleaned = rawTitle.trim();
      if (cleaned) return cleaned;
    }
  }
  const headingMatch = markdown.match(/^#\s+(.+)/m);
  if (headingMatch) return headingMatch[1].trim();
  const firstParagraph = markdown.split(/\n\s*\n/).find((block) => block.trim().length > 0);
  return firstParagraph ? truncateText(firstParagraph, 240) : null;
}

/**
 * Get the path to the codemap JSON file
 */
export function getCodemapPath(projectRoot, projectId) {
  return path.join(projectRoot, ".rks", "state", projectId, "codemap.json");
}

/**
 * Get the path to the analysis JSON file
 */
export function getAnalysisPath(projectRoot, projectId) {
  return path.join(projectRoot, ".rks", "state", projectId, "analysis.json");
}

/**
 * Read the codemap for a project
 */
export function readCodemap(projectRoot, projectId) {
  const codemapPath = getCodemapPath(projectRoot, projectId);
  if (!fs.existsSync(codemapPath)) return null;
  return { path: codemapPath, data: JSON.parse(fs.readFileSync(codemapPath, "utf8")) };
}

/**
 * Read the analysis for a project
 */
export function readAnalysis(projectRoot, projectId) {
  const analysisPath = getAnalysisPath(projectRoot, projectId);
  if (!fs.existsSync(analysisPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read a code snippet from a file
 */
export function readSnippet(projectRoot, relPath, maxLines = MAX_SNIPPET_LINES) {
  const abs = path.join(projectRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

/**
 * Extract a snippet from text around a pattern match
 */
export function extractSnippet(text, pattern, contextLines = 8) {
  if (!text) return null;
  const lines = text.split("\n");
  const idx = lines.findIndex((line) => pattern.test(line));
  if (idx === -1) return null;
  const start = Math.max(0, idx - contextLines);
  const end = Math.min(lines.length, idx + contextLines);
  return lines.slice(start, end).join("\n");
}

/**
 * Read a snippet for a specific target file, using known patterns or head fallback
 */
export function readSnippetForTarget(projectRoot, relPath, allowHeadFallback = false) {
  const text = readSnippet(projectRoot, relPath);
  if (!text) return null;
  if (allowHeadFallback) {
    return text;
  }
  const patterns = {
    "packages/mcp-rks/src/server.mjs": [/function runPlanTool/, /function buildNoteDrivenSteps/],
    "packages/mcp-rks/__tests__/planner.spec.mjs": [/describe\("LLM planner"/, /Fixture/],
    "packages/mcp-rks/src/llm/planner.mjs": [/function buildPrompt/, /function runLlmPlanner/],
    "notes/how-to.development-workflow.planning.md": [/## Planning Workflow/, /##/],
    "packages/cli/bin/routekit.js": [/run_command/, /whitelist/, /runCommandsFlag/],
  };
  const pats = patterns[relPath] || [];
  for (const pat of pats) {
    const snip = extractSnippet(text, pat);
    if (snip) return snip.split("\n").slice(0, MAX_SNIPPET_LINES).join("\n");
  }
  return null;
}

/**
 * Normalize a RAG path to be relative to project root
 */
export function normalizeRagPath(projectRoot, p) {
  if (!p) return null;
  return path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
}

/**
 * Classify the status of a plan based on its steps
 */
export function classifyPlanStatus({ steps = [], llmStatus = "note_only" } = {}) {
  // Check for any note steps - these indicate unresolved issues
  const hasNoteSteps = steps.some((s) => s?.action === "note");

  const hasExecutable = steps.some(
    (s) =>
      // edit_file or create_file with content
      ((s?.action === "edit_file" || s?.action === "create_file") &&
        s?.content &&
        String(s.content).trim().length > 0 &&
        s?.path) ||
      // search_replace with edits array
      (s?.action === "search_replace" &&
        Array.isArray(s?.edits) &&
        s.edits.length > 0 &&
        s?.path)
  );

  if (llmStatus === "error") return "error";
  // Plans with note steps are not executable - they need refinement
  if (hasNoteSteps) return "needs_refinement";
  return hasExecutable ? "executable" : "note_only";
}

/**
 * Get the runs root directory path
 */
export function runsRoot(projectRoot) {
  return path.join(projectRoot, ".rks", "runs");
}

/**
 * Detect framework from project files
 */
export function detectFrameworkFromFiles(projectRoot) {
  const candidates = [
    { id: "eleventy-nunjucks", files: [".eleventy.js"] },
    { id: "astro", files: ["astro.config.mjs", "astro.config.ts", "astro.config.js"] },
  ];
  for (const entry of candidates) {
    if (entry.files.some((f) => fs.existsSync(path.join(projectRoot, f)))) {
      return entry.id;
    }
  }
  return null;
}

/**
 * Build the codemap for a project
 */
export function buildCodemap({ projectRoot, projectId, kg } = {}) {
  const framework = kg?.framework || detectFrameworkFromFiles(projectRoot);
  const kgCodeRoots = Array.isArray(kg?.code_roots) && kg.code_roots.length
    ? kg.code_roots
    : framework === "eleventy-nunjucks"
      ? ["src", "notes"]
      : framework === "astro"
        ? ["src", "public", "notes"]
        : [path.join("src", "pages"), path.join("src", "components")];

  const codeMaps = {};
  for (const root of kgCodeRoots) {
    codeMaps[root] = listRelativeFiles(projectRoot, root);
  }

  const pageRoots = Array.isArray(kg?.codemap?.page_roots) && kg.codemap.page_roots.length
    ? kg.codemap.page_roots
    : framework === "eleventy-nunjucks"
      ? ["src"]
      : framework === "astro"
        ? [path.join("src", "pages")]
        : [path.join("src", "pages")];

  const componentRoots = Array.isArray(kg?.codemap?.component_roots) && kg.codemap.component_roots.length
    ? kg.codemap.component_roots
    : framework === "eleventy-nunjucks"
      ? [path.join("src", "_includes", "components"), path.join("src", "_includes", "layouts")]
      : [path.join("src", "components")];

  const collectRoots = (roots) =>
    Array.from(
      new Set(
        (roots || []).flatMap((root) => codeMaps[root] || listRelativeFiles(projectRoot, root))
      )
    ).sort();

  const pages = collectRoots(pageRoots);
  const components = collectRoots(componentRoots);
  const codemap = {
    projectId,
    generatedAt: new Date().toISOString(),
    framework,
    kg,
    pages,
    components,
    codeRoots: codeMaps,
  };

  return { framework, pages, components, codeMaps, codemap };
}

/**
 * Extract CREATE FILE directives from markdown story body.
 * Looks for // CREATE FILE: <path> patterns.
 * @returns {string[]} Array of file paths
 */
export function extractCreateFileDirectives(markdown) {
  const directives = [];
  if (!markdown) return directives;
  // backlog.fix.create-file-directive-grammar-not-reconciled: accept BOTH grammars.
  // The comment form is canonical and stays unanchored (it has always matched anywhere
  // on a line). The heading arm is LINE-ANCHORED, because every how-to, the PO prompt
  // and most story notes describe the grammar in backticks mid-sentence; an unanchored
  // heading arm would read each of those mentions as a real directive.
  const patterns = [
    /\/\/\s*CREATE\s+FILE:\s*(\S+)/gi,
    /^[^\S\n]*#{2,3}\s*CREATE\s+FILE:\s*(\S+)/gim,
  ];
  for (const regex of patterns) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(markdown)) !== null) {
      directives.push(match[1].trim());
    }
  }
  return directives;
}

// A directive must not bind a fence across a LATER directive: "tempered" span — no character
// of the gap may start another create directive (comment or heading form).
const NOT_ANOTHER_DIRECTIVE = String.raw`(?:(?!\/\/\s*CREATE\s+FILE:|^[^\S\n]*#{2,3}\s*CREATE\s+FILE:)[\s\S])*?`;
const FENCE = "```";

/**
 * Parse a `### ...` heading line into the path it names, or null. Accepts the exact path,
 * one pair of backticks around it, and one optional suffix from the shared suffix set.
 */
export function parseCreateHeadingPath(headingLine) {
  const re = new RegExp(String.raw`^###\s+` + "`?" + String.raw`([^\s` + "`" + String.raw`(]+)` + "`?" + CREATE_HEADING_SUFFIX_SOURCE + String.raw`\s*$`, "i");
  const m = String(headingLine || "").match(re);
  return m ? m[1].trim() : null;
}

/**
 * Extract CREATE FILE directives AND their following code blocks from markdown.
 * Looks for a create directive (comment form or line-anchored heading form) followed by a code
 * fence in the SAME ### section, then ### Target: <path> sections, then — for declared-create
 * paths only — an exact-path `### <path>` heading followed by a fence.
 *
 * backlog.fix.create-directive-binds-only-same-section: complete stories failed the create gate
 * because a directive listed under `## Target Files` never reached its fence under a later
 * `### <path>` heading, and a frontmatter op:create path with no directive bound nothing.
 *
 * @param {string} markdown
 * @param {{ declaredCreatePaths?: Iterable<string> }} [options] frontmatter op:create paths.
 *   The declared-create set D is these plus every directive path in the body; with one
 *   argument D is just the directive paths, so existing callers keep their behaviour.
 * @returns {Map<string, string>} Map of file path → file content
 */
export function extractCreateFileBlocks(markdown, { declaredCreatePaths } = {}) {
  const blocks = new Map();
  if (!markdown) return blocks;

  // Split by ### headings first so neither the directive patterns nor the ### Target: pattern
  // can reach across a section boundary to grab a code block from an unrelated (e.g.
  // source/reference) section.
  const sections = markdown.split(/^(?=###\s)/m);

  // Within each bounded section, a directive binds the first fence after it IN THE SAME
  // SECTION — never across a later directive (two directives + one fence used to give the
  // FIRST path the SECOND file's content, and the !blocks.has guard then locked it in).
  // The heading arm is LINE-ANCHORED for the same reason as extractCreateFileDirectives.
  const createFilePatterns = [
    new RegExp(String.raw`\/\/\s*CREATE\s+FILE:\s*(\S+)` + NOT_ANOTHER_DIRECTIVE + FENCE + String.raw`(?:\w*)\n([\s\S]*?)` + FENCE, "gim"),
    new RegExp(String.raw`^[^\S\n]*#{2,3}\s*CREATE\s+FILE:\s*(\S+)` + NOT_ANOTHER_DIRECTIVE + FENCE + String.raw`(?:\w*)\n([\s\S]*?)` + FENCE, "gim"),
  ];
  for (const section of sections) {
   for (const createFilePattern of createFilePatterns) {
    createFilePattern.lastIndex = 0;
    let match;
    while ((match = createFilePattern.exec(section)) !== null) {
      const filePath = match[1].trim();
      const content = match[2];
      if (filePath && content && !blocks.has(filePath)) {
        blocks.set(filePath, content);
      }
    }
   }
  }

  // Extract authoritative content from ### Target: <path> sections.
  // Only look for a code block within the Target section itself.
  for (const section of sections) {
    const targetMatch = section.match(/^###\s+Target:\s*(\S+)/i);
    if (!targetMatch) continue;
    const filePath = targetMatch[1].trim();
    if (blocks.has(filePath)) continue;
    const codeMatch = section.match(/```(?:\w*)\n([\s\S]*?)```/);
    if (codeMatch && codeMatch[1]) {
      blocks.set(filePath, codeMatch[1]);
    }
  }

  // Heading pass: an exact-path `### <path>` heading binds its first fence ONLY for a path in
  // the declared-create set D. Undeclared (edit-anchor) sections carry @@SEARCH text and must
  // never be read as create content. Earlier bindings keep precedence (!blocks.has).
  const declared = new Set([
    ...(declaredCreatePaths ? [...declaredCreatePaths] : []),
    ...extractCreateFileDirectives(markdown),
  ]);
  if (declared.size > 0) {
    for (const section of sections) {
      const headingLine = section.split("\n", 1)[0];
      const filePath = parseCreateHeadingPath(headingLine);
      if (!filePath || !declared.has(filePath) || blocks.has(filePath)) continue;
      const codeMatch = section.match(/```(?:\w*)\n([\s\S]*?)```/);
      if (codeMatch && codeMatch[1]) {
        blocks.set(filePath, codeMatch[1]);
      }
    }
  }

  return blocks;
}

export default {
  MAX_SNIPPET_LINES,
  isRagIndexFresh,
  writeJson,
  summarizeProblemNote,
  getCodemapPath,
  getAnalysisPath,
  readCodemap,
  readAnalysis,
  readSnippet,
  extractSnippet,
  readSnippetForTarget,
  normalizeRagPath,
  classifyPlanStatus,
  runsRoot,
  detectFrameworkFromFiles,
  buildCodemap,
  extractCreateFileDirectives,
  extractCreateFileBlocks,
};
