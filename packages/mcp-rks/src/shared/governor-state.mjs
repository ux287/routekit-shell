/**
 * Governor State Machine — Phase 2 + Phase 3
 *
 * Enforces sequencing of tool calls within a Governor session.
 * Each state defines which tools are allowed and what the next state
 * should be after a successful tool call.
 *
 * Four flow types:
 *   - 'story': refine → plan → exec → ship chain
 *   - 'open':  research → notes chain
 *   - 'qa':    research → test → assess → report chain
 *   - 'ship':  commit → PR → merge → cycle_complete chain
 *
 * Phase 3 adds decompose tracking:
 *   - 'decomposing' state after refine_apply returns decomposed: true
 *   - 'child_active' state when processing child stories in order
 *   - Child sub-state tracking (each child has its own refine → plan → exec cycle)
 */

// ── State definitions ───────────────────────────────────────────────

/**
 * Story flow state machine.
 *
 * States and their allowed tools + transitions:
 *   init         → refining       (on rks_refine or rks_agent_research)
 *   refining     → refining       (on rks_refine, rks_refine_apply, rks_agent_research — iteration loop)
 *   refining     → planning       (on rks_plan)
 *   refining     → decomposing    (on refine_apply.decomposed result)
 *   planning     → planned        (on rks_plan success)
 *   planned      → executing      (on rks_exec)
 *   executing    → executed       (on rks_exec success)
 *   executing    → test-failed    (on rks_exec failure — tests failed)
 *   test-failed  → refining       (on rks_refine — diagnose and fix)
 *   executed     → shipping       (on rks_ship — if not autoShip)
 *   shipping     → shipped        (on rks_ship success)
 *   decomposing  → child_active   (on starting first child — rks_refine for child)
 *   child_active → child_active   (refine/plan/exec cycle for current child)
 *   child_active → shipped        (all children completed successfully)
 *   *            → failed         (on any error — terminal)
 */
