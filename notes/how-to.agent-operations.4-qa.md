---
id: how-to.agent-operations.3-qa
title: 4 Qa
desc: 'How the QA Governor validates builds — testing, visual checks, bug reporting'
updated: 1772215318931
created: 1772212122871
---

## Purpose

Prove the system is broken and prove how. QA's job is not to confirm that software works — it's to find where it doesn't. There is no such thing as perfect software. QA validates a feature branch produced by Build and either passes it to Ship or writes a `backlog.fix.*` story describing exactly what's broken and why.

QA answers: **"Is the system broken? Where? How?"**

## Governor Chain

```
0. rks_governor_init({ projectId, problemId: 'backlog.feat.<slug>' }) → TOKEN
1. rks_agent_research({ projectId, query: 'understand what was built and what to test', _governorToken: TOKEN })
2. Run unit tests against the feature branch
3. Run integration tests against the feature branch
4. Run E2E / Playwright visual tests (if project has web component)
5a. ALL PASS → Return { status: 'passed', branch, testResults }
5b. ANY FAIL → Write backlog.fix story, return { status: 'failed', fixStoryId, testResults }
```

## QA Mindset

QA is adversarial by design. Good QA assumes the code is broken and works to prove it. The QA Governor should:

- **Test beyond the happy path** — edge cases, error states, boundary conditions
- **Verify what the spec says AND what it doesn't say** — regressions, side effects, unintended behavior changes
- **Report with precision** — which test, what input, what expected vs actual, steps to reproduce
- **Never assume "it probably works"** — if it wasn't tested, it's broken until proven otherwise
- **Trust no one** — not Build, not the developer, not previous test results. QA runs its own tests from scratch.

## Test Hierarchy

### Unit Tests (Step 2)
QA re-runs unit tests independently. Build may have run them, but QA trusts no one — if Build's test runner had a bug, a stale cache, or a flaky pass, QA catches it. This is cheap (seconds) and provides a clean baseline for the rest of the test suite.

Running the same tests in a separate session also **tests the tests**: if unit tests pass in Build but fail in QA, the tests themselves are unreliable — flaky, environment-dependent, order-dependent, or timing-sensitive. That's a defect worth reporting. QA surfaces test quality problems, not just code quality problems.

Run via: `npm run test:unit`

### Integration Tests (Step 3)
Integration tests verify that components work together:
- API endpoint tests (request/response contracts)
- Database interaction tests
- Service-to-service communication
- Configuration and environment validation

Run via: `npm run test:integration` (or project-specific command from kg.yaml config)

### E2E / Visual Tests (Step 4)
End-to-end tests verify the system from the user's perspective:
- **Playwright browser tests** — navigate pages, interact with UI, verify behavior
- **Visual QA** — capture screenshots at configured viewports, assess against criteria via Anthropic vision API
- **Accessibility checks** — if configured in the project's visual check plan

Uses: `rks_agent_visual` for Playwright-based capture and assessment. Viewport configs and dev server settings come from `kg.yaml`.

> **INTERVIEW GAP**: `rks_interview` does not currently ask whether a project has web components or needs visual QA. This means `kg.yaml` won't have viewport configs or dev server settings unless manually added. Interview needs a question like "Does this project have a web UI?" and if yes, capture: dev server command, port, viewports to test, and any visual acceptance criteria.

## On Failure: Writing `backlog.fix.*`

When QA finds failures, it writes a bug story — not a vague "tests failed" note, but a precise defect report:

### Fix Story Format
```markdown
## Problem
Integration test `test_user_auth_flow` fails on the feature branch.
Expected: 200 OK with session token
Actual: 401 Unauthorized — auth middleware rejects valid credentials

## Solution
Investigate auth middleware changes in `src/middleware/auth.ts` introduced by
backlog.feat.user-registration. The bearer token validation likely doesn't
handle the new token format.

## Acceptance Criteria
- [ ] test_user_auth_flow passes with valid credentials
- [ ] Existing auth tests continue to pass (no regression)

## Target Files
- `src/middleware/auth.ts` — EDIT — Fix bearer token validation
```

### Fix Story Metadata
- **Filename**: `backlog.fix.<descriptive-slug>`
- **Frontmatter field `relatedFeat`**: Links to the original `backlog.feat.*` story
- **Frontmatter field `branch`**: The feature branch to fix (same branch Build created)
- **targetFiles**: Scoped to the files that need fixing
- **testRequirements**: The specific tests that must pass

### After Writing the Fix
1. `rks_rag_embed` the fix story (explicit, atomic)
2. `dendron_update_field` → `phase: 'ready'`
3. Return `{ status: 'failed', fixStoryId: 'backlog.fix.<slug>', branch, testResults }`

The Dispatcher then launches Build for the fix story. Build targets the same branch.

## The QA → Fix → Build → QA Cycle

