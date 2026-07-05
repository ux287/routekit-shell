---
id: how-to.rks.story-lifecycle
title: Story Lifecycle
desc: Phase transitions and gates in the RKS workflow
updated: 1769717971969
created: 1769717971969
---

# Story Lifecycle

Every RKS story progresses through a defined lifecycle. Each phase has entry gates that must pass before transitioning.

## The Phases

```
draft → ready → planned → executed → integrated → released
```

| Phase | Meaning | Next Action |
| ----- | ------- | ----------- |
| `draft` | Initial creation, being refined | Complete required fields |
| `ready` | Validated, ready for planning | Run `rks_plan` |
| `planned` | Has implementation plan | Run `rks_exec` |
| `executed` | Changes applied, PR created | Merge PR |
| `integrated` | Merged to staging | Release to main |
| `released` | In production | Archive |

## Phase Transitions

### draft → ready

**Gate**: Story completeness check

Requirements:
- `title` is set
- `desc` is set
- `targetFiles` has at least one file
- Target files exist in codebase
- Has Problem section
- Has Goal section
- Has Acceptance Criteria

Use `rks_plan_ready` to validate and promote:

```json
rks_plan_ready {
  "projectId": "my-project",
  "problemId": "backlog.feat.my-feature"
}
```

If validation fails, you'll get specific feedback about what's missing.

### ready → planned

**Gate**: Plan generation succeeds

Requirements:
- Story is in `ready` phase
- RAG index is current
- SEARCH blocks (if any) match file content
- LLM generates valid plan with steps

Use `rks_plan`:

```json
rks_plan {
  "projectId": "my-project",
  "problemId": "backlog.feat.my-feature"
}
```

If planning fails:
- Check SEARCH block accuracy
- Run `rks_rag_embed` to update index
- Use `rks_refine` for suggestions

### planned → executed

**Gate**: Execution succeeds

Requirements:
- Story is in `planned` phase
- Clean git working tree
- Tests pass before changes (baseline)
- Plan applies without errors
- Tests pass after changes

Use `rks_exec`:

```json
rks_exec {
  "projectId": "my-project"
}
```

Execution creates a feature branch, applies changes, and creates a PR.

### executed → integrated

**Gate**: PR merged to staging

Requirements:
- PR exists and is open
- No merge conflicts
- CI checks pass (if configured)

Use `rks_staging_merge` or `rks_story_ship`:

```json
rks_story_ship {
  "projectId": "my-project",
  "problemId": "backlog.feat.my-feature"
}
```

This merges the PR and marks the story as implemented.

### integrated → released

**Gate**: Release to main

Requirements:
- Story is in `integrated` phase
- Staging is ready for release

Use `rks_release`:

```json
rks_release {
  "projectId": "my-project",
  "version": "minor"
}
```

This creates a release, updates version, and transitions all integrated stories to released.

## Automatic Transitions

Some transitions happen automatically:

| Trigger | Transition |
| ------- | ---------- |
| `rks_plan` success | ready → planned |
| `rks_exec` success | planned → executed |
| `rks_staging_merge` success | executed → integrated |
| `rks_release` success | integrated → released |

## Demotion

Stories can be demoted when quality checks fail:

| Event | Demotion |
| ----- | -------- |
| Plan quality check fails | planned → draft |
| Execution fails | No demotion, stays planned |
| Test failures | No demotion, manual fix needed |

When demoted, the story needs refinement before re-planning.

## Checking Phase

View current phase in story frontmatter:

```yaml
---
id: "backlog.feat.my-feature"
phase: "ready"
---
```

Or query via tool:

```json
dendron_read_note {
  "vault": "notes",
  "fname": "backlog.feat.my-feature"
}
```

## Implemented Stories

When a story reaches `implemented` status:

1. Status changes from `not-implemented` to `implemented`
2. Story is renamed to `backlog.z_implemented.*`
3. `commitId` is recorded in frontmatter
4. Story is excluded from RAG queries

This keeps the active backlog clean while preserving history.

## Phase Enforcement

RKS guardrails enforce phase progression:

- `rks_plan` blocks unless story is `ready`
- `rks_exec` blocks unless story is `planned`
- Direct phase jumps are prevented

This ensures every story goes through proper validation.

## Troubleshooting

### Stuck in draft

Story is missing required fields. Check:
- `targetFiles` is populated
- Problem/Goal/AC sections exist
- Target files exist in codebase

### Plan keeps failing

Common causes:
- SEARCH blocks don't match file content exactly
- RAG index is stale (run `rks_rag_embed`)
- Target files have changed since story was written

Use `rks_refine` to analyze failures.

### Execution fails

Common causes:
- Merge conflicts (story is based on old code)
- Tests fail after changes
- File paths changed

Review the error message and update the story or plan.

## See Also

- [[how-to.rks]] - Complete RKS workflow guide
- [[how-to.rks.write-backlog-stories]] - Story structure and patterns
