#!/usr/bin/env node
/**
 * protect-system-files.mjs — PreToolUse hook (system tier)
 *
 * Hard block on Write/Edit to system files that must never be modified
 * by the Dispatcher or Governors. These files are managed by the user only.
 *
 * Protected files:
 *   - CLAUDE.md (Dispatcher instructions)
 *   - .claude/settings.json (hooks + permissions)
 *   - .claude/settings.local.json
 *
 * Exit codes:
 *   0 = allow
 *   2 = block
 */

const PROTECTED_PATTERNS = [
  /\/CLAUDE\.md$/,
  /^CLAUDE\.md$/,
  /\/\.claude\/settings.*\.json$/,
  /^\.claude\/settings.*\.json$/,
];

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const { tool_name, tool_input } = input;

  if (!["Edit", "Write"].includes(tool_name)) {
    process.exit(0);
  }

  const filePath = tool_input.file_path || tool_input.path || "";
  const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Normalize to relative
  let relPath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relPath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  for (const pattern of PROTECTED_PATTERNS) {
    if (pattern.test(filePath) || pattern.test(relPath)) {
      process.stderr.write(
        `\n⛔ Write blocked: ${relPath} is a protected system file\n` +
        `   This file is managed by the user only. Governors and Dispatchers must not modify it.\n\n`
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
