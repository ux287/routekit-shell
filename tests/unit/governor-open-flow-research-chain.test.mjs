/**
 * backlog.fix.open-flow-research-note-creation — primary spec.
 *
 * The Research Governor's documented chain was not executable as written:
 * `.rks/prompts/governor-research.md` step 2 MANDATES dendron_create_note, but the open
 * flow advances init -> researching -> concern-separating and neither of those states
 * allowed the tool, so the only recourse was an rks_governor_init re-init.
 *
 * The open flow is ONE state table serving TWO prompts. governor-po.md:39 also inits
 * open, and for the PO chain that denial IS the gate forcing concern-separation and the
 * test-file scan. So the fix cannot be a blanket widening. ARCH ruled mechanism (A)
 * BINDING: permit the tool in the state table, and discriminate by NAMESPACE in
 * assertToolAllowed — `backlog.*` stays refused from the two research states, while the
 * design, research and notes namespaces are permitted. The create SELF-LOOPS rather than advancing
 * to `writing`, because writing.allowed carries dendron_create_note and NAMESPACE_ALLOWLIST
 * maps open -> null, so advancing would skip the guard and reopen a laundering path.
 *
 * Run:
 *   npx vitest run --config vitest.config.unit.mjs \
 *     tests/unit/governor-open-flow-research-chain.test.mjs
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  checkStateAllowed,
  getNextState,
  getStates,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import {
  createSession,
  advanceState,
  assertToolAllowed,
  endSession,
  setProjectRoot,
  getSession,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

let tmpRoot;
beforeAll(() => {
  // Sessions persist to disk — keep them out of the repository.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-research-chain-'));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Fresh open-flow session at `init`. */
function newOpenSession() {
  return createSession({ projectId: 'open-research-chain-test', flowType: 'open' }).token;
}

