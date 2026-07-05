---
id: how-to.agent-operations.2-build
title: 3 Build
desc: >-
  How the Build Governor implements stories — refinement, planning, exec, unit
  tests
updated: 1772214672110
created: 1772212067387
---

## Purpose

Implement a backlog story. The Build Governor takes a `backlog.feat.*` or `backlog.fix.*` story through refinement, planning, execution, and unit testing. It produces **code on a feature branch** — it does NOT ship.

Build answers: **"Did I implement the spec?"**

## Governor Chain

```
0. rks_governor_init({ projectId, problemId: 'backlog.feat.<slug>' }) → TOKEN
1. rks_agent_research({ projectId, query, _governorToken: TOKEN })
2. rks_refine({ projectId, _governorToken: TOKEN })
   → Cycles until refinement passes review
3. rks_plan({ projectId, _governorToken: TOKEN })
4. rks_plan_review({ projectId, _governorToken: TOKEN })
   → If rejected, back to step 2
5. rks_exec({ projectId, _governorToken: TOKEN })
   → Applies code changes on feature branch (server-side)
   → Runs unit tests (baseline before, validation after)
6. Return { status: 'complete', branch, filesChanged }
```

## Refinement (Steps 2-4)

Refinement is the cycle where the Build Governor ensures the story is implementable:

- `rks_refine` analyzes the story against the codebase and suggests improvements
- `rks_refine_apply` applies refinement suggestions to the story
- `rks_plan` generates an implementation plan from the refined story
- `rks_plan_review` validates the plan (the .02-gate checks AC count ≤4)

If plan review rejects:
- The story has too many ACs or the plan doesn't match requirements
- The `.03-decompose` handler (when built) splits into child stories
- Each child story goes through its own Build cycle

Refinement cycles until the plan passes review or decomposition occurs.

## Exec (Step 5)

Exec is where code gets written. It is the only step that modifies source files.

### Scope Enforcement

Every exec operates within a **file scope** derived from the story's `targetFiles`. This is universal — it applies in both rks and child projects:

- `targetFiles` defines which files exec can modify
- Scope is tracked in `.rks/active-scope.json` with `allowedFiles` and `problemIds`
- `enforce-targetfile-scope` hook validates writes against the scope
- For fix stories in the QA cycle, scope is the union of the fix's targetFiles on the same branch

### Child Projects vs rks Self-Development

**In child projects**, targetFiles are always application code. Exec writes them server-side via MCP tools, which don't hit Claude Code hooks. Hooks stay on 100% of the time — they're pure rails. No hooks need to be disabled because there's no conflict between what exec needs to write and what hooks protect.

**In rks self-development**, targetFiles may include rks system files (hooks, MCP server code, governor prompts). This creates a self-referential conflict: the hooks that enforce workflow are themselves the files being modified. This is the only case where hooks need to be temporarily disabled.

### Guardrails State File (rks-internal only)

When rks is developing itself and exec needs to modify system files, a gitignored state file controls which hooks are disabled. **Hooks never move.**

```javascript
// Guard at top of every hook
const state = JSON.parse(fs.readFileSync('.rks/guardrails-state.json', 'utf8') || '{}');
if (state.disabled?.includes('this-hook-name.mjs')) process.exit(0);
```

The state file tracks two independent concerns:

**1. File scope (what can be changed)** — always enforced, in all projects
**2. Hook tier (which hook categories are disabled)** — rks-internal only, for self-referential conflicts

State file format:
```json
{
  "sessionId": "uuid",
  "disabled": ["redirect-edit-to-governor.mjs", "redirect-bash-to-governor.mjs"],
  "allowedFiles": ["src/agents/visual.mjs", "src/shared/kg-config.mjs"],
  "problemIds": ["backlog.feat.visual-qa"],
  "hookTier": "write",
  "startedAt": "2026-02-27T15:00:00Z",
  "reason": "exec: applying plan backlog-feat-visual-qa"
}
```

