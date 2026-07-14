---
id: playbooks.delivery
title: Delivery Playbook
desc: >-
  Walk-away release automation: discover, validate, plan, implement, ship,
  complete
updated: 1771182729532
created: 1771182729532
agents:
  - rks_agent_story
  - rks_refine
  - rks_refine_apply
  - rks_story_create
  - rks_agent_validate_story
  - rks_agent_plan
  - rks_agent_delivery
  - rks_agent_ship
  - rks_agent_cycle_complete
  - rks_agent_dendron
phases:
  - name: discover
    agent: rks_agent_story
    description: >-
      Find stories in ready/planned status to ship, or validate provided
      storyIds
    gate: null
    required: true
  - name: refine
    agent: rks_refine
    description: >-
      Iterate each story to contract compliance: upgrade legacy targetFiles
      format, fix missing fields, decompose stories exceeding AC limit (max 4)
      into smaller stories via rks_story_create. Loop: refine → check →
      re-refine until ready or max 3 iterations.
    gate: null
    required: true
  - name: validate
    agent: rks_agent_validate_story
    description: >-
      Validate each story for shippability — acceptance criteria, target files,
      phase, SEARCH/REPLACE blocks, CREATE directives
    gate: approval
    required: true
  - name: plan
    agent: rks_agent_plan
    description: >-
      Generate implementation plan for each validated story. Reads story
      targetFiles, SEARCH/REPLACE blocks, and CREATE directives to produce
      concrete plan steps (create_file, edit_file, search_replace). Persists
      plan to .rks/runs/.
    gate: null
    required: true
  - name: implement
    agent: rks_agent_delivery
    description: >-
      Execute the plan: create feature branch, apply plan steps
      (fs.writeFileSync for each create_file/edit_file/search_replace step), run
      verification tests. Retry up to 3x on test failure with auto-generated fix
      plans.
    gate: null
    required: true
  - name: ship
    agent: rks_agent_ship
    description: 'Ship current changes: branch, commit, PR, merge, staging sync'
    gate: null
    required: true
  - name: complete
    agent: rks_agent_cycle_complete
    description: >-
      Run post-ship lifecycle per shipped story: mark implemented, governance,
      RAG embed
    gate: null
    required: true
audibles:
  - trigger: refine.format_failed
    action: 'rks_refine_apply failed to upgrade format. Log error, skip story.'
    maxRetries: 0
  - trigger: refine.decompose_failed
    action: >-
      Story exceeds AC limit but decomposition failed. Return needs_approval
      with the story and AC list for manual splitting.
    maxRetries: 0
  - trigger: validate.story_fails
    action: >-
      Skip failing story, continue with passing stories. Report skipped stories
      in summary.
    maxRetries: 0
  - trigger: ship.merge_conflict
    action: 'Call Git Agent to check state, attempt rebase, retry ship once'
    maxRetries: 1
  - trigger: ship.ci_pending
    action: 'Wait 30 seconds, re-check CI status, retry merge'
    maxRetries: 2
  - trigger: plan.no_steps
    action: >-
      Story passed validation but planner produced zero executable steps.
      Re-read story for SEARCH/REPLACE and CREATE directives, retry plan once.
    maxRetries: 1
  - trigger: implement.dirty_tree
    action: >-
      Working tree has uncommitted changes. Call Git Agent to stash or commit,
      then retry implement.
    maxRetries: 1
  - trigger: implement.test_failure
    action: >-
      Tests failed after apply. Auto-generate fix plan and retry (built into
      exec engine, up to 3 attempts).
    maxRetries: 0
  - trigger: implement.branch_exists
    action: >-
      Feature branch rks/{slug} already exists from a prior attempt. Call Git
      Agent to delete stale branch, retry implement.
    maxRetries: 1
  - trigger: complete.partial_failure
    action: >-
      Note failed step but continue with remaining cycle-complete steps
      (non-blocking)
    maxRetries: 0
---

# Delivery Playbook

Walk-away release automation for batching multiple stories through the ship pipeline. Migrated from the Delivery Agent composite orchestrator.

## Source

Migrated from the Delivery Agent (`rks_agent_delivery`).

## Phase Details

### 1. discover

**Agent**: Story Agent (`rks_agent_story`)
**Entry**: storyIds provided, or none (discover mode)
**Exit**: List of story IDs to ship
**On empty**: If no stories found in discover mode, return `complete` with empty summary

If `storyIds` are provided, verify each exists and is in a shippable state. If none provided, scan for stories in `ready` or `planned` phase with `not-implemented` status.

### 2. refine

**Tools**: `rks_refine`, `rks_refine_apply`, `rks_story_create`
**Entry**: Story list from discover phase
**Exit**: All stories pass format checks and have ≤4 acceptance criteria
**Loop**: Up to 3 iterations per story

For each story:

1. Call `rks_refine` with `{ projectId, problemId, trigger: "design" }` to analyze
2. If `isLegacyFormat` or suggestions exist → call `rks_refine_apply` with `{ projectId, problemId }` to auto-fix
3. If acceptance criteria count > 4 → **decompose**:
   - Read the story via Research Agent to understand the full AC list
   - Group related ACs into logical sub-stories (≤4 AC each)
   - For each group, call `rks_story_create` with appropriate name, title, and structured targetFiles
   - Each sub-story should have its own subset of target files and focused ACs
   - Mark the original story as decomposed (phase: "decomposed") or skip it
4. Re-run `rks_refine` to verify fixes. If still failing after 3 iterations, trigger `refine.format_failed` audible.

**Decomposition guidance**: Group ACs by feature area. A calculator might become:
- `backlog.feat.calculator-display` (display rendering, number formatting)
- `backlog.feat.calculator-operations` (arithmetic logic, operator handling)
- `backlog.feat.calculator-ui` (button grid, layout, click handlers)

### 3. validate

**Agent**: Product Owner (`rks_agent_validate_story`)
**Entry**: Story list from discover phase
**Exit**: All stories validated (or failing ones skipped)
**Gate**: `approval` — present the validation results and story list for user sign-off

Validate each story against its acceptance criteria. If a story fails validation, skip it and continue with passing stories. Include skipped stories and their failure reasons in the gate question.

If `dryRun` mode is active, stop after this phase and return the validation report.

### 4. ship

**Agent**: Ship Agent (`rks_agent_ship`)
**Entry**: Validated story list approved by user
**Exit**: PR merged, staging synced

Ship all changes as a single delivery. The Ship Agent handles branch creation, commit, PR, merge, and staging sync.

**Critical rule**: If ship fails, STOP immediately. Do not proceed to complete phase.

### 5. complete

**Agent**: Cycle Complete (`rks_agent_cycle_complete`)
**Entry**: PR merged successfully
**Exit**: All stories marked implemented, governance passed, RAG embedded

Run cycle-complete for each shipped story. Pass the PR number from the ship phase. If a cycle-complete step fails for a story, note it but continue with other stories (non-blocking).