// Pre-change baseline of every non-open flow's allowed sets (sorted).
const NON_OPEN_FLOW_BASELINE = {
  "story": {
    "init": ["dendron_create_note", "dendron_edit_note", "dendron_read_note", "dendron_update_field", "rks_agent_dendron", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_analyze", "rks_exhaustive_search", "rks_preflight", "rks_project_get", "rks_refine"],
    // backlog.fix.governor-phase-state-desync-and-recovery — BASELINE DELIBERATELY UPDATED.
    // `refining` gains exactly rks_exec_abort, WITH a transition to `failed`. It is the
    // registered recovery for a story stranded at phase `executing`, and its absence here was
    // the third closed exit in the observed wedge.
    "refining": ["dendron_create_note", "dendron_edit_note", "dendron_read_note", "dendron_update_field", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_analyze", "rks_exec_abort", "rks_exhaustive_search", "rks_plan", "rks_plan_ready", "rks_preflight", "rks_project_get", "rks_refine", "rks_refine_apply"],
    "decompose-gated": ["rks_plan", "rks_project_get", "rks_refine_apply"],
    // backlog.fix.planning-state-deadlock-no-exit — BASELINE DELIBERATELY UPDATED.
    // `planning` gains exactly rks_refine + rks_refine_apply. It was a structural deadlock: three
    // tools, `transitions: {}`, and the only exits were plan results that never arrive when
    // rks_plan returns not_ready without spawning a worker. The two additions both transition OUT
    // to `refining`, so the state stays transient. This is the ONLY line in this snapshot that may
    // change for that story — every other entry staying byte-identical is what proves no other
    // state's allowlist was widened along with it.
    "planning": ["rks_agent_git", "rks_plan_review", "rks_project_get", "rks_refine", "rks_refine_apply"],
    // backlog.fix.planned-state-readonly-regression-and-search-admission — BASELINE
    // DELIBERATELY UPDATED. `planned` gains exactly rks_exhaustive_search, admitted with NO
    // transition so it self-loops and cannot regress the chain. Every other entry in this
    // snapshot staying byte-identical is what proves no other allowlist was widened with it.
    // This snapshot covers `allowed` sets ONLY, so the transitions change in the same story
    // (dropping the two read-only research demotions) is invisible here by design.
    "planned": ["rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_exec", "rks_exhaustive_search", "rks_plan", "rks_plan_review", "rks_project_get", "rks_refine"],
    "executing": ["rks_agent_git", "rks_exec", "rks_exec_abort", "rks_project_get"],
    "approval-pending": ["rks_agent_git", "rks_approve", "rks_project_get"],
    "diverged": ["rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_project_get", "rks_refine", "rks_refine_apply"],
    "test-failed": ["rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_exec_abort", "rks_project_get", "rks_refine", "rks_refine_apply"],
    "executed": ["dendron_read_note", "rks_agent_git", "rks_exhaustive_search", "rks_project_get", "rks_ship", "rks_story_ship"],
    "shipping": ["rks_agent_git", "rks_project_get"],
    "decomposing": ["dendron_read_note", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_project_get", "rks_refine"],
    "child_active": ["dendron_create_note", "dendron_edit_note", "dendron_read_note", "dendron_update_field", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_analyze", "rks_exec", "rks_exec_abort", "rks_exhaustive_search", "rks_plan", "rks_plan_ready", "rks_plan_review", "rks_preflight", "rks_project_get", "rks_refine", "rks_refine_apply", "rks_ship"],
    "shipped": ["rks_project_get"],
    "escalated": ["dendron_read_note", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_exec_abort", "rks_project_get"],
    "failed": ["rks_project_get"],
  },
  "qa": {
    "init": ["dendron_read_note", "dendron_update_field", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_governor_init", "rks_preflight", "rks_project_get"],
    "researching": ["dendron_create_note", "dendron_edit_note", "dendron_read_note", "dendron_update_field", "rks_agent_external_research", "rks_agent_git", "rks_agent_research", "rks_agent_run", "rks_exhaustive_search", "rks_project_get"],
    "qa_testing": ["dendron_read_note", "rks_agent_git", "rks_agent_run", "rks_project_get"],
    "qa_assessing": ["dendron_create_note", "dendron_edit_note", "dendron_update_field", "rks_project_get"],
    "qa_reporting": ["dendron_create_note", "dendron_edit_note", "dendron_update_field", "rks_project_get"],
    "shipped": ["rks_project_get"],
    "failed": ["rks_project_get"],
  },
  "ship": {
    "init": ["rks_agent_git", "rks_git_commit", "rks_project_get"],
    "committed": ["rks_agent_git", "rks_git_push", "rks_project_get", "rks_staging_pr"],
    "pr_created": ["rks_agent_git", "rks_git_merge", "rks_project_get"],
    "merging": ["rks_agent_git", "rks_cycle_complete", "rks_project_get"],
    "shipped": ["rks_project_get"],
    "failed": ["rks_project_get"],
  },
  "ops": {
    "init": ["rks_agent_git", "rks_agent_recovery", "rks_agent_research", "rks_agent_run", "rks_exhaustive_search", "rks_preflight", "rks_project_get", "rks_release", "rks_tag"],
    "executing": ["rks_agent_git", "rks_agent_research", "rks_agent_run", "rks_exhaustive_search", "rks_project_get", "rks_release", "rks_tag"],
    "done": ["rks_project_get"],
  },
};

const RESEARCH_NOTE = 'research.2026.07.31.qa-probe';
const BACKLOG_NOTE = 'backlog.feat.some-story';

describe('LOAD-BEARING: governor-research.md is executable as written', () => {
  it('minimal chain: init -> rks_agent_research -> dendron_create_note, no re-init', () => {
    const token = newOpenSession();
    try {
      // Replay the prompt against the REAL state machine — no manual state setting.
      advanceState(token, 'rks_agent_research');
      expect(getSession(token).state).toBe('researching');

      const res = assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE });

      // null == allowed. No chain_violation, no namespace_violation, no re-init.
      expect(res).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it('with optional step 1b: init -> research -> external_research -> dendron_create_note', () => {
    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      advanceState(token, 'rks_agent_external_research');
      expect(getSession(token).state).toBe('researching');

      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE }),
      ).toBeNull();
    } finally {
      endSession(token);
    }
  });

  it('from concern-separating: design.* / research.* / notes.* creates are all permitted', () => {
    for (const filename of ['design.some-design', RESEARCH_NOTE, 'notes.scratch']) {
      const token = newOpenSession();
      try {
        advanceState(token, 'rks_agent_research');
        advanceState(token, 'rks_agent_research');
        expect(getSession(token).state).toBe('concern-separating');

        expect(assertToolAllowed(token, 'dendron_create_note', { filename })).toBeNull();
      } finally {
        endSession(token);
      }
    }
  });

  it('follow-up frontmatter writes are reachable from both research states', () => {
    for (const state of ['researching', 'concern-separating']) {
      const token = newOpenSession();
      try {
        advanceState(token, 'rks_agent_research');
        if (state === 'concern-separating') advanceState(token, 'rks_agent_research');
        expect(getSession(token).state).toBe(state);

        expect(
          assertToolAllowed(token, 'dendron_edit_note', { filename: RESEARCH_NOTE }),
        ).toBeNull();
        expect(
          assertToolAllowed(token, 'dendron_update_field', {
            filename: RESEARCH_NOTE,
            field: 'desc',
            value: 'x',
          }),
        ).toBeNull();
      } finally {
        endSession(token);
      }
    }
  });
});

describe('PO gate preserved (behavioural, non-negotiable)', () => {
  it('backlog.* create is REJECTED from researching', () => {
    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      const res = assertToolAllowed(token, 'dendron_create_note', { filename: BACKLOG_NOTE });
      expect(res?.ok).toBe(false);
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('backlog.* create is REJECTED from concern-separating', () => {
    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      advanceState(token, 'rks_agent_research');
      const res = assertToolAllowed(token, 'dendron_create_note', { filename: BACKLOG_NOTE });
      expect(res?.ok).toBe(false);
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('PO happy path: FOUR research calls reach writing, where backlog.* is allowed', () => {
    let state = 'init';
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('researching');
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('concern-separating');
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('test-file-scanning'); // THREE calls land here, not writing
    state = getNextState('open', state, 'rks_agent_research');
    expect(state).toBe('writing');

    const token = newOpenSession();
    try {
      for (let i = 0; i < 4; i++) advanceState(token, 'rks_agent_research');
      expect(getSession(token).state).toBe('writing');
      // The gate has been traversed — story creation is now legitimate.
      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: BACKLOG_NOTE }),
      ).toBeNull();
    } finally {
      endSession(token);
    }
  });
});

describe('SELF-LOOP transition invariants', () => {
  it('dendron_create_note self-loops in researching and concern-separating', () => {
    expect(getNextState('open', 'researching', 'dendron_create_note')).toBe('researching');
    expect(getNextState('open', 'concern-separating', 'dendron_create_note')).toBe(
      'concern-separating',
    );
  });

  it('neither transition advances to writing', () => {
    expect(getNextState('open', 'researching', 'dendron_create_note')).not.toBe('writing');
    expect(getNextState('open', 'concern-separating', 'dendron_create_note')).not.toBe('writing');
  });

  it('pre-existing init edge is undisturbed', () => {
    const states = getStates('open');
    expect(states.init.transitions.dendron_create_note).toBe('writing');
    expect(states.init.allowed.has('dendron_create_note')).toBe(true);
    // ...as is the writing self-loop.
    expect(states.writing.transitions.dendron_create_note).toBe('writing');
  });
});

describe('LAUNDERING PATH CLOSED', () => {
  it('a successful research.* create leaves state at researching and does NOT unlock backlog.*', () => {
    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      expect(getSession(token).state).toBe('researching');

      // Step 1: the legitimate research create succeeds...
      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE }),
      ).toBeNull();
      advanceState(token, 'dendron_create_note');

      // ...and the session is STILL researching. This state assertion is mandatory:
      // it is what proves the rejection below follows from the self-loop rather than
      // being incidental, and it prevents a future edit silently restoring '-> writing'.
      expect(getSession(token).state).toBe('researching');
      expect(getSession(token).state).not.toBe('writing');

      // Step 2: the laundering attempt is still refused.
      const res = assertToolAllowed(token, 'dendron_create_note', { filename: BACKLOG_NOTE });
      expect(res?.ok).toBe(false);
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('the same holds from concern-separating', () => {
    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      advanceState(token, 'rks_agent_research');
      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE }),
      ).toBeNull();
      advanceState(token, 'dendron_create_note');

      expect(getSession(token).state).toBe('concern-separating');
      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: BACKLOG_NOTE })?.ok,
      ).toBe(false);
    } finally {
      endSession(token);
    }
  });
});

