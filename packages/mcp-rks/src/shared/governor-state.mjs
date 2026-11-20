/**
 * Governor State Machine — Phase 2 + Phase 3
 *
 * Enforces sequencing of tool calls within a Governor session.
 * Each state defines what the next state should be after a successful tool call. Which tools a
 * state ADMITS is the admission decision table's business (admission-table.mjs chain rows,
 * backlog.feat.admission-decision-table-decide); getStates() returns a derived view that carries
 * each state's admitted tools back as an `allowed` Set.
 *
 * CHAIN_MACHINE (declared after the tables below) is the single definition of this
 * machine: one frozen object keyed by flow, each entry holding its `start` state, its
 * `terminal` states and its `states` table. getStates, getStartState and isTerminal are
 * derived from it, and validateChainMachine checks it at module load.
 *
 * Five flow types:
 *   - 'story': refine → plan → exec → ship chain
 *   - 'open':  research → notes chain
 *   - 'qa':    research → test → assess → report chain
 *   - 'ship':  commit → PR → merge → cycle_complete chain
 *   - 'ops':   runtime operations (rks_agent_run, release, promote) → done
 *
 * Every flow starts at init. Terminal states: story {shipped, failed}, open {review, failed},
 * qa {shipped, failed}, ship {shipped, failed}, ops {done}. An unrecognised flowType
 * (including undefined) falls back to the story flow.
 *
 * Phase 3 adds decompose tracking:
 *   - 'decomposing' state after refine_apply returns decomposed: true
 *   - 'child_active' state when processing child stories in order
 *   - Child sub-state tracking (each child has its own refine → plan → exec cycle)
 */

import { ADMISSION_TABLE, validateAdmissionTable, chainStateTools, readOnlySet, STATE_BYPASS_TOOL_NAMES, READ_ONLY_EXEMPT_TOOL_NAMES } from './admission-table.mjs';

// ── State definitions ───────────────────────────────────────────────

/**
 * Story flow state machine.
 *
 * States (every key of STORY_STATES): init, refining, decompose-gated, planning, planned,
 * executing, approval-pending, diverged, test-failed, executed, shipping, decomposing,
 * child_active, shipped, escalated, failed.
 *
 * Main transitions (the table is authoritative):
 *   init             → refining          (on rks_refine or rks_agent_research)
 *   refining         → refining          (on rks_refine, rks_refine_apply, rks_agent_research — iteration loop)
 *   refining         → planning          (on rks_plan)
 *   refining         → decomposing       (on refine_apply.decomposed result)
 *   refining         → decompose-gated   (on refine.decompose_suggested result)
 *   refining         → escalated         (on refine_apply.noop_repeated result)
 *   decompose-gated  → planning | refining | decomposing
 *   planning         → planned           (on rks_plan success)
 *   planned          → executing         (on rks_exec)
 *   executing        → executed          (on rks_exec success)
 *   executing        → test-failed       (on rks_exec failure — tests failed)
 *   executing        → approval-pending  (on exec.needs_approval result)
 *   executing        → diverged          (on exec.diverged result)
 *   approval-pending → executing | failed
 *   diverged         → refining
 *   test-failed      → refining          (on rks_refine — diagnose and fix)
 *   executed         → shipping          (on rks_ship — if not autoShip)
 *   shipping         → shipped           (on rks_ship success)
 *   decomposing      → child_active      (on starting first child — rks_refine for child)
 *   child_active     → child_active      (refine/plan/exec cycle for current child)
 *   child_active     → shipped           (all children completed successfully)
 *   child_active     → escalated         (on refine_apply.noop_repeated result)
 *   escalated        → failed
 *   *                → failed            (on any error — terminal)
 */
