---
id: 4qebnhwrigj9j363uispj5z
title: rks.exec run_command planning
desc: >-
  Decisions made while designing the exec run_command workflow so future
  reviewers can trace the intent.
updated: '2026-01-05T00:00:00.000Z'
created: '2026-01-05T00:00:00.000Z'
tags:
  - planning
  - exec
  - decision
---

## Context
- We are extending `rks.exec` to trust only documented run_command targets that have been whitelisted/logged/tested.
- The planner code needs to drive parser expectations, tests, and docs from requirements that mention exec-run_command flows.
- During review the branch contents must align with the files declared in our plan summary and steps.

## Decision
- We will document this workflow so that every future review can verify that server, tests, and docs are coordinated with the exec run_command updates.
- The note states that parser changes will align with the forced target comments in `packages/mcp-rks/src/server.mjs` and that the tests will validate deterministic planning, including whitelisting safeguards.

## Next Steps
1. Update `packages/mcp-rks/src/server.mjs` to enumerate the new expectations for run_command usage, especially around whitelists/logging/timeouts.
2. Expand `packages/mcp-rks/__tests__/planner.spec.mjs` so it asserts the new planner behavior and ensures note-driven steps produce action entries with filled content when run_command is part of the plan.
3. Make sure the documentation in `packages/cli/bin/routekit.js` clearly comments on run_command limits and the expectation of `notes/how-to.development-workflow.decisions.md` existing alongside executable edits.
4. During review, confirm the branch touches only the files listed above plus the ones modified during implementation.
