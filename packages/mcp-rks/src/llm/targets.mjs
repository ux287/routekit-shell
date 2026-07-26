import fs from "fs";
import path from "path";
import { globSync } from "glob";
import { findFunctionSlice } from "./slices.mjs";
import { loadProjectProtectedConfig, isProtectedPath } from "../server/project.mjs";

function listFilesRecursive(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const next = stack.pop();
    if (!next) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

export function looksLikeGlob(value) {
  if (!value || typeof value !== "string") return false;
  return /[*?[\]{},]/.test(value);
}

function extractFunctionSlice(fileContent, functionName, contextLines = 0) {
  if (!fileContent || !functionName) return null;
  const lines = fileContent.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line.includes(`function ${functionName}`));
  if (startIdx === -1) return null;
  let braceBalance = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") braceBalance += 1;
      if (ch === "}") braceBalance -= 1;
    }
    if (braceBalance <= 0 && i > startIdx) {
      endIdx = i;
      break;
    }
  }
  const start = Math.max(0, startIdx - contextLines);
  const end = Math.min(lines.length, endIdx + 1 + contextLines);
  return lines.slice(start, end).join("\n");
}

function extractSection(markdown, headingRegex) {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const collected = [];
  let capture = false;
  for (const line of lines) {
    if (headingRegex.test(line.trim())) {
      capture = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(line) && capture) break;
    if (capture) collected.push(line);
  }
  return collected;
}

export function parseTargetsFromMarkdown(markdown) {
  // Match both "## Targets" and "## Target Files" section headers
  const sectionLines = extractSection(markdown || "", /^#{2,3}\s+target(?:s|\s+files)/i);
  const paths = [];
  for (const line of sectionLines) {
    const m = line.match(/^\s*[-*]\s+(.+)/);
    if (!m) continue;
    const raw = m[1].trim();
    // Strip markdown formatting (e.g., backticks around paths: `packages/...`)
    const withoutTicks = raw.replace(/`/g, "").trim();
    // Only keep the path portion before any trailing description, e.g.:
    // "packages/cli/src/project/index.js (project subsystem: init and helpers)" -> "packages/cli/src/project/index.js"
    // Also strip PO Governor em-dash format: "`path/to/file.ts` — EDIT — desc" -> "path/to/file.ts"
    const candidate = withoutTicks.split(/\s+\(/)[0].split(/\s+[—–-]\s+/)[0].trim();
    if (!candidate || candidate.includes("\n")) continue;
    paths.push(candidate);
  }
  return Array.from(new Set(paths));
}

/**
 * Parse Implementation code blocks from story content.
 * Recognizes patterns like:
 *   ### path/to/file.ts
 *   ```ts
 *   content
 *   ```
 * or:
 *   ### path/to/file.ts (CREATE FILE)
 *   ```tsx
 *   content
 *   ```
 *
 * @param {string} storyContent - The full story markdown content
 * @returns {Map<string, string>} Map of file path to content
 */
export function parseImplementationCodeBlocks(storyContent) {
  const codeBlocks = new Map();
  if (!storyContent) return codeBlocks;

  // Find the Implementation section
  const implMatch = storyContent.match(/^## Implementation\s*$/im);
  if (!implMatch) {
    return codeBlocks;
  }

  // Get content after ## Implementation until next ## section or end
  const implStart = implMatch.index + implMatch[0].length;
  const nextSectionMatch = storyContent.slice(implStart).match(/^## /m);
  const implEnd = nextSectionMatch ? implStart + nextSectionMatch.index : storyContent.length;
  const implContent = storyContent.slice(implStart, implEnd);

  // Match patterns like: ### path/to/file.ext or ### path/to/file.ext (CREATE FILE)
  // followed by a code fence
  const blockPattern = /^###\s+([^\s(]+)(?:\s*\((?:CREATE\s+FILE|new\s+file)\))?\s*\n```\w*\n([\s\S]*?)```/gim;
  let match;
  while ((match = blockPattern.exec(implContent)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    if (filePath && content) {
      codeBlocks.set(filePath, content);
    }
  }

  return codeBlocks;
}

export function resolveTargetPaths(projectRoot, targets, options = {}) {
  const protectedConfig = loadProjectProtectedConfig(projectRoot);
  const protectedPatterns = [
    ...(protectedConfig.protected || []),
    ...(protectedConfig.projectProtected || []),
  ];
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 80;

  const allowPatterns = [];
  const resolved = new Set();
  const addResolved = (rel) => {
    if (!rel || typeof rel !== "string") return;
    if (resolved.size >= maxFiles) return;
    if (rel.includes("\n") || rel.includes("..")) return;
    if (isProtectedPath(rel, protectedPatterns)) return;
    resolved.add(rel);
  };

  for (const raw of targets || []) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/`/g, "");
    if (!trimmed) continue;

    if (looksLikeGlob(trimmed)) {
      allowPatterns.push(trimmed);
      const matches = globSync(trimmed, {
        cwd: projectRoot,
        dot: true,
        nodir: true,
        absolute: false,
      });
      matches.sort().forEach(addResolved);
      continue;
    }

    const abs = path.join(projectRoot, trimmed);
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const normalizedDir = trimmed.replace(/\/+$/, "");
        const dirPattern = `${normalizedDir}/**`;
        allowPatterns.push(dirPattern);
        const files = listFilesRecursive(abs)
          .map((fileAbs) => path.relative(projectRoot, fileAbs))
          .sort();
        for (const rel of files) addResolved(rel);
        continue;
      }
      if (stat.isFile()) {
        allowPatterns.push(trimmed);
        addResolved(trimmed);
        continue;
      }
    }

    // If it doesn't exist yet, treat it as an allowed create target.
    allowPatterns.push(trimmed);
  }

  return {
    allowPatterns: Array.from(new Set(allowPatterns)).sort(),
    allowFiles: Array.from(resolved).sort(),
    truncated: resolved.size >= maxFiles,
    maxFiles,
  };
}

