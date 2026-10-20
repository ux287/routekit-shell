---
name: skills-ci
description: |
  Use when the user asks about CI status, recent CI failures, or you need to autonomously
  check whether a just-pushed commit landed green. Wraps the GitHub Actions CLI (`gh run
  list` / `gh run view` / `gh run download`) plus the project's `scripts/analyze-vitest-report.mjs`
  parser so a single invocation returns a structured status header, per-shard summary,
  failure list, and diagnosis hint. Read-only — never mutates CI state.
user-invocable: true
disable-model-invocation: false
verbosity: heartbeat
---

# CI Skill

Read-only CI inspection for autonomous diagnosis. Wraps the GitHub Actions CLI + the
project's existing vitest-report analyzer so Claude can check CI status without the user
manually pasting GHA Step Summary text.

This skill is a Tier 1 quick-win from the
[telemetry + CI observability paper](../../../notes/research.2026.06.15.telemetry-and-ci-observability-audit.md)
and complements the [test-suite audit paper](../../../notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md) Tier 1 work.

## Argument Modes

Parse `$ARGUMENTS` to determine intent:

| Mode | Trigger | Behavior |
|---|---|---|
| latest | empty `$ARGUMENTS` OR `latest` | Status of the most recent CI run on the `staging` branch |
| runId | `$ARGUMENTS` matches `^\d+$` | Status of that specific run |
| green | `$ARGUMENTS` includes `green` | Returns the latest run ONLY if conclusion is success — else "no recent green" |
| red | `$ARGUMENTS` includes `red` | Returns the latest run ONLY if conclusion is failure — else "no recent red" |
| failures | `$ARGUMENTS` includes `failures` | Returns the latest failure with parsed failure list, skips green-run details |

## Instructions

### Step 1: List recent runs

Run via Bash:

```
gh run list --branch staging --limit 5 --json databaseId,displayTitle,conclusion,workflowName,createdAt,headSha
```

Parse the JSON. Filter to `workflowName == "CI"` to avoid release-smoke / check-hooks-drift noise. Identify the target run per the argument mode.

If `gh` is not installed or not authenticated, return:

```
⚠️ Unable to query CI: `gh` CLI is not authenticated. Run `gh auth login` first, then retry `/ci`.
```

If there are no recent runs on the branch, return:

```
ℹ️ No recent CI runs found on the staging branch.
```

### Step 2: Get status metadata

Run via Bash:

```
gh run view <runId> --json conclusion,jobs,workflowName,startedAt,updatedAt
```

Use this to render the **status header** (one line):

- ✅ Green: `✅ CI #<displayNumber> green · <duration> · <commit short SHA>`
- ❌ Red: `❌ CI #<displayNumber> red · <duration> · <commit short SHA>`
- 🟡 Running: `🟡 CI #<displayNumber> running · started <relative time> ago`
- ⚠️ Runner died: `⚠️ CI #<displayNumber> abandoned · runner lost communication or SIGTERM · <duration>`

(The runner-died case is detected when `conclusion` is null but `updatedAt` is older than ~30 min — the GitHub Actions infrastructure killed the runner before it could report.)

For green-only or red-only modes: if the mode doesn't match, return the appropriate "no matching" message and STOP.

### Step 3: For failed/running runs, get the failure log

Only for `red` or `failures` modes (or `latest` on a red run). Run via Bash:

```
gh run view <runId> --log-failed
```

Read the returned log output directly — it is captured in the tool result. Do
NOT redirect to a file (`>`) or pipe through `grep`/`head`: the guardrails-on
read-only allowlist permits the bare `gh run view` command, but rejects shell
redirection and pipelines (a `>`/`|`/`&&`/`;` causes the command to redirect to
the Governor instead of running). Scan the captured output for failure markers:
`FAIL `, `×`, `AssertionError`, `Error: Test`, `timed out`, `Process completed with exit`.

Parse each failing line into `{ file, suite, test, errorFirstLine }` records. Limit to 10
distinct failures in output (cite "+N more" if more exist).

### Step 4: Download per-shard vitest JSON and analyze

For CI runs that completed (green or red), the analyze step produces per-shard JSON artifacts.

Run via Bash:

```
gh run download <runId> --pattern "vitest-unit-*" --dir /tmp/ci-<runId>-artifacts
```

For each shard's JSON file:

```
node scripts/analyze-vitest-report.mjs /tmp/ci-<runId>-artifacts/<shard-file>.json
```

The analyzer emits a markdown summary (already used by the GHA Step Summary). Strip the markdown
formatting and extract:

- File count, test count, pass count, fail count, wall-clock duration
- Top 5 slowest files (file, duration_ms, tests_run)

### Step 5: Format output

Assemble a single response in this order:

1. **Status header** (Step 2)
2. **Per-shard summary** (Step 4): one bulleted line per shard with counts + wall-clock + top-5
3. **Failure list** (Step 3): file → suite → test → first-line error, one per line, max 10
4. **Diagnosis hint** (heuristic):
   - If failures contain "Test timed out in 5000ms" → suggest checking Tier 1 testTimeout pattern; cite `notes/research.2026.06.15.test-suite-bloat-audit-and-tier-redesign.md`
   - If failures contain "Hook timed out in 10000ms" → suggest checking fixture beforeEach
   - If runner-died status → suggest checking memory pressure; cite the audit paper's CI runner profile (§4)
   - If failure is in `tests/unit/ci-workflow.test.mjs` or `tests/unit/governor-state.test.mjs` → suggest a regression-witness blind spot pattern from yesterday's session
   - Else: no hint

If `gh run download` returns "no valid artifacts found", note that artifacts haven't uploaded yet (job didn't complete cleanly) and continue with whatever data the log scrape provided.

## Read-only Contract

This skill MUST NOT call any mutating gh subcommand. Forbidden:

- `gh run rerun`
- `gh run cancel`
- `gh workflow dispatch`
- `gh pr comment`
- `gh pr edit`
- `gh pr close`
- `gh pr merge`
- `npx vitest` (no local re-runs)

The skill only READS state. It never mutates.

Also: `gh run download` MUST always include `--pattern "vitest-unit-*"`. Never download the
full log archive (large, unbounded).

## Graceful Degradation

The skill should handle and explicitly report:

1. `gh` CLI not installed or not authenticated → friendly message + STOP
2. Artifacts not yet uploaded (job in progress or runner died) → continue with log scrape only
3. JSON malformed or empty → fall back to log-scrape-only mode
4. No recent CI runs on the branch → friendly message + STOP

Never silently swallow errors. The user expects a complete answer or a clean failure note.

## Usage Examples

- `/ci` → latest CI on staging
- `/ci latest` → same
- `/ci 27579016204` → specific run by databaseId
- `/ci green` → latest only if green
- `/ci red` → latest only if red
- `/ci failures` → parsed failure list from latest run
