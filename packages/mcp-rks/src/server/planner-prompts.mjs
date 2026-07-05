/**
 * Planner Prompt Utilities — extracted from planner.mjs
 *
 * Pure text processing functions used to build LLM prompts:
 * markdown parsing, content detection, snippet formatting,
 * note summarization, and note-driven step generation.
 */
import fs from "fs";
import path from "path";

const MAX_SNIPPET_LINES = 300;

// ── Text utilities ───────────────────────────────────────────────────

export function truncateText(text, length = 160) {
  if (!text) return "";
  if (text.length <= length) return text.trim();
  return `${text.slice(0, length).trim()}…`;
}

export function extractSectionLines(markdown, headingPattern) {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  let capture = false;
  const collected = [];
  const headingRegex = typeof headingPattern === "string" ? new RegExp(headingPattern, "i") : headingPattern;
  for (const rawLine of lines) {
    const line = rawLine || "";
    if (headingRegex && headingRegex.test(line.trim())) {
      capture = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && capture) break;
    if (capture) collected.push(line);
  }
  return collected;
}

// ── File/action detection ────────────────────────────────────────────

export function detectFileMetadata(text) {
  if (!text) return {};
  let filePath = null;
  const codeMatch = text.match(/`([^`]+\/[^`]+)`/);
  if (codeMatch) {
    filePath = codeMatch[1].trim();
  } else {
    const plainMatch = text.match(/\b([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\b/);
    if (plainMatch) filePath = plainMatch[1].trim();
  }
  let actionHint = null;
  if (/create/i.test(text)) actionHint = "create_file";
  else if (/delete|remove/i.test(text)) actionHint = "delete_file";
  else if (/edit|update|modify/i.test(text)) actionHint = "edit_file";
  else if (/command|run/i.test(text)) actionHint = "run_command";
  return {
    ...(filePath ? { filePath } : {}),
    ...(actionHint ? { actionHint } : {}),
  };
}

export function guessFilePath(text) {
  if (!text) return null;
  if (/buildNoteDrivenSteps|numbered lists|nested bullets|heading normalization|normalize multiple headings|table utility/i.test(text)) {
    return "packages/mcp-rks/src/server.mjs";
  }
  if (/regression (coverage|tests)|snapshot tests|planner\.spec/i.test(text)) {
    return "packages/mcp-rks/__tests__/planner.spec.mjs";
  }
  if (/planning\.md|supported patterns/i.test(text)) {
    return "notes/how-to.development-workflow.planning.md";
  }
  if (/telemetry/i.test(text)) {
    return ".rks/telemetry/summary.csv";
  }
  return null;
}

// ── Content generation ───────────────────────────────────────────────

export function buildContentForPath(pathHint, description) {
  if (!pathHint) return "";
  if (pathHint.endsWith(".md")) {
    return [
      "## Supported Requirement Formats",
      "",
      "- Numbered lists (1., 2., ...), nested bullets (one level), Markdown tables.",
      "- Headings normalized: Requirements, Acceptance, Implementation Tasks/Steps, Constraints.",
      "- Each item becomes a discrete planner step with a valid action/path.",
      "",
      description || "",
      "",
    ].join("\n");
  }
  if (pathHint.endsWith(".mjs") || pathHint.endsWith(".js") || pathHint.endsWith(".ts") || pathHint.endsWith(".tsx")) {
    if (pathHint.includes("__tests__/planner.spec.mjs")) {
      return [
        "import assert from \"node:assert\";",
        "import { buildNoteDrivenSteps } from \"../src/server.mjs\";",
        "",
        "describe(\"planner mapping\", () => {",
        "  it(\"emits multiple steps with valid paths\", () => {",
        "    const note = `# Requirements\\n- Add table parsing\\n- Normalize headings`;",
        "    const steps = buildNoteDrivenSteps(note);",
        "    assert(steps.length > 1, \"expected multiple steps\");",
        "    steps.forEach((s) => {",
        "      if (s.action === \"note\") return;",
        "      assert(s.path && !s.path.includes(\"\\n\"), \"valid path\");",
        "      if (s.action === \"edit_file\") {",
        "        assert(s.content && s.content.trim().length > 0, \"non-empty content\");",
        "      }",
        "    });",
        "  });",
        "});",
        "",
      ].join("\n");
    }
    return [
      "// Planner mapping enhancements",
      "// - Resolve items to known targets (parser/tests/docs)",
      "// - Emit edit_file only when path exists, otherwise create_file with full content",
      "// - Downgrade to note when path/content are invalid",
      "",
      description || "",
      "",
    ].join("\n");
  }
  return description || "";
}

// ── Markdown parsing ─────────────────────────────────────────────────

export function parseListAndTables(lines) {
  const items = [];
  let i = 0;
  const isTableRow = (line) => /^\s*\|.+\|\s*$/.test(line);
  const isSeparator = (line) => /^\s*\|\s*-+/.test(line);
  const consumeTable = () => {
    const rows = [];
    while (i < lines.length && isTableRow(lines[i])) {
      const line = lines[i];
      if (isSeparator(line)) {
        i += 1;
        continue;
      }
      rows.push(line);
      i += 1;
    }
    for (const row of rows) {
      const cols = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length >= 2) {
        items.push({ type: "table", path: cols[0], text: cols.slice(1).join(" | ") });
      }
    }
  };
  const consumeBullet = () => {
    const bulletLine = lines[i];
    const bulletMatch = bulletLine.match(/^(\s*)(?:[-*]|\d+[.)])\s+(.*)/);
    const indent = bulletMatch && bulletMatch[1] ? bulletMatch[1].length : 0;
    const buffer = [bulletMatch ? bulletMatch[2] : bulletLine.trim()];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      const nextMatch = next.match(/^(\s*)(?:[-*]|\d+[.)])\s+(.*)/);
      const nextIndent = nextMatch && nextMatch[1] ? nextMatch[1].length : 0;
      if (nextMatch && nextIndent <= indent) break;
      if (nextMatch && nextIndent > indent) {
        items.push({ type: "bullet", text: nextMatch[2].trim() });
        i += 1;
        continue;
      }
      if (isTableRow(next)) break;
      if (next.trim()) buffer.push(next.trim());
      i += 1;
    }
    items.push({ type: "bullet", text: buffer.join(" ") });
  };
  while (i < lines.length) {
    const line = lines[i] || "";
    if (isTableRow(line)) {
      consumeTable();
      continue;
    }
    if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
      consumeBullet();
      continue;
    }
    i += 1;
  }
  return items;
}

