---
id: bnggzwjesr51obzz9m7jvy6
title: What Is Rks
desc: >-
  Authoritative overview: what rks is, the problem it solves, and the
  Governor/story/pipeline model
updated: 1778123000959
created: 1777848000000
---

RouteKit Shell (rks) is an AI-native software development workflow system. It orchestrates Claude Code agents — called Governors — through a structured story-and-pipeline model to produce auditable, tested, and deliverable code changes. If you have used Claude Code and found yourself wondering "how do I turn AI-generated code into something I can actually ship confidently?" — rks is the answer.

## The Problem rks Solves

Unstructured AI coding sessions are powerful but brittle. An AI can produce working code in minutes, but the gap between "it runs locally" and "I can review and ship this" is wide:

- No story definition — it is unclear what exactly was changed and why
- No test gate — passing tests are a matter of luck, not enforcement
- No audit trail — the reasoning behind implementation decisions is lost
- No pipeline discipline — refine, review, and rollback steps are ad hoc

This is the **auditability gap**: AI-produced changes that lack the structure needed to review them confidently. rks closes this gap by adding governance around every code change — defined acceptance criteria, automated test validation, gated pipeline phases, and telemetry — without slowing down the AI's ability to write code quickly.

## The Core Model

rks organizes work into three concepts:

**Stories** are the unit of work. A story defines what needs to be built, why, acceptance criteria, target files, and test requirements. Stories live in the `notes/backlog.*` namespace as structured markdown notes (using the Dendron note format).

**Governors** are specialized Claude Code agents, each responsible for one pipeline phase. You do not write code directly — you instruct the Dispatcher (your Claude Code session) to launch a Governor for the current phase.

**The pipeline** is the sequence of phases a story moves through before it is shipped:

| Phase | Governor | What happens |
|---|---|---|
| `draft` | PO | Story is scoped and acceptance criteria defined |
| `ready` | QA | Test requirements added, story ready to build |
| `arch-approved` | ARCH | Architecture and scope reviewed before build |
| `building` | Build | Implementation, test execution, auto-ship to PR |
| `integrated` | — | PR merged to staging |
| `released` | — | Shipped in a version release |

**Guardrails** are Claude Code hooks that enforce the pipeline. They redirect raw tool calls (bash, edit, git) through Governors so that no code change happens outside the controlled workflow — unless you explicitly go off-rail for cases where the Governors themselves are being changed.

## Key Concepts

**Governor** — A Claude Code subagent with a specific role: PO (product owner), QA (test planning), ARCH (architectural review), Build (implementation + ship), or Ship (commit/PR/merge). Launched by the Dispatcher via a skill command (`/build`, `/qa`, etc.).

**Story** — A structured markdown note (Dendron format) in `notes/backlog.*` that defines a unit of work: problem, solution, acceptance criteria, target files, and test requirements. The Build Governor reads the story to know what to implement.

**Pipeline phase** — The lifecycle stage of a story: draft → ready → arch-approved → building → integrated → released. Each transition is gated by a Governor or merge event.

**Guardrails** — Claude Code hooks that enforce the pipeline workflow. When active, they redirect tool calls (bash, edit, git) to Governors so all work goes through the structured pipeline. Can be temporarily disabled for off-rail work via `rks_guardrails_off`.

**MCP tools** — The Model Context Protocol server tools (`rks_plan`, `rks_exec`, `rks_ship`, etc.) that Governors call to perform structured operations. Governors use MCP tools; you use skill commands to launch Governors.

**Dispatcher** — Your Claude Code session running with the rks CLAUDE.md loaded. The Dispatcher is the orchestration layer: it reads the user's intent, determines which skill to invoke, launches the appropriate Governor, and handles the return. You interact with rks through the Dispatcher.

## Next Steps

If you are ready to install rks and run your first build, see [[public.canon.getting-started]].
