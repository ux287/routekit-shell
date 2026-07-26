---
name: skills-telemetry-export
description: |
  Use when the user wants to EXPORT/SHARE a project's telemetry — e.g. for a UAT report or
  to attach to a GitHub issue. Produces a redacted .json + .md bundle via an MCP tool; no
  Task subagent or Governor is launched. $ARGUMENTS may be a storyId to scope the export.
user-invocable: true
disable-model-invocation: false
verbosity: silent
---

# Telemetry Export Skill

Exports rks telemetry to a **shareable, redacted** bundle (`.rks/exports/telemetry-<timestamp>.{json,md}`)
suitable for UAT reports or attaching to a GitHub issue. Calls one MCP tool directly — no
Governor, no Task subagent.

## What it does

`rks_telemetry_export` reads the project's `.rks/telemetry`, reuses the cost report + query
readers to summarize event counts, token cost, and a recent timeline, then **scrubs secrets**
(API keys `sk-ant-…`/`ghp_…`, `Bearer` tokens, session/governor UUIDs, and absolute
filesystem paths) before writing. Output is **local files only** — nothing is uploaded.

## Instructions

Parse `$ARGUMENTS`:

- **No arguments** — export the whole project:
  `mcp__rks__rks_telemetry_export({ projectId: 'routekit-shell' })`

- **A storyId** (e.g. `backlog.feat.foo`) — scope the export to that story:
  `mcp__rks__rks_telemetry_export({ projectId: 'routekit-shell', storyId: '$ARGUMENTS' })`

Works for any registered project — replace `routekit-shell` with the target projectId if the
user names a different project.

## On return

Report the two written paths (`jsonPath`, `mdPath`) and note:
- the bundle is **redacted** and safe to attach to a GitHub issue / share for UAT;
- if `degraded: true`, cost data was unavailable for the scope (no token events) — the rest
  of the export is still valid.

Do NOT paste the raw file contents into chat unless asked; point the user at the files.

## Not in scope

This skill only writes a local file. It does **not** upload or "phone home". A future opt-in
"share anonymous usage data with the developer" feature (see
`notes/ideas.2026.07.05.telemetry-anon-share-mothership.md`) will reuse this same redaction
core + bundle format as its payload.
