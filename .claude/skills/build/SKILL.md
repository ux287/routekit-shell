---
name: skills-build
description: |
  Use when the user wants to implement an existing backlog story. Accepts a storyId as
  $ARGUMENTS (e.g. backlog.agents.skills.my-story). If the story is at phase draft, runs
  QA Governor first then builds. If at phase ready, builds immediately.
  For building from a task description with no existing story, use /po instead.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Build Governor Skill

This skill implements the **Build Governor** workflow for story implementation, test execution, and quality validation.

## Purpose

The Build Governor manages the implementation phase by:
- Executing the story's test requirements
- Implementing changes to satisfy acceptance criteria
- Running tests and validating results
- Shipping via PR on success

## Bootstrap Instructions

1. Check the story phase from $ARGUMENTS (the storyId).
   - If phase is `draft`: run /qa $ARGUMENTS first, then proceed to build.
   - If phase is `ready`: go straight to build.

2. QA Governor (only if draft) — launch and wait for completion:

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a QA Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-qa.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with $ARGUMENTS. Then execute:

    # Task
    Review story $ARGUMENTS — add testRequirements and advance to ready

3. Build Governor:

  subagent_type: governor
  max_turns: 100
  prompt:
    You are a Build Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-build.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with $ARGUMENTS. Then execute:

    # Task
    Build story $ARGUMENTS

## On Return

- `complete`: Report artifacts (branch, PR, files changed).
- `review` (decomposed, no orphanedTests): Auto-proceed. Launch /qa then /build for each
  child story in dependency order. No user review needed.
- `review` (decomposed, has orphanedTests): Stop. Present orphaned requirements and child
  summaries. Wait for user direction.
- `failed` with testsFailed true: Report diagnostics — show partialDiffPath,
  refinementSuggestions, attempts. Wait for user direction. Do NOT auto-retry.
- `failed`: Report error. Suggest /telemetry for diagnostics. Wait for user direction.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
