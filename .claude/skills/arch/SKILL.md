---
name: skills-arch
description: |
  Run the ARCH architectural gate review on one or more stories at phase ready.
  Invoked by the Dispatcher after all QAs in a batch complete — before Build.
  Accepts one or more storyIds as $ARGUMENTS (space- or comma-separated).
  Returns approved (proceed to Build) or needs-revision (surface findings, hold Build).
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# ARCH Governor Skill

This skill implements the **ARCH Governor** workflow — the mandatory architectural gate between QA and Build.

## Purpose

ARCH reviews one or more stories holistically before any Build is launched. It reads each story note and its target files, applies an 8-item mechanical checklist, and returns a binary verdict. ARCH runs for every story — no skip conditions.

## Bootstrap Instructions

Launch the ARCH Governor:

  subagent_type: governor
  max_turns: 15
  prompt:
    You are an ARCH Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-arch.md. Replace __PROJECT_ID__ with routekit-shell
    and __STORY_IDS__ with $ARGUMENTS. Then execute the ARCH review.

## On Return

- **`approved`**: All stories cleared. Dispatcher proceeds to `/build` for each story in dependency order. Minor findings (informational only) may be noted.
- **`needs-revision`**: One or more stories have implementation issues. Dispatcher surfaces all findings to the user with specific file/line details and waits for user direction before proceeding to Build. Do NOT launch Build until ARCH clears.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
