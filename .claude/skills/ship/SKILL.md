---
name: skills-ship
description: |
  Use when the user wants to commit and ship uncommitted changes. Accepts an optional
  commit message as $ARGUMENTS. Launches the Ship Governor via Task subagent.
  Handles both 2-branch (push → PR → merge) and 3-branch (local merge, no PR) workflows
  automatically based on project config.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Ship Governor Skill

This skill implements the **Ship Governor** workflow for committing and shipping changes.

## Purpose

The Ship Governor manages the final delivery stage. It auto-detects the project's branch workflow:
- **2-branch** (working = integration): commit → push → PR → merge
- **3-branch** (working ≠ integration): commit → local merge into working branch → cleanup (no push, no PR)

## Bootstrap Instructions

Launch the Ship Governor:

  subagent_type: governor
  max_turns: 5
  prompt:
    You are a Ship Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-ship.md. Replace __PROJECT_ID__ with routekit-shell
    and __COMMIT_MESSAGE__ with: $ARGUMENTS

## On Return

Ship Governor returns `complete`: Report the branch name and PR URL.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
