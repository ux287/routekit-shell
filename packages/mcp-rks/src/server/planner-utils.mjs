/**
 * Planner Utilities Module
 *
 * Contains utility functions for the planner: snippet reading, codemap management,
 * framework detection, plan status classification, and path helpers.
 */

import fs from "fs";
import path from "path";
import { getLastEmbedTime } from "../rag/index.mjs";
import { ensureDir, listRelativeFiles } from "./project.mjs";
import { truncateText } from "./planner-note-steps.mjs";

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
  const regex = /\/\/\s*CREATE\s+FILE:\s*(\S+)/gi;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    directives.push(match[1].trim());
  }
  return directives;
}

/**
 * Extract CREATE FILE directives AND their following code blocks from markdown.
 * Looks for // CREATE FILE: <path> followed by a code fence.
 * @returns {Map<string, string>} Map of file path → file content
 */
export function extractCreateFileBlocks(markdown) {
  const blocks = new Map();
  if (!markdown) return blocks;

  // Split by ### headings first so neither the // CREATE FILE: pattern nor the
  // ### Target: pattern can reach across a section boundary to grab a code block
  // from an unrelated (e.g. source/reference) section.
  const sections = markdown.split(/^(?=###\s)/m);

  // Within each bounded section, match // CREATE FILE: <path> followed by a
  // code fence that exists IN THE SAME SECTION — no cross-boundary scanning.
  const createFilePattern = /\/\/\s*CREATE\s+FILE:\s*(\S+)[\s\S]*?```(?:\w*)\n([\s\S]*?)```/gi;
  for (const section of sections) {
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
