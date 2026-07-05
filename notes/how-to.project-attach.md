---
id: how-to.project-attach
title: Project Attach Workflow
desc: Onboard an existing repo as a full RKS runtime without destroying its files.
updated: '2025-12-02T00:00:00.000Z'
created: '2025-12-02T00:00:00.000Z'
tags:
  - how-to
  - project
  - attach
---

## When to attach instead of scaffolding

- Use `routekit project attach` when the workspace already contains source, CI/CD, or other valuable history and cannot be cleared for `project init`.
- Stick with `project init` only for brand-new greenfield projects that benefit from a stack skeleton being copied in.
- Attached projects can still register metadata, notes, KG/RAG assets, and CLI helpers without overwriting existing content.

## Attach requirements

1. **No empty-directory requirement** – attach works inside an existing repo by only emitting the minimal RKS support files.
2. **Minimal seeding**:
   - Create or update `routekit/project.json` with the provided `--id` and workspace path.
   - Add the project entry to `routekit/registry.json` if it does not already exist.
   - Generate or refresh a `routekit/kg.yaml` (or equivalent KG config) so KG-based commands run.
   - Ensure a `notes/` vault exists and contains `notes/<projectId>.welcome.md` that welcomes contributors and links to next steps.
   - Validate or create a `dendron.yml` (v5 schema) so notes tooling works.
3. **Non-destructive** – do not copy stack skeleton files, do not delete existing files, and only emit the “start here” note if it is missing.

## Post-attach lifecycle

- After attach, running `routekit plan <projectId> <noteId> --label <slug>` should work without requiring a prior analyze step.
- MCP tools should infer the project ID from the workspace so CLI commands like `npm run rks:plan` and `npm run rks:exec` function after adding them to `package.json`.
- RAG initialization (`routekit rag init`/`rag/init`) should run inside the repo using the seeded KG config.
- `routekit project info` and `routekit project list` must treat attached projects the same as scaffolded ones.

## CI/metadata helpers

- Document how attached projects can host their own `.env` with client-specific LLM providers/keys and still be part of the registry.
- Remind contributors that `routekit/project.json` and `routekit/registry.json` are the authoritative metadata files and must be kept in sync if the project ID or path changes.
