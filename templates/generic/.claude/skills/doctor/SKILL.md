---
name: doctor
description: |
  Run `routekit doctor` against the invoking shell's child-project ecosystem and
  surface per-child outcomes. Default mode is detect + auto-fix across all
  registered children. Pass `--dry-run` to inspect the fix plan without
  mutating anything. Non-recoverable findings (pinned-but-drifted children)
  are reported but not repaired.
user-invocable: true
disable-model-invocation: false
verbosity: silent
---

# /doctor — diagnose + auto-fix the child-project ecosystem

This skill wraps `routekit doctor` — a single CLI verb that diagnoses every
registered child project across five drift conditions and applies the matching
fixers by default.

## When this skill runs

The user invokes `/doctor` (with optional `--dry-run`) to verify the ecosystem
is healthy after a shell upgrade or to repair drift before launching feature
work in child projects. The skill is a thin wrapper — every detection and
repair lives in `routekit doctor` itself.

## What it checks

1. **Shell template drift** — `packages/hooks/` vs `templates/generic/.routekit/hooks/`.
2. **Per-child hooks drift** — child's `.routekit/hooks/` vs the shell's template.
3. **Per-child `.mcp.json` pointer** — `mcpServers.rks.args[0]` must point under
   the invoking shell. A child can opt out of auto-repair by setting
   `pinned: true` in `.rks/project.json`; such drift is reported as
   non-recoverable.
4. **Per-child registry presence** — child registered in the invoking shell's
   `projects/index.jsonl`.
5. **Per-child schema version** — `routekit/project.json` schemaVersion vs the
   latest known migration.

## What it does NOT touch: the shell itself

`routekit doctor` walks the shell's registry, and **the shell registers itself in
that registry** (`npm run setup` does this so `rag init` can find it). Doctor
therefore skips its own record explicitly — a shell is not one of its own
children.

This is load-bearing, not tidiness. Every fixer above takes `projectRoot`, and
handing the shell's own root to `syncProject` syncs a directory *from itself*:
each skill is deleted to make room for the copy, the copy then finds nothing to
copy, and the whole thing exits 0. A clean-machine UAT lost all 17 distributable
skills exactly this way — and preflight reported healthy the entire time, because
until now nothing checked that the skills were still there.

If you need to update the shell, use git. `routekit project sync` / `upgrade` /
`doctor` are for child projects, and they now refuse a self-targeted run outright
rather than silently eating it.

## Arguments

Parse `$ARGUMENTS` for an optional `--dry-run` flag.

## Instructions

### Step 1: Invoke `routekit doctor` via Bash

Run the CLI verb exactly once per skill invocation — no loops, no retries:

```
routekit doctor [--dry-run]
```

If the user passed `--dry-run` in `$ARGUMENTS`, forward it. Otherwise invoke
the default (auto-fix) mode.

### Step 2: Report outcomes

Surface the per-child outcomes from the CLI's stdout to the user, with
particular emphasis on:

- The total `fixers applied` count and the `succeeded` / `failed` breakdown.
- Each `NON-RECOVERABLE` line — these are findings the doctor refused to
  repair (most commonly `pinned: true` children with stale `.mcp.json`
  pointers). The user must decide whether to clear the pin and re-run, or
  leave the child intentionally pinned to a different shell.
- The exit code. A non-zero exit means at least one fixer failed or at least
  one non-recoverable finding remains.

### Step 3: Honor the verbosity contract

This skill defaults to `silent` verbosity. Do not narrate steps or restate
what the CLI already printed. If the exit code is 0 and no non-recoverable
findings exist, a one-line confirmation is enough.

## What this skill does NOT do

- It does not invoke any internal helper directly. `routekit doctor` already
  composes the underlying fixers internally; the skill never bypasses the CLI
  to call them.
- It does not launch a Governor. The skill is a thin Dispatcher-side wrapper
  over a single CLI invocation — no orchestration is required.
- It does not iterate per-child in the skill body. The CLI handles the batch;
  the skill just runs the CLI once and reads the result.
