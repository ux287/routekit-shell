---
id: 2reiuull8ehc17zwtb9s83n
title: Agent Operations Backlog
desc: >-
  Consolidated backlog from the agent-operations how-to series — clustered by
  theme, prioritized for dev order, with abstraction opportunities identified
updated: 1772218536192
created: 1772217870002
---

## Purpose

This note consolidates every divergence entry, bug, and design gap from the `how-to.agent-operations.*` series into a single prioritized backlog. Items are clustered by theme rather than source doc — because what looks like 25+ separate issues is really 6 clusters, and 3 of those clusters share a common abstraction.

**Source docs**: 0-design-riff, 1-product-owner, 2-research, 3-build, 4-qa, 5-ship

---

## The Big Picture

Most of these items fall into one of two meta-problems:

1. **Access control is prompt-level, not code-level.** Governor tokens exist but don't enforce tool restrictions at the handler level. Every "a misbehaving agent could do X" entry is a symptom of this.
2. **The pipeline is designed but half-built.** QA and Ship Governors are specified but don't exist. Test runners are specified but don't exist. The pipeline diagram has boxes with no implementation behind them.

The refactoring opportunity: **build flow-aware access control once** (Cluster 1), and the namespace guards, tool restrictions, and shipping controls all fall out of the same mechanism.

---

## Cluster 1: Access Control / Flow-Aware Tool Restrictions

**Theme**: Things that should be restricted but are enforced only by prompt conventions.

**Common abstraction**: A single `assertToolAllowed(token, toolName, args)` function in the MCP tool handlers that checks flow type, session type, and current state machine position. Build this once, and every entry in this cluster becomes a configuration line.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 1.1 | GitHub MCP tools bypass all guardrails — `create_or_update_file`, `push_files`, `merge_pull_request` not intercepted by hooks or token enforcement | **Critical** | 2-research | No hook, no token check |
| 1.2 | `rks_ship` accessible from Build/QA state machines — should be restricted to Ship Governor sessions only | **High** | 3-build, 5-ship | In `COMMON_TOOLS`, available everywhere |
| 1.3 | Namespace enforcement is prompt-level only — Research can write `backlog.*`, Build can write `research.*` | **Medium** | 2-research | Prompt says "don't", code allows it |
| 1.4 | Proto-story guard — non-PO flows can set `phase: 'ready'` on backlog notes | **Medium** | 0-design-riff | Option B designed (namespace + field guard), not built |
| 1.5 | `rks_agent_git` missing from all Governor tool allowlists | **Medium** | MEMORY.md | Unlisted in `STORY_FLOW_TOOLS` and `OPEN_FLOW_TOOLS` |
| 1.6 | `rks_exec_abort` missing from `UNPROTECTED_TOOLS` | **Low** | MEMORY.md | Cannot abort a stuck exec without token |

**Dev approach**: Build `assertToolAllowed` in `governor-token.mjs`. Migrate `COMMON_TOOLS`, `STORY_FLOW_TOOLS`, `OPEN_FLOW_TOOLS` to use it. Add namespace-aware checks for Dendron handlers. Add GitHub MCP interception. Items 1.1–1.4 are the priority; 1.5–1.6 are configuration fixes once the mechanism exists.

---

## Cluster 2: Testing Infrastructure

**Theme**: Tests that block builds, tests that don't run, and test results that don't flow through the pipeline.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 2.1 | Flaky baseline tests block `rks_exec` — 26 failures across 3 files, every build attempt wastes a full debug cycle on false negatives | **High** | 3-build | Workaround: `skipTests: true` (defeats the safety net) |
| 2.2 | Test runner MCP tools don't exist — `gov_test_run` specified but not implemented for unit/integration/E2E tiers | **Critical** | 4-qa | QA Governor chain has no tools to call |
| 2.3 | Missing post-exec unit test validation — Build doesn't verify tests pass after code changes | **High** | 3-build | Exec succeeds even if it broke tests |
| 2.4 | Missing test results in PR body — Ship creates PRs without test evidence | **Medium** | 5-ship | PR body has no test summary section |

**Dev approach**: Fix 2.1 first (unblock current builds). Build 2.2 next (test runner tools for all tiers). Wire 2.2 into Build (2.3) and Ship (2.4) chains.

**Abstraction opportunity**: A `TestRunner` service that handles all tiers (unit, integration, E2E, visual), emits standardized results, and flows results into PR bodies and telemetry. Build it once, QA and Build both consume it.

