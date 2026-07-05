---
name: skills-telemetry
description: |
  Use when the user asks about recent activity, failures, build history, or wants to query
  telemetry events. Calls MCP telemetry tools directly — no Task subagent needed.
  $ARGUMENTS can be: summary, failures, or an event type filter string.
user-invocable: true
disable-model-invocation: false
verbosity: silent
---

# Telemetry Skill

This skill queries rks telemetry directly via MCP tools. No Governor or Task subagent is launched.

## Purpose

Provides fast access to:
- Recent build and ship activity across projects
- Failure diagnostics and error summaries
- Filtered event queries by type

## Instructions

Call MCP tools directly based on $ARGUMENTS:

- No arguments or "summary":
  mcp__rks__rks_telemetry_report({ projectId: 'routekit-shell', reportType: 'summary' })

- "failures":
  mcp__rks__rks_telemetry_report({ projectId: 'routekit-shell', reportType: 'failures' })

- Any other string (treated as event type filter):
  mcp__rks__rks_telemetry_query({ projectId: 'routekit-shell', type: '$ARGUMENTS' })

Works for any registered project — replace 'routekit-shell' with the target projectId if
the user specifies a different project (e.g. uat-agents-1).

## Cost Summary

After running the main telemetry query, call `rks_token_cost_report` and append a Cost Summary section:

```js
mcp__rks__rks_token_cost_report({ projectId: '<projectId>', scope: 'story', format: 'json' })
```

Format the result as:

### Token Cost & Efficiency

- Total tokens: `rawCost` (formatted with toLocaleString)
- Waste ratio: `wasteRatio` as percentage, with health band (🟢 green / 🟡 yellow / 🔴 red)
- Cache ratio: `cacheRatio` as percentage
- Phase summary: `phaseSummary` (e.g. "plan x2 ok | exec x3 (1 failed)")

If `noData: true`, show: "No token data available for this scope."
