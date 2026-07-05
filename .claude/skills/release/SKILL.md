---
name: skills-release
description: |
  Use when the user wants to release staging to main. Initializes an ops Governor,
  calls rks_release (which handles pre-flight checks, ff-merge, tagging, and push).
  $ARGUMENTS can be: patch (default), minor, or major.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# Release Skill

This skill releases staging to main via `rks_release` under an ops Governor session.

## Purpose

Provides a deterministic release flow:
1. Initialize ops Governor for token
2. Call `rks_release` (pre-flight checks + version bump + ff-merge to main + tag + push)
3. Report result

## Instructions

### Step 1: Parse arguments

Parse `$ARGUMENTS` for the version bump type:
- `patch` (default if no argument)
- `minor`
- `major`

If `$ARGUMENTS` is empty or not one of the above, default to `patch`.

### Step 2: Initialize Governor

Call:

```
mcp__rks__rks_governor_init({
  projectId: 'routekit-shell',
  flowType: 'ops'
})
```

Store the returned `token`.

### Step 3: Release

Call the MCP tool with the Governor token:

```
mcp__rks__rks_release({
  projectId: 'routekit-shell',
  version: '<parsed version bump>',
  changelog: '<optional — ask user or omit>',
  _governorToken: '<token from step 2>'
})
```

`rks_release` handles all pre-flight checks internally:
- Verifies clean working tree
- Verifies current branch is staging
- Verifies staging is in sync with origin
- Verifies CI is green on latest staging commit

If any check fails, it returns `{ ok: false, error: '...' }` — report the error.

### Step 4: Report result

On success, report:
- New version and tag (e.g., `v0.19.5`)
- Commit SHA
- Number of stories transitioned to `released`
- Remind user to sync `routekit-shell-release` with:
  ```
  cd ../routekit-shell-release && git fetch origin && git checkout v<new-version>
  ```
  Then restart the MCP server in any child project (snacks, concourse-prototype, etc.) to pick up the update.

On failure, report the error from `rks_release` and suggest diagnostics.

## Notes

- Uses ops flow Governor for token authorization
- `rks_release` handles: version bump commit on staging, ff-merge main, tag on main, push
- The tag is created on main after the ff-merge (not on staging)
- Works for any registered project — replace `routekit-shell` with the target projectId
