---
id: r4do0w7n0hwaignl8ykmlz8
title: RKS Three-Branch Workflow Guide
desc: Template for projects using dev → staging → main workflow
updated: 1770143053861
created: 1770007766865
---

# How to Use RKS

RouteKit Shell (RKS) is an AI-first development framework that brings structure and predictability to AI-assisted coding. This guide covers the core workflow and key tools.

## Core Philosophy

RKS enforces a structured workflow: **backlog → refine → plan → exec → story_ship → promote → release**. This prevents AI from making random changes and ensures every modification is traceable, reviewable, and intentional.

## Branch Topology

This project uses a three-branch workflow:

| Branch    | Role               | Notes                                   |
| --------- | ------------------ | --------------------------------------- |
| `dev`     | Working branch     | Local development, not pushed to origin |
| `staging` | Integration branch | Triggers Netlify preview builds         |
| `main`    | Production branch  | Triggers production deploys             |

**Workflow**: `plan → exec → story_ship → promote → release`

Use `rks_promote` to merge dev → staging when ready for preview builds.

## Quick Start Checklist

1. **Check workflow config**: `rks_preflight` to confirm branch topology
2. **RAG initialization**: `rks_rag_init` then `rks_rag_embed`
3. **Create a backlog story**: `dendron_create_note` with `backlog.feat.my-feature`
4. **Plan**: `rks_plan` with the story ID
5. **Execute**: `rks_exec` to apply the plan (commits locally)
6. **Ship story**: `rks_story_ship` to push, PR, merge, and cleanup ← REQUIRED after exec
7. **Promote**: `rks_promote` when ready for preview build (dev → staging)
8. **Release**: `rks_release` to release to production (staging → main)

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

- Creates a feature branch from dev
- Applies file modifications
- Runs tests
- Commits changes locally

**⚠️ REQUIRED NEXT STEP**: After `rks_exec` succeeds, you MUST run `rks_story_ship`:

```json
rks_story_ship {
  "projectId": "{{projectId}}",
  "problemId": "backlog.feat.my-feature"
}
```

`rks_story_ship` handles the complete shipping flow:
- Pushes branch to remote (if needed)
- Creates PR to working branch
- Merges the PR
- Marks story as implemented
- Completes the cycle (cleanup, sync)

Do NOT skip this step. The `rks_exec` output will include a `requiredNext` field with the exact command to run.

### 5. Promotion

When ready for a preview build, promote dev to staging:

```json
rks_promote {
  "projectId": "{{projectId}}"
}
```

This merges dev → staging and triggers the Netlify preview build.

### 6. Shipping

The fastest way to ship is the `rks_ship` tool:

```json
rks_ship {
  "projectId": "{{projectId}}",
  "message": "add logout button",
  "scope": "auth",
  "problemId": "backlog.feat.logout-button"
}
```

This combines: commit → branch → PR → cycle complete.

**Note**: With `autoMergeIntegration: false`, the PR stays open. Use `rks_promote` separately to control when builds trigger.

For manual control, use the individual git tools:

- `rks_git_commit` - Stage and commit with conventional format
- `rks_git_branch` - Create feature branch
- `rks_staging_pr` - Create PR to dev
- `rks_promote` - Merge dev → staging (triggers preview build)
- `rks_cycle_complete` - Sync and cleanup

## Key Tools Reference

### Project Management

| Tool              | Purpose                                      |
| ----------------- | -------------------------------------------- |
| `rks_project_get` | Get project info and KG                      |
| `rks_preflight`   | Check prerequisites and show workflow config |
| `rks_analyze`     | Scan codebase and build codemap              |
| `rks_git_state`   | Check branch and status                      |

### Planning & Execution

| Tool             | Purpose                                      |
| ---------------- | -------------------------------------------- |
| `rks_plan`       | Generate implementation plan                 |
| `rks_exec`       | Execute plan (branch, apply, test, commit)   |
| `rks_story_ship` | Ship story (push, PR, merge, mark, cleanup)  |
| `rks_ape`        | Full cycle: analyze → plan → exec            |
| `rks_refine`     | Analyze and improve story                    |
| `rks_apply`      | Apply plan without git operations            |

### RAG System

| Tool                 | Purpose                         |
| -------------------- | ------------------------------- |
| `rks_rag_init`       | Initialize LanceDB              |
| `rks_rag_embed`      | Embed notes into vector DB      |
| `rks_rag_query`      | Semantic search in notes        |
| `orchestrator_query` | Multi-source intelligent search |

### Git Workflow

| Tool                 | Purpose                                |
| -------------------- | -------------------------------------- |
| `rks_ship`           | One-command shipping                   |
| `rks_git_commit`     | Conventional commit                    |
| `rks_git_branch`     | Create feature branch                  |
| `rks_staging_pr`     | Create PR to dev                       |
| `rks_promote`        | Merge dev → staging (triggers preview) |
| `rks_cycle_complete` | Sync dev, delete branch                |
| `rks_release`        | Release staging to main                |

### Guardrails

| Tool                    | Purpose                              |
| ----------------------- | ------------------------------------ |
| `rks_guardrails_off`    | Disable hooks for off-rail work      |
| `rks_guardrails_on`     | Restore hooks, get workflow guidance |
| `rks_guardrails_status` | Check current guardrails state       |

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

```text
draft → ready → planned → executed → shipped → integrated → released
```

- **draft**: Initial creation, still being refined
- **ready**: Validated and ready for planning
- **planned**: Has an implementation plan
- **executed**: Plan applied and committed locally (after `rks_exec`)
- **shipped**: PR merged to working branch (after `rks_story_ship`)
- **integrated**: Merged to staging (after `rks_promote`)
- **released**: Released to main (after `rks_release`)

**Key transition**: After `rks_exec` completes, you MUST run `rks_story_ship` to move from executed → shipped. This is not optional.

## Tips for Effective Use

1. **Run preflight first**: Check your workflow configuration before starting
2. **Start with good stories**: Clear acceptance criteria make planning more accurate
3. **Use RAG before coding**: Query the knowledge base to understand existing patterns
4. **Iterate with refinement**: Run `rks_refine` when plans fail quality checks
5. **Batch before promoting**: Accumulate changes on dev, then promote when ready for preview
6. **Keep guardrails on**: Only disable for specific exploratory work

## See Also

- [[project.overview]] - Project-specific details
- [[how-to.write-backlog-stories]] - Story writing guide
- [[how-to.story-lifecycle]] - Phase transitions and gates
