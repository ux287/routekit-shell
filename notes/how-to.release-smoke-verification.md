---
id: how-to.release-smoke-verification
title: How to maintain the release-smoke workflow and its fixture vault
desc: Operator's guide for the post-release smoke verification job — what it covers, when it fires, and how to update fixtures when the content_type taxonomy evolves.
created: 1780972648343
updated: 1780972648343
---

## What this is

The release-smoke workflow at `.github/workflows/release-smoke.yml` fires on every tag push matching `v*.*.*` (the tags created by `rks_release`). It builds a LanceDB index from a synthetic fixture vault at `tests/integration/fixtures/release-smoke-vault/` using the **production** `scripts/rag/embed.mjs`, then runs `tests/integration/release-smoke.test.mjs` to assert the resulting index satisfies the post-release storage contract:

1. Every required content_type is present (`backlog`, `note`, `code`, `implemented`).
2. `implemented` has ≥ 1 row.
3. Total row count is within a sane band (catches empty + runaway indexes).

A green smoke proves the release artifact actually produces a populated, correctly-typed LanceDB end-to-end. A red smoke posts a commit comment on the tag's commit referencing the failed assertion so the release-day operator sees the failure without scrubbing the Actions UI.

## What motivated it

Before this workflow existed, the v0.20.15 release required four manual commands to verify the embed-classifier fix actually shipped working code. A green CI does not prove the release artifact works — `scripts/rag/embed.mjs` integration paths (project-root resolution, classifier, LanceDB write) are not covered by unit tests, and a regression there silently lands an empty or mistyped index.

## Why the fixture vault layout matters

The fixture at `tests/integration/fixtures/release-smoke-vault/` is a minimal synthetic project:

```
release-smoke-vault/
  .rks/project.json        — project metadata embed.mjs reads
  dendron.yml              — vault declaration
  package.json             — metadata
  notes/
    backlog.feat.*.md      — exercises content_type='backlog'
    backlog.fix.*.md       — exercises content_type='backlog' (variant)
    backlog.z_implemented.*.md — exercises content_type='implemented'
    research.*.md          — exercises content_type='note'
    canon.*.md             — exercises content_type='note' (variant)
    how-to.*.md            — exercises content_type='note' (variant)
  src/sample.mjs           — exercises content_type='code'
  scripts/sample-script.mjs — exercises content_type='code' (variant)
```

Each filename prefix routes through `classifyContentType()` in the production embed pipeline. If the classifier enum changes — a new content_type added, an old one renamed — the smoke will fail because the test expects the documented set.

## When you must update the fixture or test

| Change | What to update |
| --- | --- |
| New content_type added to the classifier | Add a fixture file under `notes/` whose filename matches the new prefix. Add the new type to `REQUIRED_CONTENT_TYPES` (if mandatory) or to the `allowed` set (if optional) in `tests/integration/release-smoke.test.mjs`. |
| content_type renamed | Rename the relevant fixture filename prefix and update the assertion array. |
| content_type removed | Delete the relevant fixture file(s) and remove the assertion. |
| Row-count band tightened or loosened | Adjust `EXPECTED_ROW_FLOOR` / `EXPECTED_ROW_CEILING` in `tests/integration/release-smoke.test.mjs`. The current band is intentionally wide — it catches empty + runaway, not drift. |
| ROUTEKIT_PROJECT_ROOT semantics change | Update the `env:` block in `.github/workflows/release-smoke.yml` AND the path-derivation in `tests/integration/release-smoke.test.mjs` in lockstep. The two must use the same derivation rule (`path.basename(projectRoot)` for the LanceDB filename) or the test will query a different path than embed wrote. |
| ROUTEKIT_RAG_EMBEDDINGS_MODE default changes | Update the `env:` block to whatever mode production now defaults to. The smoke must exercise the production path, not a degenerate alternative. |
| `scripts/rag/embed.mjs` moved or renamed | Update the workflow's `run:` line AND the source-grep pin in `tests/unit/release-smoke-workflow.test.mjs`. |

## When the smoke fails on a release tag

1. The workflow posts a comment on the tag's commit via `gh api repos/{owner}/{repo}/commits/{sha}/comments`. Read it for which step failed (embed vs assert).
2. If the embed step failed: the production embed script crashed against the fixture vault. Reproduce locally with the recipe below; it is almost always a code regression introduced since the last green smoke.
3. If the assert step failed: the index built but the contract was violated — likely a classifier regression. Re-run `node scripts/rag/embed.mjs` against the fixture vault, query the LanceDB manually, and compare the content_type distribution against the expectation in `tests/integration/release-smoke.test.mjs`.
4. **Do NOT proceed with the next release** until the smoke passes again. The smoke's whole purpose is to gate releases on storage-contract correctness.

## Local invocation (reproducing the workflow)

```bash
# From the routekit-shell-core repo root:
export ROUTEKIT_PROJECT_ROOT="$(pwd)/tests/integration/fixtures/release-smoke-vault"
export ROUTEKIT_RAG_EMBEDDINGS_MODE=model

# Build the index:
node scripts/rag/embed.mjs

# Run the assertions:
npx vitest run tests/integration/release-smoke.test.mjs
```

After running locally, the LanceDB lives at:

```
tests/integration/fixtures/release-smoke-vault/.rks/rag/release-smoke-vault.lancedb/
```

Delete that directory to force a clean re-index.

## Related files

- `.github/workflows/release-smoke.yml` — the workflow itself
- `tests/integration/release-smoke.test.mjs` — the assertion test
- `tests/unit/release-smoke-workflow.test.mjs` — unit-level YAML structure checks (run on every PR)
- `scripts/rag/embed.mjs` — the production embed script the workflow invokes
- `packages/cli/src/rag/config.mjs` — owner of the `path.basename(projectRoot)` derivation rule the workflow and test both follow

## Story of record

`notes/backlog.feat.post-release-smoke-verification.md` — original story with the full requirements set and ARCH guidance.
