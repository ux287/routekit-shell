---
id: how-to.story-lifecycle
title: Story Lifecycle and Phases
desc: Phase transitions and gates for backlog stories
---

# Story Lifecycle and Phases

Every story progresses through a defined lifecycle. The phase field tracks where a story is in this journey.

## Phase Overview

```
draft → ready → planned → executed → implemented
          ↑        ↑         ↑
          └────────┴─────────┘ (can regress if issues found)
```

| Phase | Description | Next Phase |
|-------|-------------|------------|
| `draft` | Initial state, story being written | `ready` |
| `ready` | Story validated, ready for planning | `planned` or back to `draft` |
| `planned` | Plan generated, ready for execution | `executed` or back to `ready` |
| `executed` | Changes applied, PR created | `implemented` or back to `ready` |
| `implemented` | Merged and complete | (terminal) |

## Phase Details

### Draft

The initial state when a story is created.

**What happens here:**
- Write problem statement
- Define goals and acceptance criteria
- Identify target files
- Optionally add explicit SEARCH/REPLACE edits

**Gate to exit:** Must have `targetFiles` defined and non-empty.

**Tools:**
- `dendron_create_note` - Create the story
- `dendron_edit_note` - Modify story content

### Ready

Story is complete and validated for planning.

**What happens here:**
- Story structure is validated
- Target files are confirmed to exist
- Ready for LLM planning

**Gate to exit:** Story must have `phase: ready` explicitly set.

**Tools:**
- `rks_plan` - Generate execution plan from story

**Regression:** Can go back to `draft` if story needs rework.

### Planned

A plan has been generated and reviewed.

**What happens here:**
- Plan exists in `.rks/runs/<runId>/plan.json`
- Steps are validated against codebase
- Quality checks passed

**Gate to exit:** Story must have `phase: planned`.

**Tools:**
- `rks_exec` - Execute the plan (creates branch, applies changes, runs tests)
- `rks_plan` - Re-plan if current plan is rejected

**Regression:** Can go back to `ready` if plan needs regeneration.

### Executed

Changes have been applied and a PR exists.

**What happens here:**
- Feature branch created
- Code changes applied
- Tests run (pre and post)
- PR created to staging

**Tools:**
- `rks_story_ship` - Merge PR and mark implemented
- `rks_staging_merge` - Merge the PR
- `rks_cycle_complete` - Clean up after merge

**Regression:** Can go back to `ready` if execution failed or changes need revision.

### Implemented

Terminal state. Story is complete.

**What happens here:**
- PR merged to staging
- Story moved to `backlog.z_implemented.*`
- Status changed to `implemented`

**No regression:** This is the end state.

**Tools:**
- `dendron_mark_implemented` - Move story to implemented namespace

## Transition Commands

| Transition | Command | What It Does |
|------------|---------|--------------|
| draft → ready | (manual) | Set `phase: ready` in frontmatter |
| ready → planned | `rks_plan` | Generates plan, updates phase |
| planned → executed | `rks_exec` | Applies plan, creates PR, updates phase |
| executed → implemented | `rks_story_ship` | Merges PR, moves to z_implemented |

## Gates

Gates are validation checks that must pass before a transition.

### draft → ready

- **has_target_files**: Story must have `targetFiles` array with at least one file

### ready → planned

- **phase_is_ready**: Story phase must explicitly be "ready"

### planned → executed

- **phase_is_planned**: Story phase must be "planned"

## Handling Failures

### Plan Failed

If `rks_plan` fails:
1. Check error message for specific issue
2. Update story to fix the problem
3. Re-run `rks_plan`

Common issues:
- Target files don't exist
- SEARCH patterns don't match file content
- RAG index is stale

### Execution Failed

If `rks_exec` fails:
1. Check test output for failures
2. Story phase may regress to `ready`
3. Update story or plan
4. Re-run `rks_plan` then `rks_exec`

### Merge Conflicts

If `rks_staging_merge` fails:
1. Use `rks_resolve_conflict` for guided resolution
2. Or manually resolve and retry merge

## Quick Reference

```
# Check current phase
dendron_read_note { filename: "backlog.my-story.md" }

# Advance from draft to ready
dendron_update_field { filename: "backlog.my-story.md", field: "phase", value: "ready" }

# Plan the story
rks_plan { projectId: "my-project", problemId: "backlog.my-story" }

# Execute the plan
rks_exec { projectId: "my-project" }

# Ship it
rks_story_ship { projectId: "my-project", problemId: "backlog.my-story" }
```

## See Also

- [[how-to.write-backlog-stories]] - How to write effective stories
- [[how-to.rks]] - Overall RKS workflow
