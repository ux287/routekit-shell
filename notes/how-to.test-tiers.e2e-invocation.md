---
id: "how-to.test-tiers.e2e-invocation"
title: "How-To: Tier 3 (E2E) Test Invocation"
desc: "When and how to run the full e2e test suite: manual trigger, required secrets, local run, and trigger conditions"
created: 1746288000000
updated: 1746288000000
---

## When to Run Tier 3

Tier 3 (e2e) tests make real API calls and consume tokens. Run them:

- **Nightly** — automatically via GitHub Actions cron (`0 4 * * *`)
- **After a Tier 2 failure** — if mock tests pass but staging breaks, e2e rules out environment differences
- **On user-reported bugs** — when a bug is reported against production behavior, run e2e to reproduce before fixing
- **Before a release** — as a final gate if the nightly hasn't run recently

Do NOT run e2e on every PR or commit. Use Tier 1 (unit) for that.

## Manual Trigger via `gh workflow run`

```bash
# Trigger e2e on staging
gh workflow run ci.yml --ref staging

# Trigger on a specific branch
gh workflow run ci.yml --ref your-branch-name
```

The `e2e-tests` job only runs when `secrets.RKS_E2E_ENABLED` is set in the repository secrets. Standard PR runs skip it automatically.

## Required Secrets and Environment Variables

| Secret / Env Var | Required | Purpose |
|---|---|---|
| `RKS_E2E_ENABLED` | Yes (gate) | Must be set to any non-empty value to enable the e2e job |
| `ANTHROPIC_API_KEY` | Yes | LLM calls in e2e tests |
| `ROUTEKIT_LLM_PROVIDER` | No | Override provider (defaults to anthropic if key is present) |

Set these in GitHub: **Settings → Secrets and variables → Actions**.

## Local Run

```bash
# Run the full e2e suite locally
npm run test:e2e

# With a custom timeout (milliseconds)
node scripts/vitest-runner.mjs --config vitest.config.e2e.mjs --timeout 300000
```

Requires a valid `.env` file with `ANTHROPIC_API_KEY` set. Copy `.env.example` to `.env` and fill in credentials.

## Tier Summary

| Tier | Command | When it runs | Cost |
|---|---|---|---|
| 1 — Unit | `npm run test:unit` | Every exec, every PR | Fast, free |
| 2 — Mock | `npm run test:mock` | Every staging push/PR | Fast, free |
| 3 — E2E | `npm run test:e2e` | Nightly, manual, bug reports | Real API calls |
