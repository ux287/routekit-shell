---
id: yyi2vd44296jkf6qgr0gnmp
title: 'Canon: Phase State Machine'
desc: >-
  Authoritative reference for the rks story-phase lifecycle. Documents what the
  system does today, with [GAP-N] annotations where reality diverges from
  intended Vision.
updated: 1779997761734
created: 1779997761734
---

## 1. Purpose

This document is the contract for the rks story-phase state machine. It describes what the system does today, citing source file:line for every claim. Where the current code diverges from the intended Vision — missing graph edges, broken transitions, silent failures, bypassed helpers — the divergence is marked inline as `[GAP-N]`. Each `[GAP-N]` resolves in section 8 with current behavior, Vision, audit-paper reference, and suggested fix shape.

The contract: future contributors write code against this document. Stories cite gaps. When a story closes a gap, the `[GAP-N]` annotation gets edited out and the prose updated. Canon stays true at any given moment — if reality changes, this document changes.

The diagnostic source for every gap below is [notes/research.2026.05.28.phase-state-machine-audit.md](research.2026.05.28.phase-state-machine-audit.md) — a code-grounded audit of the as-is state machine produced 2026-05-28.

## 2. Phases

The canonical phase list lives in `PHASE_MACHINE.states` at [packages/mcp-rks/src/workflow/phases.mjs](../packages/mcp-rks/src/workflow/phases.mjs). After the v1→v2 sweep (R1.0–R1.4), the live phases are:

- **`draft`** — A story exists with a problem statement but no test plan or architectural review. **Entered by** the PO Governor via `dendron_create_note` (the direct handler at `packages/mcp-rks/src/server.mjs` sets `phase: "draft"` for any `backlog.*` filename that is not under `z_implemented` or `z_archive`). **Exited by** the QA Governor advancing to `ready`.

- **`ready`** — A story has `testRequirements`, the architecture review has not yet run. **Entered by** the QA Governor via direct `dendron_update_field` per the prompt chain at `.rks/prompts/governor-qa.md`. **Exited by** the ARCH Governor advancing to `arch-approved`.

- **`arch-approved`** — Architecture review cleared the story. The Dispatcher may now route to `/build`. **Entered by** the ARCH Governor via direct `dendron_update_field` per `.rks/prompts/governor-arch.md` step 3.b. **Exited by** `rks_plan` advancing to `planned` via the `exec_start` operation (R1.3e migration — `rks_plan` now calls `advancePhase('exec_start')`).

- **`planned`** — A plan has been generated for the story and persisted. **Entered by** `rks_plan` via the `persistAndFinalize` path in `packages/mcp-rks/src/server/planner-persistence.mjs` routing through `advancePhase('exec_start')`. **Exited by** `rks_exec` advancing to `executing` (R1.3). Note: `planned` is in the process of being phased out — the design (research.2026.06.12) routes plan persistence to set `executing` directly in a subsequent sweep; until then `planned` remains a live intermediate state.

- **`executing`** — `rks_exec` is actively applying a plan to the working tree. **Entered by** `rks_exec` via `advancePhase('exec_start')` (R1.0–R1.2 foundation). **Exited by** `rks_exec` advancing to `committed` via `advancePhase('exec_end')` once tests pass, or back to `arch-approved` via `rks_refine` (R1.3e companion — refine now resets phase to `arch-approved`).

- **`committed`** — `rks_exec` finished cleanly; the change is committed on the feature/off-rail branch but not yet merged to the integration branch. **Entered by** `rks_exec` via `advancePhase('exec_end')` (R1.0–R1.2). **Exited by** `rks_ship` / `runStagingMerge` via `advancePhase('ship')` (R1.3-followup-rks-ship) or by `rks_guardrails_on` via `advancePhase('guardrails_on.commit')` (R1.0–R1.2).

- **`executed`** — Legacy v1 holdover retained for back-compat in `legacyAcceptedOperations` (R1.3). New v2 production writers use `committed` instead; `executed` survives only so existing notes that pre-date the sweep continue to validate. **Exited by** `rks_ship` advancing to `integrated`.

- **`integrated`** — The change is merged to the integration branch (typically `staging`). **Entered by** `rks_ship` / `runStagingMerge` via `advancePhase('ship')` (R1.3-followup-rks-ship) or off-rail `rks_guardrails_on` via `advancePhase('guardrails_on.merge')` (R1.0–R1.2). **Exited by** `rks_release` advancing to `released` via `advancePhase('release')` (R1.3-followup-rks-release). Note: `rks_cycle_complete` no longer overwrites `phase` (R1.3f) — it still moves the file to `backlog.z_implemented.*` but leaves `phase: integrated` on disk. The R8 backfill tool migrates any in-flight `phase: implemented` notes to `integrated` (collapsing the retired phase into the live one).

