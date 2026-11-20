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
2. Write the release notes from the released stories
3. Call `rks_release` (pre-flight checks + version bump + ff-merge to main + tag + push)
4. End the Governor session
5. Report result

## Instructions

### Step 1: Parse arguments

Parse `$ARGUMENTS` for the version bump type:
- `patch` (default if no argument) — **fixing broken behavior** (a bug fix)
- `minor` — **new or changed intended behavior** (a feature or a deliberate behavior change)
- `major` — reserved for `1.0` / breaking changes

If `$ARGUMENTS` is empty or not one of the above, default to `patch`.

Which to pick (the versioning policy — see the "Versioning" section in `README.md`): the intent axis decides, not the surface size. Sharpening test — **changing or adding intended behavior is a minor; fixing broken behavior is a patch.** `rks_release` bumps the root + `packages/mcp-rks` + `packages/cli` `package.json` versions in lockstep, so they never drift.

### Step 2: Initialize Governor

Call:

```
mcp__rks__rks_governor_init({
  projectId: 'routekit-shell',
  flowType: 'ops'
})
```

Store the returned `token`.

### Step 2b: Write the release notes

Release notes are required, and they must account for every story the release transitions.
Start with a dry run, which changes nothing:

```
mcp__rks__rks_release({
  projectId: 'routekit-shell',
  version: '<parsed version bump>',
  dryRun: true,
  _governorToken: '<token from step 2>'
})
```

1. Take `notesBrief` from the dry-run result. It is the exact list to write from: the stories this
   release transitions, grouped `Added`, `Changed`, `Fixed`, `Internal` in that order and sorted
   within each group. Each item carries its `storyId` (for coverage only, never for the text), its
   `title` and `desc`, and `leaks`: every story id and denylisted term in that title or desc.
2. Hand `notesBrief`, unchanged, to a writing agent with this instruction: "Write one user-facing
   bullet per item, under its group's `### <Group>` heading, in the given order, written
   from the released stories, never from commit subjects. Rephrase every `leaks` entry so no story id or
   denylisted term survives. Return `changelog`, `notesCoverage` (each storyId mapped to the exact
   phrase of the bullet that covers it) and `notesExclusions` (a story with no user-facing change,
   with a reason)." `notesDraft` and `coverageDraft` are a mechanical starting point the agent may
   keep or improve.
3. Call `rks_release` again with `dryRun: true`, `changelog`, `notesCoverage` and
   `notesExclusions`. Proceed only when every `coverage` list is empty: `unknownStories`,
   `unaccountedStories`, `phrasesNotFound`, `storyIdLeaks` and `deniedTerms`. Otherwise send the
   findings back to the writing agent and dry-run again.
4. Show the lines, the mapping and the exclusions to the user before the real call.
5. Pass the text as `changelog`, and the mapping and exclusions as `notesCoverage` and
   `notesExclusions`, in Step 3. `rks_release` writes the text verbatim (trimmed) to
   `CHANGELOG.md` and to both GitHub Release bodies; the mapping and exclusions are not published.

