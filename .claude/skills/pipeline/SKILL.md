---
name: skills-pipeline
description: |
  Use when the user describes work to build but no backlog story exists yet. Accepts a
  natural-language task description as $ARGUMENTS and runs the full PO → QA → ARCH → Build flow.
  Creates the story, reviews it, passes the ARCH gate, then builds it — all in sequence.
  Use /po instead if you only want story creation without building.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Pipeline Skill

Runs the full PO → QA → ARCH → Build sequence from a task description. All four Governors run
sequentially — never in parallel.

## Purpose

Orchestrates the complete story lifecycle:
- PO Governor creates and scopes the story
- QA Governor adds test requirements and advances to ready
- ARCH Governor reviews the batch and gates Build (approved → arch-approved)
- Build Governor implements and ships

## Instructions

**Step 1 — PO Governor:**

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a PO Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-po.md. Replace __PROJECT_ID__ with routekit-shell.
    Then execute:

    # Task
    $ARGUMENTS

On return: present story summaries to the user. Wait for confirmation before proceeding.

**Step 2 — QA Governor** (for each storyId returned, sequentially):

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a QA Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-qa.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with <storyId>. Then execute:

    # Task
    Review story <storyId> — add testRequirements and advance to ready

**Step 3 — ARCH Governor** (ONCE, after every QA above has returned `ready`, with the full storyId list):

  subagent_type: governor
  max_turns: 15
  prompt:
    You are an ARCH Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-arch.md. Replace __PROJECT_ID__ with routekit-shell
    and __STORY_IDS__ with <all storyIds, space-separated>. Then execute the ARCH review.

Do not launch Step 4 until ARCH returns `approved` (see On Return).

**Step 4 — Build Governor** (for each storyId, in dependency order, sequentially):

  subagent_type: governor
  max_turns: 100
  prompt:
    You are a Build Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-build.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with <storyId>. Then execute:

    # Task
    Build story <storyId>

If the projectId above is still an unsubstituted template token, resolve it from the projectId declared at the top of `CLAUDE.md`.

Report progress between builds.

## On Return

- ARCH (Step 3) returns `approved`: proceed to Step 4 (Build) for each storyId in dependency order.
- ARCH returns `needs-revision`: STOP. Surface every finding to the user with its file/line detail and wait for user direction. Build is never launched before ARCH returns `approved`.
- Build (Step 4): follow the same Build Governor return handling as /build for each story.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
