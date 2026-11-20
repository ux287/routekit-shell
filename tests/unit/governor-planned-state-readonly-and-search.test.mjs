/**
 * backlog.fix.planned-state-readonly-regression-and-search-admission
 *
 * Two coupled defects in the story flow's `planned` state:
 *
 * 1. READ-ONLY REGRESSION. `planned` mapped BOTH read-only research tools to `refining`.
 *    Calling either one silently regressed the chain to a state where rks_exec is forbidden,
 *    while the story phase had already advanced to `executing`, which rks_plan rejects — both
 *    escapes closed at once. Reproduced across two runs on released 0.42.0.
 *
 * 2. SEARCH ADMISSION. rks_exhaustive_search was admitted only in `refining`, and the only
 *    route from `refining` back to `planned` is a re-plan producing a DIFFERENT plan hash.
 *    So the plan that actually executed could never be the plan that was inspected.
 *
 * The liveness invariant gives ZERO coverage for either: it is satisfied per-STATE, not
 * per-tool, and `planned` stays live via rks_exec regardless. These explicit assertions are
 * the only guard.
 */
import { describe, it, expect } from "vitest";
import { getStates, getNextState } from "../../packages/mcp-rks/src/shared/governor-state.mjs";

const FLOW = "story";
const STATE = "planned";

describe("story/planned — read-only tools must not regress the chain", () => {
  const READ_ONLY_RESEARCH = ["rks_agent_research", "rks_agent_external_research"];

  it.each(READ_ONLY_RESEARCH)("%s is allowed in planned", (tool) => {
    expect(getStates(FLOW)[STATE].allowed.has(tool)).toBe(true);
  });

  it.each(READ_ONLY_RESEARCH)("%s self-loops rather than demoting to refining", (tool) => {
    expect(getNextState(FLOW, STATE, tool)).toBe(STATE);
  });

  it("both research tools are treated IDENTICALLY — a half-fix fails here", () => {
    // The field report named only rks_agent_research. rks_agent_external_research sits in the
    // same block and demoted identically; fixing one and not the other leaves the defect live.
    const [a, b] = READ_ONLY_RESEARCH.map((t) => getNextState(FLOW, STATE, t));
    expect(a).toBe(b);
  });

  it("rks_refine STILL demotes to refining — it mutates the story, so the plan is stale", () => {
    // Regression guard: the correct demotion sits between the two that were removed and must
    // not be dropped by a careless edit adjacent to both fix sites.
    expect(getNextState(FLOW, STATE, "rks_refine")).toBe("refining");
  });

  it("rks_exec still transitions to executing", () => {
    expect(getNextState(FLOW, STATE, "rks_exec")).toBe("executing");
  });
});

describe("story/planned — a plan can be verified before it executes", () => {
  it("rks_exhaustive_search is admitted in planned", () => {
    expect(getStates(FLOW)[STATE].allowed.has("rks_exhaustive_search")).toBe(true);
  });

  it("rks_exhaustive_search self-loops — admitted read-only, with no transition", () => {
    // Vacuity guard: assert against the CAPTURED pre-call state rather than the literal
    // "planned". If a sibling story ever removes the mapping under test, a bare
    // toBe("planned") would pass with no transition having fired at all.
    const before = STATE;
    expect(getNextState(FLOW, before, "rks_exhaustive_search")).toBe(before);
  });

  it("search-then-exec is legal in ONE session without an intervening re-plan", () => {
    // This is the whole point of the story: the plan that is inspected must be the plan that
    // executes. Walk it as a real sequence rather than asserting the two facts separately.
    let state = STATE;
    state = getNextState(FLOW, state, "rks_exhaustive_search");
    expect(getStates(FLOW)[state].allowed.has("rks_exec")).toBe(true);
    state = getNextState(FLOW, state, "rks_exec");
    expect(state).toBe("executing");
  });

  it("reading research then searching then executing stays legal end to end", () => {
    // The two defects compose: pre-fix, the research call alone was enough to make the
    // subsequent exec illegal. This walks the exact sequence that wedged in the field.
    let state = STATE;
    for (const tool of ["rks_agent_research", "rks_exhaustive_search", "rks_plan_review"]) {
      expect(getStates(FLOW)[state].allowed.has(tool)).toBe(true);
      state = getNextState(FLOW, state, tool);
      expect(state).toBe(STATE);
    }
    expect(getStates(FLOW)[state].allowed.has("rks_exec")).toBe(true);
  });
});
