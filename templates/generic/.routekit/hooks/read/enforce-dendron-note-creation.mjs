#!/usr/bin/env node
/**
 * Template: Enforce Dendron MCP for note creation
 * PreToolUse hook: block Write to notes/*.md except allowed exceptions
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with message to stderr)
 */
import fs from "node:fs";
import path from "node:path";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const isNotesMd = (relativePath) => /^notes\/.*\.md$/.test(relativePath);
const isDraftNamespace = (relativePath) => /^notes\/drafts\./.test(relativePath) || /^notes\/scratch\./.test(relativePath);

const hasRagFalseFrontmatter = (absolutePath) => {
  try {
    if (!fs.existsSync(absolutePath)) return false;
    const contents = fs.readFileSync(absolutePath, "utf8");
    return /(^|\n)\s*rag\s*:\s*false(\s|\n)/m.test(contents);
  } catch {
    return false;
  }
};

async function main() {
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

  if (toolName === "Edit") process.exit(0);
  if (toolName !== "Write") process.exit(0);

  const filePath = toolInput.file_path;
  if (!filePath) process.exit(0);

  let relativePath = filePath;
  if (filePath.startsWith(PROJECT_DIR)) {
    relativePath = filePath.slice(PROJECT_DIR.length).replace(/^\//, "");
  }

  if (!isNotesMd(relativePath)) process.exit(0);
  if (isDraftNamespace(relativePath)) process.exit(0);

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(PROJECT_DIR, filePath);
  if (hasRagFalseFrontmatter(absolutePath)) process.exit(0);

  const msg = [
    "",
    "⛔ Direct note creation blocked by enforce-dendron-note-creation hook.",
    "   Use Dendron MCP tooling to create notes so frontmatter, IDs, and schemas are correct:",
    "     - dendron_create_note",
    "     - Edit (for existing notes)",
    "",
    "   Exceptions: notes/drafts.* or notes/scratch.* and notes with `rag: false` in frontmatter.",
    ""
  ].join("\n");
  process.stderr.write(msg);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