- **`released`** — The story is included in a tagged release on `main`. **Entered by** `rks_release` / `transitionIntegratedStories` via `advancePhase('release')` (R1.3-followup-rks-release — the regex now matches `phase: integrated` and the writer routes through the state-machine helper). No exit (terminal).

**Retired phases**:

- **`implemented`** — retired in R1.4. `PHASE_MACHINE.states` no longer includes `implemented` as a live phase. The v2 model collapses `implemented` into `integrated`: the filename prefix `backlog.z_implemented.*` remains the archival marker (set by `runCycleComplete`), but the `phase` frontmatter field stays at `integrated` from ship through release. In-flight notes still carrying `phase: implemented` are backfilled by the R8 migration tool.

## 3. Transitions

The canonical edge set is derived from `PHASE_MACHINE.transitions` at `packages/mcp-rks/src/workflow/phases.mjs` (Story 1, updated through R1.4). Today's graph (v2 — `implemented` retired):

```
draft           → [ready]
ready           → [arch-approved, planned, draft]
arch-approved   → [planned, executing, ready]
planned         → [executing, executed, planned, ready]
executing       → [committed, arch-approved]
committed       → [integrated]
executed        → [integrated, planned, ready]
integrated      → [released]
released        → []
```

`released` is the declared terminal node. Every other state has both an incoming and an outgoing edge (asserted by the phase-machine-integrity test suite).

**v2 operations** (added in the R1.0–R1.3 arc; consumed by `advancePhase` and the legacy `resolveOperation` helper):

| Operation              | from                              | to              | Writer                                                     |
| ---------------------- | --------------------------------- | --------------- | ---------------------------------------------------------- |
| `exec_start`           | `arch-approved`, `planned`        | `executing`     | `rks_plan` (persistAndFinalize) / `rks_exec` entry         |
| `exec_end`             | `executing`                       | `committed`     | `rks_exec` on successful test pass                         |
| `commit`               | `executing`                       | `committed`     | 2-branch commit path                                       |
| `promote`              | `committed`                       | `integrated`    | 2-branch promote (commit-already-on-staging path)          |
| `guardrails_off`       | `arch-approved`                   | `executing`     | `rks_guardrails_off` entry (off-rail session start)        |
| `guardrails_on.commit` | `executing`                       | `committed`     | `rks_guardrails_on` first stage (commit local work)        |
| `guardrails_on.merge`  | `committed`                       | `integrated`    | `rks_guardrails_on` second stage (merge to integration)    |
| `ship`                 | `committed`, `executed`           | `integrated`    | `runStagingMerge` / `runStoryShipTool` (R1.3-followup-rks-ship) |
| `release`              | `integrated`                      | `released`      | `transitionIntegratedStories` (R1.3-followup-rks-release)  |
| `refine`               | `executing`, `planned`, `executed`| `arch-approved` | `rks_refine` (R1.3e companion — resets phase)              |

The `legacyAcceptedOperations` map at `phases.mjs` (R1.3) maps the old v1 operation names (`plan`, `exec`, `cycle_complete`) onto the corresponding v2 transitions for back-compat. `resolveOperation` is the helper that consults both `PHASE_MACHINE.transitions` and the legacy map.

For each transition the system uses today:

- **`draft → ready`** (QA Governor)
  - Trigger: QA Governor returns `ready` after adding testRequirements
  - Gate: `phase_is_draft` check at `packages/mcp-rks/src/workflow/state-machine.mjs` (`draft→ready` key has a gate: targetFiles must be non-empty array)
  - Writer: direct `dendron_update_field` per `.rks/prompts/governor-qa.md`
  - **`[GAP-6]`** — writer bypasses `advancePhase`; gate runs only if the writer chooses to call `validateTransition`, which QA does not.

- **`ready → arch-approved`** (ARCH Governor)
  - Trigger: ARCH Governor returns `approved`
  - Gate: **none** — `[GAP-7]`
  - Writer: direct `dendron_update_field` per `.rks/prompts/governor-arch.md` step 3.b
  - The edge now exists in the derived `TRANSITION_GRAPH` (Story 1) via the `arch` operation in `PHASE_MACHINE.transitions`. Migration of the ARCH writer to `advancePhase("arch")` remains — see `[GAP-6]`.

