---
id: how-to.story-lifecycle
title: Story Lifecycle and Phases
desc: Phase transitions and gates for backlog stories
updated: 1769717940789
created: 1769717940789
---

# Story Lifecycle and Phases

Every story progresses through a defined lifecycle. The phase field tracks where a story is in this journey.

## Phase Overview

```
draft → ready → arch-approved → planned → executed → implemented
          ↑            ↑           ↑         ↑
          └────────────┴───────────┴─────────┘ (can regress if issues found)
```

| Phase | Description | Next Phase |
|-------|-------------|------------|
| `draft` | Initial state, story being written | `ready` |
| `ready` | Story validated by QA, ready for ARCH review | `arch-approved` or back to `draft` |
| `arch-approved` | Passed ARCH Governor review, cleared for build | `planned` or back to `ready` |
| `planned` | Plan generated, ready for execution | `executed` or back to `ready` |
| `executed` | Changes applied, PR created | `implemented` or back to `ready` |
| `implemented` | PR merged to staging — terminal state | — |

> **Note:** `integrated` and `released` exist in the phase enum for future use (e.g. distinguishing staging integration from production release), but are not yet wired into the active lifecycle.

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

Story is complete and validated by the QA Governor.

**What happens here:**
- Story structure is validated
- Target files are confirmed to exist
- QA Governor has reviewed and approved test requirements
- Next: Dispatcher invokes ARCH Governor before Build

**Gate to exit:** Story must have `phase: ready` explicitly set.

**Regression:** Can go back to `draft` if story needs rework.

### Arch-Approved

Story has passed the ARCH Governor's mandatory architectural review.

**What happens here:**

- ARCH Governor checks 8 mechanical items (symbol existence, secondary paths, test strategy, etc.)
- ARCH writes `arch_guidance` to the story with verdict and findings
- Phase advanced from `ready` to `arch-approved`
- Story is now cleared for Build

**Gate to exit:** Story must have `phase: arch-approved`.

**Tools:**

- `rks_plan` - Generate execution plan (accepts both `ready` and `arch-approved`)

**Regression:** Can go back to `ready` if ARCH finds issues that require story rework.

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

Terminal state. Story is complete and merged to staging.

**What happens here:**
- PR merged to staging
- Story note archived to `backlog.z_implemented.*` namespace
- Phase set to `implemented`

**No regression:** This is the end state.

**Tools:**

- `rks_story_ship` / `dendron_mark_implemented` - Merge PR and archive story note

## Transition Commands

| Transition | Command | What It Does |
|------------|---------|--------------|
| draft → ready | (manual) | Set `phase: ready` in frontmatter |
| ready → planned | `rks_plan` | Generates plan, updates phase |
| planned → executed | `rks_exec` | Applies plan, creates PR, updates phase |
| executed → implemented | `rks_story_ship` | Merges PR, archives note to `z_implemented` namespace |

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