The denylist is configured, never written in code: `releaseNotes.denylist` in the project's
`.rks/project.json`, or the machine-local `RKS_RELEASE_NOTES_DENYLIST` (comma-separated, in the
environment or the project's gitignored `.env`) for a term that must never be committed.

A fresh release refuses before anything is changed when a story is neither covered nor excluded,
or a mapped phrase does not occur in `changelog` (`reason: 'release_notes_incomplete'`, with
`unaccountedStories` and `phrasesNotFound`); when `notesCoverage` is malformed, names a story the
release does not transition, or names a story also excluded (`reason: 'notes_coverage_invalid'`);
or when `notesExclusions` is malformed or names a story the release does not transition
(`reason: 'notes_exclusions_invalid'`). It also refuses published text (the `changelog`, or an
applied `notesOverride` reason) that contains a story id (`reason: 'release_notes_story_id'`) or a
denylisted term in any letter case (`reason: 'release_notes_denied_term'`, identified by source,
entry and line, never by the term), and a denylist it cannot read or parse
(`reason: 'release_notes_denylist_invalid'`).

`rks_release` has no git-log fallback. A fresh release with no usable `changelog` (absent,
empty or whitespace-only) is refused with `reason: 'release_notes_missing'` before anything is
changed. The only way to release without notes is `notesOverride: { enabled: true, reason: '...' }`,
and it requires the user's explicit direction and a reason: never pass it on your own judgement.
An applied override writes `Release notes waived: <reason>` and is recorded in the
`release.complete` telemetry. An invalid override is refused with `reason: 'notes_override_invalid'`.

A resumed release (staging HEAD is already the `chore(release): <version>` bump commit) uses the
`CHANGELOG.md` entry committed in that bump commit and ignores `changelog`, with a warning. If that
entry is missing it is refused with `reason: 'release_notes_resume_entry_missing'`.

Report every refusal reason verbatim.

### Step 3: Release

Call the MCP tool with the Governor token:

```
mcp__rks__rks_release({
  projectId: 'routekit-shell',
  version: '<parsed version bump>',
  changelog: '<the release notes written in Step 2b>',
  notesCoverage: { '<storyId>': '<phrase copied from the notes>' },
  notesExclusions: [],
  _governorToken: '<token from step 2>'
})
```

If the projectId above is still an unsubstituted template token, resolve it from the projectId declared at the top of `CLAUDE.md`.

`rks_release` handles all pre-flight checks internally:
- Verifies clean working tree
- Verifies current branch is staging
- Verifies staging is in sync with origin
- Verifies CI is green **for the commit being released** — and FAILS CLOSED if it cannot get a verdict.

  This gate previously passed whenever it could not reach an answer. On 2026-08-17 a local
  `gh` returning HTTP 404 caused it to be skipped entirely, and v0.39.0 was cut onto `main`
  while staging CI was red. It now blocks on an unreachable `gh`, a timeout, unreadable
  output, or no run at all — every one of those is a missing verdict, not a pass.

  When the newest run's `headSha` is not the commit being released, the gate passes only if
  BOTH: (a) that run is `completed` with conclusion `success`, AND (b) the diff
  `<run headSha>..<integration HEAD>` touches only paths `.github/workflows/ci.yml`
  `paths-ignore`s. That is what makes an ordinary release work — staging HEAD is routinely a
  notes-only commit which produces no CI run of its own, and that is normal, not a fault.
  The range is anchored at the verified run's sha, never at `origin/<production>` or a
  release tag; both of those span real code on every release and would block everything,
  including the resume path whose HEAD is the `[skip ci]` bump commit.

### Overriding a blocking CI verdict

If CI genuinely cannot be reached — GitHub down, `gh` unauthenticated — the gate blocks and
that is correct. To release anyway, pass an override **with a reason**:

```js
mcp__rks__rks_release({
  projectId: '<projectId>',
  version: '<patch|minor|major>',
  changelog: '<the release notes written in the write-the-release-notes step>',
  notesCoverage: { '<storyId>': '<phrase copied from the notes>' },
  enforcementOverride: { enabled: true, reason: 'why you are releasing without a CI verdict' },
  _governorToken: '<token>',
})
```

`enabled` must be literally `true` (it cannot default on) and `reason` must be non-empty —
an override with a missing or blank reason is REJECTED, not quietly accepted. An applied
override is recorded in the `release.complete` telemetry as `ciGateOverridden` plus the
reason, because an override that leaves no trace is indistinguishable from the fail-open
this gate exists to prevent. Supplying an override when the gate is *not* blocking does
nothing and is not recorded.

`enforcementOverride` waives only the CI gate. It does not waive release notes: a CI-overridden
release still needs `changelog`, or a separate `notesOverride` on the user's explicit direction.

If any check fails, it returns `{ ok: false, error: '...' }` — report the error.

### Step 3b: End the session

After `rks_release` returns — on success AND on failure — end the ops session with the Step 2
token. It is the last MCP call of this flow (backlog.feat.governor-session-end):

```
mcp__rks__rks_governor_end({
  projectId: 'routekit-shell',
  _governorToken: '<token from step 2>'
})
```

`ended: false` with `reason: 'session_not_live'` is not an error. `end_blocked` is reported with
its `blockedBy` and is not retried.

### Step 4: Report result

On success, report:
- New version and tag (e.g., `v0.19.5`)
- Commit SHA
- Number of stories transitioned to `released`
- Remind the user to roll the release out to child projects — **two steps**:
  1. Update the release mirror to the new tag (it's a checkout-only mirror, so `-f` safely discards local lockfile noise):
     ```
     cd ../routekit-shell-release && git fetch origin --tags && git checkout -f v<new-version>
     ```
  2. Upgrade **all** registered children **from the release** in one command (run from anywhere):
     ```
     routekit project upgrade --all --from-release ../routekit-shell-release
     ```
     `--from-release` sources the release's hooks/skills/prompts/version while still resolving children from your normal registry; it repins each child's `.mcp.json` and stamps its `rksVersion`. (For a single child: `routekit project upgrade --id <child> --from-release ../routekit-shell-release`.)
  Then restart the MCP server in each child (snacks, concourse-prototype, etc.) to pick up the update.

On failure, report the error from `rks_release` and suggest diagnostics.

## Notes

- Uses ops flow Governor for token authorization
- `rks_release` handles: version bump commit on staging, ff-merge main, tag on main, push
- The tag is created on main after the ff-merge (not on staging)
- Works for any registered project — replace the projectId above with the target projectId
