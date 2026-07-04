---
id: how-to.llm-planning
title: LLM-Assisted Planning Workflow
desc: 'How to run rks.plan with LLM, validation, and replay'
updated: '2025-11-28T00:00:00.000Z'
created: '2025-11-28T00:00:00.000Z'
tags:
  - how-to
  - llm
  - planner
---

## Inputs
- Requirements note (problemId/task)
- RAG/KG/codemap context
- Candidate targets (parser/tests/docs) with excerpts
- Guardrails: allowed actions/paths, no TODOs/placeholders
- Credentials in `.env` (provider/model/api key)

## Outputs
- Actions using anchored patches or full files for small targets
- Non-empty content; invalid items downgraded to notes
- Caching: LLM I/O stored in run folder; replay supported

## Validation
- Path allowlist and existence checks
- Non-empty content for file actions
- Downgrade unsafe/invalid to notes

## Replay
- Use stored `llm-output.json` to avoid re-calling LLM

## Project Metadata Schema
- `id`: Stable identifier used by the catalog to reference a project; required when linking notes or rerunning workflows.
- `title`: Human-friendly name that shows up in listings, reports, and anchors the schema narrative.
- `desc`: Short description capturing the project's focus; keeps context visible in metadata views.
- `created`: Epoch milliseconds timestamp recorded when the metadata record is first materialized.
- `updated`: Epoch milliseconds timestamp that should be refreshed on every meaningful edit.
- `tags`: Optional array of strings for grouping or filtering by domain, capability, or status.

### Example
```yaml
id: c9hb8qdy7g20kge33x2fx7x
title: Project Metadata Schema
desc: ''
created: 1764737966414
updated: 1764737966414
tags:
  - planning
  - schema
```