const STORY_STATES = {
  init: {
    allowed: new Set([
      'rks_refine',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_agent_dendron',
      'rks_project_get',
      'rks_preflight',
      'rks_analyze',
      'rks_exhaustive_search',
      // Hook chain misconfig fix: wherever the rks_agent_dendron wrapper is
      // allowed, the underlying dendron tools must also be allowed — the
      // wrapper internally invokes the same calls, so denying them at the
      // chain level while permitting the wrapper is a contradiction users
      // hit cold (3 separate workarounds during the v1→v2 phase machine arc).
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
    ]),
    transitions: {
      rks_refine: 'refining',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
    },
  },
  refining: {
    allowed: new Set([
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_plan',
      'rks_plan_ready',
      'rks_preflight',
      'rks_analyze',
      'rks_project_get',
      // Dendron tools for decompose path
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      // backlog.fix.governor-phase-state-desync-and-recovery
      //
      // rks_exec_abort is THE registered recovery for a story stranded at phase `executing`
      // — exec.mjs says so verbatim in its own error text. But its allowlist membership was
      // confined to the exec-side states, so from `refining` it was blocked too. In the
      // observed wedge that meant all three exits were shut at once: rks_exec blocked by
      // state, rks_plan blocked by phase, rks_exec_abort blocked by state. The registered
      // recovery existing but being unreachable is worse than no recovery at all, because
      // the error text names a tool the caller is then refused.
      'rks_exec_abort',
    ]),
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
      // Must have a transition, not just admission. The liveness invariant is satisfied
      // per-STATE (and `refining` is already live via rks_refine), so admitting a tool with
      // no way out would leave the suite green while the escape hatch dead-ends.
      rks_exec_abort: 'failed',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
      rks_plan: 'planning',
    },
    resultTransitions: {
      'refine_apply.decomposed': 'decomposing',
      'refine.decompose_suggested': 'decompose-gated',
      // backlog.fix.build-governor-self-heal: refine changed NOTHING. Re-planning a byte-identical
      // story cannot produce a different outcome, so the loop must not be allowed to continue.
      //
      // backlog.fix.refine-noop-escalation-false-positive: escalating on the FIRST no-op was too
      // eager. Three separate mechanisms produced no-ops that were never real — a stripped payload,
      // a silently-dropped refinement, and a detector that disagreed with its own applier — and each
      // one terminated a healthy build. A first no-op now SELF-LOOPS back to `refining`, which keeps
      // rks_refine / rks_refine_apply / rks_plan reachable so the Governor can act on the (now
      // populated) `escalation.skipped` ledger. The anti-loop guarantee is preserved by
      // `refine_apply.noop_repeated` below, which `advanceStateOnResult` substitutes once the
      // consecutive-no-op counter trips.
      'refine_apply.noop': 'refining',
      // backlog.fix.refine-inapplicable-status: a refinement that could never have
      // been applied is not evidence about the story, so it self-loops WITHOUT
      // touching the consecutive-no-op streak. The key must exist here, not merely
      // be absent: an unmapped key also returns currentState, so absence and a
      // mapped self-loop are observationally identical through transitionOnResult.
      'refine_apply.inapplicable': 'refining',
      'refine_apply.noop_repeated': 'escalated',
      // backlog.fix.planning-state-deadlock-no-exit: plan results must be honoured HERE too.
      //
      // That story gives `planning` an escape hatch to `refining` via rks_refine/rks_refine_apply.
      // If that hatch is taken while a plan worker is genuinely in flight, the worker's result
      // arrives while the session sits in `refining` — and `transitionOnResult` returns the
      // CURRENT state on a missing key, so without these two entries the result is silently
      // discarded and the session strands in `refining`, where rks_exec is not permitted. Not a
      // deadlock, but a lost plan and a wasted re-plan.
      //
      // Purely additive: these mirror `planning`'s own resultTransitions and widen no allowed Set.
      'plan.ok': 'planned',
      'plan.failed': 'refining',
    },
  },
  'decompose-gated': {
    // Child story has decompose signals. Human must choose: decompose further or proceed.
    // rks_refine_apply → user chose to decompose (transitions to decomposing on result)
    // rks_plan → user chose to skip gate and proceed without decomposing
    allowed: new Set([
      'rks_refine_apply',
      'rks_plan',
      'rks_project_get',
    ]),
    transitions: {
      rks_plan: 'planning',
      rks_refine_apply: 'refining',
    },
    resultTransitions: {
      'refine_apply.decomposed': 'decomposing',
    },
  },
  planning: {
    // backlog.fix.planning-state-deadlock-no-exit: this state was a STRUCTURAL DEADLOCK.
    //
    // It held exactly three tools and `transitions: {}` — so no tool call moved you out, and the
    // only exits were the resultTransitions below, which fire on a plan RESULT. When `rks_plan`
    // returns `not_ready` from its pre-spawn readiness gate, no worker is spawned, so no result
    // ever arrives and neither exit can fire. The session is parked.
    //
    // What made it a deadlock rather than a pause: the sanctioned remedy for the failure that put
    // you here is adding @@SEARCH anchors, and NONE of the tools that can do that were reachable —
    // not rks_refine / rks_refine_apply (the remedy), not rks_exhaustive_search (to find verbatim
    // anchor text), not the dendron pair (to hand-author one). The cure was unreachable from the
    // disease. Observed live; the session escaped only by accident, via an undocumented
    // side-effect transition in rks_plan_review.
    allowed: new Set([
      'rks_plan_review',
      'rks_agent_git',
      'rks_project_get',
      // The recovery pair. Deliberately minimal: both EXIT to `refining` via `transitions` below,
      // so `planning` stays genuinely transient rather than becoming a general-purpose state. One
      // hop restores the full toolkit — `refining` already permits rks_exhaustive_search,
      // rks_plan_ready and all four dendron_* tools.
      'rks_refine',
      'rks_refine_apply',
    ]),
    // Paired with the allowlist above. A tool permitted with no transition entry is half-wired:
    // callable, but it never moves the state, which is a different way to stay stuck.
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
    },
    resultTransitions: {
      'plan.ok': 'planned',
      'plan.failed': 'refining',
    },
  },
  planned: {
    allowed: new Set([
      'rks_exec',
      'rks_plan_review',
      'rks_agent_git',
      'rks_project_get',
      // Recovery tools — needed when exec rolls back to planned (exec.no_actions/exec.error)
      'rks_refine',
      'rks_plan',
      'rks_agent_research',
      'rks_agent_external_research',
      // backlog.fix.planned-state-readonly-regression-and-search-admission
      //
      // Admitted so a plan can be VERIFIED before it executes. Previously the only state
      // allowing rks_exhaustive_search was `refining`, and the only route from `refining`
      // back to `planned` is a re-plan — which produces a DIFFERENT plan hash. So the plan
      // that actually landed could never be the plan that was inspected: byte-level checking
      // of the executing plan was structurally impossible, not merely awkward.
      //
      // Deliberately NOT given a transitions entry below. getNextState returns
      // `transitions?.[tool] || currentState`, so an allowed tool with no mapping self-loops
      // — which is exactly the read-only semantics wanted here. `child_active` is the
      // standing precedent: it already holds rks_exhaustive_search and rks_exec in one
      // allowed set and self-loops its research tool rather than demoting it.
      'rks_exhaustive_search',
    ]),
    transitions: {
      rks_exec: 'executing',
      // rks_refine DOES demote — it mutates the story, so the plan is genuinely stale after it.
      rks_refine: 'refining',
      // rks_agent_research and rks_agent_external_research deliberately have NO entry here.
      //
      // They are READ-ONLY. Demoting on them was a live plan-destroying footgun: reading
      // anything from `planned` silently regressed the chain to `refining`, where rks_exec is
      // forbidden, while the story phase had independently advanced to `executing`, which
      // rks_plan rejects. Both escape routes closed at once and recovery needed a manual
      // phase reset plus a full re-walk. Reproduced across two runs on released 0.42.0.
      //
      // Both lines are removed together on purpose. They sit in the same block and demote
      // identically; fixing only the one named in the field report would leave the identical
      // defect live behind the other tool.
      rks_plan: 'planning',
    },
  },
  executing: {
    allowed: new Set([
      'rks_exec_abort',
      'rks_agent_git',
      'rks_project_get',
      'rks_exec',    // Allow retry from executing state
    ]),
    transitions: {
      rks_exec_abort: 'failed',
    },
    resultTransitions: {
      'exec.ok': 'executed',
      'exec.failed': 'test-failed',   // Route to test-failed state — allows refine-retry loop
      'exec.diverged': 'diverged',    // Execution diverged from plan — recover via refine
      'exec.needs_approval': 'approval-pending',  // Guardrail-critical files need user approval
      'exec.no_actions': 'planned',   // Pre-exec gate rejected plan (note steps only) — nothing touched, revert to planned
      'exec.error': 'planned',        // Unexpected throw before any files touched — revert to planned
    },
  },
  'approval-pending': {
    // Exec encountered guardrail-critical files (governor-token.mjs, guardrails-audit.mjs).
    // Wait for approval before re-executing.
    // Transitions: approval-pending → (approve.ok) → executing → re-exec
    allowed: new Set([
      'rks_approve',
      'rks_agent_git',
      'rks_project_get',
    ]),
    transitions: {
      rks_approve: 'approval-pending',  // Stay until result arrives
    },
    resultTransitions: {
      'approve.ok': 'executing',
      'approve.denied': 'failed',
    },
  },
  diverged: {
    // Execution diverged from plan at a step. Allow refine to diagnose and replan.
    // Transitions: diverged → (rks_refine) → refining → planning → planned → executing
    allowed: new Set([
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
    ]),
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
    },
  },
  'test-failed': {
    // Tests failed after exec. Allow refine to diagnose and fix before re-planning.
    // Transitions: test-failed → (rks_refine) → refining → planning → planned → executing
    //
    // backlog.fix.exec-rollback-strands-executing-phase: `rks_exec_abort` is the only registered
    // tool that can un-strand a story left at phase `executing`, and it was reachable from
    // `executing` but NOT from `test-failed` — the state an exec failure actually lands in. It is
    // allowed here in PAIR with a transition (mirroring `executing`, which pairs them correctly):
    // adding it to `allowed` without a `transitions` entry would permit the tool but never move the
    // state, which is a half-wired permission and its own kind of wedge.
    //
    // Largely defensive now that exec resets the phase on every failing exit — abort's stranded-scan
    // leg will find nothing to reset — but it still covers the run-record cleanup leg, and it closes
    // a real hole in the state machine rather than leaving it to be rediscovered.
    allowed: new Set([
      'rks_refine',
      'rks_refine_apply',
      'rks_exec_abort',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
    ]),
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
      rks_exec_abort: 'failed',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
    },
  },
  executed: {
    // READ-ONLY VERIFICATION. A Governor that has just written files must be able to read
    // them back; without these it had no route at all — rks_exhaustive_search and
    // dendron_read_note were state-blocked, Read/Grep were hook-blocked on "no provenance",
    // and rks_agent_git truncates. Both are read-only and neither gets a transitions entry,
    // so no write path opens and the state still advances only via ship.
    allowed: new Set([
      'rks_ship',
      'rks_story_ship',
      'rks_agent_git',
      'rks_project_get',
      'rks_exhaustive_search',
      'dendron_read_note',
    ]),
    transitions: {
      rks_ship: 'shipping',
      rks_story_ship: 'shipping',
    },
  },
  shipping: {
    allowed: new Set([
      'rks_agent_git',
      'rks_project_get',
    ]),
    resultTransitions: {
      'ship.ok': 'shipped',
      'ship.failed': 'executed',
    },
  },
  // Phase 3: Decompose states
  decomposing: {
    // Parent has been decomposed, children queued. Governor should start first child.
    allowed: new Set([
      'rks_refine',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      'dendron_read_note',
    ]),
    transitions: {
      rks_refine: 'child_active',
      rks_agent_research: 'child_active',
      rks_agent_external_research: 'child_active',
    },
  },
  child_active: {
    // A child story is being processed through refine → plan → exec.
    // All chain tools are allowed — the child sub-state tracks sequencing.
    allowed: new Set([
      'rks_refine',
      'rks_refine_apply',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_plan',
      'rks_plan_ready',
      'rks_plan_review',
      'rks_exec',
      'rks_exec_abort',
      'rks_ship',
      'rks_preflight',
      'rks_analyze',
      'rks_project_get',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
    ]),
    transitions: {
      // Child_active stays in child_active — sub-state handles sequencing.
      // Transitions to 'shipped' or next child happen via result transitions.
      rks_refine: 'child_active',
      rks_refine_apply: 'child_active',
      rks_agent_research: 'child_active',
      rks_agent_external_research: 'child_active',
      rks_plan: 'child_active',
      rks_exec: 'child_active',
      rks_ship: 'child_active',
    },
    resultTransitions: {
      'child.complete': 'child_active',   // Next child (or shipped if last)
      'child.failed': 'failed',           // Child failure = parent failure
      'exec.ok': 'child_active',
      'exec.failed': 'failed',
      'plan.ok': 'child_active',
      'plan.failed': 'child_active',      // Can retry child planning
      'ship.ok': 'child_active',
      'ship.failed': 'child_active',
      // backlog.fix.build-governor-self-heal: children need this too. `child_active` permits
      // rks_plan (above), so without this a decomposed child whose refine no-ops re-plans an
      // unchanged story forever — the same loop, one level down.
      //
      // backlog.fix.refine-noop-escalation-false-positive: same change as `refining`, and it must
      // be made here too — fixing only the parent leaves a decomposed child dying on the same
      // false no-op one level down. First no-op self-loops; the repeat key still escalates.
      'refine_apply.noop': 'child_active',
      // Same as `refining` above — a decomposed child must not die on an
      // unactionable refinement any more than its parent.
      'refine_apply.inapplicable': 'child_active',
      'refine_apply.noop_repeated': 'escalated',
    },
  },
  shipped: {
    allowed: new Set([
      'rks_project_get',
    ]),
    transitions: {},
  },
  /**
   * backlog.fix.build-governor-self-heal: refine_apply changed NOTHING, so retrying is pointless.
   *
   * This state exists to STOP a loop that could not otherwise stop. The Build Governor arrives here
   * when a refinement was applied and the story came out byte-identical — meaning a re-plan would
   * regenerate the same plan and hit the same failure, forever. `rks_refine`, `rks_refine_apply`,
   * `rks_plan` and `rks_exec` are all deliberately NOT permitted: every one of them is a way back
   * into the loop.
   *
   * NOT terminal. The Governor can still research and read, so it can explain WHY it is stuck, then
   * abort and hand back to a human. `rks_exec_abort` is paired with a transition (→ failed): a tool
   * in `allowed` with no `transitions` entry is permitted but never moves the state — a half-wired
   * permission, and a wedge of its own.
   */
  escalated: {
    allowed: new Set([
      'rks_exec_abort',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_agent_git',
      'rks_project_get',
      'dendron_read_note',
    ]),
    transitions: {
      rks_exec_abort: 'failed',
    },
    resultTransitions: {},
  },
  failed: {
    allowed: new Set([
      'rks_project_get',
    ]),
    transitions: {},
  },
};

    /**
     * QA flow state machine.
     *
     * States and their allowed tools + transitions:
     *   init         → researching     (on rks_agent_research)
     *   researching  → qa_testing      (research complete, start test execution)
     *   qa_testing   → qa_assessing    (tests executed, assess results)
     *   qa_assessing → qa_reporting    (results analyzed, generate report)
     *   qa_reporting → shipped         (all QA passed, ready for Ship)
     *   *            → failed          (on test failure or assessment failure — terminal)
     */
    const QA_STATES = {
      init: {
        allowed: new Set([
          'rks_governor_init',
          'rks_agent_research',
          'rks_agent_external_research',
          'rks_agent_git',
          'rks_project_get',
          'rks_preflight',
          'dendron_read_note',
          'dendron_update_field',
        ]),
        transitions: {
          rks_agent_research: 'researching',
          rks_agent_external_research: 'researching',
        },
      },
      researching: {
        allowed: new Set([
          'rks_agent_research',
          'rks_agent_external_research',
          'rks_agent_git',
          'rks_agent_run',
          'rks_exhaustive_search',
          'dendron_create_note',
          'dendron_edit_note',
          'dendron_read_note',
          'dendron_update_field',
          'rks_project_get',
        ]),
        transitions: {
          rks_agent_research: 'researching',
          rks_agent_external_research: 'researching',
          rks_agent_run: 'qa_testing',
        },
        resultTransitions: {
          'research.complete': 'qa_testing',
        },
      },
      qa_testing: {
        allowed: new Set([
          'rks_agent_git',
          'rks_agent_run',
          'rks_project_get',
          'dendron_read_note',
        ]),
        transitions: {
          rks_agent_run: 'qa_testing',
        },
        resultTransitions: {
          'qa.tests_complete': 'qa_assessing',
          'qa.tests_failed': 'failed',
        },
      },
      qa_assessing: {
        allowed: new Set([
          'dendron_create_note',
          'dendron_edit_note',
          'dendron_update_field',
          'rks_project_get',
        ]),
        transitions: {},
        resultTransitions: {
          'qa.assessment_pass': 'qa_reporting',
          'qa.assessment_fail': 'failed',
        },
      },
      qa_reporting: {
        allowed: new Set([
          'dendron_create_note',
          'dendron_edit_note',
          'dendron_update_field',
          'rks_project_get',
        ]),
        transitions: {},
        resultTransitions: {
          'qa.report_complete': 'shipped',
          'qa.report_failed': 'failed',
        },
      },
      shipped: {
        allowed: new Set([
          'rks_project_get',
        ]),
        transitions: {},
      },
      failed: {
        allowed: new Set([
          'rks_project_get',
        ]),
        transitions: {},
      },
    };

    /**
     * Open (notes) flow state machine.
     */
    const OPEN_STATES = {
  init: {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
      // rks_fetch_raw: research-governor toolbox member, mirrors external_research
      // across all open-flow states (parity). PROTECTED — needs this per-state entry.
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_recovery',
      'rks_agent_git',
      'rks_agent_dendron',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      // Hook chain misconfig fix: dendron_update_field was the lone underlying
      // dendron tool missing here even though the wrapper is allowed. Worked
      // around 3x during the v1→v2 arc by routing through rks_agent_dendron.
      'dendron_update_field',
      'rks_arch_verdict',
      'rks_project_get',
      'rks_preflight',
    ]),
    transitions: {
      rks_agent_research: 'researching',
      rks_agent_external_research: 'researching',
      dendron_create_note: 'writing',
      dendron_edit_note: 'writing',
    },
  },
  researching: {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // backlog.fix.open-flow-research-note-creation: governor-research.md step 2
      // MANDATES dendron_create_note, but this state denied it, so the documented
      // research chain was not executable without an rks_governor_init re-init.
      //
      // The open flow is ONE table serving TWO prompts. governor-po.md:39 also inits
      // open, and for the PO chain this denial IS the gate that forces concern
      // separation and the test-file scan. So the state check may not adjudicate
      // alone: the namespace discriminator in governor-token.mjs assertToolAllowed
      // rejects `backlog.*` here while permitting design.*/research.*/notes.*.
      // checkStateAllowed() receives only three strings and cannot see tool args,
      // which is why the discriminator cannot live in this file.
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'rks_arch_verdict',
      'rks_project_get',
    ]),
    transitions: {
      rks_agent_research: 'concern-separating',
      rks_agent_external_research: 'researching',
      // SELF-LOOP, deliberately NOT 'writing'. writing.allowed already carries
      // dendron_create_note and NAMESPACE_ALLOWLIST maps open -> null, so the
      // namespace guard is SKIPPED at writing. Advancing there would open a
      // two-step laundering path: research.* create -> writing -> backlog.* create,
      // sailing past both PO gates. Self-looping keeps every subsequent create
      // under the same discriminator.
      dendron_create_note: 'researching',
    },
  },
  'concern-separating': {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // Same rationale as researching above. dendron_edit_note and
      // dendron_update_field are restored to match researching: without them the
      // follow-up frontmatter write on a freshly created paper was equally
      // unreachable from this state.
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'rks_arch_verdict',
      'rks_project_get',
    ]),
    transitions: {
      rks_agent_research: 'test-file-scanning',
      rks_agent_external_research: 'concern-separating',
      // SELF-LOOP — see the researching rationale above.
      dendron_create_note: 'concern-separating',
    },
  },
  'test-file-scanning': {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      // Hook chain misconfig fix: previously denied both the wrapper and the
      // underlying dendron tools, leaving POs stranded when their step-1d
      // research transitioned them into this state (observed during the canon
      // sweep PO attempt). Symmetry rule: wrapper + all 4 underlying allowed.
      'rks_agent_dendron',
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'rks_arch_verdict',
      'rks_project_get',
    ]),
    transitions: {
      rks_agent_research: 'writing',
      rks_agent_external_research: 'test-file-scanning',
    },
  },
  writing: {
    allowed: new Set([
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'rks_arch_verdict',
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_fetch_raw',
      'rks_exhaustive_search',
      'rks_agent_git',
      'rks_project_get',
    ]),
    transitions: {
      dendron_create_note: 'writing',
      dendron_edit_note: 'writing',
      dendron_read_note: 'writing',
      dendron_update_field: 'writing',
      rks_agent_research: 'writing',
      rks_agent_external_research: 'writing',
    },
  },
  review: {
    allowed: new Set([
      'rks_project_get',
    ]),
    transitions: {},
  },
  failed: {
    allowed: new Set([
      'rks_project_get',
    ]),
    transitions: {},
  },
};

    /**
     * Ship flow state machine.
     *
     * States and their allowed tools + transitions:
     *   init        → committed     (on git_commit.ok)
     *   committed   → pr_created    (on staging_pr.ok)
     *   pr_created  → merging       (on git_merge.ok)
     *   merging     → shipped       (on cycle_complete.ok)
     *   *           → failed        (on any error — terminal)
     */
    const SHIP_STATES = {
      init: {
        allowed: new Set([
          'rks_git_commit',
          'rks_agent_git',
          'rks_project_get',
        ]),
        transitions: {
          rks_git_commit: 'init',  // Stay in init until result arrives
        },
        resultTransitions: {
          'git_commit.ok': 'committed',
          'git_commit.error': 'failed',
        },
      },
      committed: {
        allowed: new Set([
          'rks_git_push',
          'rks_staging_pr',
          'rks_agent_git',
          'rks_project_get',
        ]),
        transitions: {
          rks_git_push: 'committed',  // Stay in committed until result
          rks_staging_pr: 'committed',
        },
        resultTransitions: {
          'git_push.ok': 'committed',  // Push succeeded, stay in committed for PR
          'git_push.error': 'failed',
          'staging_pr.ok': 'pr_created',
          'staging_pr.error': 'failed',
        },
      },
      pr_created: {
        allowed: new Set([
          'rks_git_merge',
          'rks_agent_git',
          'rks_project_get',
        ]),
        transitions: {
          rks_git_merge: 'pr_created',
        },
        resultTransitions: {
          'git_merge.ok': 'merging',
          'git_merge.error': 'failed',
        },
      },
      merging: {
        allowed: new Set([
          'rks_cycle_complete',
          'rks_agent_git',
          'rks_project_get',
        ]),
        transitions: {
          rks_cycle_complete: 'merging',
        },
        resultTransitions: {
          'cycle_complete.ok': 'shipped',
          'cycle_complete.error': 'failed',
          // Ad-hoc/research paths skip cycle_complete — allow direct ship
          'ship.ok': 'shipped',
        },
      },
      shipped: {
        allowed: new Set([
          'rks_project_get',
        ]),
        transitions: {},
      },
      failed: {
        allowed: new Set([
          'rks_project_get',
        ]),
        transitions: {},
      },
    };

    // ── QA Governor tool allowlist ────────────────────────────────────

        /**
         * Tools allowed in QA flow. Excludes Build phase (rks_refine, rks_plan, rks_exec)
         * and Ship phase (rks_ship, rks_story_ship) tools.
         */
        const QA_FLOW_TOOLS = new Set([
          'rks_governor_init',
          'rks_agent_research',
          'rks_agent_external_research',
          'rks_exhaustive_search',
          'rks_agent_git',
          'rks_agent_run',
          'rks_project_get',
          'rks_preflight',
          'dendron_create_note',
          'dendron_edit_note',
          'dendron_read_note',
          'dendron_update_field',
        ]);
    
        /**
         * Tools allowed in Ship flow. Excludes Build phase (rks_refine, rks_plan, rks_exec)
         * and ensures rks_ship is only callable from Ship, not from Build/QA.
         * Ships committed changes via git commit → PR → merge → cycle_complete.
         */
        const SHIP_FLOW_TOOLS = new Set([
          'rks_governor_init',
          'rks_git_commit',
          'rks_git_push',
          'rks_staging_pr',
          'rks_git_merge',
          'rks_cycle_complete',
          'rks_agent_git',
          'rks_project_get',
        ]);

    // ── Common tools (bypass state checks) ──────────────────────────────
    
    const STATE_BYPASS_TOOLS = new Set([
      'rks_governor_init',
      'rks_guardrails_on',
      // rks_guardrails_off intentionally NOT here — Governors must not disable guardrails.
      // It is also excluded from COMMON_TOOLS. The state machine blocks it in every state.
      'rks_guardrails_status',
      // rks_stash mutates the working tree, unlike the three above. It is admitted here rather
      // than to COMMON_TOOLS deliberately: STATE_BYPASS_TOOLS is consulted inside
      // checkStateAllowed, which checkAllowedTool reaches only AFTER its session lookup has
      // refused a token with no live session. Session presence is therefore a structural
      // precondition of admission, which is what guarantees setPendingStash's
      // governorSessions.get(token) hits and the endSession auto-pop can fire. COMMON_TOOLS
      // returns before that lookup and would make the guarantee silently optional.
      'rks_stash',
    ]);