---

## Cluster 3: Pipeline Stages (QA + Ship)

**Theme**: Governor stages that are designed in the how-to docs but don't exist as runnable code.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 3.1 | QA Governor doesn't exist | **Critical** | 4-qa | Full spec in 4-qa doc, no implementation |
| 3.2 | Ship Governor not standalone — depends on manual Dispatcher orchestration | **High** | 5-ship | Partially built, no formal chain |
| 3.3 | `backlog.fix.*` schema not built — QA can't write fix stories in the format it needs | **High** | 4-qa | No frontmatter schema, no PO integration |
| 3.4 | Missing CI check enforcement — Ship doesn't wait for CI before merging | **Medium** | 5-ship | PR created, merged without CI gate |
| 3.5 | Undefined release promotion — no path from staging to production | **Low** | 5-ship | 3-branch model exists, promotion doesn't |

**Dev approach**: 3.3 first (fix story schema — needed before QA can function). 3.1 next (QA Governor). 3.2 after (Ship standalone). 3.4 and 3.5 are polish.

**Dependency**: Cluster 1 (access control) should land before Cluster 3. QA and Ship Governors need proper flow-aware tool restrictions from day one — retrofitting is harder than building it in.

---

## Cluster 4: Build Pipeline Mechanics

**Theme**: Issues in the existing Build Governor that prevent clean chaining to QA and Ship.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 4.1 | ~~`autoShip: true` bundles shipping into Build~~ | **High** | 3-build | **DONE** — `autoShip` removed from exec + governor-build prompt |
| 4.2 | Hooks use file-move mechanism (`hooks/` ↔ `hooks.bak/`) instead of guardrails state file | **High** | 3-build | Fragile, causes ENOENT in tests, inconsistent state |
| 4.3 | `relatedFeat` field needed in fix stories — links fix back to the feature that broke | **Low** | 3-build | Fix stories are orphaned from their origin |

**Dev approach**: 4.1 and 4.2 are prerequisites for the QA chain. Fix them before building QA Governor (Cluster 3). 4.3 is a schema enhancement that can land with the fix story schema (3.3).

**Abstraction opportunity**: 4.2 is the same pattern as the `design_riff` session type (Cluster 6) — both need guardrails to be state-file-driven, not file-move-driven. One refactoring solves both.

---

## Cluster 5: Telemetry / Observability

**Theme**: Things that happen silently — no events emitted, no diagnostics available.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 5.1 | RAG embed emits zero telemetry — can't answer "who embedded what, when" | **Medium** | 2-research | No events for `rag.embed.*` |
| 5.2 | Telemetry query type filter requires exact subtype — `agent.research` returns nothing, need `agent.research.started` | **Low** | 2-research | Discoverability issue |

**Dev approach**: 5.1 when building the test runner (Cluster 2) — both need telemetry plumbing. 5.2 is a small UX fix anytime.

---

## Cluster 6: UX / Developer Experience

**Theme**: Friction in the developer experience that slows down every session.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 6.1 | Research Agent redirect is high-friction — latency, invocation complexity, result fidelity | **High** | 2-research | Hooks redirect correctly but the redirected path is slow and lossy |
| 6.2 | Research agent escalation rate is 33% — haiku exceeds max turns, triggers sonnet escalation | **Low** | 2-research | Transparent but adds latency and cost |
| 6.3 | `rks_interview` doesn't ask about visual QA configuration — `kg.yaml` lacks viewport/component configs | **Medium** | 4-qa | No visual QA setup during project init |
| 6.4 | Prompt files inaccessible with guardrails on — `.rks/prompts/*` not in read-classification allowlist | **Low** | 2-research | Moot if bootstrap pattern is followed |
| 6.5 | `design_riff` session type not recognized in guardrails state | **Medium** | 0-design-riff | Generic `guardrails_off`, no session-specific behavior |

**Dev approach**: 6.1 is the highest-impact UX fix — every session hits this friction. 6.3 and 6.5 when building their respective features. 6.2 and 6.4 are minor polish.

---

## Cluster 7: PO Governor Gaps

**Theme**: Missing capabilities in the PO Governor that limit story quality and decomposition.