const STORY_STATES = {
  init: {
    transitions: {
      rks_refine: 'refining',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
    },
  },
  refining: {
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
    transitions: {
      rks_exec_abort: 'failed',
    },
    resultTransitions: {
      'exec.ok': 'executed',
      'exec.failed': 'test-failed',   // Route to test-failed state — allows refine-retry loop
      'exec.diverged': 'diverged',    // Execution diverged from plan — recover via refine
      'exec.needs_approval': 'approval-pending',  // Guardrail-critical files need user approval
      'exec.no_actions': 'refining',  // Throw path: runExecTool has reset phase to arch-approved; refining admits rks_plan / rks_plan_ready / rks_exec_abort
      'exec.error': 'refining',       // Throw path (pre- or post-mutation): same (refining, arch-approved) pair — re-plan, not re-exec
    },
  },
  'approval-pending': {
    // Exec encountered guardrail-critical files (governor-token.mjs, guardrails-audit.mjs).
    // Wait for approval before re-executing.
    // Transitions: approval-pending → (approve.ok) → executing → re-exec
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
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
      rks_exec_abort: 'failed',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
      // rks_exhaustive_search: no entry — deliberate read-only self-loop (see allowed above).
    },
  },
  executed: {
    // READ-ONLY VERIFICATION. A Governor that has just written files must be able to read
    // them back; without these it had no route at all — rks_exhaustive_search and
    // dendron_read_note were state-blocked, Read/Grep were hook-blocked on "no provenance",
    // and rks_agent_git truncates. Both are read-only and neither gets a transitions entry,
    // so no write path opens and the state still advances only via ship.
    transitions: {
      rks_ship: 'shipping',
      rks_story_ship: 'shipping',
    },
  },
  shipping: {
    resultTransitions: {
      'ship.ok': 'shipped',
      'ship.failed': 'executed',
    },
  },
  // Phase 3: Decompose states
  decomposing: {
    // Parent has been decomposed, children queued. Governor should start first child.
    transitions: {
      rks_refine: 'child_active',
      rks_agent_research: 'child_active',
      rks_agent_external_research: 'child_active',
    },
  },
  child_active: {
    // A child story is being processed through refine → plan → exec.
    // All chain tools are allowed — the child sub-state tracks sequencing.
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
    transitions: {
      rks_exec_abort: 'failed',
    },
    resultTransitions: {},
  },
  failed: {
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
        transitions: {
          rks_agent_research: 'researching',
          rks_agent_external_research: 'researching',
        },
      },
      researching: {
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
        transitions: {
          rks_agent_run: 'qa_testing',
        },
        resultTransitions: {
          'qa.tests_complete': 'qa_assessing',
          'qa.tests_failed': 'failed',
        },
      },
      qa_assessing: {
        transitions: {},
        resultTransitions: {
          'qa.assessment_pass': 'qa_reporting',
          'qa.assessment_fail': 'failed',
        },
      },
      qa_reporting: {
        transitions: {},
        resultTransitions: {
          'qa.report_complete': 'shipped',
          'qa.report_failed': 'failed',
        },
      },
      shipped: {
        transitions: {},
      },
      failed: {
        transitions: {},
      },
    };

    /**
     * Open (notes) flow state machine.
     */
    const OPEN_STATES = {
  init: {
    transitions: {
      rks_agent_research: 'researching',
      rks_agent_external_research: 'researching',
      dendron_create_note: 'writing',
      dendron_edit_note: 'writing',
    },
  },
  researching: {
    transitions: {
      rks_agent_research: 'concern-separating',
      rks_agent_external_research: 'researching',
      // SELF-LOOP, deliberately NOT 'writing'. writing.allowed already carries
      // dendron_create_note and NAMESPACE_ALLOWLIST maps open -> null. Advancing there
      // would reach writing without the PO research traversal. Since
      // backlog.feat.dendron-write-arg-checks-close-bypasses the backlog gate is keyed
      // to the traversed chain (a session flag set on entering test-file-scanning), so
      // a writing reached any other way (including init's create/edit edges) still
      // refuses a backlog.* create; the self-loop keeps the chain position honest.
      dendron_create_note: 'researching',
    },
  },
  'concern-separating': {
    transitions: {
      rks_agent_research: 'test-file-scanning',
      rks_agent_external_research: 'concern-separating',
      // SELF-LOOP — see the researching rationale above (the backlog gate is the
      // traversal flag set on entering test-file-scanning, not this state).
      dendron_create_note: 'concern-separating',
    },
  },
  'test-file-scanning': {
    transitions: {
      rks_agent_research: 'writing',
      rks_agent_external_research: 'test-file-scanning',
    },
  },
  writing: {
    transitions: {
      dendron_create_note: 'writing',
      dendron_edit_note: 'writing',
      dendron_read_note: 'writing',
      dendron_update_field: 'writing',
      dendron_update_fields: 'writing',
      dendron_rename_note: 'writing',
      rks_inbox_review: 'writing',
      rks_agent_research: 'writing',
      rks_agent_external_research: 'writing',
    },
  },
  review: {
    transitions: {},
  },
  failed: {
    transitions: {},
  },
};

    /**
     * Ship flow state machine.
     *
     * States and their allowed tools + transitions:
     *   init        → committed     (on git_commit.ok)
     *   committed   → pr_created    (on staging_pr.ok)
     *   committed   → merging       (on git_merge.ok — 3-branch local feature-branch merge)
     *   committed   → shipped       (on cycle_complete.ok — working-branch ship)
     *   pr_created  → merging       (on git_merge.ok)
     *   merging     → shipped       (on cycle_complete.ok)
     *   *           → failed        (on any error — terminal)
     */
    const SHIP_STATES = {
      init: {
        transitions: {
          rks_git_commit: 'init',  // Stay in init until result arrives
          // backlog.fix.ship-flow-deterministic-no-llm: step 0.5 reads git state through the
          // deterministic rks_git_state (read-only, no result key), so it never moves the state.
          rks_git_state: 'init',
        },
        resultTransitions: {
          'git_commit.ok': 'committed',
          'git_commit.error': 'failed',
        },
      },
      committed: {
        transitions: {
          rks_git_push: 'committed',  // Stay in committed until result
          rks_staging_pr: 'committed',
          rks_git_merge: 'committed',
          rks_cycle_complete: 'committed',
        },
        resultTransitions: {
          'git_push.ok': 'committed',  // Push succeeded, stay in committed for PR
          'git_push.error': 'failed',
          'staging_pr.ok': 'pr_created',
          'staging_pr.error': 'failed',
          'git_merge.ok': 'merging',
          'git_merge.error': 'failed',
          'cycle_complete.ok': 'shipped',
          'cycle_complete.error': 'failed',
        },
      },
      pr_created: {
        transitions: {
          rks_git_merge: 'pr_created',
          rks_staging_merge: 'pr_created',
        },
        resultTransitions: {
          'git_merge.ok': 'merging',
          'git_merge.error': 'failed',
          // 2-branch: rks_staging_merge merges the PR rks_staging_pr opened.
          'staging_merge.ok': 'merging',
          'staging_merge.error': 'failed',
        },
      },
      merging: {
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
        transitions: {},
      },
      failed: {
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
          'dendron_update_fields',
        ]);
    
        /**
         * Tools allowed in Ship flow. Excludes Build phase (rks_refine, rks_plan, rks_exec)
         * and ensures rks_ship is only callable from Ship, not from Build/QA.
         * Ships committed changes via git commit → PR → merge → cycle_complete.
         */
        const SHIP_FLOW_TOOLS = new Set([
          'rks_governor_init',
          'rks_git_state',
          'rks_git_commit',
          'rks_git_push',
          'rks_staging_pr',
          'rks_git_merge',
          'rks_staging_merge',
          'rks_cycle_complete',
          'rks_agent_git',
          'rks_project_get',
        ]);

    // ── Common tools (bypass state checks) ──────────────────────────────
    
    // Projections of the admission table's lists (admission-table.mjs STATE_BYPASS_TOOL_NAMES and
    // READ_ONLY_EXEMPT_TOOL_NAMES, where each membership is explained). Same names, same contents.
    const STATE_BYPASS_TOOLS = new Set(STATE_BYPASS_TOOL_NAMES);
    const READ_ONLY_EXEMPT_TOOLS = new Set(READ_ONLY_EXEMPT_TOOL_NAMES);

