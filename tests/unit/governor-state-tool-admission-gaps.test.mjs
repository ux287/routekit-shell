import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkStateAllowed,
  getNextState,
  getStates,
  isTerminal,
  transitionOnResult,
} from '../../packages/mcp-rks/src/shared/governor-state.mjs';
import {
  OPEN_FLOW_TOOLS,
  STORY_FLOW_TOOLS,
  createSession,
  advanceState,
  assertToolAllowed,
  endSession,
  getSession,
  setProjectRoot,
} from '../../packages/mcp-rks/src/shared/governor-token.mjs';
import { runPlanReadyTool, isPlanReadyReadOnly } from '../../packages/mcp-rks/src/server/plan-ready.mjs';

// backlog.fix.governor-state-tool-admission-gaps
// Instance 1: test-failed admits rks_exhaustive_search as a deliberate self-loop.
// Instance 2: rks_plan_ready is admitted to the open flow at BOTH Layer 2 and Layer 3.
// Amendment: the open-flow probe is read-only; the story-flow default still self-heals.
// ARCH round 1: the rks_plan_ready handler selects readOnly by the caller's session flowType;
// the read-only report has its own check name, stale_executing_detected.

// Must match the states the implementation chose (named in its code comment).
const CHOSEN_OPEN_STATES = ['concern-separating', 'test-file-scanning', 'writing'];
const OPEN_CHAIN = ['init', 'researching', 'concern-separating', 'test-file-scanning', 'writing'];

let tmpRoot;
beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-gaps-'));
  setProjectRoot(tmpRoot);
});
afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function openSessionAt(state) {
  const { token } = createSession({ projectId: 'admission-gaps-test', flowType: 'open' });
  const hops = OPEN_CHAIN.indexOf(state);
  for (let i = 0; i < hops; i++) advanceState(token, 'rks_agent_research');
  return token;
}

describe('test-failed admits rks_exhaustive_search (Layer 3)', () => {
  it('is allowed', () => {
    expect(checkStateAllowed('story', 'test-failed', 'rks_exhaustive_search').allowed).toBe(true);
  });

  it('self-loops deliberately: no transitions entry', () => {
    const def = getStates('story')['test-failed'];
    expect(Object.hasOwn(def.transitions ?? {}, 'rks_exhaustive_search')).toBe(false);
    expect(getNextState('story', 'test-failed', 'rks_exhaustive_search')).toBe('test-failed');
  });

  it('existing exits are unchanged', () => {
    for (const tool of ['rks_refine', 'rks_refine_apply', 'rks_agent_research', 'rks_agent_external_research']) {
      expect(getNextState('story', 'test-failed', tool), tool).toBe('refining');
    }
    expect(getNextState('story', 'test-failed', 'rks_exec_abort')).toBe('failed');
  });

  it('rks_exec decision is consistent with its transition', () => {
    const admitted = checkStateAllowed('story', 'test-failed', 'rks_exec').allowed;
    if (admitted) {
      expect(getNextState('story', 'test-failed', 'rks_exec')).toBe('executing');
    }
    expect(transitionOnResult('story', 'executing', 'exec.failed')).toBe('test-failed');
  });

  it('rks_plan stays refused at test-failed', () => {
    expect(checkStateAllowed('story', 'test-failed', 'rks_plan').allowed).toBe(false);
  });
});

describe('rks_plan_ready in the open flow (Layer 2 + Layer 3)', () => {
  it('Layer 2: OPEN_FLOW_TOOLS and STORY_FLOW_TOOLS both carry it', () => {
    expect(OPEN_FLOW_TOOLS.has('rks_plan_ready')).toBe(true);
    expect(STORY_FLOW_TOOLS.has('rks_plan_ready')).toBe(true);
  });

  it('Layer 3: every chosen open state admits it', () => {
    for (const state of CHOSEN_OPEN_STATES) {
      expect(checkStateAllowed('open', state, 'rks_plan_ready').allowed, state).toBe(true);
    }
  });

  it('both layers end-to-end via assertToolAllowed', () => {
    for (const state of CHOSEN_OPEN_STATES) {
      const token = openSessionAt(state);
      try {
        expect(assertToolAllowed(token, 'rks_plan_ready'), state).toBeNull();
      } finally {
        endSession(token);
      }
    }
  });

  it('at least one research state admits it', () => {
    const reachable = ['researching', 'concern-separating'].filter(
      (s) => checkStateAllowed('open', s, 'rks_plan_ready').allowed,
    );
    expect(reachable.length).toBeGreaterThan(0);
  });

  it('self-loops in every open state that admits it', () => {
    for (const [name, def] of Object.entries(getStates('open'))) {
      if (!def.allowed?.has('rks_plan_ready')) continue;
      expect(Object.hasOwn(def.transitions ?? {}, 'rks_plan_ready'), name).toBe(false);
      expect(getNextState('open', name, 'rks_plan_ready'), name).toBe(name);
    }
  });

  it('failed stays closed and terminal semantics hold', () => {
    expect(checkStateAllowed('open', 'failed', 'rks_plan_ready').allowed).toBe(false);
    // Pre-change values measured at @9a09ab0ad+dirty: terminalOpen = { review, failed };
    // OPEN_STATES.review and OPEN_STATES.failed both carry `transitions: {}`.
    expect(isTerminal('open', 'failed')).toBe(true);
    expect(isTerminal('open', 'review')).toBe(true);
    expect(getStates('open').failed.transitions).toEqual({});
    expect(getStates('open').review.transitions).toEqual({});
  });

  it('is not added to qa, ship or ops states', () => {
    for (const flow of ['qa', 'ship', 'ops']) {
      for (const state of Object.keys(getStates(flow))) {
        expect(checkStateAllowed(flow, state, 'rks_plan_ready').allowed, `${flow}/${state}`).toBe(false);
      }
    }
  });
});

