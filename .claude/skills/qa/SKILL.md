---
name: skills-qa
description: |
  Use when a draft story needs test planning before it can be built. Accepts a storyId as
  $ARGUMENTS (e.g. backlog.agents.skills.my-story). Launches the QA Governor in
  story-review mode to add testRequirements and advance the story to phase ready.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# QA Governor Skill

This skill implements the **QA Governor** workflow for story review, test planning, and quality gate validation.

## Purpose

The QA Governor operates in story-review mode to:
- Validate story acceptance criteria and test requirements
- Ensure test coverage is adequate and measurable
- Add missing test scenarios
- Advance the story to phase `ready` for build

## Bootstrap Instructions

Launch the QA Governor:

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a QA Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-qa.md. Replace __PROJECT_ID__ with routekit-shell
    and __PROBLEM_ID__ with $ARGUMENTS. Then execute:

    # Task
    Review story $ARGUMENTS — add testRequirements and advance to ready

## On Return

QA Governor returns `review`: Story now has testRequirements and is at phase `ready`.
Proceed to /build for that story.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
