---
name: skills-pipeline
description: |
  Use when the user describes work to build but no backlog story exists yet. Accepts a
  natural-language task description as $ARGUMENTS and runs the full PO → QA → Build flow.
  Creates the story, reviews it, then builds it — all in sequence.
  Use /po instead if you only want story creation without building.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Pipeline Skill

Runs the full PO → QA → Build sequence from a task description. All three Governors run
sequentially — never in parallel.

## Purpose

Orchestrates the complete story lifecycle:
- PO Governor creates and scopes the story
- QA Governor adds test requirements and advances to ready
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

**Step 3 — Build Governor** (for each storyId, in dependency order, sequentially):

  subagent_type: governor
  max_turns: 100
  prompt:
    You are a Build Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-build.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with <storyId>. Then execute:

    # Task
    Build story <storyId>

Report progress between builds.

## On Return

Follow the same Build Governor return handling as /build for each story.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
