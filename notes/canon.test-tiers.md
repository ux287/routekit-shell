---
id: canon.test-tiers
title: Test Tiers
desc: >-
  Reference: the unit/mock/e2e test tiers, when each runs in the pipeline, how
  to invoke each tier, and test file conventions
updated: 1778123000963
created: 1777848003000
---

rks organizes tests into three tiers based on speed, isolation requirements, and when they run in the build pipeline. Every story ships with a `testFiles` frontmatter field that declares which test file(s) cover it, and the Build Governor runs the appropriate tier automatically.

See [[public.canon.getting-started]] for how tests fit into the overall build flow.

## Tier Overview

| Tier | What it tests | When it runs | How to invoke |
|---|---|---|---|
| **Unit** | Pure logic, no I/O, no credentials | Every build — pre-exec pre-flight and post-exec validation | `npx vitest run --config vitest.config.unit.mjs` |
| **Mock/Integration** | MCP tools and server logic with mocked dependencies | Every build for stories that add or modify MCP tools | `npx vitest run --config vitest.config.integration.mjs` |
| **E2E** | Full pipeline with real credentials and external APIs | Manually before releases; never in automated builds | `npx vitest run --config vitest.config.e2e.mjs` |

## Tier 1 — Unit Tests

Unit tests cover pure business logic with no filesystem access, no network calls, and no real credentials. They must be fast (under 5 seconds for the full unit suite) and deterministic.

**What belongs here:** Transform logic, parsing utilities, configuration validation, pure algorithm tests, any function that takes inputs and returns outputs with no side effects.

**File location convention:** `tests/unit/*.test.mjs` or colocated `*.test.mjs` files next to the source they test.

**Run command:**
```bash
npx vitest run --config vitest.config.unit.mjs
```

Or using the project's wrapper script (handles process cleanup):
```bash
node scripts/vitest-runner.mjs --config vitest.config.unit.mjs
```

To run a single test file:
```bash
node scripts/vitest-runner.mjs --config vitest.config.unit.mjs tests/unit/my-feature.test.mjs
```

## Tier 2 — Mock/Integration Tests

Mock/integration tests exercise MCP tools or server logic using mocked dependencies (no real API calls, no real git pushes). These are the appropriate tier for testing that an MCP tool returns the right shape, handles error cases gracefully, or wires its sub-operations correctly.

**What belongs here:** MCP tool handler tests, `spawnSync`-mocked git operation tests, tests that import from `packages/mcp-rks/src/` and mock the external calls.

**File location convention:** `tests/unit/*.test.mjs` (currently collocated with unit tests; a separate `tests/integration/` directory may be introduced in the future).

**Run command:**
```bash
npx vitest run --config vitest.config.integration.mjs
```

## Tier 3 — E2E Tests

E2E tests exercise the full build pipeline with real API credentials. They call real LLM APIs, execute real git operations, and create real PRs. They are slow (minutes per test), expensive (LLM token costs), and non-deterministic.

**What belongs here:** Full Governor round-trip tests, story-create-to-PR tests, tests that verify the LLM output meets requirements.

**Credential requirements:** `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and a real git remote must all be present.

**When to run:** Not in automated builds. Run manually before a release to catch regressions in the full pipeline. The Build Governor never triggers E2E tests automatically.

**Run command:**
```bash
npx vitest run --config vitest.config.e2e.mjs
```

## The `testFiles` Frontmatter Field

Every story note has a `testFiles` field in its frontmatter that declares the test files covering that story:

```yaml
testFiles:
  - tests/unit/my-feature.test.mjs
```

The Build Governor uses this field to run only the relevant test files during a build, rather than the entire suite. This keeps build times short. The `testRequirements` field in the same frontmatter lists the individual test cases that must pass for the story to be considered done.

## Warning: Do Not Run Concurrent Vitest Instances

Running multiple `vitest run` processes simultaneously against the same project causes severe problems:

- Multiple `rg` (ripgrep) processes accumulate and are never cleaned up
- Shared test fixtures and temp directories collide
- CPU thrash from overlapping Node.js processes slows the whole system
- Test results become unreliable due to race conditions

**The rule:** Run one `vitest run` at a time. Wait for it to exit before starting another. The `block-concurrent-vitest` hook enforces this when guardrails are on — it blocks a second `vitest run` if one is already running in the project. Do not attempt to bypass this hook; if a vitest run appears hung, kill it explicitly before starting a new one.
