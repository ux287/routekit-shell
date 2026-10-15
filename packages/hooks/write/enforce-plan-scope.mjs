#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Enforce plan-based edit scope + pre-flight checks
 *
 * When an active plan is set, blocks Edit/Write to files not listed
 * in the plan's ## Target Files section.
 *
 * Also runs pre-flight checks (typecheck, lint, imports) before allowing edits
 * to ensure code quality is maintained.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with message to stderr)
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SCOPE_CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "scope-policy.yaml");

// ============ Pre-flight Check Functions ============

function loadScopeConfig() {
  if (!fs.existsSync(SCOPE_CONFIG_PATH)) {
    return {
      pre_edit_checks: { typecheck: true, lint: false, imports: true },
      commands: {
        typecheck: "npx tsc --noEmit --skipLibCheck",
        lint: "npx eslint --quiet --max-warnings 0",
      },
      check_patterns: {
        typecheck: ["\\.ts$", "\\.tsx$"],
        lint: ["\\.js$", "\\.mjs$", "\\.ts$", "\\.tsx$"],
      },
      skip_patterns: [
        "node_modules/",
        "\\.d\\.ts$",
        "dist/",
        "build/",
        "\\.test\\.",
        "\\.spec\\.",
        "\\.routekit/",
        "\\.claude/",
        "templates/",
      ],
      check_timeout: 30000,
      on_failure: { typecheck: "block", lint: "warn", imports: "warn" },
    };
  }
  try {
    const content = fs.readFileSync(SCOPE_CONFIG_PATH, "utf8");
    return yaml.load(content) || {};
  } catch {
    return {};
  }
}