// ── Ops Governor state machine ───────────────────────────────────────

    const OPS_STATES = {
      init: {
        allowed: new Set([
          'rks_agent_run',
          'rks_agent_research',
          'rks_exhaustive_search',
          'rks_agent_recovery',
          'rks_agent_git',
          'rks_project_get',
          'rks_preflight',
          'rks_release',
          'rks_tag',
        ]),
        transitions: {
          rks_agent_run: 'executing',
          rks_release: 'executing',
          rks_agent_recovery: 'executing',
        },
        resultTransitions: {},
      },
      executing: {
        allowed: new Set([
          'rks_agent_run',
          'rks_agent_research',
          'rks_exhaustive_search',
          'rks_agent_git',
          'rks_project_get',
          'rks_release',
          'rks_tag',
        ]),
        transitions: {
          // Self-loop: can dispatch multiple agent runs. NOT shell commands —
          // rks_agent_run's schema is { agent, input } and it dispatches LLM agents
          // from the registry; no agent input schema accepts a command string.
          // The prior comment here described this as running shell commands, which is
          // what seeded the same misconception in the Bash redirect hook. Value unchanged.
          rks_agent_run: 'executing',
          rks_release: 'executing',
          rks_cycle_complete: 'executing',
        },
        resultTransitions: {
          'cycle_complete.ok': 'done',
        },
      },
      done: {
        allowed: new Set([
          'rks_project_get',
        ]),
        transitions: {},
      },
    };

