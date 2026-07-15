---
id: how-to.golden-path
title: Golden Path - Quick Start Guide
desc: Concise guide to get started with RouteKit Shell
updated: 1770007368924
created: 1768797105146
---

# Golden Path - Quick Start Guide

This guide covers the essential workflow for using RouteKit Shell effectively.

## Prerequisites

- **Node.js 18+** - Required runtime
- **pnpm** - Package manager (`npm install -g pnpm`)
- **Git** - Version control
- **VS Code** - Recommended IDE with Dendron extension

## Quick Start

### 1. Clone and Setup

```bash
git clone <repo-url>
cd routekit-shell
pnpm install
```

### 2. Create a New Project

```bash
# List available templates
node packages/cli/bin/routekit.js templates list

# Initialize a new project
node packages/cli/bin/routekit.js project init \
  --id=my-project \
  --stack=web-vite-rag-agency \
  --path=/path/to/my-project
```

### 3. Check Your Workflow

Before starting work, check your project's branch configuration:

```
rks_preflight { "projectId": "my-project" }
```

This shows your working branch (default: `staging`) and workflow type.

### 4. Work on a Backlog Story

```bash
# Checkout your working branch (default: staging, or check rks_preflight output)
git checkout <working-branch>

# Plan the story
node packages/cli/bin/routekit.js plan <projectId> --problem backlog.story-name

# Review the plan in .rks/runs/<timestamp>/plan.yaml

# Execute the plan (creates branch, applies changes, runs tests)
# Use MCP tool: rks_exec with projectId and label
```

## Core Workflow

1. **Start on working branch** - Checkout your project's working branch (run `rks_preflight` to see which)
2. **Plan first** - Use `rks_plan` to generate implementation plan
3. **Review plan** - Check `.rks/runs/<label>/plan.yaml` for quality
4. **Execute** - Use `rks_exec` to apply changes with guardrails
5. **Mark implemented** - Use `dendron_mark_implemented` to update story status
6. **PR to integration** - Use `rks_staging_pr` to create PR
7. **Merge PR** - Use `rks_staging_merge` to merge the PR
8. **Release to production** - User reviews integration → production periodically

**For custom workflows** (working ≠ integration):
- Use `rks_promote` to merge working → integration when ready for CI builds

**Important**: Mark the story as implemented BEFORE creating the PR. This ensures the doc status update is part of the same PR as the code changes, keeping everything in sync.

## Common Commands

| Command | Description |
|---------|-------------|
| `routekit plan <project> --problem <id>` | Generate implementation plan |
| `routekit rag embed <project>` | Refresh RAG embeddings |
| `routekit project list` | List registered projects |
| `routekit templates list` | Show available stack templates |

## MCP Tools (Preferred)

| Tool | Description |
|------|-------------|
| `rks_preflight` | Check prerequisites and show workflow config |
| `rks_plan` | Plan from backlog item or task |
| `rks_exec` | Execute plan with guardrails |
| `rks_plan_review` | Validate plan quality |
| `rks_staging_pr` | Create PR to integration branch |
| `rks_staging_merge` | Merge integration PR |
| `rks_promote` | Merge working → integration (custom workflows) |
| `dendron_mark_implemented` | Mark story as implemented |
| `rks_rag_embed` | Refresh embeddings |

## Tips

- **Run preflight first** - Check your workflow configuration before starting
- **Commit before planning** - Triggers auto-embed hook
- **Use MCP tools** - Better than CLI for consistency
- **Check plan.yaml** - Review before executing
- **Tests must pass** - exec blocks if tests fail pre-apply
- **Mark implemented before PR** - Keeps docs and code in the same PR