| # | Item | Severity | Source | Current State |
|---|------|----------|--------|---------------|
| 7.1 | `.03-decompose` handler not built — AC gate rejects stories >4 ACs with no automated recovery path | **High** | 1-product-owner | PO must manually scope to ≤4 ACs; gate rejection is a dead end |
| 7.2 | PO prompt missing Research Governor delegation (step 1c) — PO can't orchestrate deep research before story creation | **Medium** | 1-product-owner | Prompt has no delegation pattern; Dispatcher would need to sequence Research → PO |
| 7.3 | PO inflates ACs beyond what Dispatcher specifies — stories come back overscoped | **Medium** | MEMORY.md | Prompt-level issue; no AC budget mechanism |

**Dev approach**: 7.1 is the priority — it's a hard blocker when stories exceed 4 ACs. 7.2 and 7.3 are prompt/workflow refinements that improve story quality.

**Dependency**: 7.1 (decompose handler) should land before Cluster 3 (QA Governor). QA will generate fix stories that may also need decomposition. The decompose mechanism needs to exist before more story-generating Governors come online.

---

## Recommended Dev Order

Based on dependency chains and impact:

### Phase 1: Foundations (unblock everything) — COMPLETE
1. **Cluster 1.1–1.4**: Flow-aware access control (`assertToolAllowed`) — DONE (PRs #798, #799)
2. **Item 2.1**: Fix flaky baseline tests (unblock `rks_exec`) — DONE
3. **Items 4.1, 4.2**: Remove `autoShip`, migrate hooks to state file — DONE

### Phase 2: Story Pipeline (enable clean story flow)
4. **Item 7.1**: Build `.03-decompose` handler
5. **Item 2.2**: Build test runner MCP tools
6. **Item 3.3**: `backlog.fix.*` schema

### Phase 3: Pipeline Completion (QA + Ship chains)
7. **Item 2.3**: Wire post-exec test validation into Build
8. **Item 3.1**: QA Governor
9. **Item 3.2**: Ship Governor standalone
10. **Item 2.4**: Test results in PR body
11. **Item 3.4**: CI check enforcement

### Phase 4: Polish
12. **Item 6.1**: Research Agent UX (reduce redirect friction)
13. **Items 5.1, 5.2**: Telemetry coverage
14. **Items 6.3, 6.5, 7.2, 7.3**: Interview visual QA, design_riff session type, PO prompt refinements
15. **Items 1.5, 1.6, 3.5, 4.3, 6.2, 6.4**: Minor fixes and enhancements

---

## Abstraction Opportunities

Three refactorings that solve multiple items simultaneously:

### 1. `assertToolAllowed(token, toolName, args)` → Cluster 1 + parts of Cluster 3
A single function in `governor-token.mjs` that checks:
- Flow type (story, open, design_riff)
- Session type
- Current state machine position
- Namespace of target note (for Dendron tools)
- Protected fields (for backlog notes)

This replaces the scattered `COMMON_TOOLS`/`STORY_FLOW_TOOLS`/`OPEN_FLOW_TOOLS` arrays with a unified check. Every new Governor type gets proper restrictions by default.

### 2. Guardrails state file → Cluster 4 + Cluster 6
Moving hooks from file-move (`hooks/` ↔ `hooks.bak/`) to state-file-driven behavior means:
- Hooks read `.rks/guardrails-state.json` to decide behavior (not their own existence)
- Session types (`design_riff`, `build`, `qa`) configure hook behavior per-session
- No more ENOENT errors from missing hook files
- Tests can mock the state file instead of moving files around

### 3. `TestRunner` service → Cluster 2 + parts of Cluster 3
A single service that:
- Runs any test tier (unit, integration, E2E, visual)
- Emits standardized results (pass/fail counts, failure details, duration)
- Emits telemetry events
- Flows results into PR bodies (for Ship) and fix stories (for QA)
- Is consumed by Build (post-exec validation), QA (full validation), and Ship (PR evidence)

---

## Cross-References

- **Proto-story guard (1.4)**: Option B enforcement design detailed in `how-to.agent-operations.0-design-riff`
- **QA spec (3.1)**: Full Governor chain spec in `how-to.agent-operations.4-qa`
- **Ship entry paths (3.2)**: Three entry paths documented in `how-to.agent-operations.5-ship`
- **Decompose gap (7.1)**: Known gap documented in `how-to.agent-operations.1-product-owner`
- **Flaky tests (2.1)**: Fix plan exists at `.claude/plans/mossy-plotting-pebble.md`