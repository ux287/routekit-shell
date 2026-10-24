/**
 * Planner Note-Driven Steps Module
 *
 * Handles building plan steps from note/markdown content.
 * Includes parsing, validation, and target resolution.
 */

import fs from "fs";
import path from "path";
import { repoRoot, ensureDir, isProtectedPath } from "./project.mjs";

/**
 * Truncate text to specified length with ellipsis
 */
export function truncateText(text, length = 160) {
  if (!text) return "";
  if (text.length <= length) return text.trim();
  return `${text.slice(0, length).trim()}…`;
}

/**
 * Extract lines from a markdown section matching a heading pattern
 */
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

/**
 * Detect file path and action hint from text content
 */
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

/**
 * Guess file path based on content patterns
 */
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

/**
 * Build content template for a given path and description
 */
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

/**
 * Parse markdown lists and tables into structured items
 */
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

// Content classifiers
export function isParserWork(text) {
  return /buildNoteDrivenSteps|numbered lists|nested bullets|heading normalization|table utility|parser/i.test(text || "");
}

export function isTestWork(text) {
  return /regression|snapshot|test|spec/i.test(text || "");
}

export function isDocWork(text) {
  return /doc|document|planning\.md|supported patterns/i.test(text || "");
}

/**
 * Resolve an item to a target file action
 */
export function resolveTarget(item, normalized, projectRoot) {
  const meta = detectFileMetadata(normalized);
  const safePath = (p) => p && typeof p === "string" && p.trim() && !p.includes("\n");
  if (item.path) {
    if (!safePath(item.path)) return null;
    const abs = path.join(projectRoot, item.path);
    const exists = fs.existsSync(abs);
    const action = exists ? "edit_file" : "create_file";
    const content = buildContentForPath(item.path, normalized);
    if (!content || !content.trim()) return null;
    return { action, path: item.path, content };
  }
  const guessedPath = meta.filePath || guessFilePath(normalized);
  if (meta.actionHint === "run_command" && !guessedPath) {
    return { action: "run_command", command: normalized, cwd: projectRoot };
  }
  if (guessedPath && safePath(guessedPath)) {
    const abs = path.join(projectRoot, guessedPath);
    const exists = fs.existsSync(abs);
    const actionKind = exists ? (meta.actionHint && meta.actionHint !== "run_command" ? meta.actionHint : "edit_file") : "create_file";
    const content = actionKind === "delete_file" ? "" : buildContentForPath(guessedPath, normalized);
    if (actionKind !== "delete_file" && (!content || !content.trim())) return null;
    return { action: actionKind, path: guessedPath, content, ...(meta.actionHint === "run_command" ? { command: normalized, cwd: projectRoot } : {}) };
  }
  if (isParserWork(normalized)) {
    const content = buildContentForPath("packages/mcp-rks/src/server.mjs", normalized);
    if (!content || !content.trim()) return null;
    return { action: "edit_file", path: "packages/mcp-rks/src/server.mjs", content };
  }
  if (isTestWork(normalized)) {
    const testPath = "packages/mcp-rks/__tests__/planner.spec.mjs";
    const abs = path.join(projectRoot, testPath);
    const exists = fs.existsSync(abs);
    const content = buildContentForPath(testPath, normalized);
    if (!content || !content.trim()) return null;
    return {
      action: exists ? "edit_file" : "create_file",
      path: testPath,
      content,
    };
  }
  if (isDocWork(normalized)) {
    const docPath = "notes/how-to.development-workflow.planning.md";
    const content = buildContentForPath(docPath, normalized);
    if (!content || !content.trim()) return null;
    return { action: "edit_file", path: docPath, content };
  }
  return null;
}

/**
 * Check if text contains diff markers
 */
function containsDiffMarkers(text) {
  if (!text || typeof text !== "string") return false;
  if (/diff --git/i.test(text)) return true;
  if (/^@@/m.test(text)) return true;
  if (/^\+\+\+ /m.test(text) || /^--- /m.test(text)) return true;
  const lines = text.split("\n");
  return lines.some((line) => {
    if (/^---\s*$/.test(line) || /^\+\+\+\s*$/.test(line)) return false;
    return /^\+[^\s]/.test(line) || /^-[^\s]/.test(line);
  });
}

/**
 * Check if text contains merge conflict markers
 */
function hasMergeMarkers(text) {
  if (!text || typeof text !== "string") return false;
  return /^<<<<<<<\s|^=======\s*$|^>>>>>>>\s/m.test(text);
}

/**
 * Validate a single step, returning null for invalid or converting to note action
 */