function shouldSkipFile(filePath, config) {
  const skipPatterns = config.skip_patterns || [];
  for (const pattern of skipPatterns) {
    try {
      if (new RegExp(pattern).test(filePath)) {
        return true;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

function shouldRunCheck(checkType, filePath, config) {
  const patterns = config.check_patterns?.[checkType] || [];
  if (patterns.length === 0) return false;

  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(filePath)) {
        return true;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

function runTypeCheck(config) {
  const command = config.commands?.typecheck || "npx tsc --noEmit --skipLibCheck";
  const timeout = config.check_timeout || 30000;

  try {
    execSync(command, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
    return { success: true };
  } catch (err) {
    const stderr = err.stderr || err.message || "Type check failed";
    // Extract just the first few error lines for readability
    const errorLines = stderr.split("\n").slice(0, 10).join("\n");
    return { success: false, message: errorLines };
  }
}

function runLintCheck(filePath, config) {
  const baseCommand = config.commands?.lint || "npx eslint --quiet --max-warnings 0";
  const timeout = config.check_timeout || 30000;

  try {
    execSync(`${baseCommand} "${filePath}"`, {
      cwd: PROJECT_DIR,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
    return { success: true };
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || "Lint check failed";
    const errorLines = output.split("\n").slice(0, 10).join("\n");
    return { success: false, message: errorLines };
  }
}

function runImportCheck(filePath) {
  // Basic import validation - check if file can be parsed
  // This is a lightweight check that catches obvious syntax/import issues
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Look for import statements and check if they reference valid paths
    const importMatches = content.matchAll(/import\s+.*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g);

    for (const match of importMatches) {
      const importPath = match[1];
      const resolvedPath = path.resolve(path.dirname(filePath), importPath);

      // Try common extensions
      const extensions = ["", ".js", ".mjs", ".ts", ".tsx", ".json"];
      let found = false;

      for (const ext of extensions) {
        if (fs.existsSync(resolvedPath + ext)) {
          found = true;
          break;
        }
        // Also check for index files
        if (fs.existsSync(path.join(resolvedPath, "index" + (ext || ".js")))) {
          found = true;
          break;
        }
      }

      if (!found) {
        return {
          success: false,
          message: `Unresolved import: ${importPath} in ${path.basename(filePath)}`
        };
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, message: `Could not parse file: ${err.message}` };
  }
}

function runPreFlightChecks(filePath, config) {
  const checks = config.pre_edit_checks || {};
  const onFailure = config.on_failure || {};
  const results = [];

  // Skip if file matches skip patterns
  if (shouldSkipFile(filePath, config)) {
    return { passed: true, results: [] };
  }

  // TypeScript check
  if (checks.typecheck && shouldRunCheck("typecheck", filePath, config)) {
    const result = runTypeCheck(config);
    results.push({
      check: "typecheck",
      ...result,
      action: onFailure.typecheck || "block",
    });
  }

  // Lint check (only if file exists - for Edit, not Write of new files)
  if (checks.lint && fs.existsSync(filePath) && shouldRunCheck("lint", filePath, config)) {
    const result = runLintCheck(filePath, config);
    results.push({
      check: "lint",
      ...result,
      action: onFailure.lint || "warn",
    });
  }

  // Import check (only for existing files)
  if (checks.imports && fs.existsSync(filePath)) {
    const result = runImportCheck(filePath);
    results.push({
      check: "imports",
      ...result,
      action: onFailure.imports || "warn",
    });
  }

  // Check if any blocking failures
  const blockingFailures = results.filter(r => !r.success && r.action === "block");
  const warnings = results.filter(r => !r.success && r.action === "warn");

  return {
    passed: blockingFailures.length === 0,
    blockingFailures,
    warnings,
    results,
  };
}

// ============ Protected Paths Functions ============

function checkProtectedPaths(filePath, config) {
  const protectedPaths = config.protected_paths || [];
  if (protectedPaths.length === 0) return { isProtected: false };

  // Normalize path (remove project dir prefix if present)
  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  for (const protection of protectedPaths) {
    const pattern = protection.pattern;
    if (!pattern) continue;

    try {
      // Convert glob pattern to regex
      const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/\{\{GLOBSTAR\}\}/g, ".*");

      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(relativePath)) {
        return {
          isProtected: true,
          require: protection.require || "backlog_note",
          reason: protection.reason || "This path is protected",
          pattern: pattern,
        };
      }
    } catch {
      // Invalid pattern, skip
    }
  }

  return { isProtected: false };
}

function findBacklogNoteForPath(filePath) {
  // Look for a backlog note that mentions this file or hook modification
  const notesDir = path.join(PROJECT_DIR, "notes");
  if (!fs.existsSync(notesDir)) return null;

  const files = fs.readdirSync(notesDir).filter(f => f.startsWith("backlog.") && f.endsWith(".md"));

  // Normalize the file path for matching
  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }
  const fileName = path.basename(relativePath);

  for (const noteFile of files) {
    const notePath = path.join(notesDir, noteFile);
    try {
      const content = fs.readFileSync(notePath, "utf8");

      // Check if note mentions this file (by name or path)
      if (content.includes(relativePath) || content.includes(fileName)) {
        // Check if note status is not "implemented" (still active)
        const statusMatch = content.match(/^status:\s*(.+)$/m);
        const status = statusMatch ? statusMatch[1].trim() : "unknown";

        if (status !== "implemented") {
          return {
            noteFile,
            notePath,
            status,
            slug: noteFile.replace(/^backlog\./, "").replace(/\.md$/, ""),
          };
        }
      }
    } catch {
      // Skip unreadable notes
    }
  }

  return null;
}

// ============ Plan Scope Functions ============

/**
 * Convert a glob pattern to a RegExp
 * Supports: * (any chars except /), ** (any chars including /), ? (single char)
 */
function globToRegex(pattern) {
  // Escape regex special chars except glob chars
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** matches anything including /
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // ? matches single char
    .replace(/\?/g, ".")
    // Restore globstar
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  return new RegExp(`^${regex}$`);
}

function matchesGlob(filePath, pattern) {
  // Remove leading ./ from both
  const normalizedPath = filePath.replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/^\.\//, "");

  // Direct match
  if (normalizedPath === normalizedPattern) {
    return true;
  }

  // Glob match
  try {
    const regex = globToRegex(normalizedPattern);
    return regex.test(normalizedPath);
  } catch {
    return false;
  }
}
const ACTIVE_PLAN_PATH = path.join(PROJECT_DIR, ".claude", "active-plan.json");

// Paths that are always allowed (meta/config files)
const ALWAYS_ALLOWED = [
  /^\.claude\//,
  /^\.routekit\//,
  /^node_modules\//,
];

// Code file extensions that require an approved plan to write
const CODE_FILE_PATTERNS = [
  /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|json|yaml|yml|toml|sh|py|rs|go)$/,
];

// Paths always allowed without a plan (meta/config/notes)
const PLAN_EXEMPT_PATHS = [
  /^\.claude\//,
  /^\.routekit\//,
  /^\.rks\//,
  /^notes\//,
  /^node_modules\//,
  /^package-lock\.json$/,
];

function loadActivePlan() {
  if (!fs.existsSync(ACTIVE_PLAN_PATH)) {
    return null;
  }
  try {
    const content = fs.readFileSync(ACTIVE_PLAN_PATH, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function parseTargetFiles(noteContent) {
  // Find ## Target Files section and extract the list
  const lines = noteContent.split("\n");
  const targets = [];
  let inTargetSection = false;

  for (const line of lines) {
    // Check for Target Files header (various formats)
    if (/^##\s+Target\s+Files/i.test(line)) {
      inTargetSection = true;
      continue;
    }

    // Stop at next heading
    if (inTargetSection && /^##\s+/.test(line)) {
      break;
    }

    // Extract list items in Target Files section
    if (inTargetSection) {
      const match = line.match(/^\s*[-*]\s+(.+)/);
      if (match) {
        targets.push(match[1].trim());
      }
    }
  }

  return targets;
}

function isPathAllowed(filePath, targetPatterns) {
  // Normalize path (remove project dir prefix if present)
  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  // Always allow meta files
  for (const pattern of ALWAYS_ALLOWED) {
    if (pattern.test(relativePath)) {
      return true;
    }
  }

  // Check against target patterns
  for (const pattern of targetPatterns) {
    if (matchesGlob(relativePath, pattern)) {
      return true;
    }
  }

  return false;
}

async function main() {
  // Read hook input from stdin
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  // Only enforce on Edit and Write tools
  if (!["Edit", "Write"].includes(toolName)) {
    process.exit(0);
  }

  // Get the target file path
  const filePath = toolInput.file_path;
  if (!filePath) {
    process.exit(0);
  }

  // === Protected Paths Check (backlog-first for hooks) ===
  const scopeConfig = loadScopeConfig();
  const protectedCheck = checkProtectedPaths(filePath, scopeConfig);

  if (protectedCheck.isProtected && protectedCheck.require === "backlog_note") {
    const backlogNote = findBacklogNoteForPath(filePath);

    if (!backlogNote) {
      // Block - no backlog note found for this protected path
      const relativePath = filePath.startsWith(PROJECT_DIR)
        ? filePath.slice(PROJECT_DIR.length).replace(/^\//, "")
        : filePath;

      process.stderr.write(
        `\n⛔ Edit blocked: protected path requires backlog note first\n` +
        `   File: ${relativePath}\n` +
        `   Pattern: ${protectedCheck.pattern}\n` +
        `   Reason: ${protectedCheck.reason}\n` +
        `\n   📝 To modify this file:\n` +
        `      1. Create: notes/backlog.{your-change-slug}.md\n` +
        `      2. Explain WHY this change is needed\n` +
        `      3. Include the file path in the note\n` +
        `      4. Then retry the edit\n` +
        `\n   💡 This creates an audit trail for guardrail modifications.\n\n`
      );
      process.exit(2);
    } else {
      // Backlog note exists - allow with info
      process.stderr.write(
        `\n✅ Protected path edit allowed (backlog note found)\n` +
        `   Note: ${backlogNote.noteFile} (status: ${backlogNote.status})\n\n`
      );
    }
  }

  // Check if there's an active plan
  const activePlan = loadActivePlan();
  if (!activePlan || !activePlan.backlog_note) {
    // No active plan — block code files, allow meta files
    let relativePath = filePath;
    if (filePath.startsWith(PROJECT_DIR)) {
      relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
    }

    // Always allow meta/config paths
    const isExempt = PLAN_EXEMPT_PATHS.some(p => p.test(relativePath));
    if (isExempt) {
      process.exit(0);
    }

    // Block code files
    const isCodeFile = CODE_FILE_PATTERNS.some(p => p.test(relativePath));
    if (isCodeFile) {
      process.stderr.write(
        `\n⛔ Write blocked: no approved plan for code file writes\n` +
        `   File: ${relativePath}\n` +
        `\n   🔀 REDIRECT: Delegate implementation to an agent:\n` +
        `      - rks_agent_lifecycle (full story workflow)\n` +
        `      - Launch a Governor with the lifecycle playbook\n` +
        `\n   💡 The Dispatcher does not write code files directly.\n` +
        `      Set up an active plan with approved target files first.\n\n`
      );
      process.exit(2);
    }

    // Non-code, non-exempt files: run pre-flight checks only
    const preflightResult = runPreFlightChecks(filePath, scopeConfig);
    if (preflightResult.warnings?.length > 0) {
      process.stderr.write(`\n⚠️  Pre-flight warnings:\n`);
      for (const w of preflightResult.warnings) {
        process.stderr.write(`   ${w.check}: ${w.message}\n`);
      }
      process.stderr.write(`\n`);
    }
    if (!preflightResult.passed) {
      process.stderr.write(`\n⛔ Edit blocked: pre-flight checks failed\n`);
      for (const f of preflightResult.blockingFailures) {
        process.stderr.write(`\n   ❌ ${f.check}:\n`);
        process.stderr.write(`   ${f.message.split("\n").join("\n   ")}\n`);
      }
      process.exit(2);
    }
    process.exit(0);
  }

  // Plan exists but not yet approved — only allow meta files, block code
  if (!activePlan.approved_by) {
    let relativePath = filePath;
    if (filePath.startsWith(PROJECT_DIR)) {
      relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
    }

    const isExempt = PLAN_EXEMPT_PATHS.some(p => p.test(relativePath));
    if (isExempt) {
      process.exit(0);
    }

    const isCodeFile = CODE_FILE_PATTERNS.some(p => p.test(relativePath));
    if (isCodeFile) {
      process.stderr.write(
        `\n⛔ Write blocked: plan exists but not yet approved\n` +
        `   File: ${relativePath}\n` +
        `   Plan: ${activePlan.backlog_note}\n` +
        `\n   🔀 REDIRECT: The plan needs human approval first.\n` +
        `      The Governor sets approved_by after the approval gate.\n` +
        `      Do not write code files until the plan is approved.\n\n`
      );
      process.exit(2);
    }

    process.exit(0);
  }

  // Read the backlog note
  const notePath = path.join(PROJECT_DIR, activePlan.backlog_note);
  if (!fs.existsSync(notePath)) {
    process.stderr.write(
      `\n⚠️  Active plan references missing note: ${activePlan.backlog_note}\n` +
      `   Allowing edit, but consider deactivating the plan.\n\n`
    );
    process.exit(0);
  }

  const noteContent = fs.readFileSync(notePath, "utf8");
  const targetFiles = parseTargetFiles(noteContent);

  if (targetFiles.length === 0) {
    // No target files defined — block code files
    let relativePath = filePath;
    if (filePath.startsWith(PROJECT_DIR)) {
      relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
    }

    const isExempt = PLAN_EXEMPT_PATHS.some(p => p.test(relativePath));
    if (isExempt) {
      process.exit(0);
    }

    process.stderr.write(
      `\n⛔ Write blocked: plan has no ## Target Files section\n` +
      `   File: ${relativePath}\n` +
      `   Plan: ${activePlan.backlog_note}\n` +
      `\n   💡 Add a ## Target Files section to the story note\n` +
      `      listing the specific files this plan is allowed to modify.\n\n`
    );
    process.exit(2);
  }

  // Check if file is in scope
  if (!isPathAllowed(filePath, targetFiles)) {
    // Block - file is outside scope
    process.stderr.write(
      `\n⛔ Edit blocked: file is outside active plan scope\n` +
      `   File: ${filePath}\n` +
      `   Plan: ${activePlan.backlog_note}\n` +
      `\n   📋 Target files in scope:\n` +
      targetFiles.map(t => `      - ${t}`).join("\n") +
      `\n\n   💡 Either:\n` +
      `      - Add this file to the plan's ## Target Files\n` +
      `      - Deactivate the plan: rm .claude/active-plan.json\n` +
      `      - Work on a different task\n\n`
    );
    process.exit(2);
  }

  // === Pre-flight Checks (after scope passes) ===
  const preflightResult = runPreFlightChecks(filePath, scopeConfig);

  // Show warnings (but don't block)
  if (preflightResult.warnings && preflightResult.warnings.length > 0) {
    process.stderr.write(`\n⚠️  Pre-flight warnings:\n`);
    for (const w of preflightResult.warnings) {
      process.stderr.write(`   ${w.check}: ${w.message}\n`);
    }
    process.stderr.write(`\n`);
  }

  // Block if any blocking failures
  if (!preflightResult.passed) {
    process.stderr.write(`\n⛔ Edit blocked: pre-flight checks failed\n`);
    for (const f of preflightResult.blockingFailures) {
      process.stderr.write(`\n   ❌ ${f.check}:\n`);
      process.stderr.write(`   ${f.message.split("\n").join("\n   ")}\n`);
    }
    process.stderr.write(
      `\n   💡 Fix the issues above before editing this file.\n` +
      `   Or disable the check in .routekit/scope-policy.yaml\n\n`
    );
    process.exit(2);
  }

  // All checks passed
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