export function loadEditableTargets(projectRoot, targets, options = {}) {
  const plannerMode = options.plannerMode || "full";
  const functionTargets = options.functionTargets || {};
  const resolvedTargets = resolveTargetPaths(projectRoot, targets, { maxFiles: options.maxFiles });
  const list = [];
  for (const rel of resolvedTargets.allowFiles || []) {
    const abs = path.join(projectRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const content = fs.readFileSync(abs, "utf8");
      const firstLine = content.split(/\r?\n/).find((l) => l.trim()) || "";
      let payload = content;

      // Generic function-scope handling when explicit function targets are provided for this path.
      if (plannerMode === "function_scope" && Array.isArray(functionTargets[rel]) && functionTargets[rel].length) {
        const parts = [];
        for (const fnName of functionTargets[rel]) {
          const slice = findFunctionSlice(content, fnName);
          if (slice?.text) {
            parts.push(`// -- START: ${fnName} --`);
            parts.push(slice.text);
            parts.push(`// -- END: ${fnName} --`);
          }
        }
        if (parts.length) {
          const combined = parts.join("\n");
          const condensed = combined.replace(/\n\s*\n+/g, "\n");
          payload = condensed.length > 4000 ? condensed.slice(0, 4000) : condensed;
        }
      }

      // Special handling for planner.mjs slices when in function-scope mode.
      if (plannerMode === "function_scope" && rel === "packages/mcp-rks/src/llm/planner.mjs") {
        const sliceCritic = findFunctionSlice(content, "runDecompositionCritic");
        const slicePlanner = findFunctionSlice(content, "runLlmPlanner");
        const parts = [];
        if (sliceCritic?.text) {
          parts.push("// -- START: runDecompositionCritic --");
          parts.push(sliceCritic.text);
          parts.push("// -- END: runDecompositionCritic --");
        }
        if (slicePlanner?.text) {
          parts.push("// -- START: runLlmPlanner --");
          parts.push(slicePlanner.text);
          parts.push("// -- END: runLlmPlanner --");
        }
        if (parts.length) {
          const combined = parts.join("\n");
          const condensed = combined.replace(/\n\s*\n+/g, "\n");
          payload = condensed.length > 4000 ? condensed.slice(0, 4000) : condensed;
        } else {
          payload = "(planner.mjs slices unavailable)";
        }
      }

      list.push({ path: rel, content: payload, summary: firstLine.slice(0, 120) });
    } catch {
      // skip unreadable
    }
  }
  return list;
}
