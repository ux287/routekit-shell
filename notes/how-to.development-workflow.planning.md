---
id: v66kjp4b8lrahytdj2tg8fq
title: Runtime Expectations for Client Projects
desc: >-
  Clarify how the shared RouteKit engine and per-project runtimes relate, along
  with required project-local assets and configuration.
updated: 1769295583178
created: 1769295583178
tags:
  - planning
  - runtime
  - docs
---

## Problem
The traditional mindset treats `routekit-shell` as the only real runtime and pushes client projects into a passive target role. That breaks down when client teams need to operate inside their own repos, use different LLM providers, and manage their own notes, RAG indexes, and scripts. Without a documented runtime story it is hard for clients to understand what belongs in the shared engine vs their local repo, which makes adoption and customization difficult.

## Goals
1. Establish that the **RouteKit core engine** is developed and distributed from `routekit-shell` (or a shared tooling repo) and can be versioned independently.
2. Clarify that each client repo hosts a full **RouteKit project runtime** including local notes, RAG configuration, CLI/MCP entrypoints, and scripts wired to the shared engine.
3. Make it obvious that every project can configure its own `.env`, LLM provider/API keys, and runtime artifacts so that the engine respects the project context when running commands.

## Runtime Expectations
- The RouteKit core engine provides the binaries, MCP entrypoints, and tooling sources shipped from `routekit-shell`.
- Each client repo has a `routekit/` (or `.rks/`) directory with project metadata (ID, stack, root path), KG/RAG configuration, and later analysis artifacts produced by the runtime.
- Notes and knowledge live inside the client repo (for example a `notes/` vault with a valid `dendron.yml`) and are consumed by local workflows and RAG indices.
- Client scripts (e.g., `rks:plan`, `rks:exec`) invoke the shared engine but resolve against the project root so that the runtime behaves identically to other CLI commands executed locally.
- `.env` files inside the client repo declare `ROUTEKIT_LLM_PROVIDER`, API keys, and credentials so each repo can use its preferred LLM stack (Claude, Gemini, OpenAI, etc.) without colliding with other projects.

## Acceptance Criteria
1. Documentation clearly distinguishes the **RouteKit core engine** (implemented in `routekit-shell`) from the **per-project runtime** hosted inside client repos like `snacks-design`.
2. For an attached/initialized project:
   - `routekit/` or `.rks/` exists with metadata and KG/RAG configuration.
   - A local notes vault (e.g., `notes/`) and `dendron.yml` are present and used for planning work.
   - Project-local scripts and MCP entrypoints call the shared engine but act as first-class runtime commands.
3. LLM configuration is project-specific via `.env`, and the engine respects those values when running MCP/CLI commands inside the repo.
4. The high-level narrative is stable: the shared engine lives in `routekit-shell`, and every client repo hosts its own runtime with local notes, RAG, config, and LLM provider.

## Next Steps
Use this note as the definitive reference for runtime documentation, and keep it in sync with future changes to `project init`/`project attach` workflows and runtime wiring.