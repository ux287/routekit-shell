---
name: skills-product-owner
description: |
  Use when the user wants to create a new backlog story or define requirements for a feature
  that does not yet have an existing story. Accepts a natural-language task description as
  $ARGUMENTS. Launches the PO Governor via Task subagent.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---


# PO Governor Skill

This skill implements the **PO Governor** workflow for creating stories from task descriptions and managing story lifecycle entry gates.

## Purpose

The PO Governor accepts a task description and bootstraps the story creation process, including:
- Breaking down complex requirements into acceptance criteria
- Generating test requirements
- Setting up the initial story phase and lifecycle state

## Bootstrap Instructions

Launch the PO Governor:

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a PO Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-po.md. Replace __PROJECT_ID__ with routekit-shell.
    Then execute:

    # Task
    $ARGUMENTS

In the Task section, describe WHAT to build — features, requirements, expected behavior.
Do NOT include workflow instructions (plan, exec, ship) — the Governor prompt handles workflow.

## Workflow

The PO Governor follows this sequence:

1. **Parse** the incoming task description
2. **Analyze** requirements and break into acceptance criteria
3. **Generate** initial test requirements
4. **Create** story metadata with proper frontmatter
5. **Initialize** story lifecycle state
6. **Hand off** to QA Governor for review

## Integration Points

- **Input**: Task description (from user, parent story, or backlog)
- **Output**: Story with frontmatter, acceptance criteria, test requirements
- **Next Governor**: QA Governor (for story-review mode)
- **Lifecycle Gate**: Validates that story phase can transition to `ready`
