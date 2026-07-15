#!/usr/bin/env node
/**
 * enforce-targetfile-scope.mjs — PreToolUse hook (system tier)
 *
 * Enforces write scope during guardrails-off sessions.
 * Reads `.rks/active-scope.json` (written by guardrailsOff()).
 * Stays active even when guardrails are off (system tier — not moved to hooks.bak).
 *
 * Behavior:
 * - No scope file → allow (guardrails-on mode; enforce-plan-scope handles scope)
 * - writeMode "scoped" + allowedFiles → only allow writes matching those patterns
 * - writeMode "read-only" → block all code writes
 * - Always allows non-code files (.routekit/, .claude/, .rks/, telemetry, logs)
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with message to stderr)
 *
 * @see backlog.feat.guardrails-off-scoped-writes
 */
import fs from "fs";
import path from "path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SCOPE_FILE = ".rks/active-scope.json";

const CODE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java"];

// Paths that are always writable (meta/config/telemetry)
const ALWAYS_ALLOWED = [
  /^\.claude\//,
  /^\.routekit\//,
  /^\.rks\//,
  /^node_modules\//,
  /^notes\//,
];

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.some(ext => filePath.endsWith(ext));
}

function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${regex}$`);
}

function matchesGlob(filePath, pattern) {
  const normalizedPath = filePath.replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/^\.\//, "");
  if (normalizedPath === normalizedPattern) return true;
  try {
    return globToRegex(normalizedPattern).test(normalizedPath);
  } catch {
    return false;
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const { tool_name, tool_input } = input;

  // Only check write operations
  if (!["Edit", "Write"].includes(tool_name)) {
    process.exit(0);
  }

  const scopePath = path.join(PROJECT_DIR, SCOPE_FILE);

  // No scope file = no restrictions from this hook
  if (!fs.existsSync(scopePath)) {
    process.exit(0);
  }

  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(scopePath, "utf8"));
  } catch {
    // Corrupt scope file — allow to avoid blocking work
    process.exit(0);
  }

  const filePath = tool_input.file_path || tool_input.path;
  if (!filePath) {
    process.exit(0);
  }

  // Normalize to relative path
  let relPath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relPath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  // Deny-list mode (framework-update tier): denyList takes priority over ALWAYS_ALLOWED
  if (scope.writeMode === "deny-list") {
    if (scope.denyList && scope.denyList.length > 0) {
      const isDenied = scope.denyList.some(prefix => relPath.startsWith(prefix));
      if (isDenied) {
        process.stderr.write(
          `\nscope.violation: ${scope.tier || "framework-update"} — write blocked by deny-list\n` +
          `   File: ${relPath}\n` +
          `   Deny-listed prefixes: ${scope.denyList.join(", ")}\n\n`
        );
        process.exit(2);
      }
    }
    process.exit(0);
  }

  // Always allow meta/config/telemetry paths (for non-deny-list modes)
  for (const pattern of ALWAYS_ALLOWED) {
    if (pattern.test(relPath)) {
      process.exit(0);
    }
  }

  // Read-only mode (writeMode === "read-only")
  if (scope.writeMode === "read-only" && isCodeFile(relPath)) {
    process.stderr.write(
      `\nscope.violation: ${scope.tier || "read-only"} — write blocked: off-rail session is read-only\n` +
      `   File: ${relPath}\n` +
      `   Reason: No targetFiles defined for story ${scope.problemId || "(unknown)"}\n` +
      `\n   💡 To write code, add targetFiles to your story note and restart off-rail:\n` +
      `      rks_guardrails_off { problemId: "${scope.problemId || "backlog.your.story"}" }\n\n`
    );
    process.exit(2);
  }

  // Scoped mode (writeMode === "scoped" with allowedFiles)
  if (scope.writeMode === "scoped" && scope.allowedFiles && scope.allowedFiles.length > 0) {
    const allowed = scope.allowedFiles.some(pattern => matchesGlob(relPath, pattern));
    if (!allowed) {
      process.stderr.write(
        `\nscope.violation: ${scope.tier || "build-only"} — write blocked: file not in story's targetFiles\n` +
        `   File: ${relPath}\n` +
        `   Story: ${scope.problemId || "(unknown)"}\n` +
        `   Allowed:\n` +
        scope.allowedFiles.map(f => `      - ${f}`).join("\n") +
        `\n\n   💡 Add this file to targetFiles in your story, or work within scope\n\n`
      );
      process.exit(2);
    }
  }

  // All checks passed
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
