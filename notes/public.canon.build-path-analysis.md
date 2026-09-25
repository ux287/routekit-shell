---
id: v7gddzcej5hfgh649lhuk8d
title: Build Path Analysis
desc: >-
  Reference: when to use the Build Governor (on-rail) vs guardrails-off
  (off-rail), the MCP dogfood zone, the guardrails system, and the offRail
  config
updated: 1778181631110
created: 1777848002000
---

Every story has two possible build paths: **on-rail** (the Build Governor via `/build`) and **off-rail** (direct implementation via `rks_guardrails_off`). Choosing the wrong path wastes a build cycle. This note explains how to choose correctly in under two minutes.

See [[public.canon.getting-started]] for the overall pipeline and [[public.canon.what-is-rks]] for conceptual background.

## The Two Build Paths

**On-rail** uses the Build Governor. You run `/build <storyId>` and the Dispatcher launches a Governor that calls `rks_plan`, `rks_exec`, and `rks_ship` in sequence. The Governor reads your story note, generates a plan, executes the changes, runs tests, and opens a PR — all without you writing a line of code.

**Off-rail** uses `rks_guardrails_off` to temporarily disable hook enforcement, then you implement changes directly (read files, edit files, run tests), and `rks_guardrails_on` auto-ships when done. This is the correct path when the story modifies the system that the Build Governor depends on.

## On-Rail Sequence

When using the Build Governor, the full on-rail sequence is:

1. **`/po`** — PO Governor creates a story note with scoped acceptance criteria and `targetFiles`
2. **`/qa`** — QA Governor adds `testRequirements` and advances the story to `phase: ready`
3. **`/arch`** — ARCH Governor runs an 8-item mechanical checklist and returns `approved` or `needs-revision`. **This gate is mandatory** — Build Governor will not accept a story below `arch-approved` phase.
4. **`/build`** — Build Governor implements changes, runs tests, and opens a PR

Do not call `/build` until `/arch` returns `approved`. The Build Governor reads `phase` from the story frontmatter and returns `plan_worker_phase_mismatch` if the story has not been cleared by ARCH.

## Decision Table

| targetFile path starts with    | Recommended path | Reason                             |
| ------------------------------ | ---------------- | ---------------------------------- |
| `packages/mcp-rks/src/`        | Off-rail         | MCP dogfood zone                   |
| `.rks/prompts/`                | Off-rail         | Governor prompts                   |
| `.routekit/hooks/`             | Off-rail         | Hook enforcement                   |
| `.claude/`                     | Off-rail         | Dispatcher config                  |
| `notes/`, `tests/`, `scripts/` | On-rail          | Application layer                  |
| `src/`, `components/`, `lib/`  | On-rail          | Application layer                  |
| `templates/`                   | On-rail          | Non-circular                       |
| Mix of dogfood + application   | Off-rail         | Any dogfood file triggers off-rail |

When in doubt: if the story touches any file that the Build Governor reads or executes to do its work, use off-rail.

## The MCP Dogfood Zone

Four path patterns require off-rail because the Build Governor depends on them at runtime:

**`packages/mcp-rks/src/`** — The MCP server itself. The Build Governor calls `rks_plan`, `rks_exec`, `rks_ship` and other MCP tools during every build. If you edit the server code while the Governor is running, the Governor could call a broken version of itself mid-build. Circular.

**`.rks/prompts/`** — The governor prompt files. The Build Governor reads `governor-build.md` (and other prompts) to know its own instructions. Editing the prompt the Governor is executing while it runs creates undefined behavior.

**`.routekit/hooks/`** — The hook enforcement scripts. Hooks enforce the pipeline by intercepting tool calls. If the Build Governor modifies the hooks that govern its own execution, enforcement becomes unpredictable.

**`.claude/`** — The Dispatcher configuration (CLAUDE.md, settings, skills). The Dispatcher is what orchestrates the Governor. Editing the Dispatcher config while the Dispatcher is running risks self-referential changes.

## The Guardrails System

Guardrails are Claude Code hooks that enforce the pipeline workflow when active. There are two tiers:

**Write hooks** intercept Edit, Write, Bash, and git operations and redirect them through Governors. This ensures every code change goes through the structured pipeline (plan → exec → ship) rather than being applied ad hoc.

**Read hooks** provide research guidance — they redirect raw file reads through the Research Agent so context is built correctly.

**Toggling guardrails** works in three steps:
1. `rks_governor_init({ projectId, problemId })` — creates a session token scoped to the story
2. `rks_guardrails_off({ projectId, problemId, reason, _governorToken })` — disables hooks; writes are scoped to the story's `targetFiles`
3. `rks_guardrails_on({ projectId })` — restores hooks and auto-ships via PR

While guardrails are off, write scope is enforced by `active-scope.json` — you can only edit files listed in the story's `targetFiles`. System hooks (the ones enforcing write scope itself) remain active even during off-rail work.

## The `offRail` Config

Child projects that use rks but have a different directory layout configure off-rail scope in `.rks/project.json`:

```json
{
  "offRail": {
    "enabled": true,
    "roots": ["components/*", "services/*", "lib/*", "src/*"]
  }
}
```

**`enabled`** — Set to `false` to hard-block off-rail for this project. `rks_guardrails_off` returns `reason: off_rail_disabled` without executing. Use this for projects where off-rail should never happen (e.g., production-only repos).

**`roots`** — An array of trailing-wildcard prefix patterns. Story `targetFiles` must all match at least one root. Files outside all roots return `reason: non_core_work` to prevent scope creep.

When the `offRail` field is absent, the system falls back to the hardcoded routekit-shell core-path check (the four patterns listed above). Child projects with non-standard layouts declare their own roots.

## Ship Path: 2-Branch vs 3-Branch

rks supports two ship topologies, detected automatically from `.rks/project.json`:

**3-branch (push → PR → merge):** `branches.working ≠ branches.integration`

The story ships on a feature branch (e.g. `off-rail/<sessionId>`), which is pushed to origin, a PR is opened against the integration branch (`staging`), and merge happens automatically or after CI passes. This is the standard topology for teams that want a PR audit trail.

**2-branch (local merge, no PR):** `branches.working === branches.integration`

The story is committed directly on the integration branch, merged locally, the feature branch is deleted, and `staging` is pushed. No PR is created. This is the routekit-shell-core default — because stories in this repo are already reviewed at the ARCH gate, the PR step adds overhead without adding safety. The `autoShipped: true` flag in the `rks_guardrails_on` response confirms a 2-branch auto-ship occurred.

To switch topologies, update `branches.working` in `.rks/project.json`. Child projects shipping to a team review process should use 3-branch.
