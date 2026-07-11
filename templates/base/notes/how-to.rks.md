---
id: how-to.rks
title: How to Use RKS
desc: Complete guide to the RouteKit Shell workflow
---

# How to Use RKS

RouteKit Shell (RKS) is an AI-first development framework that brings structure and predictability to AI-assisted coding. This guide covers the core workflow and key tools.

## Core Philosophy

RKS enforces a structured workflow: **backlog → refine → plan → exec → ship**. This prevents AI from making random changes and ensures every modification is traceable, reviewable, and intentional.

## Quick Start Checklist

1. **RAG initialization**: `rks_rag_init` then `rks_rag_embed`
2. **Create a backlog story**: `dendron_create_note` with `backlog.feat.my-feature`
3. **Plan**: `rks_plan` with the story ID
4. **Execute**: `rks_exec` to apply the plan
5. **Ship**: `rks_ship` or manual PR workflow

## The Workflow

### 1. Creating Backlog Items

Every feature, bug fix, or task starts as a backlog story. Use Dendron to create structured notes:

```json
dendron_create_note {
  "vault": "notes",
  "fname": "backlog.feat.my-feature"
}
```

A good backlog story includes:

- **Problem**: What needs to be solved
- **Goal**: The desired outcome
- **Target Files**: Which files will be modified
- **Acceptance Criteria**: Testable conditions for completion

### 2. Refining Stories

Before planning, stories should be refined to ensure they're actionable:

```json
rks_refine {
  "projectId": "{{projectId}}",
  "problemId": "backlog.feat.my-feature"
}
```

Refinement analyzes the story against the codebase and suggests improvements. Apply refinements with `rks_refine_apply`.

### 3. Planning

Generate an implementation plan from a backlog story:

```json
rks_plan {
  "projectId": "{{projectId}}",
  "problemId": "backlog.feat.my-feature"
}
```

Or from a free-text task:

```json
rks_plan {
  "projectId": "{{projectId}}",
  "task": "Add a logout button to the header",
  "label": "add-logout"
}
```

Plans include:

- Step-by-step implementation actions
- File modifications with search/replace blocks
- Test commands to verify changes

### 4. Execution

Apply the plan to your codebase:

```json
rks_exec {
  "projectId": "{{projectId}}"
}
```

Execution:

- Creates a feature branch
- Applies file modifications
- Runs tests
- Creates a PR to staging

### 5. Shipping

The fastest way to ship is the `rks_ship` tool:

```json
rks_ship {
  "projectId": "{{projectId}}",
  "message": "add logout button",
  "scope": "auth",
  "problemId": "backlog.feat.logout-button"
}
```

This combines: commit → branch → PR → merge → cycle complete.

For manual control, use the individual git tools:

- `rks_git_commit` - Stage and commit with conventional format
- `rks_git_branch` - Create feature branch
- `rks_staging_pr` - Create PR to staging
- `rks_staging_merge` - Merge the PR
- `rks_cycle_complete` - Sync and cleanup

## Key Tools Reference

### Project Management

| Tool | Purpose |
| ---- | ------- |
| `rks_project_get` | Get project info and KG |
| `rks_analyze` | Scan codebase and build codemap |
| `rks_git_state` | Check branch and status |

### Planning & Execution

| Tool | Purpose |
| ---- | ------- |
| `rks_plan` | Generate implementation plan |
| `rks_exec` | Execute plan (branch, apply, test, PR) |
| `rks_ape` | Full cycle: analyze → plan → exec |
| `rks_refine` | Analyze and improve story |
| `rks_apply` | Apply plan without git operations |

### RAG System

| Tool | Purpose |
| ---- | ------- |
| `rks_rag_init` | Initialize LanceDB |
| `rks_rag_embed` | Embed notes into vector DB |
| `rks_rag_query` | Semantic search in notes |
| `orchestrator_query` | Multi-source intelligent search |

### Git Workflow

| Tool | Purpose |
| ---- | ------- |
| `rks_ship` | One-command shipping |
| `rks_git_commit` | Conventional commit |
| `rks_git_branch` | Create feature branch |
| `rks_staging_pr` | Create PR to staging |
| `rks_staging_merge` | Merge PR with squash |
| `rks_cycle_complete` | Sync staging, delete branch |
| `rks_release` | Release staging to main |

### Guardrails

| Tool | Purpose |
| ---- | ------- |
| `rks_guardrails_off` | Disable hooks for off-rail work |
| `rks_guardrails_on` | Restore hooks, get workflow guidance |
| `rks_guardrails_status` | Check current guardrails state |

## Guardrails System

RKS includes a guardrails system that enforces best practices through hooks. When guardrails are on:

- RAG queries are enforced before file reads
- Code context must have provenance
- Plans must come from backlog stories
- Git workflow is enforced

For exploratory or off-rail work:

```json
rks_guardrails_off {
  "projectId": "{{projectId}}",
  "reason": "Debugging production issue"
}
```

When done, restore guardrails:

```json
rks_guardrails_on {
  "projectId": "{{projectId}}"
}
```

This logs your session and provides workflow guidance for any changes made.

## RAG Queries

Use `orchestrator_query` for intelligent multi-source search:

```json
orchestrator_query {
  "projectId": "{{projectId}}",
  "query": "how does authentication work?"
}
```

This searches notes, code, and knowledge graph to provide contextual answers.

For direct note search:

```json
rks_rag_query {
  "projectId": "{{projectId}}",
  "q": "authentication flow",
  "k": 5
}
```

## Story Lifecycle

Stories progress through phases:

```
draft → ready → planned → executed → integrated → released
```

- **draft**: Initial creation, still being refined
- **ready**: Validated and ready for planning
- **planned**: Has an implementation plan
- **executed**: Plan applied, PR created
- **integrated**: Merged to staging
- **released**: Released to main

## Tips for Effective Use

1. **Start with good stories**: Clear acceptance criteria make planning more accurate
2. **Use RAG before coding**: Query the knowledge base to understand existing patterns
3. **Iterate with refinement**: Run `rks_refine` when plans fail quality checks
4. **Commit often**: Use `rks_ship` for quick iterations
5. **Keep guardrails on**: Only disable for specific exploratory work

## See Also

- [[project.overview]] - Project-specific details
- [[how-to.write-backlog-stories]] - Story writing guide
- [[how-to.story-lifecycle]] - Phase transitions and gates