```
Build (feat) → produces code on branch
  ↓
QA → finds failure
  ↓
QA writes backlog.fix (targets same branch, related to feat)
  ↓
Build (fix) → refines, plans, execs on same branch
  ↓
QA → re-validates
  ↓ fail → another backlog.fix → Build → QA (loop)
  ↓ pass
Ship
```

This cycle ensures:
- Each fix attempt is a tracked story with its own scope, telemetry, and git history
- QA is not a "retry until it works" loop — it's a proper defect-report-and-fix cycle
- The branch accumulates fixes until QA passes, then Ship delivers the whole thing

## Allowed Namespaces

- **Reads from**: `backlog.feat.*` (the story being validated)
- **Writes to**: `backlog.fix.*` (bug stories on failure)

QA does NOT write to `backlog.feat.*` — it doesn't modify the original story. It creates new fix stories that reference the original.

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| QA Governor | Yes | Its own `rks_agent_research` call in step 1 populates session state |
| Dispatcher | Yes (indirect) | Session state persists after QA returns |
| Build Governor (fix) | **Separate session** | Build for the fix starts fresh, runs its own research |

## Governor Token and State Machine

- QA operates in **story flow** (problemId = the feat story being validated)
- Needs access to: `rks_agent_research`, `rks_agent_visual`, `dendron_create_note`, `dendron_update_field`, `rks_rag_embed`
- Does NOT need: `rks_refine`, `rks_plan`, `rks_exec` (those belong to Build)

> **TODO**: QA Governor doesn't exist yet. Needs its own state machine states (e.g., `testing → assessing → reporting`), its own tool allowlist, and its own Governor prompt at `.rks/prompts/governor-qa.md`.

## Visual QA Integration

For projects with web components, QA uses the visual agent:

1. Load `kg.yaml` config (viewports, dev server settings)
2. Start dev server if needed (`startDevServer()`)
3. Generate check plan from story's visual criteria
4. Capture screenshots at each viewport (`captureScreenshots()` via Playwright)
5. Assess each screenshot against criteria (`assessScreenshot()` via Anthropic vision API)
6. Stop dev server if we started it
7. Include visual results in test report

Visual failures produce the same `backlog.fix.*` stories with screenshot evidence.

## Bootstrapping

Same as all Governors: Task subagent runs in Claude Code (hooked), but the Governor's chain is entirely MCP tools (server-side, unhooked).

## Dispatcher Integration

The Dispatcher calls QA after Build returns successfully:
1. Build returns `{ status: 'complete', branch, filesChanged }`
2. Dispatcher launches QA Governor with the branch and feat story info
3. QA validates the branch

On return:
- `status: 'passed'` → hand off to Ship
- `status: 'failed'` → launch Build for the fix story, then re-run QA after Build completes

## Current State Requirements Divergence

### NOT BUILT: QA Governor does not exist

**Severity: Critical — QA phase is entirely missing from the pipeline**

There is no `governor-qa.md` prompt, no QA state machine states, no QA tool allowlist, and no QA-specific MCP tools for test execution. The visual agent (`rks_agent_visual`) exists but is not wired into any QA workflow.

`autoShip` has been removed from Build. Build now calls `rks_exec` then `rks_story_ship` as separate steps, enabling future QA insertion between them.

### NOT BUILT: `backlog.fix.*` story schema

**Severity: High — QA can't write fix stories without the schema**

The `backlog.fix.*` namespace needs:
- Dendron schema definition (like `backlog.feat.*` has)
- Frontmatter fields: `relatedFeat` (link to feat story), `branch` (target branch), standard fields
- Template for fix story body format

### NOT BUILT: Test runner MCP tools

**Severity: High — QA has no way to run tests through the MCP layer**

QA needs MCP tools that run tests server-side and return structured results:
- `rks_test_run({ projectId, suite: 'unit' })` — run unit tests
- `rks_test_run({ projectId, suite: 'integration' })` — run integration tests
- `rks_test_run({ projectId, suite: 'e2e' })` — run E2E tests
- Or: QA uses `rks_agent_visual` for visual tests and a new test agent for other suites

### DESIGN: QA needs to know which branch to test

**Severity: Medium — handoff between Build and QA**

Build returns `{ branch }` in its result. The Dispatcher passes this to QA. But QA also needs to check out the branch and set up the test environment. The mechanics of this handoff (checkout, install deps, start servers) need to be defined.

### DESIGN: `rks_interview` needs visual QA configuration

**Severity: Medium — projects with web UIs get no visual testing without manual kg.yaml setup**

`rks_interview` does not ask whether a project has web components. If it doesn't capture this during project init, `kg.yaml` will lack viewport configs, dev server commands, and visual acceptance criteria. Visual QA silently skips.

**Fix**: Add interview questions: "Does this project have a web UI?", and if yes: dev server command (`npm run dev`), port, viewports to test (desktop, tablet, mobile), and whether visual regression testing is wanted. Store in `kg.yaml` under a `visual` config block.