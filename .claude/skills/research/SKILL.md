---
name: skills-research
description: |
  Use when the user wants to design, research, or document something — OR asks a question
  about the codebase, backlog, or how anything in this project works. This is the ONLY way
  to answer questions about rks internals. Do NOT answer from memory or call MCP tools
  directly — always use this skill. Questions get a direct answer. Everything else produces
  a report in notes/.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Research Skill

This skill handles two modes based on `$ARGUMENTS`:

## Mode Detection

**Query mode** — `$ARGUMENTS` starts with `?` OR is phrased as a question (who/what/where/when/why/how/which/is/are/does/do/can):
- Init a Governor (`flowType: 'open'`)
- Call `rks_agent_research` with the question as the query
- Return the answer directly to the user — no note created

**Document mode** — everything else:
- Launch the Research Governor subagent
- Produces a research report in `notes/`
- Returns report location and key findings

## Query Mode Instructions

1. `rks_governor_init({ projectId: 'routekit-shell', flowType: 'open' })` → store TOKEN
2. `rks_agent_research({ projectId: 'routekit-shell', query: '$ARGUMENTS', _governorToken: TOKEN })`
3. Present the answer directly to the user.

## Document Mode Instructions

Launch the Research Governor:

  subagent_type: governor
  max_turns: 10
  prompt:
    You are a Research Governor for projectId routekit-shell. Read your prompt at
    .rks/prompts/governor-research.md. Replace __PROJECT_ID__ with routekit-shell.
    Then execute:

    # Task
    $ARGUMENTS

## On Return

- **Query mode**: Present the answer inline.
- **Document mode**: Research Governor returns `review` — present the report location and key findings to the user.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
