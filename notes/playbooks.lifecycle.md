---
id: j1ln1fojawzevtxhgnbaa14
title: Lifecycle Playbook
desc: 'Full story automation: validate → plan → exec → ship → complete'
updated: 1771180385187
created: 1771180385187
agents:
  - rks_agent_validate_story
  - rks_agent_research
  - rks_agent_ship
  - rks_agent_cycle_complete
  - rks_agent_git
  - rks_agent_dendron
phases:
  - name: validate
    agent: rks_agent_validate_story
    description: Validate story readiness against acceptance criteria
    gate: null
    required: true
  - name: plan
    agent: null
    description: 'Research codebase, design implementation approach, write plan'
    gate: approval
    required: true
  - name: exec
    agent: null
    description: 'Execute plan — edit files, run tests, iterate until green'
    gate: null
    required: true
  - name: ship
    agent: rks_agent_ship
    description: 'Branch, commit, PR, merge, staging sync'
    gate: null
    required: true
  - name: complete
    agent: rks_agent_cycle_complete
    description: 'Mark implemented, run governance, embed RAG'
    gate: null
    required: true
audibles:
  - trigger: ship.merge_conflict
    action: 'Call Git Agent to check state, attempt rebase, retry ship'
    maxRetries: 1
  - trigger: exec.tests_fail
    action: 'Read test output, fix the failing code, re-run tests'
    maxRetries: 2
  - trigger: validate.fail
    action: Return validation errors as needs_approval — let user decide
    maxRetries: 0
---

# Lifecycle Playbook

Full story automation from validation through shipping. This is the most complex playbook and the highest-value target — if the Governor can run a full lifecycle, it can run anything.

## Source

Migrated from the Lifecycle Agent composite orchestrator.

## Phase Details

### 1. validate

**Agent**: Product Owner (`rks_agent_validate_story`)
**Entry**: storyId provided, story note exists
**Exit**: Validation passes (quality score >= 0.7)
**On failure**: Return validation errors to user as `needs_approval`. User can override or fix the story note.

Call the PO agent with `{ projectId, problemId: storyId }`. If quality score is below threshold, escalate to user.

### 2. plan

**Agent**: None (Governor uses raw tools + Research Agent)
**Entry**: Story validated
**Exit**: Implementation plan written and approved by user
**Gate**: `approval` — Governor presents the plan and waits for user sign-off

Steps:
1. Call Research Agent to understand the codebase area affected
2. Read relevant files directly (raw Read tool)
3. Design an implementation approach
4. Write the plan as structured output
5. Return `needs_approval` with the plan for user review

### 3. exec

**Agent**: None (Governor uses raw tools)
**Entry**: Plan approved
**Exit**: All files modified, tests passing

Steps:
1. Edit/Write files per the approved plan
2. Run tests via Bash (`npm test` or project-specific command)
3. If tests fail: read output, fix, re-run (audible: max 2 retries)
4. Verify all changes are consistent

### 4. ship

**Agent**: Ship Agent (`rks_agent_ship`)
**Entry**: Code changes complete, tests passing
**Exit**: PR merged, staging synced

Call Ship Agent with `{ projectId, storyId }`. Ship Agent handles branch creation, commit, PR, merge, and staging sync autonomously.

**Audible**: If merge conflict, call Git Agent to diagnose, attempt resolution, retry once.

### 5. complete

**Agent**: Cycle Complete (`rks_agent_cycle_complete`)
**Entry**: PR merged
**Exit**: Story marked implemented, governance passed, RAG embedded

Call Cycle Complete with `{ projectId, storyId, prNumber }` using the PR number from the ship phase.