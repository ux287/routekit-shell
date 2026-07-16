---
id: 0f56lkhwrqpx61iqolxifc7
title: 5 Ship
desc: 'How the Ship Governor delivers validated code — commit, push, PR, merge'
updated: 1772215630153
created: 1772212169970
---

## Purpose

Deliver work to the permanent record. The Ship Governor moves validated artifacts — code, notes, config — through the git delivery pipeline: commit, push, PR, merge.

Ship answers: **"Is this delivered?"**

## Entry Paths

Ship has three entry paths. Each is a different chain, but Ship's job is the same: get it into git.

### 1. Pipeline Path (Build → QA → Ship)

The standard code delivery flow. Each Governor chains to the next:

1. Build returns `{ status: 'complete', branch, filesChanged }`
2. Dispatcher auto-launches QA for the branch
3. QA returns `{ status: 'passed', branch, testResults }`
4. Dispatcher auto-launches Ship with the branch, story ID, and commit message

Ship trusts QA's pass — it does not re-validate code.

### 2. Research Path (Research → Ship)

Research creates notes (`design.*`, `research.*`, `notes.*`) as local files. If those notes should become part of the permanent record (committed to git, visible in PRs, searchable by future sessions), the Dispatcher chains Research → Ship.

Notes don't need QA — there's no code to test. The flow is shorter:

1. Research returns `{ status: 'review', noteId, notePath }`
2. User confirms the note is worth shipping (or Dispatcher auto-ships if configured)
3. Dispatcher launches Ship with the note files and a commit message

### 3. Ad-hoc Path (User → Ship)

The user asks the Dispatcher to ship uncommitted work directly. Examples:
- "Ship what I have"
- "Commit and push my changes"
- "Ship these docs"

The Dispatcher launches Ship without a preceding Governor chain. This is used for:
- Manual fixes the user made themselves
- Config updates
- Any work where the user is the quality gate

### Access Control Principle

No Governor calls `rks_ship` directly within its own session. Governors finish their work and return to the Dispatcher. The Dispatcher chains to the next step — including Ship. This means:
- Build cannot ship (it returns to Dispatcher, which launches QA)
- QA cannot ship (it returns to Dispatcher, which launches Ship)
- Research cannot ship (it returns to Dispatcher, which launches Ship)
- PO cannot ship (it returns to Dispatcher, which launches Build)

`rks_ship` stays out of `COMMON_TOOLS` and `STORY_FLOW_TOOLS`. Ship tools are only available within a Ship Governor session.

## Governor Chain

```
0. rks_governor_init({ projectId, problemId: 'backlog.feat.<slug>' }) → TOKEN
1. rks_git_commit({ projectId, message, files, _governorToken: TOKEN })
2. Push branch to remote
3. Create PR (feature branch → staging)
4. Merge PR
5. rks_cycle_complete({ projectId, _governorToken: TOKEN })
   → Updates story phase, cleans up branch, returns to staging
6. Return { status: 'shipped', prUrl, commitId }
```

For ad-hoc or research shipping (no story), the chain is simpler — no `problemId` in governor_init, no `rks_cycle_complete`.

## What Ship Does

### Commit (Step 1)
- Stage and commit all changes on the feature branch
- Conventional commit format: `feat(<scope>): <message>` or `fix(<scope>): <message>`
- For notes: `docs(<scope>): <message>`
- `Co-Authored-By` trailer appended automatically
- Commit message references the story ID (if pipeline path)

### Push (Step 2)
- Push the feature branch to the remote (`git push -u origin <branch>`)
- Branch naming follows convention: `rks/backlog-feat-<slug>` or `rks/backlog-fix-<slug>`
- For notes/ad-hoc: may commit directly to staging (no feature branch needed)

### PR Creation (Step 3)
- Create a pull request: feature branch → staging (integration branch)
- PR title from story title
- PR body includes: summary, files changed, test results reference, story link
- PR must pass CI checks (GitHub Actions: lint, build, "Verify guardrails hooks exist")

### Merge (Step 4)
- Squash merge to staging
- PR must have passing CI before merge
- If CI fails, Ship reports the failure — does NOT force merge

### Cycle Complete (Step 5)
- `rks_cycle_complete` handles post-merge cleanup:
  - Updates story phase to `shipped` (or `implemented`)
  - Deletes the feature branch (local and remote)
  - Switches back to staging
  - Pulls latest staging

## What Ship Does NOT Do