// ── Public API ──────────────────────────────────────────────────────

    /**
     * Get the state definition for a flow type.
     * @param {'story'|'open'|'qa'|'ship'|'ops'} flowType
     * @returns {Object} The state definitions map
     */
    export function getStates(flowType) {
      if (flowType === 'qa') return QA_STATES;
      if (flowType === 'ship') return SHIP_STATES;
      if (flowType === 'ops') return OPS_STATES;
      return flowType === 'open' ? OPEN_STATES : STORY_STATES;
    }

/**
 * Check if a tool is allowed in the current state.
 *
 * @param {'story'|'open'} flowType - The session's flow type
 * @param {string} currentState - The current state name
 * @param {string} toolName - The tool being called
 * @returns {{ allowed: boolean, error?: string }}
 */
export function checkStateAllowed(flowType, currentState, toolName) {
  if (STATE_BYPASS_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  const states = getStates(flowType);
  const state = states[currentState];

  if (!state) {
    return {
      allowed: false,
      error: `Unknown state '${currentState}' in ${flowType} flow`,
    };
  }

  if (state.allowed.has(toolName)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: `Tool '${toolName}' is not allowed in state '${currentState}' (${flowType} flow). ` +
      `Allowed tools: ${[...state.allowed].join(', ')}`,
  };
}

/**
 * Determine the next state after a tool call.
 * Returns the current state if no transition is defined.
 *
 * @param {'story'|'open'} flowType
 * @param {string} currentState
 * @param {string} toolName
 * @returns {string} The next state
 */
export function getNextState(flowType, currentState, toolName) {
  if (STATE_BYPASS_TOOLS.has(toolName)) return currentState;

  const states = getStates(flowType);
  const state = states[currentState];
  if (!state) return currentState;

  return state.transitions?.[toolName] || currentState;
}

/**
 * Determine the next state after a tool call completes with a result.
 *
 * @param {'story'|'open'} flowType
 * @param {string} currentState
 * @param {string} resultKey - e.g., 'plan.ok', 'plan.failed', 'exec.ok', 'refine_apply.decomposed'
 * @returns {string} The next state
 */
export function transitionOnResult(flowType, currentState, resultKey) {
  const states = getStates(flowType);
  const state = states[currentState];
  if (!state?.resultTransitions) return currentState;

  return state.resultTransitions[resultKey] || currentState;
}

    /**
     * Check if a state is terminal (no further transitions possible).
     *
     * @param {'story'|'open'|'qa'} flowType
     * @param {string} state
     * @returns {boolean}
     */
    export function isTerminal(flowType, state) {
      const terminalStory = new Set(['shipped', 'failed']);
      const terminalOpen = new Set(['review', 'failed']);
      const terminalQA = new Set(['shipped', 'failed']);
      const terminalShip = new Set(['shipped', 'failed']);

      const terminalOps = new Set(['done']);

      if (flowType === 'qa') return terminalQA.has(state);
      if (flowType === 'ship') return terminalShip.has(state);
      if (flowType === 'ops') return terminalOps.has(state);
      return flowType === 'open'
        ? terminalOpen.has(state)
        : terminalStory.has(state);
    }

        /**
         * Export QA and Ship tool allowlists for validation.
         */
        export { QA_FLOW_TOOLS, SHIP_FLOW_TOOLS, SHIP_STATES, OPS_STATES };

/**
 * backlog.fix.governor-phase-state-desync-and-recovery
 *
 * Classify a chain refusal so a wedge is DIAGNOSABLE instead of arriving as two unrelated
 * "not allowed" errors from two different layers.
 *
 * Two independent records gate a story-flow call and neither can see the other:
 *   - the chain STATE, held on the governor session
 *   - the story PHASE, held in the note's frontmatter
 *
 * When they disagree the caller gets a refusal from whichever layer it happened to hit
 * first, with no indication that the other is also blocking. In the observed incident that
 * cost a manual `dendron_update_field` phase reset plus a complete re-walk of the chain,
 * because nothing reported that BOTH exits were shut.
 *
 * Exported as a pure function on purpose: server.mjs's only live harness is the subprocess
 * MCP contract client and this project forbids source-text assertions, so classification
 * logic inlined at the dispatch site would be untestable by any sanctioned means.
 *
 * @param {object} args
 * @param {'story'|'open'|'qa'|'ship'|'ops'} args.flowType
 * @param {string} args.chainState   - current governor chain state
 * @param {string} [args.storyPhase] - current story frontmatter phase, if known
 * @param {string} args.tool         - the tool being refused
 * @param {(phase: string, tool: string) => boolean} [args.phaseAllows] - phase-gate probe
 * @returns {{ blockedBy: 'state'|'phase'|'both'|'neither', wedged: boolean,
 *             chainState: string, storyPhase: string|null, tool: string,
 *             recovery: string[], message: string }}
 */
export function classifyChainRefusal({ flowType, chainState, storyPhase = null, tool, phaseAllows }) {
  const states = getStates(flowType) || {};
  const stateBlocks = !(states[chainState]?.allowed?.has(tool));
  // Only consult the phase gate when the caller supplied one — an unknown phase must never
  // be reported as "phase is fine", which would send the caller down the wrong recovery.
  const phaseKnown = typeof phaseAllows === 'function' && typeof storyPhase === 'string';
  const phaseBlocks = phaseKnown ? !phaseAllows(storyPhase, tool) : false;

  const blockedBy = stateBlocks && phaseBlocks ? 'both'
    : stateBlocks ? 'state'
    : phaseBlocks ? 'phase'
    : 'neither';

  const recovery = [];
  if (blockedBy === 'both') {
    // The defining property of a wedge: no single-layer fix helps. Advancing the phase alone
    // still leaves the state blocking, and vice versa — which is why callers previously
    // bounced between the two layers without converging.
    recovery.push(
      'This is a WEDGE: the chain state and the story phase are blocking independently, so ' +
      'fixing either one alone will not unblock the call.',
      `Abort the chain with rks_exec_abort (allowed from '${chainState}'), then re-enter the flow.`,
    );
  } else if (blockedBy === 'state') {
    recovery.push(
      `'${tool}' is not allowed in chain state '${chainState}'. Reach a state that admits it, ` +
      'or abort with rks_exec_abort if no forward transition applies.',
    );
  } else if (blockedBy === 'phase') {
    recovery.push(
      `The chain state '${chainState}' permits '${tool}', but story phase '${storyPhase}' does not. ` +
      'The story record — not the session — is the blocking one here.',
    );
  }

  const message = blockedBy === 'neither'
    ? `'${tool}' is not refused by state '${chainState}'${phaseKnown ? ` or phase '${storyPhase}'` : ''}.`
    : recovery[0];

  return {
    blockedBy,
    wedged: blockedBy === 'both',
    chainState,
    storyPhase: phaseKnown ? storyPhase : null,
    tool,
    recovery,
    message,
  };
}