// backlog.fix.planner-note-step-false-rejection: NO LONGER EXPORTED. planner.mjs owns the live
// `validateStep` (and now `classifySteps`); this copy exists only to serve buildNoteDrivenSteps
// below and must not become a second public entry point that can silently diverge from the real
// one. Import validateStep from planner.mjs, not from here.
function validateStep(step, allowedTargets = null, projectRoot = repoRoot) {
  if (!step || typeof step !== "object") return null;
  if (step.action === "note") return step;

  if (step.action === "run_command") {
    if (!step.command || !step.command.trim()) return { ...step, action: "note" };
    return step;
  }
  if (step.action === "search_replace") {
    if (!step.path || typeof step.path !== "string" || !step.path.trim() || step.path.includes("..")) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "missing or invalid path" };
    }
    if (!Array.isArray(step.edits) || step.edits.length === 0) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "missing edits array" };
    }
    for (const edit of step.edits) {
      if (!edit || typeof edit !== "object") {
        return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "invalid edit object" };
      }
      if (!edit.search || typeof edit.search !== "string" || !edit.search.trim()) {
        return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "invalid edit: missing search string" };
      }
      if (typeof edit.replace !== "string") {
        return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "invalid edit: missing replace string" };
      }
    }
    // Validate file exists for search_replace
    const abs = path.join(projectRoot, step.path);
    if (!fs.existsSync(abs)) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "file not found for search_replace" };
    }
    return step;
  }
  if (step.action === "edit_file" || step.action === "create_file" || step.action === "delete_file") {
    const isNotesPath = typeof step.path === "string" && step.path.startsWith("notes/");
    const isMarkdown = typeof step.path === "string" && step.path.endsWith(".md");
    if (
      !step.path ||
      typeof step.path !== "string" ||
      step.path.includes("\n") ||
      !step.path.trim() ||
      step.path.includes("..")
    ) {
      return { action: "note", title: step.title, description: step.description, order: step.order };
    }
    const allowedFiles = allowedTargets?.allowFiles ? new Set(allowedTargets.allowFiles) : null;
    const allowedPatterns = allowedTargets?.allowPatterns || null;
    const allowedMatch = !allowedTargets
      ? true
      : step.action === "create_file"
        ? Boolean(allowedPatterns && isProtectedPath(step.path, allowedPatterns))
        : Boolean(allowedFiles && allowedFiles.has(step.path));
    if (allowedTargets && !allowedMatch) {
      // backlog.fix.planner-note-step-false-rejection: kept byte-for-byte in step with the live
      // copy in planner.mjs. This copy is module-private and only ever called with
      // allowedTargets=null (so this branch is unreachable here) — but a buggy twin is precisely
      // how the two drift apart, and the original bug was a step turned into a note with NEITHER
      // path NOR title, which every diagnostic then rendered as the empty string.
      return {
        _invalid: true,
        _invalidReason: "path not in editable targets",
        action: step.action,
        path: step.path ?? null,
        title: step.title || step.path || `${step.action} step`,
        description: `${step.description || ""} (path not in Targets)`.trim(),
        order: step.order,
      };
    }
    if (step.action === "edit_file" && !isNotesPath && !isMarkdown) {
      const abs = path.join(projectRoot, step.path);
      if (!fs.existsSync(abs)) {
        return { action: "note", title: step.title, description: step.description, order: step.order };
      }
    }
    if (step.action === "delete_file") return step;
    if (!step.content || !String(step.content).trim()) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "missing content" };
    }
    if (containsDiffMarkers(step.content)) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "diff-style content rejected" };
    }
    if (hasMergeMarkers(step.content)) {
      return { action: "note", title: step.title, description: step.description, order: step.order, _invalidReason: "merge markers detected" };
    }
    return step;
  }
  return { action: "note", title: step.title, description: step.description, order: step.order };
}

/**
 * Build plan steps from markdown content
 */
export function buildNoteDrivenSteps(markdown, projectRoot = repoRoot) {
  if (!markdown) return [];
  const sectionPatterns = [
    /^#{1,6}\s+requirements/i,
    /^#{1,6}\s+acceptance/i,
    /^#{1,6}\s+implementation tasks/i,
    /^#{1,6}\s+implementation steps/i,
    /^#{1,6}\s+constraints/i,
  ];
  const sectionLines = sectionPatterns.flatMap((pattern) => extractSectionLines(markdown, pattern));
  const items = parseListAndTables(sectionLines);

  const toAction = (item, index) => {
    const normalized = (item.text || "").replace(/\s+/g, " ").trim();
    const base = {
      title: truncateText(normalized, 120) || `Requirement ${index + 1}`,
      description: item.text || "",
      order: index + 1,
    };
    const mapped = resolveTarget(item, normalized, projectRoot);
    if (mapped) return { ...base, ...mapped };
    return { ...base, action: "note" };
  };

  const steps = items.map((item, idx) => toAction(item, idx));

  const validated = steps.map((s) => validateStep(s, null, projectRoot)).filter(Boolean);
  if (validated.length) return validated;
  const fallback = truncateText(markdown, 240);
  return fallback
    ? [
      {
        action: "note",
        title: "Review problem note",
        description: fallback,
        order: 1,
      },
    ]
    : [];
}

export default {
  truncateText,
  extractSectionLines,
  detectFileMetadata,
  guessFilePath,
  buildContentForPath,
  parseListAndTables,
  isParserWork,
  isTestWork,
  isDocWork,
  resolveTarget,
  buildNoteDrivenSteps,
};
