#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook: Capture Plan to Backlog
 *
 * After ExitPlanMode, copies the plan content from ~/.claude/plans/
 * to a notes/backlog.*.md Dendron note for persistence.
 *
 * This is the FALLBACK mode when redirect_plans_to_backlog is false.
 *
 * Exit codes:
 *   0 = always (PostToolUse hooks are advisory only)
 */
import fs from "fs";
import path from "path";
import os from "os";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "backlog-policy.yaml");
const NOTES_DIR = path.join(PROJECT_DIR, "notes");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      enabled: true,
      redirect_plans_to_backlog: true,
      copy_on_exit: true,
      plan_source_dir: "~/.claude/plans",
      backlog_prefix: "backlog",
      initial_status: "planned",
    };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return yaml.load(content) || {};
  } catch {
    return { enabled: true };
  }
}

function expandPath(p) {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function findMostRecentPlan(sourceDir) {
  const expanded = expandPath(sourceDir);
  if (!fs.existsSync(expanded)) {
    return null;
  }

  const files = fs.readdirSync(expanded)
    .filter(f => f.endsWith(".md"))
    .map(f => ({
      name: f,
      path: path.join(expanded, f),
      mtime: fs.statSync(path.join(expanded, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0] : null;
}

function extractTitleAndSlug(content) {
  // Try to extract title from "# Plan: {title}" or "# {title}"
  const titleMatch = content.match(/^#\s*(?:Plan:\s*)?(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Untitled Plan";

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  return { title, slug: slug || `plan-${Date.now()}` };
}

function generateFrontmatter(slug, title, status) {
  const now = new Date().toISOString();
  return `---
id: backlog.${slug}
title: ${title}
desc: Implementation plan imported from Claude Code
created: ${now}
updated: ${now}
status: ${status}
source: claude-plan
---

`;
}

function createBacklogNote(slug, title, content, config) {
  const prefix = config.backlog_prefix || "backlog";
  const status = config.initial_status || "planned";
  const notePath = path.join(NOTES_DIR, `${prefix}.${slug}.md`);

  // Check if note already exists
  if (fs.existsSync(notePath)) {
    // Update existing note
    const existing = fs.readFileSync(notePath, "utf8");
    const frontmatterEnd = existing.indexOf("---", 4);
    if (frontmatterEnd > 0) {
      // Update the updated timestamp in frontmatter
      const newContent = existing.slice(0, frontmatterEnd + 3) +
        `\nupdated: ${new Date().toISOString()}\n` +
        content;
      fs.writeFileSync(notePath, newContent);
      return { path: notePath, updated: true };
    }
  }

  // Create new note
  const frontmatter = generateFrontmatter(slug, title, status);
  const fullContent = frontmatter + content;

  // Ensure notes directory exists
  if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  }

  fs.writeFileSync(notePath, fullContent);
  return { path: notePath, updated: false };
}

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

  // Only handle ExitPlanMode
  if (toolName !== "ExitPlanMode") {
    process.exit(0);
  }

  const config = loadConfig();

  // If not enabled or redirect is enabled (meaning we skip this fallback)
  if (!config.enabled || config.redirect_plans_to_backlog) {
    process.exit(0);
  }

  // Check if copy_on_exit is enabled
  if (!config.copy_on_exit) {
    process.exit(0);
  }

  // Find the most recent plan file
  const sourceDir = config.plan_source_dir || "~/.claude/plans";
  const planFile = findMostRecentPlan(sourceDir);

  if (!planFile) {
    process.stderr.write(`\n\u26A0\uFE0F  No plan files found in ${sourceDir}\n`);
    process.exit(0);
  }

  // Read plan content
  const content = fs.readFileSync(planFile.path, "utf8");
  const { title, slug } = extractTitleAndSlug(content);

  // Create backlog note
  try {
    const result = createBacklogNote(slug, title, content, config);
    const action = result.updated ? "Updated" : "Created";
    process.stderr.write(`\n\u2705 ${action} backlog note: ${result.path}\n`);
    process.stderr.write(`   Status: ${config.initial_status || "planned"}\n\n`);
  } catch (err) {
    process.stderr.write(`\n\u274C Failed to create backlog note: ${err.message}\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0);
});