// ── Ops Governor state machine ───────────────────────────────────────

    const OPS_STATES = {
      init: {
        transitions: {
          rks_agent_run: 'executing',
          rks_release: 'executing',
          rks_promote: 'executing',
          rks_agent_recovery: 'executing',
        },
        resultTransitions: {},
      },
      executing: {
        transitions: {
          // Self-loop: can dispatch multiple agent runs. NOT shell commands —
          // rks_agent_run's schema is { agent, input } and it dispatches LLM agents
          // from the registry; no agent input schema accepts a command string.
          // The prior comment here described this as running shell commands, which is
          // what seeded the same misconception in the Bash redirect hook. Value unchanged.
          rks_agent_run: 'executing',
          rks_release: 'executing',
          rks_promote: 'executing',
          rks_cycle_complete: 'executing',
        },
        resultTransitions: {
          'cycle_complete.ok': 'done',
        },
      },
      done: {
        transitions: {},
      },
    };

// ── CHAIN_MACHINE: the single definition of M1 ──────────────────────

/**
 * backlog.feat.chain-machine-declarative-definition
 *
 * One declarative definition of the session/chain state machine, keyed by flow. Each entry
 * holds its start state, its terminal states, and its states table BY REFERENCE (the table
 * objects above are not copied, re-sorted or rebuilt). The machine object and its flow entries
 * are frozen; the tables are not.
 *
 * backlog.feat.admission-decision-table-decide: a state definition carries transitions and
 * resultTransitions only. The tools each state admits are the chain rows of ADMISSION_TABLE.
 */
