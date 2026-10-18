#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: Redirect Plan Mode to Backlog
 *
 * When redirect_plans_to_backlog is enabled, blocks EnterPlanMode
 * and instructs Claude to write plans directly to notes/backlog.*.md
 *
 * This saves tokens by avoiding ephemeral plan files and ensures
 * plans are persisted as project knowledge immediately.
 *
 * Exit codes:
 *   0 = allow (when redirect is disabled)
 *   2 = block (when redirect is enabled)
 */
import fs from "fs";
import path from "path";
import yaml from "../lib/js-yaml.mjs";

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = path.join(PROJECT_DIR, ".routekit", "backlog-policy.yaml");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      enabled: true,
      redirect_plans_to_backlog: true,
      backlog_prefix: "backlog",
      initial_status: "planned",
    };
  }
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf8");
    return yaml.load(content) || {};
  } catch {
    return { enabled: true, redirect_plans_to_backlog: true };
  }
}

function generateTimestamp() {
  return new Date().toISOString().split("T")[0];
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

  // Only handle EnterPlanMode
  if (toolName !== "EnterPlanMode") {
    process.exit(0);
  }

  const config = loadConfig();

  // If not enabled or redirect is disabled, allow normal plan mode
  if (!config.enabled || !config.redirect_plans_to_backlog) {
    process.exit(0);
  }

  // Block EnterPlanMode and provide instructions
  const prefix = config.backlog_prefix || "backlog";
  const status = config.initial_status || "planned";
  const today = generateTimestamp();

  process.stderr.write(`
\u{1F4DD} Plan mode redirected to backlog

Instead of using ephemeral plan mode, write your plan directly to a backlog note.

\u{1F4C1} Create: notes/${prefix}.{your-feature-slug}.md

\u{1F4CB} Template:
\`\`\`markdown
---
id: ${prefix}.your-feature-slug
title: Your Feature Title
desc: Brief description of the feature
created: ${today}
updated: ${today}
status: ${status}
---

# Your Feature Title

## Overview
What are we building and why?

## Implementation
- Phase 1: ...
- Phase 2: ...

## Target Files
- path/to/file1.ts
- path/to/file2.ts

## Verification
How to test this works.
\`\`\`

\u{1F4A1} Benefits:
- Plan persists as project knowledge immediately
- Searchable via RAG
- Status tracking (${status} \u2192 approved \u2192 implemented)
- No extra token overhead

To use traditional plan mode, set \`redirect_plans_to_backlog: false\`
in .routekit/backlog-policy.yaml

`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`Hook error: ${err.message}\n`);
  process.exit(0); // On error, allow to avoid blocking work
});
