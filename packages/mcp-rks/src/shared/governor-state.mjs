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
    ]),
    transitions: {
      rks_refine: 'refining',
      rks_refine_apply: 'refining',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
      rks_plan: 'planning',
    },
    resultTransitions: {
      'refine_apply.decomposed': 'decomposing',
      'refine.decompose_suggested': 'decompose-gated',
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
    allowed: new Set([
      'rks_plan_review',
      'rks_agent_git',
      'rks_project_get',
    ]),
    transitions: {},
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
    ]),
    transitions: {
      rks_exec: 'executing',
      rks_refine: 'refining',
      rks_agent_research: 'refining',
      rks_agent_external_research: 'refining',
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
  executed: {
    allowed: new Set([
      'rks_ship',
      'rks_story_ship',
      'rks_agent_git',
      'rks_project_get',
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
      'rks_exhaustive_search',
      'rks_agent_git',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
      'rks_project_get',
    ]),
    transitions: {
      rks_agent_research: 'concern-separating',
      rks_agent_external_research: 'researching',
    },
  },
  'concern-separating': {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
      'rks_exhaustive_search',
      'rks_agent_git',
      'dendron_read_note',
      'rks_project_get',
    ]),
    transitions: {
      rks_agent_research: 'test-file-scanning',
      rks_agent_external_research: 'concern-separating',
    },
  },
  'test-file-scanning': {
    allowed: new Set([
      'rks_agent_research',
      'rks_agent_external_research',
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
      'rks_agent_research',
      'rks_agent_external_research',
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
          rks_agent_run: 'executing',  // Self-loop: can run multiple commands
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