export const CHAIN_MACHINE = Object.freeze({
  story: Object.freeze({ start: 'init', terminal: Object.freeze(['shipped', 'failed']), states: STORY_STATES }),
  open: Object.freeze({ start: 'init', terminal: Object.freeze(['review', 'failed']), states: OPEN_STATES }),
  qa: Object.freeze({ start: 'init', terminal: Object.freeze(['shipped', 'failed']), states: QA_STATES }),
  ship: Object.freeze({ start: 'init', terminal: Object.freeze(['shipped', 'failed']), states: SHIP_STATES }),
  ops: Object.freeze({ start: 'init', terminal: Object.freeze(['done']), states: OPS_STATES }),
});

/**
 * Validate a chain machine shaped like CHAIN_MACHINE. Pure: reads only, never adds a key.
 * An absent transitions or resultTransitions key is valid and is read as empty.
 *
 * Throws an Error naming the flow and the offending state or key when:
 *   - a flow's start is not a key of its states;
 *   - a terminal entry is not a key of its states;
 *   - a transitions or resultTransitions value is not a key of the same flow's states;
 *   - a terminal state has a non-empty transitions or resultTransitions.
 *
 * @param {Record<string, { start: string, terminal: string[], states: Record<string, object> }>} machine
 */
export function validateChainMachine(machine) {
  for (const [flow, def] of Object.entries(machine)) {
    const states = def?.states;
    if (!states || typeof states !== 'object') {
      throw new Error(`CHAIN_MACHINE flow '${flow}': states is not an object`);
    }
    const isState = (name) => typeof name === 'string' && Object.hasOwn(states, name);
    if (!isState(def.start)) {
      throw new Error(`CHAIN_MACHINE flow '${flow}': start '${def.start}' is not a state of the flow`);
    }
    if (!Array.isArray(def.terminal)) {
      throw new Error(`CHAIN_MACHINE flow '${flow}': terminal is not an array`);
    }
    for (const t of def.terminal) {
      if (!isState(t)) {
        throw new Error(`CHAIN_MACHINE flow '${flow}': terminal entry '${t}' is not a state of the flow`);
      }
    }
    for (const [stateName, stateDef] of Object.entries(states)) {
      if (!stateDef || typeof stateDef !== 'object') {
        throw new Error(`CHAIN_MACHINE flow '${flow}', state '${stateName}': state definition is not an object`);
      }
      for (const key of ['transitions', 'resultTransitions']) {
        const edges = stateDef[key] ?? {};
        for (const [edge, target] of Object.entries(edges)) {
          if (!isState(target)) {
            throw new Error(`CHAIN_MACHINE flow '${flow}', state '${stateName}': ${key}['${edge}'] targets '${target}', which is not a state of the flow`);
          }
        }
        if (def.terminal.includes(stateName) && Object.keys(edges).length > 0) {
          throw new Error(`CHAIN_MACHINE flow '${flow}', state '${stateName}': terminal state has outgoing ${key}`);
        }
      }
    }
  }
}

// Load-time validation, as GATES = deriveGates(PHASE_MACHINE) runs at import in state-machine.mjs.
validateChainMachine(CHAIN_MACHINE);

// Any flowType that is not a key of CHAIN_MACHINE (including undefined and prototype keys such
// as 'constructor') resolves to the story flow, exactly as the former if-chains did.
const chainFlow = (flowType) => (Object.hasOwn(CHAIN_MACHINE, flowType) ? CHAIN_MACHINE[flowType] : CHAIN_MACHINE.story);

// backlog.feat.admission-decision-table-decide: the admission table names flows and states of this
// machine, and every state must have exactly one per-state chain row. Checked here, at load, because
// admission-table.mjs cannot import this module (this module imports it).
validateAdmissionTable(ADMISSION_TABLE, CHAIN_MACHINE);