describe('no collateral widening', () => {
  it('NO OTHER FLOW GAINED A PERMISSION: story/qa/ship/ops snapshots are byte-identical', () => {
    // Explicit expected-set snapshot (sorted arrays), captured from the pre-change
    // baseline. The total permission diff introduced by this story must be confined to
    // OPEN_STATES.researching and OPEN_STATES['concern-separating'] — this pins every
    // other flow so a future collateral widening cannot land silently.
    //
    // Note the deliberate asymmetry recorded here: QA's `researching` ALREADY permitted
    // dendron_create_note before this change, while the open flow's did not. That is
    // pre-existing and must stay true.
    for (const [flow, expectedStates] of Object.entries(NON_OPEN_FLOW_BASELINE)) {
      const states = getStates(flow);
      expect(Object.keys(states).sort(), `flow ${flow} state list`).toEqual(
        Object.keys(expectedStates).sort(),
      );
      for (const [name, expectedTools] of Object.entries(expectedStates)) {
        expect([...states[name].allowed].sort(), `${flow}/${name} allowed set`).toEqual(
          expectedTools,
        );
      }
    }
  });

  it('open flow did not become a general escape hatch', () => {
    const OUT_OF_FLOW = ['rks_exec', 'rks_plan', 'rks_exec_abort', 'rks_ship'];
    const OPEN_STATES = [
      'init',
      'researching',
      'concern-separating',
      'test-file-scanning',
      'writing',
      'review',
      'failed',
    ];
    for (const state of OPEN_STATES) {
      for (const tool of OUT_OF_FLOW) {
        const res = checkStateAllowed('open', state, tool);
        expect(res.allowed, `${tool} must be refused in open/${state}`).toBe(false);
      }
    }
  });

  it('story flow still rejects a research.* create (namespace rule intact)', () => {
    const token = createSession({
      projectId: 'open-research-chain-test',
      problemId: 'backlog.fix.whatever',
      flowType: 'story',
    }).token;
    try {
      const res = assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE });
      expect(res?.ok).toBe(false);
      expect(res.error).toBe('namespace_violation');
    } finally {
      endSession(token);
    }
  });

  it('sibling-symptom pin: rks_exhaustive_search stays allowed across open research states', () => {
    for (const state of ['init', 'researching', 'concern-separating', 'test-file-scanning', 'writing']) {
      expect(
        checkStateAllowed('open', state, 'rks_exhaustive_search').allowed,
        `rks_exhaustive_search must be allowed in open/${state}`,
      ).toBe(true);
    }
  });

  it('open-flow dendron symmetry invariant still holds', () => {
    const states = getStates('open');
    const underlying = [
      'dendron_create_note',
      'dendron_edit_note',
      'dendron_read_note',
      'dendron_update_field',
    ];
    for (const [name, def] of Object.entries(states)) {
      if (def.allowed.has('rks_agent_dendron')) {
        for (const tool of underlying) {
          expect(def.allowed.has(tool), `open/${name} allows wrapper so must allow ${tool}`).toBe(
            true,
          );
        }
      }
    }
  });
});

describe('prompt/machine agreement is asserted, not assumed', () => {
  it('governor-research.md mandates dendron_create_note, and the chain replays clean', () => {
    const prompt = fs.readFileSync(
      path.join(REPO_ROOT, '.rks', 'prompts', 'governor-research.md'),
      'utf8',
    );
    // Durable full-source assertion — no fixed-size window, no exact multi-line pin.
    expect(prompt).toContain('dendron_create_note');

    const token = newOpenSession();
    try {
      advanceState(token, 'rks_agent_research');
      expect(
        assertToolAllowed(token, 'dendron_create_note', { filename: RESEARCH_NOTE }),
      ).toBeNull();
    } finally {
      endSession(token);
    }
  });
});