Lifecycle:
- **Guardrails off** → write `.rks/guardrails-state.json`
- **Guardrails on** → delete `.rks/guardrails-state.json`
- File is **gitignored** — zero git churn, no hook contamination in PRs
- Hooks always stay in `.routekit/hooks/` — git never sees deletions
- If a session is interrupted, recovery is: delete one file

> **MIGRATION**: This replaces the current `hooks/` ↔ `hooks.bak/` file-move mechanism. The file-move approach caused: (1) 38 file deletions in git status, (2) hook deletions leaking into feature branch PRs, (3) `hooks/hooks.bak` dual-state conflicts after `git checkout`, (4) permanent hook deletion via squash merge (PR #776), (5) manual restoration via `git checkout <sha> -- .routekit/hooks/` (PR #780). All of these go away with the state file approach.

### Unit Tests

Unit tests belong in Build because they answer "does the code I just wrote do what the plan says?"

- **Baseline check (before changes)**: `npm run test:unit` runs in the main working directory to confirm the codebase is healthy before exec starts
- **Validation check (after changes)**: Unit tests run again after code changes are applied to confirm the new code doesn't break anything

> **KNOWN GAP**: Currently exec only runs baseline tests (before changes). Post-exec validation tests are not implemented. If the newly written code breaks unit tests, that failure is not caught until QA.

### What Exec Does NOT Do

- Does NOT ship
- Does NOT create PRs
- Does NOT merge branches
- Does NOT run integration or E2E tests

Exec produces code on a feature branch. That's it.

## Allowed Namespaces

Build reads from `backlog.feat.*` and `backlog.fix.*` (the story it's implementing). Build does NOT write to any Dendron namespace — it writes source code, not notes.

Exception: if Build decomposes a story (via `.03-decompose`), it may create child stories in `backlog.feat.*`.

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| Build Governor | Yes | Its own `rks_agent_research` call in step 1 populates session state |
| Dispatcher | Yes (indirect) | Session state persists after Build returns |
| QA Governor | **Separate session** | QA starts fresh with its own `rks_governor_init`. It knows the branch from Build's return value. |

Build does NOT inherit provenance from PO. It runs its own research to ground itself in the codebase.

## Decomposition

When `rks_plan_review` rejects a story (e.g., >4 ACs), the Build Governor should decompose:

1. `.03-decompose` splits the story into child stories (≤4 ACs each)
2. Build Governor returns `{ status: 'review', children: [{ storyId, notePath }] }`
3. Dispatcher evaluates:
   - **No orphaned tests** (mechanical split, scope unchanged): Auto-proceed, launch Build for each child
   - **Has orphaned tests** (scope change): Stop for user review

> **KNOWN GAP**: `.03-decompose` has not been built yet.

## Fix Stories (from QA)

When Build receives a `backlog.fix.*` story from QA:
- The fix story has a `relatedFeat` field linking to the original `backlog.feat.*` story
- Build targets the **same branch** that the original Build created — it's a continuation, not a new feature
- Refinement and exec proceed normally, but scoped to the fix's targetFiles
- The scope's `problemIds` array includes both the feat and fix story IDs
- After exec, control returns to QA for re-validation

## Governor Token and State Machine

- Build operates in **story flow** (problemId provided to governor_init)
- State progression: `init → refining → planning → planned → executing → executed`
- Allowed tools (STORY_FLOW_TOOLS): `rks_refine`, `rks_refine_apply`, `rks_agent_research`, `rks_agent_external_research`, `rks_agent_git`, `rks_plan`, `rks_plan_review`, `rks_plan_ready`, `rks_exec`, `rks_exec_abort`, `dendron_create_note`, `dendron_edit_note`, `dendron_read_note`, `dendron_update_field`, `rks_preflight`, `rks_analyze`
- Explicitly forbidden: `rks_ship` (that's the Ship Governor's job)

## Bootstrapping

Same as all Governors: Task subagent runs in Claude Code (hooked), but the Governor's chain is entirely MCP tools (server-side, unhooked). The Governor prompt says "Never use Claude Code tools."

## Dispatcher Integration

Per CLAUDE.md, the Dispatcher:
1. Tells the Governor to read its own prompt at `.rks/prompts/governor-build.md`
2. Replaces `__PROJECT_ID__` and `__PROBLEM_ID__` with the project and story IDs
3. Launches via `Task(subagent_type: "general-purpose", max_turns: 100)`

On return:
- `status: 'complete'` → report branch and files changed, hand off to QA
- `status: 'review'` (decomposed) → evaluate child stories per decomposition rules
- `status: 'failed'` → report error, suggest telemetry diagnostics

## Current State Requirements Divergence

### FIXED: `autoShip` removed from Build Governor

`autoShip` parameter has been removed from `rks_exec`. The Build Governor now calls `rks_exec` (step 6) followed by `rks_story_ship` (step 7) as separate steps. This enables future QA insertion between Build and Ship.

### BUG: No post-exec unit test validation

**Severity: Medium — broken code can pass Build**

Exec runs `npm run test:unit` as a baseline check before applying changes, but does not run tests after changes are applied. If the new code breaks unit tests, the failure is not caught until QA (or not at all if QA doesn't run unit tests).

**Fix**: Add a post-exec unit test step. If tests fail, exec should report failure and not mark the build as complete.

### BUG: `rks_ship` accessible from Build/QA state machines

**Severity: Medium — Build or QA could call Ship, bypassing the pipeline sequence**

`rks_ship` is currently in the `COMMON_TOOLS` set, meaning it's allowed in any Governor state regardless of flow type. A Build or QA Governor could call `rks_ship` directly, bypassing the intended Build → QA → Ship sequence.

However, removing `rks_ship` from `COMMON_TOOLS` entirely is too broad — the Dispatcher needs ad-hoc Ship access for shipping uncommitted changes outside the pipeline (e.g., user says "ship what I have").

**Fix**: Remove `rks_ship` from `COMMON_TOOLS`. Restrict it from the Build and QA Governor state machines (i.e., not in `STORY_FLOW_TOOLS`). The Dispatcher retains full ability to launch a Ship Governor at any time — Ship access is controlled at the Governor launch level (who can start a Ship Governor), not the tool level (who can call `rks_ship` within an active session). This preserves two entry paths:

1. **Pipeline path**: Build → QA → Ship (Dispatcher launches Ship Governor after QA passes)
2. **Ad-hoc path**: User asks Dispatcher to ship uncommitted work (Dispatcher launches Ship Governor directly)

### BUG: Hooks use file-move mechanism (hooks/ ↔ hooks.bak/)

**Severity: High — causes git contamination, PR pollution, hook loss**

The current guardrails off/on mechanism physically moves hook files between `.routekit/hooks/` and `.routekit/hooks.bak/`. This is rks-internal only but causes severe problems during rks self-development.

**Fix**: Replace with the guardrails state file mechanism. Hooks never move — a gitignored `.rks/guardrails-state.json` controls which are active. Delete the file to restore all hooks.

### BUG: Flaky baseline tests block exec with no recovery

**Severity: High — blocks every build attempt, wastes significant time diagnosing false negatives**

Baseline test failures block exec with no retry and no way to distinguish flaky tests from real failures. When a test flakes, the entire build cycle fails — the Governor reports failure, the Dispatcher surfaces the error, and time is spent investigating a test that would pass on a second run. This has repeatedly blocked story builds and consumed full debug cycles on non-issues.

Current workaround: `skipTests: true` in exec call, which bypasses the safety net entirely.

**Fix**: Add retry logic for baseline tests (run twice on failure before rejecting). Additionally, fix the specific flaky tests — the root causes are known (hardcoded hook paths that break when guardrails state changes, test assertions that don't match current implementation). Eliminating flaky tests is better than tolerating them with retries.

### DESIGN: Fix stories need `relatedFeat` relationship

**Severity: Medium — fix stories need to know which branch to target**

When QA writes a `backlog.fix.*` story, it needs a relationship to the original `backlog.feat.*` story. This tells Build: "fix this code on the same branch." The `relatedFeat` field needs to be part of the story frontmatter schema.