/**
 * The derived state views getStates returns, built once at load: for each CHAIN_MACHINE state, an
 * `allowed` Set of the tools its chain row admits (same contents and insertion order the Sets had
 * when they lived in the tables above, so checkStateAllowed's refusal text is unchanged), followed
 * by the state's own transitions / resultTransitions keys BY REFERENCE (an absent key stays absent).
 * The view and each state entry are frozen, and `allowed` is a readOnlySet, so checkStateAllowed
 * cannot diverge from the rows decide reads. A view is not CHAIN_MACHINE[flow].states.
 */
function buildStateView(flow, states) {
  const view = {};
  for (const [name, def] of Object.entries(states)) {
    const entry = { allowed: readOnlySet(chainStateTools(flow, name)) };
    for (const key of Object.keys(def)) entry[key] = def[key];
    view[name] = Object.freeze(entry);
  }
  return Object.freeze(view);
}
const STATE_VIEWS = Object.freeze(Object.fromEntries(
  Object.entries(CHAIN_MACHINE).map(([flow, def]) => [flow, buildStateView(flow, def.states)]),
));
const viewOf = (flowType) => (Object.hasOwn(STATE_VIEWS, flowType) ? STATE_VIEWS[flowType] : STATE_VIEWS.story);
// SHIP_STATES and OPS_STATES are exported as these view objects (getStates('ship') / getStates('ops')).
const SHIP_STATES_VIEW = STATE_VIEWS.ship;
const OPS_STATES_VIEW = STATE_VIEWS.ops;

// ── Public API ──────────────────────────────────────────────────────

    /**
     * Get the state definitions for a flow type: the derived view of CHAIN_MACHINE plus the
     * admission table's per-state chain rows (see buildStateView).
     * An unrecognised flowType (including undefined) returns the story view.
     * @param {'story'|'open'|'qa'|'ship'|'ops'} flowType
     * @returns {Object} The state definitions map
     */
    export function getStates(flowType) {
      return viewOf(flowType);
    }

/**
 * Get the start state of a flow, from CHAIN_MACHINE. An unrecognised flowType (including
 * undefined) returns the story flow's start state.
 * @param {'story'|'open'|'qa'|'ship'|'ops'} flowType
 * @returns {string}
 */
export function getStartState(flowType) {
  return chainFlow(flowType).start;
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
  if (STATE_BYPASS_TOOLS.has(toolName) || READ_ONLY_EXEMPT_TOOLS.has(toolName)) {
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
  if (STATE_BYPASS_TOOLS.has(toolName) || READ_ONLY_EXEMPT_TOOLS.has(toolName)) return currentState;

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
     * Reads CHAIN_MACHINE[flow].terminal; an unrecognised flowType (including undefined)
     * uses the story flow's terminal states.
     *
     * @param {'story'|'open'|'qa'|'ship'|'ops'} flowType
     * @param {string} state
     * @returns {boolean}
     */
    export function isTerminal(flowType, state) {
      return chainFlow(flowType).terminal.includes(state);
    }

        /**
         * Export QA and Ship tool allowlists for validation.
         */
        export { QA_FLOW_TOOLS, SHIP_FLOW_TOOLS, SHIP_STATES_VIEW as SHIP_STATES, OPS_STATES_VIEW as OPS_STATES, STATE_BYPASS_TOOLS, READ_ONLY_EXEMPT_TOOLS };

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
  // backlog.feat.admission-decision-table-decide: "the state blocks" is read from the admission
  // table's per-state chain row, not from a second copy of the tool list.
  const stateBlocks = !(chainStateTools(flowType, chainState)?.includes(tool));
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
    // backlog.fix.story-ship-unreachable-from-fresh-session: name rks_exec_abort only when the
    // current state admits it. Recommending a tool the state refuses is a dead end.
    const abortAdmitted = chainStateTools(flowType, chainState)?.includes('rks_exec_abort') === true;
    recovery.push(
      `'${tool}' is not allowed in chain state '${chainState}'. Reach a state that admits it, ` +
      (abortAdmitted
        ? 'or abort with rks_exec_abort if no forward transition applies.'
        : 'or start the chain over with rks_governor_init and reset: true if no forward transition applies.'),
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
