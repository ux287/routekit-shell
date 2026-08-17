---
id: ds31mq3yrcve32dr5ecdlp4
title: Dendron Note Creation Workflow
desc: How to create properly templated Dendron notes using MCP tools
updated: '2026-01-17T19:08:50.012Z'
created: '2026-01-17T19:08:50.012Z'
---

# {{fm.title}}

## Purpose
What this guide helps you accomplish

## Prerequisites
What you need to know or have set up before starting

## Step-by-Step Instructions

### Step 1: [First Action]
Detailed instructions with commands or actions

### Step 2: [Second Action]  
Continue with clear, actionable steps

## Validation
How to confirm each step worked correctly

## Troubleshooting
Common issues and their solutions

## Related Guides
Links to related procedures or documentation

## Overview

This guide covers the recommended workflow for creating Dendron notes in RouteKit Shell projects. Due to Dendron VS Code extension being in maintenance mode, some automatic features (like auto-template application) don't work reliably. This workflow provides a consistent, tested alternative.

## Recommended: MCP `dendron_create_note`

The MCP `dendron_create_note` tool is the **single source of truth** for templated note creation. It:

1. Detects matching schemas (e.g., `backlog.*` matches `schema.backlog.yml`)
2. Loads the associated template (`templates.backlog.md`)
3. Merges template frontmatter with generated fields
4. Either uses template body (for empty notes) or **replaces** it with provided content

### Creating a backlog item with content

```
dendron_create_note({
  filename: "backlog.my-feature.md",
  title: "My Feature",
  content: `## Problem
The actual problem description.

## Goal
The actual goal.

## Target Files
- src/feature.ts

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2`
})
```

**Result**: A properly formatted backlog note with:
- Frontmatter: `id`, `title`, `desc`, `updated`, `created`, `status: not-implemented`, `targetFiles: []`
- Body: Your provided content (template placeholders are **replaced**, not appended)

### Creating a backlog item without content (template placeholders)

```
dendron_create_note({
  filename: "backlog.my-feature.md",
  title: "My Feature"
})
```

**Result**: A backlog note with template placeholder text that you fill in manually.

## Alternative: VS Code "Apply Template" Command

If you create a note via VS Code's Dendron extension and it doesn't have the template applied:

1. Open the note in VS Code
2. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
3. Type "Dendron: Apply Template"
4. Select `templates.backlog` (or relevant template)

This copies the template's frontmatter fields and body into your note.

## Schema-Template Mapping

| Schema | Template | Auto-applies |
|--------|----------|--------------|
| `backlog.*` | `templates.backlog` | `status`, `targetFiles` frontmatter |
| `design.*` | N/A | Standard frontmatter only |
| `docs.*` | N/A | Standard frontmatter only |

## Frontmatter Fields

### Standard fields (all notes)
- `id`: Auto-generated from filename
- `title`: Auto-generated or custom
- `desc`: Auto-generated from namespace or custom
- `updated`: ISO timestamp
- `created`: ISO timestamp

### Backlog-specific fields
- `status`: One of `not-implemented`, `implemented`, `blocked`, `deprecated`
- `targetFiles`: Array of file paths affected by this backlog item

## Troubleshooting

### Template not applied
- Ensure schema is registered in both `dendron.yml` and root `schema.yml`
- Use MCP `dendron_create_note` instead of VS Code "Create Note"
- Check schema file naming: `schema.[namespace].yml` (not `[namespace].schema.yml`)

### Duplicate content sections
- This was a bug (fixed in `backlog.dogfooding.01-mcp-schema-template-consistency`)
- If content is provided, it now **replaces** template body instead of appending

### Missing frontmatter fields
- Ensure template file has the fields in its frontmatter
- Example: `templates.backlog.md` must have `status: not-implemented` and `targetFiles: []`