- **`arch-approved → executing`** (rks_plan, R1.3e)
  - Trigger: `rks_plan` → `runPlanTool` → `persistAndFinalize`
  - Gate: routes through `advancePhase('exec_start', ...)` which consults `PHASE_MACHINE.transitions` for valid from-phases (`arch-approved`, `planned`)
  - Writer: `advancePhase` (R1.3e migration — direct `updateField` calls eliminated from this path)
  - Companion: `rks_refine` resets phase to `arch-approved` via `advancePhase('refine')`, allowing the cycle to re-enter `executing` cleanly on subsequent plans (R1.3e companion).

- **`executing → committed`** (rks_exec, R1.3)
  - Trigger: `rks_exec` completes a successful run with tests passing
  - Gate: `advancePhase('exec_end', ...)` validates the from-phase via `PHASE_MACHINE.transitions`
  - Writer: `advancePhase` (R1.3 migration — `runExecTool` now routes through the helper instead of inline `updateField`)
  - Legacy: notes still at the v1 `planned` phase resolve through `legacyAcceptedOperations.exec` to the same `committed` end state.

- **`committed → integrated`** (rks_ship / runStagingMerge, R1.3-followup-rks-ship)
  - Trigger: `rks_ship` merges the off-rail or feature branch to the integration branch
  - Gate: `advancePhase('ship', ...)` validates the from-phase (accepts `committed`, `executed`) via `PHASE_MACHINE.transitions`
  - Writer: `advancePhase` — `runStagingMerge` and `runStoryShipTool` both migrated off direct `updateField` (R1.3-followup-rks-ship).
  - Off-rail companion: `rks_guardrails_on` walks the same destination through the `guardrails_on.commit` + `guardrails_on.merge` ops; the 3-branch off-rail ship no longer leaves stories stranded at `arch-approved`.

- **`integrated → integrated`** (rks_cycle_complete, R1.3f — no phase write)
  - Trigger: cycle-complete step in the ship sequence
  - Gate: n/a — cycle-complete no longer writes phase
  - Writer: `runCycleComplete` moves the file from `notes/<id>.md` to `notes/backlog.z_implemented.<id>.md` and sets `status: implemented`, but **does not touch the `phase` field** (R1.3f migration, commit 5776afb0). The filename prefix `backlog.z_implemented.*` is the archival marker; `phase` remains at `integrated` ready for `rks_release`.
  - The retired v1 edge `integrated → implemented` and the writer race documented historically as `[GAP-9]` are both closed by the same migration. The R8 backfill tool migrates any in-flight `phase: implemented` notes to `integrated`.

- **`integrated → released`** (rks_release, R1.3-followup-rks-release)
  - Trigger: `rks_release` runs `transitionIntegratedStories` after ff-merge to `main`
  - Gate: `advancePhase('release', ...)` validates the from-phase (`integrated`) via `PHASE_MACHINE.transitions`
  - Writer: `transitionIntegratedStories` discovers candidate notes via `phase: integrated` regex match and routes the write through `advancePhase('release')`. The regex-as-discovery plus state-machine-as-writer pattern preserves the existing index strategy while closing the silent-no-op bug documented in `[GAP-3]`.
  - The retired v1 edge `implemented → released` is collapsed: notes never reach `implemented` in v2 (R1.3f), so the only live path is `integrated → released`.

Reverse edges (`ready → draft`, `arch-approved → ready`, `planned → ready`, `executed → ready`) exist in the graph but have **no operation trigger** and **no gate** — they are reachable only via manual `updateField` writes. `[GAP-10]`

## 4. Governor Ownership

Post-v2-arc (R1.0–R1.4), every production writer except PO/QA/ARCH Governors routes through `advancePhase`. The Governor-prompt writers are tracked separately as remaining work (see `[GAP-6]`).

