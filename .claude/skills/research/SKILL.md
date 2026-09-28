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
- **Classify the subject first — INTERNAL or EXTERNAL.** This decides the tool, and getting it
  wrong produces an ungrounded answer wearing the authority of a governed one, which is worse
  than an obviously-unsourced one.
  - **INTERNAL** — this codebase, its backlog, its config, its history. Call `rks_agent_research`,
    which retrieves over THIS project's corpus.
  - **EXTERNAL** — anything the corpus cannot contain: third-party pricing, another vendor's API,
    library behaviour, statutes, standards, current events. Call `rks_agent_external_research`.
    `rks_agent_research` cannot answer these — the index holds only this project, so it can only
    return a confident non-answer.
  - **MIXED** — call both, and say which claim came from which.
- Return the answer directly to the user — no note created

**Document mode** — everything else:
- Launch the Research Governor subagent
- Produces a research report in `notes/`
- Returns report location and key findings
- **A paper whose subject is EXTERNAL to this project does not belong in this project's
  backlog namespace.** File it under `research.external.*` so it is distinguishable from
  research about this codebase. If the subject belongs to a *different* project, say so and
  offer to hand it off rather than filing it here — a paper about another domain sitting in
  this backlog is misfiled, not merely untidy.

## Query Mode Instructions

1. `rks_governor_init({ projectId: 'routekit-shell', flowType: 'open' })` → store TOKEN
2. Classify the subject per Mode Detection above, then call the matching tool:
   - INTERNAL → `rks_agent_research({ projectId: 'routekit-shell', query: '$ARGUMENTS', _governorToken: TOKEN })`
   - EXTERNAL → `rks_agent_external_research({ projectId: 'routekit-shell', query: '$ARGUMENTS', _governorToken: TOKEN })`
   - MIXED → call both, and attribute each claim to the tool that produced it.
3. Present the answer directly to the user, naming which tool answered. If an EXTERNAL question
   was answered by `rks_agent_research`, that answer is not grounded — say so rather than
   presenting it.

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

If the projectId above is still an unsubstituted template token, resolve it from the projectId declared at the top of `CLAUDE.md`.

## On Return

- **Query mode**: Present the answer inline.
- **Document mode**: Research Governor returns `review` — present the report location and key findings to the user.

## Singleton Rule

Never run two Governors in parallel. Always wait for each to complete before launching the next.