// ── Intent classification ────────────────────────────────────────────

export function isParserWork(text) {
  return /buildNoteDrivenSteps|numbered lists|nested bullets|heading normalization|table utility|parser/i.test(text || "");
}

export function isTestWork(text) {
  return /regression|snapshot|test|spec/i.test(text || "");
}

export function isDocWork(text) {
  return /doc|document|planning\.md|supported patterns/i.test(text || "");
}

// ── Note summarization ──────────────────────────────────────────────

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

// ── Codemap / analysis loading ──────────────────────────────────────

export function getCodemapPath(projectRoot, projectId) {
  return path.join(projectRoot, ".rks", "state", projectId, "codemap.json");
}

export function getAnalysisPath(projectRoot, projectId) {
  return path.join(projectRoot, ".rks", "state", projectId, "analysis.json");
}

export function readCodemap(projectRoot, projectId) {
  const codemapPath = getCodemapPath(projectRoot, projectId);
  if (!fs.existsSync(codemapPath)) return null;
  return { path: codemapPath, data: JSON.parse(fs.readFileSync(codemapPath, "utf8")) };
}

export function readAnalysis(projectRoot, projectId) {
  const analysisPath = getAnalysisPath(projectRoot, projectId);
  if (!fs.existsSync(analysisPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  } catch {
    return null;
  }
}

// ── Context loading ─────────────────────────────────────────────────

export function readPackageScripts(projectRoot) {
  const pkgPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) return null;
    return pkg.scripts;
  } catch {
    return null;
  }
}

export function formatScriptsForPrompt(pkgScripts) {
  if (!pkgScripts || typeof pkgScripts !== "object") {
    return ["⚠️ No npm scripts found in package.json. Do NOT generate run_command steps."];
  }
  const entries = Object.entries(pkgScripts);
  if (entries.length === 0) {
    return ["⚠️ No npm scripts found in package.json. Do NOT generate run_command steps."];
  }
  const lines = ["--- Available npm scripts (from package.json) ---"];
  for (const [name, cmd] of entries) {
    lines.push(`  npm run ${name} → ${cmd}`);
  }
  lines.push("--- End npm scripts ---");
  const directive = "IMPORTANT: Only generate run_command steps for npm scripts listed above. Do NOT invent scripts that are not in this list.";
  return [lines.join("\n"), directive];
}

export function readSnippet(projectRoot, relPath, maxLines = MAX_SNIPPET_LINES) {
  const abs = path.join(projectRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split("\n");
    if (lines.length <= maxLines) return text;
    return lines.slice(0, maxLines).join("\n") + `\n// ... (${lines.length - maxLines} more lines)`;
  } catch {
    return null;
  }
}

export function extractSnippet(text, pattern, contextLines = 8) {
  if (!text) return null;
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx < 0) return null;
  const start = Math.max(0, idx - contextLines);
  const end = Math.min(lines.length, idx + contextLines + 1);
  return lines.slice(start, end).join("\n");
}

export function readSnippetForTarget(projectRoot, relPath, allowHeadFallback = false) {
  const abs = path.join(projectRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    const text = fs.readFileSync(abs, "utf8");
    const lines = text.split("\n");
    if (lines.length <= MAX_SNIPPET_LINES) return text;
    if (allowHeadFallback) {
      return lines.slice(0, MAX_SNIPPET_LINES).join("\n") + `\n// ... (${lines.length - MAX_SNIPPET_LINES} more lines)`;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeRagPath(projectRoot, p) {
  if (!p) return null;
  const rel = p.startsWith(projectRoot) ? path.relative(projectRoot, p) : p.replace(/^\.\//, "");
  return rel;
}

// ── Plan classification ─────────────────────────────────────────────

export function classifyPlanStatus({ steps = [], llmStatus = "note_only" } = {}) {
  const hasNoteSteps = steps.some((s) => s?.action === "note");
  const hasExecutable = steps.some(
    (s) =>
      ((s?.action === "edit_file" || s?.action === "create_file") &&
        s?.content &&
        String(s.content).trim().length > 0 &&
        s?.path) ||
      (s?.action === "search_replace" &&
        Array.isArray(s?.edits) &&
        s.edits.length > 0 &&
        s?.path)
  );
  if (llmStatus === "error") return "error";
  if (hasNoteSteps) return "needs_refinement";
  return hasExecutable ? "executable" : "note_only";
}

// ── Project utilities ───────────────────────────────────────────────

export function runsRoot(projectRoot) {
  return path.join(projectRoot, ".rks", "runs");
}

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

export function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
