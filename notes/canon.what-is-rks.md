---
id: "canon.what-is-rks"
title: "What is RouteKit Shell (rks)?"
desc: "Overview of rks — what it is, the problem it solves, and how Governors, stories, and pipeline phases work together."
created: 1778427302054
updated: 1778427302054
---

RouteKit Shell (rks) is a structured software development workflow system that runs inside Claude Code. rks is designed to bring auditability, traceability, and repeatability to AI-assisted software development by tracking every piece of work through a defined lifecycle — from idea through implementation to release.

## The Problem rks Solves

AI coding tools are fast, but unstructured. A developer can ask an AI to "fix the bug" and get a change — but there is no record of why it was done, what was considered, what tests were required, or whether the change was reviewed. This is the auditability gap: the disconnect between what was built and why.

rks solves this by requiring all work to flow through named **stories**, reviewed by **Governors**, gated by **guardrails**, and committed with traceability. Every change has a paper trail. Every decision has a source.

## Core Concepts

**Governor** — An AI agent that manages one phase of the development lifecycle. Governors are specialized: the PO Governor scopes stories, the QA Governor adds test requirements, the ARCH Governor validates architecture, and the Build Governor implements. Governors communicate through structured return values and never overlap.

**Story** — A unit of tracked work in rks. Each **story** has an id, a target set of files, a problem statement, test requirements, and a current pipeline phase. Stories live as Dendron notes in `notes/backlog.*`.

**Pipeline phase** — The current lifecycle state of a story. Each **pipeline phase** represents a gate: a story must pass through `draft → ready → arch-approved → implementing → complete`. Governors advance stories through phases; no phase can be skipped.

**Guardrails** — Enforcement hooks that prevent out-of-scope edits during an active build session. **Guardrails** ensure the Build Governor only touches files listed in the story's `targetFiles`. Guardrails can be turned off for trusted off-rail work, but only with a valid Governor token and a story id.

**MCP tools** — The callable interface the Dispatcher and Governors use to interact with rks. **MCP tools** like `rks_governor_init`, `dendron_create_note`, and `rks_guardrails_off` are the primitives of the rks system. They are not called directly by users — they are called by Governors or the Dispatcher in response to skill invocations.

**Dispatcher** — The Claude Code session agent (the AI you interact with directly). The **Dispatcher** routes user requests to the appropriate skill, launches Governors, and enforces the Singleton Rule: no two Governors run in parallel.

## Pipeline Phase Reference

| Phase | Who Advances It | What Happens |
|-------|----------------|--------------|
| draft | PO Governor | Story is created and scoped |
| ready | QA Governor | Test requirements added |
| arch-approved | ARCH Governor | Architecture validated |
| implementing | Build Governor | Code is written and tested |
| complete | Build Governor | PR merged, story closed |

## See Also

For a step-by-step guide to running your first story, see canon.getting-started.