| Governor                                 | Phases Read                | Phases Written                                                                                         | Operation                              | Notes                                                                                                                                          |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| PO                                       | —                          | `draft` (via `dendron_create_note` direct handler — phase set automatically for `backlog.*` filenames) | n/a (create-note handler)              | Chain at `.rks/prompts/governor-po.md`. Includes step 2a verification via `dendron_read_note` (shipped v0.20.14).                              |
| QA                                       | `draft`                    | `ready` (via direct `dendron_update_field`)                                                            | n/a (direct write — `[GAP-6]` remains) | Chain at `.rks/prompts/governor-qa.md`. Adds testRequirements before advancing.                                                                |
| ARCH                                     | `ready`                    | `arch-approved` (via direct `dendron_update_field`)                                                    | n/a (direct write — `[GAP-6]` remains) | Chain at `.rks/prompts/governor-arch.md` step 3.b.                                                                                             |
| `rks_plan`                               | `arch-approved`, `planned` | `executing` (via `advancePhase`)                                                                       | `exec_start` (R1.3e)                   | `runPlanTool` → `persistAndFinalize` routes through `advancePhase('exec_start')`. Hardcoded from-phase eliminated.                             |
| `rks_refine`                             | `executing`, `planned`     | `arch-approved` (via `advancePhase`)                                                                   | `refine` (R1.3e companion)             | `rks_refine` resets phase so the next `rks_plan` enters cleanly.                                                                               |
| `rks_exec`                               | `executing`, `planned`     | `committed` (via `advancePhase`)                                                                       | `exec_end` (R1.3)                      | `runExecTool` routes through `advancePhase`. Legacy `planned` start resolves via `legacyAcceptedOperations.exec`.                              |
| `rks_ship`                               | `committed`, `executed`    | `integrated` (via `advancePhase`)                                                                      | `ship` (R1.3-followup-rks-ship)        | `runStagingMerge` and `runStoryShipTool` migrated off direct `updateField`.                                                                    |
| `rks_cycle_complete`                     | `integrated`               | — (no phase write; moves file to `z_implemented/`, sets `status`)                                      | n/a (R1.3f migration, commit 5776afb0) | Filename prefix is the archival marker; phase stays at `integrated`.                                                                           |
| `rks_release`                            | `integrated`               | `released` (via `advancePhase`)                                                                        | `release` (R1.3-followup-rks-release)  | `transitionIntegratedStories` uses the regex as the discovery mechanism and `advancePhase` as the writer. `releasedStories` populates again.   |
| Off-rail (3-branch, `rks_guardrails_off`) | `arch-approved`            | `executing` (via `advancePhase`)                                                                       | `guardrails_off` (R1.0–R1.2)           | Off-rail session start now advances phase.                                                                                                    |
| Off-rail (3-branch, `rks_guardrails_on`) | `executing`, `committed`   | `committed` then `integrated` (via `advancePhase`)                                                     | `guardrails_on.commit` + `guardrails_on.merge` (R1.0–R1.2) | The 3-branch `guardrailsOn` path now walks the full phase progression. The historical `[GAP-11]` stranding is closed.     |

**Every production phase write except PO/QA/ARCH Governor direct dendron writes now routes through `advancePhase`. `[GAP-12]` is closed for operations; `[GAP-6]` remains scoped to the three Governor prompts.**

## 5. On-Rail vs Off-Rail

Two ship lifecycles coexist:

**On-rail** (Build Governor path): `rks_exec` → `rks_ship` → `rks_cycle_complete`. Writes `phase: executed` → `integrated` → `implemented`. Subject to `[GAP-2]`, `[GAP-8]`, `[GAP-9]`. End state: the story note is moved to `notes/backlog.z_implemented.` with `phase: implemented`.