describe('read-only plan-ready probe (amendment 2026-10-03)', () => {
  const STORY = 'backlog.fix.admission-gaps-fixture';
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  function makeProject(phase) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-gaps-pr-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'notes', `${STORY}.md`),
      `---\nid: ${STORY}\ntitle: fixture\nphase: ${phase}\n---\n\n## Problem\n\nfixture\n`,
    );
    return dir;
  }
  const notePath = (dir) => path.join(dir, 'notes', `${STORY}.md`);

  // A LIVE exec run: findIncompleteRuns (workflow/exec-state.mjs) lists a run whose
  // exec-state.json currentPhase is not complete/idle/failed/aborted.
  function addLiveRun(dir) {
    const rd = path.join(dir, '.rks', 'runs', `2026-10-03T00-00-00-000Z_${STORY.replace(/\./g, '-')}`);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'plan.json'), JSON.stringify({ steps: [] }));
    fs.writeFileSync(
      path.join(rd, 'exec-state.json'),
      JSON.stringify({ storyId: STORY, currentPhase: 'applyingSteps' }),
    );
  }

  const hasCheck = (result, check) => (result.warnings || []).some((w) => w.check === check);

  // readOnly is the decided parameter name (see ## Decisions).
  const readOnly = (projectRoot) =>
    runPlanReadyTool({ projectId: 'test', problemId: STORY, projectRoot, readOnly: true });
  const storyFlow = (projectRoot) =>
    runPlanReadyTool({ projectId: 'test', problemId: STORY, projectRoot });

  it('leaves a stranded executing note byte-identical and reports stale_executing_detected', async () => {
    const dir = makeProject('executing');
    const before = fs.readFileSync(notePath(dir));
    const result = await readOnly(dir);
    expect(fs.readFileSync(notePath(dir)).equals(before)).toBe(true);
    expect(hasCheck(result, 'stale_executing_detected')).toBe(true);
    expect(hasCheck(result, 'stale_executing_self_heal')).toBe(false);
  });

  it('does NOT report stale_executing_detected when a live exec run exists', async () => {
    const dir = makeProject('executing');
    addLiveRun(dir);
    const before = fs.readFileSync(notePath(dir));
    const result = await readOnly(dir);
    expect(fs.readFileSync(notePath(dir)).equals(before)).toBe(true);
    expect(hasCheck(result, 'stale_executing_detected')).toBe(false);
    expect(hasCheck(result, 'stale_executing_self_heal')).toBe(false);
  });

  it('story-flow default never emits stale_executing_detected', async () => {
    const result = await storyFlow(makeProject('executing'));
    expect(hasCheck(result, 'stale_executing_detected')).toBe(false);
  });

  it('story-flow default still self-heals to arch-approved', async () => {
    const dir = makeProject('executing');
    const result = await storyFlow(dir);
    expect((result.warnings || []).some((w) => w.check === 'stale_executing_self_heal')).toBe(true);
    expect(fs.readFileSync(notePath(dir), 'utf8')).toMatch(/^phase:\s*"?arch-approved"?/m);
  });

  it('returns the same issues for an unchanged plannable story', async () => {
    const a = await readOnly(makeProject('arch-approved'));
    const b = await storyFlow(makeProject('arch-approved'));
    expect(a.issues).toEqual(b.issues);
  });
});

describe('rks_plan_ready dispatch selects the read-only path by caller flowType (ARCH round 1)', () => {
  it('isPlanReadyReadOnly: no session means default healing', () => {
    expect(isPlanReadyReadOnly(null)).toBe(false);
    expect(isPlanReadyReadOnly(undefined)).toBe(false);
  });

  it('isPlanReadyReadOnly: story flow heals, every other flow is read-only', () => {
    expect(isPlanReadyReadOnly({ flowType: 'story' })).toBe(false);
    for (const flowType of ['open', 'qa', 'ship', 'ops']) {
      expect(isPlanReadyReadOnly({ flowType }), flowType).toBe(true);
    }
  });

  it('real sessions: open-flow session selects read-only, story-flow session does not', () => {
    const open = createSession({ projectId: 'admission-gaps-test', flowType: 'open' });
    const story = createSession({ projectId: 'admission-gaps-test', problemId: 'backlog.fix.admission-gaps-fixture' });
    try {
      expect(isPlanReadyReadOnly(getSession(open.token))).toBe(true);
      expect(isPlanReadyReadOnly(getSession(story.token))).toBe(false);
    } finally {
      endSession(open.token);
      endSession(story.token);
    }
  });

  // server.mjs is not imported (heavy top-level side effects); witness the handler source instead.
  const serverSrc = fs.readFileSync(path.resolve('packages/mcp-rks/src/server.mjs'), 'utf8');
  const handlerStart = serverSrc.indexOf('if (tool === "rks_plan_ready")');
  const handlerEnd = serverSrc.indexOf('if (tool === "rks_exec")', handlerStart);
  const handler = serverSrc.slice(handlerStart, handlerEnd);

  it('the rks_plan_ready handler resolves the session from a validated token and passes readOnly', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain('validateToken(_governorToken)');
    expect(handler).toContain('getSession(_governorToken)');
    expect(handler).toMatch(/readOnly:\s*isPlanReadyReadOnly\(/);
  });

  it('the rks_plan pre-spawn gate keeps the default healing call', () => {
    const planStart = serverSrc.indexOf('if (tool === "rks_plan")');
    const planEnd = serverSrc.indexOf('if (tool === "rks_plan_review")');
    expect(serverSrc.slice(planStart, planEnd)).not.toContain('readOnly');
  });
});
