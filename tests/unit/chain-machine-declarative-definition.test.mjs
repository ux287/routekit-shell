// backlog.feat.chain-machine-declarative-definition: CHAIN_MACHINE is the one declarative
// definition of the governor session/chain state machine (M1). Behaviour-preserving refactor.
//
// TABLE_SNAPSHOT and REFUSAL_SNAPSHOT below were captured from the PRE-change module (before
// any production edit for this story) and are committed inline. They are never regenerated
// from the post-change module: a mismatch means the refactor changed a table.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  CHAIN_MACHINE,
  validateChainMachine,
  getStartState,
  getStates,
  isTerminal,
  checkStateAllowed,
  getNextState,
  transitionOnResult,
  classifyChainRefusal,
  QA_FLOW_TOOLS,
  SHIP_FLOW_TOOLS,
  SHIP_STATES,
  OPS_STATES,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { setProjectRoot, createSession, resetToken, getSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_SRC = path.join(ROOT, "packages/mcp-rks/src/shared/governor-state.mjs");
const INIT_SRC = path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs");
const FLOWS = ["story", "open", "qa", "ship", "ops"];
const TERMINAL = { story: ["shipped", "failed"], open: ["review", "failed"], qa: ["shipped", "failed"], ship: ["shipped", "failed"], ops: ["done"] };

const TABLE_SNAPSHOT = {
  story: {
    "init": {"allowed":["rks_refine","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_agent_dendron","rks_project_get","rks_preflight","rks_analyze","rks_exhaustive_search","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields"],"transitions":{"rks_refine":"refining","rks_agent_research":"refining","rks_agent_external_research":"refining"}},
    "refining": {"allowed":["rks_refine","rks_refine_apply","rks_agent_research","rks_agent_external_research","rks_exhaustive_search","rks_agent_git","rks_plan","rks_plan_ready","rks_preflight","rks_analyze","rks_project_get","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","rks_exec_abort"],"transitions":{"rks_refine":"refining","rks_refine_apply":"refining","rks_exec_abort":"failed","rks_agent_research":"refining","rks_agent_external_research":"refining","rks_plan":"planning"},"resultTransitions":{"refine_apply.decomposed":"decomposing","refine.decompose_suggested":"decompose-gated","refine_apply.noop":"refining","refine_apply.inapplicable":"refining","refine_apply.noop_repeated":"escalated","plan.ok":"planned","plan.failed":"refining"}},
    "decompose-gated": {"allowed":["rks_refine_apply","rks_plan","rks_project_get"],"transitions":{"rks_plan":"planning","rks_refine_apply":"refining"},"resultTransitions":{"refine_apply.decomposed":"decomposing"}},
    "planning": {"allowed":["rks_plan_review","rks_agent_git","rks_project_get","rks_refine","rks_refine_apply"],"transitions":{"rks_refine":"refining","rks_refine_apply":"refining"},"resultTransitions":{"plan.ok":"planned","plan.failed":"refining"}},
    "planned": {"allowed":["rks_exec","rks_plan_review","rks_agent_git","rks_project_get","rks_refine","rks_plan","rks_agent_research","rks_agent_external_research","rks_exhaustive_search"],"transitions":{"rks_exec":"executing","rks_refine":"refining","rks_plan":"planning"}},
    "executing": {"allowed":["rks_exec_abort","rks_agent_git","rks_project_get","rks_exec"],"transitions":{"rks_exec_abort":"failed"},"resultTransitions":{"exec.ok":"executed","exec.failed":"test-failed","exec.diverged":"diverged","exec.needs_approval":"approval-pending","exec.no_actions":"refining","exec.error":"refining"}},
    "approval-pending": {"allowed":["rks_approve","rks_agent_git","rks_project_get"],"transitions":{"rks_approve":"approval-pending"},"resultTransitions":{"approve.ok":"executing","approve.denied":"failed"}},
    "diverged": {"allowed":["rks_refine","rks_refine_apply","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_project_get"],"transitions":{"rks_refine":"refining","rks_refine_apply":"refining","rks_agent_research":"refining","rks_agent_external_research":"refining"}},
    "test-failed": {"allowed":["rks_refine","rks_refine_apply","rks_exec_abort","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_project_get","rks_exhaustive_search"],"transitions":{"rks_refine":"refining","rks_refine_apply":"refining","rks_exec_abort":"failed","rks_agent_research":"refining","rks_agent_external_research":"refining"}},
    "executed": {"allowed":["rks_ship","rks_story_ship","rks_agent_git","rks_project_get","rks_exhaustive_search","dendron_read_note"],"transitions":{"rks_ship":"shipping","rks_story_ship":"shipping"}},
    "shipping": {"allowed":["rks_agent_git","rks_project_get"],"resultTransitions":{"ship.ok":"shipped","ship.failed":"executed"}},
    "decomposing": {"allowed":["rks_refine","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_project_get","dendron_read_note"],"transitions":{"rks_refine":"child_active","rks_agent_research":"child_active","rks_agent_external_research":"child_active"}},
    "child_active": {"allowed":["rks_refine","rks_refine_apply","rks_agent_research","rks_agent_external_research","rks_exhaustive_search","rks_agent_git","rks_plan","rks_plan_ready","rks_plan_review","rks_exec","rks_exec_abort","rks_ship","rks_preflight","rks_analyze","rks_project_get","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields"],"transitions":{"rks_refine":"child_active","rks_refine_apply":"child_active","rks_agent_research":"child_active","rks_agent_external_research":"child_active","rks_plan":"child_active","rks_exec":"child_active","rks_ship":"child_active"},"resultTransitions":{"child.complete":"child_active","child.failed":"failed","exec.ok":"child_active","exec.failed":"failed","plan.ok":"child_active","plan.failed":"child_active","ship.ok":"child_active","ship.failed":"child_active","refine_apply.noop":"child_active","refine_apply.inapplicable":"child_active","refine_apply.noop_repeated":"escalated"}},
    "shipped": {"allowed":["rks_project_get"],"transitions":{}},
    "escalated": {"allowed":["rks_exec_abort","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_project_get","dendron_read_note"],"transitions":{"rks_exec_abort":"failed"},"resultTransitions":{}},
    "failed": {"allowed":["rks_project_get"],"transitions":{}},
  },
  open: {
    "init": {"allowed":["rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_recovery","rks_agent_git","rks_agent_dendron","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","dendron_rename_note","rks_inbox_review","rks_rag_query","rks_arch_verdict","rks_project_get","rks_preflight"],"transitions":{"rks_agent_research":"researching","rks_agent_external_research":"researching","dendron_create_note":"writing","dendron_edit_note":"writing"}},
    "researching": {"allowed":["rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_git","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","rks_arch_verdict","rks_project_get"],"transitions":{"rks_agent_research":"concern-separating","rks_agent_external_research":"researching","dendron_create_note":"researching"}},
    "concern-separating": {"allowed":["rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_git","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","rks_arch_verdict","rks_project_get","rks_plan_ready"],"transitions":{"rks_agent_research":"test-file-scanning","rks_agent_external_research":"concern-separating","dendron_create_note":"concern-separating"}},
    "test-file-scanning": {"allowed":["rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_git","rks_agent_dendron","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","rks_arch_verdict","rks_project_get","rks_plan_ready"],"transitions":{"rks_agent_research":"writing","rks_agent_external_research":"test-file-scanning"}},
    "writing": {"allowed":["dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","dendron_rename_note","rks_inbox_review","rks_arch_verdict","rks_agent_research","rks_agent_external_research","rks_fetch_raw","rks_exhaustive_search","rks_agent_git","rks_project_get","rks_plan_ready","rks_rag_query"],"transitions":{"dendron_create_note":"writing","dendron_edit_note":"writing","dendron_read_note":"writing","dendron_update_field":"writing","dendron_update_fields":"writing","dendron_rename_note":"writing","rks_inbox_review":"writing","rks_agent_research":"writing","rks_agent_external_research":"writing"}},
    "review": {"allowed":["rks_project_get"],"transitions":{}},
    "failed": {"allowed":["rks_project_get"],"transitions":{}},
  },
  qa: {
    "init": {"allowed":["rks_governor_init","rks_agent_research","rks_agent_external_research","rks_agent_git","rks_project_get","rks_preflight","dendron_read_note","dendron_update_field","dendron_update_fields"],"transitions":{"rks_agent_research":"researching","rks_agent_external_research":"researching"}},
    "researching": {"allowed":["rks_agent_research","rks_agent_external_research","rks_agent_git","rks_agent_run","rks_exhaustive_search","dendron_create_note","dendron_edit_note","dendron_read_note","dendron_update_field","dendron_update_fields","rks_project_get"],"transitions":{"rks_agent_research":"researching","rks_agent_external_research":"researching","rks_agent_run":"qa_testing"},"resultTransitions":{"research.complete":"qa_testing"}},
    "qa_testing": {"allowed":["rks_agent_git","rks_agent_run","rks_project_get","dendron_read_note"],"transitions":{"rks_agent_run":"qa_testing"},"resultTransitions":{"qa.tests_complete":"qa_assessing","qa.tests_failed":"failed"}},
    "qa_assessing": {"allowed":["dendron_create_note","dendron_edit_note","dendron_update_field","dendron_update_fields","rks_project_get"],"transitions":{},"resultTransitions":{"qa.assessment_pass":"qa_reporting","qa.assessment_fail":"failed"}},
    "qa_reporting": {"allowed":["dendron_create_note","dendron_edit_note","dendron_update_field","dendron_update_fields","rks_project_get"],"transitions":{},"resultTransitions":{"qa.report_complete":"shipped","qa.report_failed":"failed"}},
    "shipped": {"allowed":["rks_project_get"],"transitions":{}},
    "failed": {"allowed":["rks_project_get"],"transitions":{}},
  },
  ship: {
    "init": {"allowed":["rks_git_commit","rks_git_state","rks_agent_git","rks_project_get"],"transitions":{"rks_git_commit":"init","rks_git_state":"init"},"resultTransitions":{"git_commit.ok":"committed","git_commit.error":"failed"}},
    "committed": {"allowed":["rks_git_push","rks_staging_pr","rks_git_merge","rks_cycle_complete","rks_agent_git","rks_project_get"],"transitions":{"rks_git_push":"committed","rks_staging_pr":"committed","rks_git_merge":"committed","rks_cycle_complete":"committed"},"resultTransitions":{"git_push.ok":"committed","git_push.error":"failed","staging_pr.ok":"pr_created","staging_pr.error":"failed","git_merge.ok":"merging","git_merge.error":"failed","cycle_complete.ok":"shipped","cycle_complete.error":"failed"}},
    "pr_created": {"allowed":["rks_git_merge","rks_staging_merge","rks_agent_git","rks_project_get"],"transitions":{"rks_git_merge":"pr_created","rks_staging_merge":"pr_created"},"resultTransitions":{"git_merge.ok":"merging","git_merge.error":"failed","staging_merge.ok":"merging","staging_merge.error":"failed"}},
    "merging": {"allowed":["rks_cycle_complete","rks_agent_git","rks_project_get"],"transitions":{"rks_cycle_complete":"merging"},"resultTransitions":{"cycle_complete.ok":"shipped","cycle_complete.error":"failed","ship.ok":"shipped"}},
    "shipped": {"allowed":["rks_project_get"],"transitions":{}},
    "failed": {"allowed":["rks_project_get"],"transitions":{}},
  },
  ops: {
    "init": {"allowed":["rks_agent_run","rks_agent_research","rks_exhaustive_search","rks_agent_recovery","rks_agent_git","rks_project_get","rks_preflight","rks_release","rks_promote","rks_sync_staging","rks_tag"],"transitions":{"rks_agent_run":"executing","rks_release":"executing","rks_promote":"executing","rks_agent_recovery":"executing"},"resultTransitions":{}},
    "executing": {"allowed":["rks_agent_run","rks_agent_research","rks_exhaustive_search","rks_agent_git","rks_project_get","rks_release","rks_promote","rks_sync_staging","rks_tag"],"transitions":{"rks_agent_run":"executing","rks_release":"executing","rks_promote":"executing","rks_cycle_complete":"executing"},"resultTransitions":{"cycle_complete.ok":"done"}},
    "done": {"allowed":["rks_project_get"],"transitions":{}},
  },
};

const REFUSAL_SNAPSHOT = {
  story: {"allowed":false,"error":"Tool 'no_such_tool_x' is not allowed in state 'init' (story flow). Allowed tools: rks_refine, rks_agent_research, rks_agent_external_research, rks_agent_git, rks_agent_dendron, rks_project_get, rks_preflight, rks_analyze, rks_exhaustive_search, dendron_create_note, dendron_edit_note, dendron_read_note, dendron_update_field, dendron_update_fields"},
  open: {"allowed":false,"error":"Tool 'no_such_tool_x' is not allowed in state 'init' (open flow). Allowed tools: rks_agent_research, rks_agent_external_research, rks_fetch_raw, rks_exhaustive_search, rks_agent_recovery, rks_agent_git, rks_agent_dendron, dendron_create_note, dendron_edit_note, dendron_read_note, dendron_update_field, dendron_update_fields, dendron_rename_note, rks_inbox_review, rks_rag_query, rks_arch_verdict, rks_project_get, rks_preflight"},
  qa: {"allowed":false,"error":"Tool 'no_such_tool_x' is not allowed in state 'init' (qa flow). Allowed tools: rks_governor_init, rks_agent_research, rks_agent_external_research, rks_agent_git, rks_project_get, rks_preflight, dendron_read_note, dendron_update_field, dendron_update_fields"},
  ship: {"allowed":false,"error":"Tool 'no_such_tool_x' is not allowed in state 'init' (ship flow). Allowed tools: rks_git_commit, rks_git_state, rks_agent_git, rks_project_get"},
  ops: {"allowed":false,"error":"Tool 'no_such_tool_x' is not allowed in state 'init' (ops flow). Allowed tools: rks_agent_run, rks_agent_research, rks_exhaustive_search, rks_agent_recovery, rks_agent_git, rks_project_get, rks_preflight, rks_release, rks_promote, rks_sync_staging, rks_tag"},
  unknownState: {"allowed":false,"error":"Unknown state 'no-such-state' in story flow"},
};

// Deep copy of the machine that a single-defect case may mutate. structuredClone keeps the
// allowed Sets as Sets and drops the freeze, so the copy is mutable.
function cloneMachine() {
  return structuredClone({ ...CHAIN_MACHINE });
}

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chain-machine-"));
  setProjectRoot(tmpRoot);
  resetToken();
});
afterEach(() => {
  resetToken();
  setProjectRoot(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("CHAIN_MACHINE declarative definition", () => {
  it("exports a frozen CHAIN_MACHINE whose flow states are the getStates tables", () => {
    expect(Object.isFrozen(CHAIN_MACHINE)).toBe(true);
    expect(Object.keys(CHAIN_MACHINE).sort()).toEqual([...FLOWS].sort());
    for (const f of FLOWS) {
      expect(Array.isArray(CHAIN_MACHINE[f].terminal), f).toBe(true);
      expect(typeof CHAIN_MACHINE[f].start, f).toBe("string");
      expect(typeof CHAIN_MACHINE[f].states, f).toBe("object");
      // backlog.feat.admission-decision-table-decide: getStates returns a derived view (the machine's
      // states plus the admission table's per-state tools as `allowed`), not CHAIN_MACHINE[f].states.
      // The view has the machine's states, in order, and shares their transition tables by reference.
      const view = getStates(f);
      expect(Object.keys(view), f).toEqual(Object.keys(CHAIN_MACHINE[f].states));
      for (const [s, def] of Object.entries(CHAIN_MACHINE[f].states)) {
        for (const k of ["transitions", "resultTransitions"]) {
          if (Object.hasOwn(def, k)) expect(view[s][k], `${f}/${s} ${k}`).toBe(def[k]);
        }
      }
    }
  });

  it("getStates tables equal the pre-change snapshot", () => {
    for (const f of FLOWS) {
      const states = getStates(f);
      const snap = TABLE_SNAPSHOT[f];
      expect(Object.keys(states), f).toEqual(Object.keys(snap));
      for (const s of Object.keys(snap)) {
        const def = states[s];
        const want = snap[s];
        // Own properties, including absence of transitions / resultTransitions.
        expect(Object.keys(def), `${f}/${s} keys`).toEqual(Object.keys(want));
        expect(def.allowed, `${f}/${s} allowed`).toBeInstanceOf(Set);
        expect([...def.allowed], `${f}/${s} allowed order`).toEqual(want.allowed);
        for (const k of ["transitions", "resultTransitions"]) {
          expect(Object.hasOwn(def, k), `${f}/${s} has ${k}`).toBe(Object.hasOwn(want, k));
          if (Object.hasOwn(want, k)) {
            expect(Object.entries(def[k]), `${f}/${s} ${k}`).toEqual(Object.entries(want[k]));
          }
        }
      }
    }
  });

  it("isTerminal matches the pre-change terminal sets for every flow and state", () => {
    for (const f of FLOWS) {
      for (const s of Object.keys(getStates(f))) {
        expect(isTerminal(f, s), `${f}/${s}`).toBe(TERMINAL[f].includes(s));
      }
    }
    for (const s of Object.keys(getStates("story"))) {
      expect(isTerminal("no-such-flow", s), s).toBe(TERMINAL.story.includes(s));
      expect(isTerminal(undefined, s), s).toBe(TERMINAL.story.includes(s));
    }
  });

  it("isTerminal holds no literal terminal Set", () => {
    const src = fs.readFileSync(STATE_SRC, "utf8");
    const start = src.search(/export function isTerminal\(/);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 1);
    const nextExport = rest.search(/\n\s*export\b/);
    expect(nextExport).toBeGreaterThan(0);
    const body = rest.slice(0, nextExport);
    expect(body).toContain("terminal");
    expect(body).not.toContain("new Set(");
  });

  it("getStates falls back to the story table for an unrecognised or undefined flowType", () => {
    // backlog.feat.admission-decision-table-decide: the fallback is the derived story view.
    expect(getStates("no-such-flow")).toBe(getStates("story"));
    expect(getStates(undefined)).toBe(getStates("story"));
    expect(Object.keys(getStates("no-such-flow"))).toEqual(Object.keys(CHAIN_MACHINE.story.states));
  });

  it("getStartState returns init for every flow and for an unrecognised flowType", () => {
    for (const f of [...FLOWS, "no-such-flow", undefined]) expect(getStartState(f), String(f)).toBe("init");
  });

  it("createSession falls back to getStartState and honours a valid initialState", () => {
    for (const f of FLOWS) {
      const none = createSession({ projectId: `p-${f}`, flowType: f });
      expect(none.flowType, f).toBe(f);
      expect(none.session.state, `${f} no initialState`).toBe(getStartState(f));
      const bogus = createSession({ projectId: `p-${f}`, flowType: f, initialState: "no-such-state" });
      expect(bogus.session.state, `${f} bogus initialState`).toBe(getStartState(f));
      const valid = Object.keys(getStates(f)).find((s) => s !== getStartState(f));
      expect(valid, f).toBeTruthy();
      const honoured = createSession({ projectId: `p-${f}`, flowType: f, initialState: valid });
      expect(honoured.session.state, `${f} valid initialState`).toBe(valid);
    }
  });

  it("handleGovernorInit starts a fresh session of every flow in getStartState", () => {
    for (const f of FLOWS) {
      const input = { projectId: `p-init-${f}`, flowType: f };
      if (f === "story" || f === "qa") input.problemId = `backlog.fix.no-such-note-${f}`;
      const res = handleGovernorInit(input);
      expect(res.ok, `${f}: ${res.message}`).toBe(true);
      expect(res.flowType, f).toBe(f);
      expect(res.state, f).toBe(getStartState(f));
      expect(res.seededFrom, f).toBeUndefined();
      expect(getSession(res.token).state, f).toBe(getStartState(f));
    }
  });

  it("governor-init.mjs reads the start state from getStartState", () => {
    const src = fs.readFileSync(INIT_SRC, "utf8");
    expect(src).not.toMatch(/['"`]init['"`]/);
    expect(src).toContain("getStartState(flowType)");
    expect(src).toMatch(/import\s*\{[^}]*\bgetStartState\b[^}]*\}\s*from\s*["']\.\.\/shared\/governor-state\.mjs["']/);
  });

  it("validateChainMachine accepts the shipped machine", () => {
    expect(() => validateChainMachine(CHAIN_MACHINE)).not.toThrow();
    // Absent keys are read as empty and never added at load.
    expect(Object.hasOwn(CHAIN_MACHINE.story.states.shipping, "transitions")).toBe(false);
    // A copy whose only change is deleting one non-terminal state's transitions key passes.
    const copy = cloneMachine();
    const victim = Object.entries(copy.story.states)
      .find(([s, d]) => !copy.story.terminal.includes(s) && Object.hasOwn(d, "transitions"));
    expect(victim).toBeTruthy();
    delete victim[1].transitions;
    expect(() => validateChainMachine(copy)).not.toThrow();
  });

  it("validateChainMachine rejects each single-defect copy naming the flow and state", () => {
    const cases = [
      {
        name: "start not a state",
        mutate: (m) => { m.qa.start = "nowhere"; },
        expectIn: ["qa", "nowhere"],
      },
      {
        name: "terminal entry not a state",
        mutate: (m) => { m.ship.terminal = [...m.ship.terminal, "ghost-terminal"]; },
        expectIn: ["ship", "ghost-terminal"],
      },
      // backlog.feat.admission-decision-table-decide: a state no longer carries an allowed Set (the
      // admission table holds per-state tools), so the former "state with no allowed Set" defect is
      // replaced by a state definition that is not an object.
      {
        name: "state definition not an object",
        mutate: (m) => { m.open.states.init = null; },
        expectIn: ["open", "init"],
      },
      {
        name: "transitions target not a state",
        mutate: (m) => { m.story.states.init.transitions = { ...(m.story.states.init.transitions ?? {}), rks_refine: "phantom-target" }; },
        expectIn: ["story", "init", "phantom-target"],
      },
      {
        name: "resultTransitions target not a state",
        mutate: (m) => { m.ops.states.init.resultTransitions = { ...(m.ops.states.init.resultTransitions ?? {}), "x.ok": "phantom-result" }; },
        expectIn: ["ops", "init", "phantom-result"],
      },
      {
        name: "terminal state with an outgoing transition",
        mutate: (m) => { m.story.states.shipped.transitions = { rks_refine: "init" }; },
        expectIn: ["story", "shipped"],
      },
    ];
    for (const c of cases) {
      const copy = cloneMachine();
      c.mutate(copy);
      let thrown = null;
      try { validateChainMachine(copy); } catch (e) { thrown = e; }
      expect(thrown, c.name).toBeInstanceOf(Error);
      for (const needle of c.expectIn) expect(thrown.message, `${c.name}: ${needle}`).toContain(needle);
    }
  });

  it("the file header describes the five-flow CHAIN_MACHINE and every story state", () => {
    const src = fs.readFileSync(STATE_SRC, "utf8");
    const firstTable = src.search(/const [A-Z]+_STATES = \{/);
    expect(firstTable).toBeGreaterThan(0);
    const header = src.slice(0, firstTable);
    expect(header).toMatch(/five flow/i);
    expect(header).not.toMatch(/four flow/i);
    for (const f of FLOWS) expect(header, f).toContain(`'${f}'`);
    expect(header).toContain("CHAIN_MACHINE");
    for (const s of Object.keys(CHAIN_MACHINE.story.states)) {
      expect(header, s).toMatch(new RegExp(`(^|[^A-Za-z_-])${s.replace(/[-]/g, "\\-")}([^A-Za-z_-]|$)`, "m"));
    }
  });

  it("existing exports keep their names and results", () => {
    for (const fn of [getStates, checkStateAllowed, getNextState, transitionOnResult, isTerminal, classifyChainRefusal]) {
      expect(typeof fn).toBe("function");
    }
    expect(QA_FLOW_TOOLS).toBeDefined();
    expect(SHIP_FLOW_TOOLS).toBeDefined();
    expect(SHIP_STATES).toBe(getStates("ship"));
    expect(OPS_STATES).toBe(getStates("ops"));
    for (const f of FLOWS) {
      expect(checkStateAllowed(f, "init", "no_such_tool_x"), f).toEqual(REFUSAL_SNAPSHOT[f]);
    }
    expect(checkStateAllowed("story", "no-such-state", "rks_plan")).toEqual(REFUSAL_SNAPSHOT.unknownState);
  });
});