**Off-rail** (the user's preferred development pattern): `rks_governor_init` (story flow) → `rks_guardrails_off` → direct file edits + `vitest run` → `rks_guardrails_on`. The auto-ship inside `guardrails_on` performs commit → local-merge to integration branch → push, but **does not write story phase at all** for 3-branch projects — `[GAP-11]`. The 2-branch ship path may behave differently and is not audited here.

**The visible consequence**: every story shipped via off-rail in this session (the 9 child-lifecycle stories plus the fixes) is still at `arch-approved` on disk. They never advanced through `planned/executed/integrated/implemented`. The git history says they shipped; the state machine says they didn't. This is exactly the kind of partial truth that allows `releasedStories: []` to look like an isolated bug.

**Vision** for off-rail: when `rks_guardrails_on` auto-ships, it should walk the same phase progression as on-rail — or, if off-rail is to be a distinct lifecycle, the graph and operations should model that explicitly. Either way, "off-rail writes no phase" is not a defensible end state.

## 6. The Single Helper That Should Be Called

`advancePhase` lives at `packages/mcp-rks/src/workflow/auto-phase.mjs:22-89`. Its signature:

```js
export async function advancePhase(projectRoot, problemId, operation, projectId = "unknown")
```

It reads the operation's expected transition from `OPERATION_TRANSITIONS`, loads the current frontmatter via the notes path, calls `validateTransition` with the actual current phase, and writes the new phase via `updateField`. It also emits telemetry. It is the canonical phase-write primitive.

**`[GAP-12]`** — `advancePhase` is currently invoked only by unit tests. Every production phase write (PO, QA, ARCH, rks_plan, rks_exec, rks_ship, rks_cycle_complete, rks_release, off-rail-ship) reinvents its own path via direct `updateField` calls or hardcoded `validateTransition` invocations. The helper exists, is correct, and is bypassed by all callers. This is the structural root of every other phase gap.

**Vision**: every transition runs through `advancePhase`. Governors that currently write phase via direct `dendron_update_field` (PO sets via create-note handler, QA, ARCH) either move to calling `advancePhase` through an MCP tool, or the helper is wired into a phase-advance MCP tool that the Governors call.

## 7. Verification Contract

For each transition the system should guarantee one or more invariants. Mark `[GAP-N]` where the current code does not enforce.

- **`draft → ready`**: after QA returns `ready`, the note on disk has `phase: ready` AND `testRequirements: [...]` (non-empty). Today: the prompt instructs QA to make both writes, but no code enforces the conjunction — `[GAP-13]`.
- **`ready → arch-approved`**: after ARCH returns `approved`, the note has `phase: arch-approved` AND `arch_guidance: {...}` populated. Today: same as above — `[GAP-13]`.
- **`arch-approved → planned`**: after `rks_plan` returns success, the note has `phase: planned` AND a plan file at `.rks/plans/<id>.md` exists. Today: broken — `[GAP-1]` — phase may be `draft` or rejected, while the plan file may have been written regardless.
- **`planned → executed`**: after `rks_exec` returns success with `testsPassed: true`, the note has `phase: executed` AND all changes are committed. Today: enforced indirectly by `rks_exec`'s autoCommit step but not by the phase write.
- **`executed → integrated`**: after `rks_ship` returns success, the integration branch contains the merge commit AND the note has `phase: integrated`. Today: the merge is enforced; the phase write is not gated and is then immediately clobbered by `runCycleComplete` — `[GAP-9]`.
- **`integrated → implemented`**: after `rks_cycle_complete`, the note has `phase: implemented` AND is located at `notes/backlog.z_implemented.<id>.md`. Today: both happen but in a way that destroys `integrated` — `[GAP-2]`, `[GAP-9]`.
- **`implemented → released`**: after `rks_release`, all stories that were `implemented` at the moment of release are now `released` AND the release's `releasedStories` array lists each transitioned storyId. Today: zero stories transition — `[GAP-3]`.

**Cross-cutting invariants**:

- After PO returns, every storyId in the return exists on disk at `phase: draft`. **Shipped v0.20.14** — three-layer defense.
- After any Governor returns success, the story note's `phase` field matches what the Governor's contract says it should be. **Not enforced today** — `[GAP-14]`.
- No two writers race the `phase` field within a single operation. **Not enforced today** — `[GAP-9]`.

## 8. Known Gaps

### [GAP-1] `rks_plan` cannot advance `arch-approved` stories to `planned` — **CLOSED (R1.3e)**

- **Original behavior**: `persistAndFinalize` at `packages/mcp-rks/src/server/planner-persistence.mjs` called `validateTransition({ phase: "ready", ... }, "planned", ...)` with a hardcoded from-phase. The actual story frontmatter was never read. When `planStatus !== "executable"`, the same path downgraded the story to `phase: "draft"`. `OPERATION_TRANSITIONS.plan` declared only `ready → planned`, while `PLANNABLE_PHASES` listed `arch-approved` too — two sources of truth that disagreed.
- **Closure path** (R1.3e): `rks_plan` now routes through `advancePhase('exec_start')`. The operation `exec_start` accepts both `arch-approved` and `planned` as valid from-phases per `PHASE_MACHINE.transitions`. Hardcoded from-phase eliminated; the inline `validateTransition` + `updateField` calls removed. The companion `rks_refine` migration (R1.3e companion) resets phase to `arch-approved` so the cycle re-enters cleanly.
- **Reference**: research.2026.06.10.phase-machine-redesign.md (v1.3); research.2026.06.12.re-plan-workflow-audit.md.
- **Status**: closed.

### [GAP-3] `rks_release` always returns `releasedStories: []` — **CLOSED (R1.3f + R1.3-followup)**

- **Original behavior**: `transitionIntegratedStories` (called from `runRelease` in `packages/mcp-rks/src/server/git/git-release.mjs`) used a regex that matched `phase: "integrated"`. By release time every story had already been overwritten to `phase: "implemented"` by `runCycleComplete`. The regex never matched. Every release through v0.20.14 returned `releasedStories: []`.
- **Closure path** (2026-06-13, design paper `research.2026.06.13.integrated-implemented-released-arc.md` Option A):
  1. **R1.3f** (commit 5776afb0) — `cycle-complete-agent` stopped writing `phase: "implemented"`. The status field still becomes `implemented` and the file still moves to `backlog.z_implemented.*` (the filename prefix is the archival marker), but the phase stays at `integrated`. The release regex started matching stories for the first time in production.
  2. **R1.3-followup-rks-release-migration** — `transitionIntegratedStories` migrated from `updateField('phase', 'released')` to `advancePhase(projectRoot, problemId, 'release', projectId)`. `PHASE_MACHINE.release.from` changed from `["implemented"]` to `["integrated"]` to match. The regex stays as the discovery mechanism; the write routes through the state-machine helper.
- **Reference**: audit paper section 4(b); design paper section 6 (Option A) + section 7 (recommendations).
- **Status**: closed. Future releases will return non-empty `releasedStories` arrays for every shipped story.

### [GAP-6] PO, QA, ARCH, rks_plan, rks_exec all bypass `advancePhase` — **PARTIALLY CLOSED (R1.3, R1.3e); remains OPEN for PO/QA/ARCH Governors**

- **Original behavior**: every production phase writer called either the dendron MCP tool directly or `updateField` inline. `advancePhase` was consumed only by unit tests.
- **Closure path (operations)**:
  - **R1.3e**: `rks_plan` (`persistAndFinalize`) routes through `advancePhase('exec_start')`.
  - **R1.3**: `rks_exec` (`runExecTool`) routes through `advancePhase('exec_end')`. `legacyAcceptedOperations` keeps old `planned`-start notes valid.
  - **R1.3-followup-rks-ship**: `rks_ship` / `runStagingMerge` / `runStoryShipTool` route through `advancePhase('ship')`.
  - **R1.3-followup-rks-release**: `rks_release` / `transitionIntegratedStories` route through `advancePhase('release')`.
  - **R1.0–R1.2**: `rks_guardrails_off` and `rks_guardrails_on` route through `advancePhase` for `guardrails_off`, `guardrails_on.commit`, `guardrails_on.merge`.
- **Still OPEN**: PO Governor (sets phase via `dendron_create_note` direct handler), QA Governor (direct `dendron_update_field` per `.rks/prompts/governor-qa.md`), ARCH Governor (direct `dendron_update_field` per `.rks/prompts/governor-arch.md`). The redesign paper (research.2026.06.10) defers Governor-prompt migration to a later sweep — the prompts are still LLM-authored writes and routing them through `advancePhase` requires a dedicated `phase_advance` MCP tool the prompts can call.
- **Reference**: research.2026.06.10.phase-machine-redesign.md.
- **Status**: partially closed — operations side done; Governor-prompt side **OPEN**.

### [GAP-7] `ready → arch-approved` has no gate — OPEN

- **Current behavior**: ARCH still writes the phase via direct `dendron_update_field`. `GATES` at `packages/mcp-rks/src/workflow/state-machine.mjs` has no entry for this transition. The v1→v2 arc did not touch ARCH-side validation; the edge exists in `PHASE_MACHINE.transitions` (`arch: { from: ready, to: arch-approved }`) but no gate function blocks the transition without `arch_guidance` populated.
- **Vision**: a gate exists checking that the story has `arch_guidance` populated and the verdict is `approved` before the transition is allowed. Pairs with the Governor-side closure of `[GAP-6]`.
- **Reference**: research.2026.05.28.phase-state-machine-audit.md, section 3.
- **Status**: open. Tracked alongside the Governor-prompt migration in `[GAP-6]`.

### [GAP-8] `ship`, `cycle_complete`, and `release` operations have no gates — **PARTIALLY CLOSED (R1.3, R1.3-followup); content gates remain OPEN**

- **Original behavior**: `state-machine.mjs` defined gates only for `draft → ready`, `ready → planned`, `planned → executed`. The downstream operations transitioned without any validation.
- **Closure path (from-phase validation)**: every downstream operation now routes through `advancePhase`, which validates the from-phase against `PHASE_MACHINE.transitions`. `ship` accepts `{committed, executed}`, `release` accepts `{integrated}`, `cycle_complete` is no longer a phase-writing operation (R1.3f). The "transition without validation" structural hole is closed.
- **Still OPEN**: content gates (e.g., "ship requires passing integration build", "release requires CI green on integration branch") are not implemented. The from-phase check tells you the story is in a state where the operation is structurally valid; it does not enforce business preconditions.
- **Reference**: research.2026.05.28.phase-state-machine-audit.md sections 1, 4(b); research.2026.06.13.integrated-implemented-released-arc.md.
- **Status**: partially closed — structural from-phase validation done; semantic/content gates **OPEN**.

### [GAP-9] Writer race: `runStagingMerge` writes `integrated`, `runCycleComplete` immediately overwrites with `implemented` — **CLOSED (R1.3f)**

- **Original behavior**: in `packages/mcp-rks/src/server/git-tools.mjs`, the ship sequence called `runStagingMerge` (which wrote `integrated`) and then `runCycleComplete` (which wrote `implemented` and moved the file). The writes happened back-to-back within the same operation. The `integrated` phase existed for a few milliseconds at most before being clobbered.
- **Closure path** (R1.3f, commit 5776afb0): `runCycleComplete` no longer writes the `phase` field. It still sets `status: implemented` and moves the file to `backlog.z_implemented.*`, but the phase stays at `integrated` (the value `runStagingMerge`/`advancePhase('ship')` wrote). With only one writer per transition the race is structurally eliminated.
- **Reference**: research.2026.06.13.integrated-implemented-released-arc.md (Option A — drop the `implemented` phase entirely).
- **Status**: closed.

### [GAP-10] Reverse edges have no operation triggers — **PARTIALLY CLOSED (R1.3e companion); other reverse paths remain OPEN**

- **Original behavior**: `ready → draft`, `arch-approved → ready`, `planned → ready`, `executed → ready` existed in `TRANSITION_GRAPH` but no `OPERATION_TRANSITIONS` entry produced them and no `GATES` entry validated them. Manual `dendron_update_field` was the only path.
- **Closure path (refine)**: R1.3e companion added the `refine` operation: `rks_refine` advances `{executing, planned, executed} → arch-approved` via `advancePhase('refine')`. This wires the most-trafficked recovery path (post-build refinement) into the operations layer.
- **Still OPEN**: `ready → draft`, `arch-approved → ready`, `planned → ready`, `executed → ready` remain reverse edges in the graph with no operation trigger. The redesign paper does not propose dedicated operations for these — they are intentionally manual today.
- **Reference**: research.2026.06.12.re-plan-workflow-audit.md; research.2026.06.10.phase-machine-redesign.md.
- **Status**: partially closed — refine wired; remaining reverse paths documented as manual-recovery-only, no operations planned.

### [GAP-11] Off-rail 3-branch `rks_guardrails_on` does not write story phase — **CLOSED (R1.0–R1.2)**

- **Original behavior**: `guardrailsOn` in `packages/mcp-rks/src/server/guardrails-audit.mjs` for 3-branch projects performed commit, local-merge to integration branch, and push without calling `advancePhase` or writing the story note's `phase` field. Off-rail-shipped stories never advanced past `arch-approved` on disk.
- **Closure path** (R1.0–R1.2):
  - `rks_guardrails_off` calls `advancePhase('guardrails_off')` on session start: `arch-approved → executing`.
  - `rks_guardrails_on` walks two operations: `advancePhase('guardrails_on.commit')` (`executing → committed`) then `advancePhase('guardrails_on.merge')` (`committed → integrated`).
  - The 3-branch off-rail ship now produces the same end-state phase as the on-rail ship: `integrated`.
- **Reference**: research.2026.06.10.phase-machine-redesign.md (off-rail integration); research.2026.05.28.phase-state-machine-audit.md section 4(c).
- **Status**: closed.

### [GAP-12] Production writers still bypass `advancePhase` — **CLOSED for operations (R1.3, R1.3e, R1.3-followup); remains OPEN for Governor prompts**

- **Original behavior**: `advancePhase` at `packages/mcp-rks/src/workflow/auto-phase.mjs` was correctly implemented but consumed only by unit tests. Production writers (`runPlanTool`, `runExecTool`, `runStagingMerge`, `runCycleComplete`, `transitionIntegratedStories`, off-rail `guardrails_on`, PO/QA/ARCH Governors) all reinvented the call pattern.
- **Closure path (operations)**: every operation-layer writer now routes through `advancePhase`. The complete migration list:
  - `rks_plan` → `advancePhase('exec_start')` (R1.3e)
  - `rks_exec` → `advancePhase('exec_end')` (R1.3)
  - `rks_refine` → `advancePhase('refine')` (R1.3e companion)
  - `rks_ship` / `runStagingMerge` / `runStoryShipTool` → `advancePhase('ship')` (R1.3-followup-rks-ship)
  - `rks_release` / `transitionIntegratedStories` → `advancePhase('release')` (R1.3-followup-rks-release)
  - `rks_guardrails_off` → `advancePhase('guardrails_off')` (R1.0–R1.2)
  - `rks_guardrails_on` → `advancePhase('guardrails_on.commit' | 'guardrails_on.merge')` (R1.0–R1.2)
  - `rks_cycle_complete` → no longer writes phase (R1.3f)
- **Still OPEN**: PO/QA/ARCH Governor prompts continue to use `dendron_create_note` / direct `dendron_update_field`. Closing requires a `phase_advance` MCP tool the Governor LLM can invoke. This is tracked alongside `[GAP-6]`.
- **Reference**: research.2026.06.10.phase-machine-redesign.md.
- **Status**: closed for operations; **OPEN** for the three remaining Governor prompts.

### [GAP-13] No code enforces the conjunction of phase-write and the data that justifies the phase — OPEN

- **Current behavior**: QA writes `phase: ready` and `testRequirements: [...]` as two independent `dendron_update_field` calls. If one succeeds and the other fails, the system is in an inconsistent state. Same shape for ARCH and `arch_guidance`. The v1→v2 arc did not touch this — operation-layer atomicity moved through `advancePhase`, but the Governor-prompt-level writes still happen in two steps.
- **Vision**: phase transitions are atomic with the data that justifies them. Either both the phase write and the data write succeed, or neither does.
- **Reference**: research.2026.05.28.phase-state-machine-audit.md section 7.
- **Status**: open. Blocks alongside the Governor-prompt migration in `[GAP-6]` / `[GAP-12]`.

### [GAP-14] No invariant check that the post-Governor phase matches the contract — OPEN

- **Current behavior**: when PO Governor returns success, the Dispatcher proceeds to `/qa`. If PO claimed success but the note isn't at `phase: draft` (e.g., because of the phantom-story bug `[GAP-stale]` already shipped in v0.20.14), nothing catches it. Same for every Governor return.
- **Vision**: each Governor return contract declares the expected phase. A verification layer (in the Dispatcher or in the Governor's chain) confirms the actual phase on disk matches the contract before the next step proceeds.
- **Reference**: audit paper, section 7.
- **Suggested fix**: structural — codify Governor return contracts and run automatic post-condition checks.

## 9. Operational Invariants

These are the invariants the machine should preserve. Marked `[GAP-N]` where not enforced today.

1. Every node in `VALID_PHASES` has at least one incoming and one outgoing edge in `TRANSITION_GRAPH`, unless explicitly declared as start (`draft`) or terminal (`released`). **Today**: enforced by the phase-machine-integrity test suite (Story 1).
2. Every edge in `TRANSITION_GRAPH` has either an `OPERATION_TRANSITIONS` entry that produces it or a documented manual-only annotation. **Today**: violated by reverse edges — `[GAP-10]`.
3. Every edge in `TRANSITION_GRAPH` has a corresponding `GATES` entry, or is explicitly declared as gateless. **Today**: violated by `executed → integrated`, `integrated → implemented`, `implemented → released` — `[GAP-8]`.
4. No production phase write bypasses `advancePhase`. **Today**: violated by every production writer — `[GAP-6]`.
5. No two writes to the `phase` field race within a single operation. **Today**: violated by `runStagingMerge` + `runCycleComplete` — `[GAP-9]`.
6. After any Governor or operation returns success, the on-disk `phase` field matches the contract. **Today**: not enforced — `[GAP-14]`.
7. Phase transitions are atomic with the data that justifies them (e.g., `ready` with `testRequirements`, `arch-approved` with `arch_guidance`). **Today**: not enforced — `[GAP-13]`.
8. Off-rail and on-rail ship lifecycles either follow the same phase progression or have explicit, documented divergence. **Today**: off-rail writes no phase; the divergence is undocumented — `[GAP-11]`.

## 10. How to Update This Document

When a story closes a gap, edit out the relevant `[GAP-N]` annotations and update the surrounding prose to describe the new reality. Renumber if needed for clarity, but stable IDs (e.g. keeping `[GAP-3]` retired in a footnote) help cross-referencing from older artifacts.

When new behavior is added that diverges from canon — for any reason, including intentional design changes — add a new `[GAP-N]` and a corresponding section 8 entry. The annotation is the contract that says "this divergence is known, here's where the diagnosis lives, here's the Vision."

Pull requests that touch any of:

- `packages/mcp-rks/src/workflow/phases.mjs`
- `packages/mcp-rks/src/workflow/state-machine.mjs`
- `packages/mcp-rks/src/workflow/auto-phase.mjs`
- any code path that writes the `phase` frontmatter field
- any Governor prompt under `.rks/prompts/governor-*.md`

must include a canon update — either resolving a gap or adding a new one. CI should fail PRs that change the phase machine without touching canon.
