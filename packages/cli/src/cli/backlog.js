import path from "path";
import fs from "fs";
import os from "os";
import { glob } from "glob";

/**
 * Handle backlog CLI commands
 *
 * Commands:
 *   backlog list    - List all backlog items
 *   backlog import  - Import plan from ~/.claude/plans/
 *   backlog status  - Update status of a backlog item
 */
export async function handleBacklogCommand({ sub, kv, SHELL_ROOT }) {
  const projectRoot = process.cwd();
  const notesDir = path.join(projectRoot, "notes");

  if (sub === "list") {
    await listBacklogItems(notesDir, kv);
  } else if (sub === "import") {
    await importPlan(notesDir, kv);
  } else if (sub === "status") {
    await updateStatus(notesDir, kv);
  } else {
    printBacklogHelp();
    process.exit(1);
  }
}

function printBacklogHelp() {
  console.log(`Usage:
    routekit backlog list [--status=<status>] [--pretty]
    routekit backlog import [--file=<path>] [--slug=<slug>]
    routekit backlog status <slug> <new-status>

  Examples:
    routekit backlog list
    routekit backlog list --status=planned
    routekit backlog import
    routekit backlog import --file=~/.claude/plans/my-plan.md
    routekit backlog status my-feature approved
  `);
}

async function listBacklogItems(notesDir, kv) {
  const pattern = path.join(notesDir, "backlog.*.md");
  const files = await glob(pattern);

  if (files.length === 0) {
    console.log("No backlog items found.");
    process.exit(0);
  }

  const items = files.map(file => {
    const content = fs.readFileSync(file, "utf8");
    const frontmatter = parseFrontmatter(content);
    const slug = path.basename(file, ".md").replace("backlog.", "");

    return {
      slug,
      file: path.relative(process.cwd(), file),
      title: frontmatter.title || slug,
      status: frontmatter.status || "unknown",
      created: frontmatter.created || null,
      updated: frontmatter.updated || null,
    };
  });

  // Filter by status if specified
  const filterStatus = kv.status;
  const filtered = filterStatus
    ? items.filter(i => i.status === filterStatus)
    : items;

  // Sort by updated/created date (most recent first)
  filtered.sort((a, b) => {
    const dateA = a.updated || a.created || "";
    const dateB = b.updated || b.created || "";
    return dateB.localeCompare(dateA);
  });

  if (kv.pretty) {
    console.log("\nBacklog Items:\n");
    for (const item of filtered) {
      const statusIcon = getStatusIcon(item.status);
      console.log(`  ${statusIcon} ${item.slug}`);
      console.log(`     Title: ${item.title}`);
      console.log(`     Status: ${item.status}`);
      if (item.updated) console.log(`     Updated: ${item.updated}`);
      console.log();
    }
  } else {
    console.log(JSON.stringify({ items: filtered }, null, 2));
  }

  process.exit(0);
}

async function importPlan(notesDir, kv) {
  // Find plan file
  let planPath;

  if (kv.file) {
    planPath = expandPath(kv.file);
    if (!fs.existsSync(planPath)) {
      console.error(`Plan file not found: ${planPath}`);
      process.exit(1);
    }
  } else {
    // Find most recent plan in ~/.claude/plans/
    const plansDir = expandPath("~/.claude/plans");
    if (!fs.existsSync(plansDir)) {
      console.error(`Plans directory not found: ${plansDir}`);
      process.exit(1);
    }

    const planFiles = fs.readdirSync(plansDir)
      .filter(f => f.endsWith(".md"))
      .map(f => ({
        name: f,
        path: path.join(plansDir, f),
        mtime: fs.statSync(path.join(plansDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (planFiles.length === 0) {
      console.error("No plan files found in ~/.claude/plans/");
      process.exit(1);
    }

    planPath = planFiles[0].path;
    console.log(`Importing most recent plan: ${planFiles[0].name}`);
  }

  // Read plan content
  const content = fs.readFileSync(planPath, "utf8");

  // Generate slug
  const slug = kv.slug || extractSlugFromContent(content);

  // Create backlog note
  const backlogPath = path.join(notesDir, `backlog.${slug}.md`);

  // Check if exists
  if (fs.existsSync(backlogPath) && !kv.force) {
    console.error(`Backlog item already exists: ${backlogPath}`);
    console.error("Use --force to overwrite");
    process.exit(1);
  }

  // Extract title
  const titleMatch = content.match(/^#\s*(?:Plan:\s*)?(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;

  // Create frontmatter
  const now = new Date().toISOString();
  const frontmatter = `---
id: backlog.${slug}
title: ${title}
desc: Implementation plan imported from Claude Code
created: ${now}
updated: ${now}
status: planned
source: claude-plan
---

`;

  // Ensure notes dir exists
  if (!fs.existsSync(notesDir)) {
    fs.mkdirSync(notesDir, { recursive: true });
  }

  // Write file
  fs.writeFileSync(backlogPath, frontmatter + content);

  console.log(JSON.stringify({
    ok: true,
    slug,
    file: path.relative(process.cwd(), backlogPath),
    title,
    status: "planned",
  }, null, 2));

  process.exit(0);
}

async function updateStatus(notesDir, kv) {
  // Get slug and status from args
  const args = process.argv.slice(2);
  const slug = args[2]; // backlog status <slug> <status>
  const newStatus = args[3];

  if (!slug || !newStatus) {
    console.error("usage: routekit backlog status <slug> <new-status>");
    console.error("  statuses: planned, approved, implemented");
    process.exit(1);
  }

  const backlogPath = path.join(notesDir, `backlog.${slug}.md`);

  if (!fs.existsSync(backlogPath)) {
    console.error(`Backlog item not found: ${slug}`);
    process.exit(1);
  }

  // Read and update
  let content = fs.readFileSync(backlogPath, "utf8");
  const now = new Date().toISOString();

  // Update status in frontmatter
  content = content.replace(/^status:\s*.+$/m, `status: ${newStatus}`);
  content = content.replace(/^updated:\s*.+$/m, `updated: ${now}`);

  fs.writeFileSync(backlogPath, content);

  console.log(JSON.stringify({
    ok: true,
    slug,
    status: newStatus,
    updated: now,
  }, null, 2));

  process.exit(0);
}

// Helper functions

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }
  return fm;
}

function expandPath(p) {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

function extractSlugFromContent(content) {
  // Try to extract title from "# Plan: {title}" or "# {title}"
  const titleMatch = content.match(/^#\s*(?:Plan:\s*)?(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "untitled";

  // Convert to slug
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || `plan-${Date.now()}`;
}

function getStatusIcon(status) {
  switch (status) {
    case "planned": return "\u{1F4DD}";    // memo
    case "approved": return "\u{2705}";    // check
    case "implemented": return "\u{1F389}"; // party
    default: return "\u{2753}";            // question
  }
}
