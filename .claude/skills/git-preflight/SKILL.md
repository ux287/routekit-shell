---
name: skills-git-preflight
description: >
  Use before build or ship operations to verify clean git state. Detects dirty
  working trees, orphaned worktrees, and branch mismatches. Can auto-stash or
  auto-clean worktrees. Other skills should invoke this as a precondition.
user-invocable: true
disable-model-invocation: false
---

# Git Preflight Skill

Runs git state checks before build/ship operations to prevent failures from dirty trees, orphaned worktrees, or wrong branches.

## When to Use

- Before `/skills-build` — ensure clean tree for exec
- Before `/skills-ship` — ensure committable state
- When a build or ship fails with dirty tree or branch errors
- When the user asks to check git state or clean up worktrees

## Instructions

Call the MCP tool directly:

  mcp__rks__rks_preflight({ projectId: 'routekit-shell' })

Optional parameters:
- `expectedBranch`: verify current branch matches (e.g. 'staging')
- `autoStash`: true to auto-stash dirty changes
- `cleanWorktrees`: true (default) to auto-remove orphaned worktrees

## Interpreting Results

The result contains three sections:

- `dirtyTree`: `{ dirty, files, suggestion }` — uncommitted changes
- `worktrees`: `{ orphaned, cleaned, errors }` — worktree state
- `branch`: `{ currentBranch, matches, tracking, ahead, behind }` — branch verification

`ok: true` means all checks passed. `ok: false` means at least one issue needs attention before proceeding.
