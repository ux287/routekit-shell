---
id: p10agktop2k0aofmc9y9s8z
title: Telemetry & Feedback Review
desc: How to capture and inspect learning-system signals inside RouteKit Shell
updated: '2025-11-20T00:00:00.000Z'
created: '2025-11-20T00:00:00.000Z'
tags:
  - telemetry
  - workflow
rag: true
---

# Overview

RouteKit Shell now records telemetry for every MCP `rks.exec` run. Each execution writes a JSON payload plus a CSV summary under `.rks/telemetry/`. The goal is to surface retrieval quality (RAG note hits, code hits, KG hits) and track how often plans modify files.

# Files Generated

- `.rks/telemetry/<timestamp>_<slug>.json` – detailed payload containing project, run, branch, and metric fields.
- `.rks/telemetry/summary.csv` – append-only log summarizing each run for quick analysis in spreadsheets or dashboards.

# Reviewing Telemetry

```bash
# List the most recent entries
ls -dt .rks/telemetry/* | head

# Inspect the latest JSON
latest=$(ls -t .rks/telemetry/*.json | head -n1)
cat "$latest"

# Open the summary log
column -s, -t .rks/telemetry/summary.csv | less

# Run guardrail report
node scripts/guardrails/telemetry-report.mjs
```

# Weekly Ritual

1. Open `.rks/telemetry/summary.csv` and review trends: spikes in ragNotes/ragKg, runs with zero applied files, etc.
2. If confidence drops (e.g., ragNotes consistently < 1), open the corresponding `.rks/runs/<id>/plan.json` and backlog items to diagnose.
3. Capture findings in `notes/blog.*` or new decision notes for visibility.

# Feedback Hooks

Telemetry currently captures structural metrics. When user-facing feedback is collected (e.g., thumbs up/down from agents or clients), append the signals to the JSON payloads and aggregate via the same summary file.

# Next Steps

- Automate dashboards (Data Studio, Observable) against `.rks/telemetry/summary.csv`.
- Add alerts that compare the latest N runs against a threshold (e.g., ragNotes average).
