---
id: 6eq5yxlxk12nt2pkvdqsm0j
title: Guardrail Policies & Decision Trees
desc: How to define and enforce MCP guardrails inside RouteKit Shell
updated: '2025-11-20T00:00:00.000Z'
created: '2025-11-20T00:00:00.000Z'
tags:
  - guardrails
  - workflow
rag: true
---

# Overview

Guardrail policies ensure every MCP APE run follows predefined decision trees. Policies live at `guardrails/policy.json` in each project and are loaded automatically by `rks.plan`, `rks.exec`, and `rks.ape`.

# Policy Structure

```json
{
  "default": {
    "id": "default",
    "allowedTools": ["rks.analyze", "rks.plan", "rks.exec", "rks.ape"],
    "requiresReview": false
  },
  "scenarios": [
    {
      "id": "blog-content",
      "match": { "labels": ["blog", "changelog"] },
      "allowedTools": ["rks.plan", "rks.exec"],
      "requiresReview": false
    }
  ]
}
```

- `match.labels` compares against the plan label/slug.
- `allowedTools` enumerates which MCP tools can run for that scenario.
- `requiresReview` blocks `rks.exec` until a human review step is completed (handled outside MCP).

# Workflow

1. Update `guardrails/policy.json` when introducing new plan labels or workflows.
2. Run `rks.plan --label <slug>`; if the label violates a guardrail, MCP returns a descriptive error.
3. Guardrail status is recorded in `.rks/telemetry/*.json` and `summary.csv` for weekly review.

# Policy Change Review

- Before merging any change to `guardrails/policy.json`, run `npm run guardrails:verify -- origin/dev`.
- The script fails if no guardrail-focused decision note (for example `notes/decisions.*guardrail*.md`) was updated in the same diff.
- Document approvals inside decision notes and reference them from backlog entries.

# Simulation

- CLI: `node scripts/guardrails/simulate.mjs <label>` prints the matched scenario. Omit the label to list the entire policy.
- MCP: call `rks.guardrails_simulate { "projectId": "routekit-shell", "label": "<slug>" }` to retrieve structured JSON from chat.
- Telemetry: `node scripts/guardrails/telemetry-report.mjs` summarizes scenario counts/violations from `.rks/telemetry/summary.csv`.

# Best Practices

- Keep scenarios simple and additive. More specific matches should precede general ones in the JSON array.
- Document rationale for each scenario inside the policy file or associated notes.
- When a guardrail needs temporary bypass, edit the policy in a dedicated branch and capture the decision in `notes/decisions.*`.

# References

- `notes/backlog.guardrails.agent-decision-tree-enforcement.md`
- UX287 blog posts on agent decision trees and contextual intelligence.