- Does NOT run tests (that's QA's job)
- Does NOT modify source code (that's Build's job)
- Does NOT create stories (that's PO's job)
- Does NOT merge staging → main (that's a release, separate from Ship)

## The staging → main Promotion

Ship merges feature branches into staging. Promoting staging to main (production release) is a separate operation — not part of the Ship Governor's chain. Release promotion may involve:
- Aggregating multiple shipped features
- Running a final QA pass against staging
- Creating a release tag
- Merging staging → main

This is likely a future `Release Governor` concern.

## Allowed Namespaces

Ship does not write to any Dendron namespace. It updates story frontmatter fields (via `dendron_update_field`) to mark phase transitions:
- `phase: 'shipped'` after successful delivery

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| Ship Governor | Minimal | Ship doesn't need deep codebase research — it's doing git operations |
| Dispatcher | Yes (indirect) | Session state persists after Ship returns |

Ship is the lightest Governor in terms of provenance needs. It operates on the branch that Build created and QA validated — it doesn't need to understand the code.

## Governor Token and State Machine

- **Pipeline path**: Ship operates in **story flow** (problemId = the story being shipped)
- **Research/ad-hoc path**: Ship operates in **open flow** (no problemId)
- Needs access to: `rks_git_commit`, `rks_staging_pr`, `rks_git_merge`, `rks_cycle_complete`, `rks_agent_git`
- Does NOT need: `rks_refine`, `rks_plan`, `rks_exec`, `rks_agent_research`

**Access control**: `rks_ship` must NOT be in `COMMON_TOOLS`. No Governor can call Ship tools within its own session. The Dispatcher is the only entity that launches Ship Governors — this is the chaining enforcement point. Within a Ship Governor session, ship tools are available via a `SHIP_FLOW_TOOLS` set or ship-specific state machine states.

## Error Handling

### CI Failure
If the PR fails CI checks:
- Ship reports the CI failure details to the Dispatcher
- Ship does NOT force merge or skip CI
- The Dispatcher may need to send the branch back to Build for fixes

### Merge Conflict
If the PR has merge conflicts with staging:
- Ship reports the conflict
- The Dispatcher may need to update the branch (rebase/merge staging into feature branch) via Build

### Push Failure
If the push fails (permissions, network):
- Ship reports the error and stops
- Retryable by the Dispatcher

## Bootstrapping

Same as all Governors: Task subagent runs in Claude Code (hooked), but the Governor's chain is entirely MCP tools (server-side, unhooked).

## Dispatcher Integration

The Dispatcher chains to Ship from three paths:

**Pipeline (after QA)**:
1. QA returns `{ status: 'passed', branch, testResults }`
2. Dispatcher reads `.rks/prompts/governor-ship.md`
3. Replaces `__PROJECT_ID__` and `__PROBLEM_ID__` with the project and story IDs
4. Launches via `Task(subagent_type: "general-purpose", max_turns: 5)`

**Research (after note creation)**:
1. Research returns `{ status: 'review', noteId, notePath }`
2. Dispatcher presents note to user. On confirmation:
3. Dispatcher reads `.rks/prompts/governor-ship.md`
4. Replaces `__PROJECT_ID__` and `__COMMIT_MESSAGE__` with the project and message
5. Launches via `Task(subagent_type: "general-purpose", max_turns: 5)`

**Ad-hoc (user request)**:
1. User says "ship what I have" or "commit and push"
2. Dispatcher reads `.rks/prompts/governor-ship.md`
3. Replaces `__PROJECT_ID__` and `__COMMIT_MESSAGE__` with the project and message
4. Launches via `Task(subagent_type: "general-purpose", max_turns: 5)`

On return:
- `status: 'shipped'` → report PR URL and commit ID to user. Done.
- `status: 'failed'` → report error. Depending on failure type:
  - CI failure → may need Build to fix
  - Merge conflict → may need Build to rebase
  - Transient error → Dispatcher can retry

## The Complete Pipeline

```
User describes work
  ↓
Research (optional) → research.* note → Ship (if permanent record needed)
  ↓
PO → backlog.feat.* story
  ↓
Build → refinement → plan → exec → unit tests → code on branch
  ↓
QA → unit tests → integration tests → visual tests
  ↓ fail → backlog.fix.* → Build → QA (loop)
  ↓ pass
Ship → commit → push → PR → merge → cycle complete
  ↓
Done. Story phase = shipped.
```

## Current State Requirements Divergence

### PARTIAL: Ship Governor partially exists but is bundled into Build

**Severity: High — Ship is not a standalone Governor**

The current `governor-ship.md` prompt exists and handles "uncommitted changes" shipping. But it's designed for ad-hoc off-rail work, not as the final step in the Build → QA → Ship pipeline. The existing Ship flow doesn't:
- Receive a branch from QA
- Know about the feat/fix story relationship
- Run `rks_cycle_complete` to clean up properly
- Handle the Research → Ship path for notes delivery

The Ship Governor needs to be extended to serve all three entry paths: pipeline (code), research (notes), and ad-hoc.

### BUG: `rks_ship` in COMMON_TOOLS allows premature shipping

**Severity: Medium — any Governor can ship at any time**

`rks_ship` is in `COMMON_TOOLS`, meaning Build, QA, or Research could call it directly within their session, bypassing the Dispatcher's chaining logic. Ship tools should only be available within a Ship Governor session.

**Fix**: Remove `rks_ship` from `COMMON_TOOLS`. Create a `SHIP_FLOW_TOOLS` set or add ship tools only to ship-specific state machine states. The Dispatcher's ability to chain to Ship Governors is unaffected — access is controlled at the Governor launch level, not the tool level.

### NOT BUILT: CI check enforcement before merge

**Severity: Medium — PRs can be merged with failing CI**

The current merge logic does not gate on CI check status. PRs have been merged with failing "Verify guardrails hooks exist" CI checks (observed in PRs #774, #776-#779 this session).

**Fix**: Ship Governor should poll PR check status before merging. If CI fails, report failure instead of merging.

### DESIGN: Release promotion (staging → main) is undefined

**Severity: Low — not blocking current workflow but needed for production releases**

Ship merges to staging. There's no defined process for promoting staging to main. This may be a manual user decision or a future Release Governor.

### DESIGN: Ship needs test results in PR body

**Severity: Low — improves traceability**

QA produces test results. Ship should include those results (or a summary) in the PR body so reviewers can see what was validated. This requires passing test results from QA → Dispatcher → Ship.