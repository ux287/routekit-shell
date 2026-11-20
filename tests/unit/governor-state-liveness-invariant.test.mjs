/**
 * Witness for backlog.fix.planning-state-deadlock-no-exit — the GENERAL invariant.
 *
 * THE DEFECT, specifically: `story/planning` held three tools and `transitions: {}`. No tool call
 * moved you out; the only exits were `resultTransitions`, which fire on a plan RESULT. When
 * `rks_plan` returns `not_ready` from its pre-spawn readiness gate, no worker spawns, so no result
 * ever arrives and neither exit can fire. The session parks — and every tool that could fix the
 * blocking issue (rks_refine, rks_refine_apply, rks_exhaustive_search, the dendron pair) was
 * absent. The cure was unreachable from the disease.
 *
 * WHY THIS FILE IS TABLE-DRIVEN RATHER THAN `planning`-SPECIFIC. A test asserting only that
 * `planning` is now live would go green and catch nothing else. The invariant below holds over
 * EVERY state in EVERY flow, so the next state wired this way fails here instead of wedging a
 * build in production.
 *
 * THE DEFINITION, and why each clause is load-bearing:
 *
 *   A non-terminal state is LIVE iff  ∃ T. T ∈ state.allowed  ∧  T ∈ keys(state.transitions ?? {})
 *
 *   - `resultTransitions` deliberately does NOT count. `planning` already had a non-empty
 *     resultTransitions map, so any invariant phrased as "has some exit" would have passed it
 *     vacuously — the exact state this story exists to fix.
 *   - The transitioning tool must itself be in `allowed`, or a state passes on an edge its
 *     Governor may never invoke.
 *   - `?? {}` is not defensive padding: `story/shipping` declares no `transitions` key at all.
 *   - Terminal states are exempt via the real `isTerminal()`, never a hardcoded list, so the
 *     exemption cannot drift away from the implementation.
 */
import { describe, it, expect } from "vitest";
import {
  getStates,
  isTerminal,
} from "../../packages/mcp-rks/src/shared/governor-state.mjs";

/** Every flow whose state table this invariant covers. */
const FLOWS = ["story", "open", "qa", "ship", "ops"];

/**
 * States that are legitimately non-live because they are AWAITING AN ASYNC RESULT rather than a
 * tool call. Asserted by EXACT SET EQUALITY below, not by membership — so a newly-dead state
 * cannot be quietly absorbed into the exemption. Adding one here is a conscious act that breaks
 * the equality assertion until someone justifies it.
 *
 * `story/planning` is deliberately ABSENT: it was the bug, and after this story it is live.
 * `story/shipping` is exempt on behaviour, not shape — it is entered via rks_ship/rks_story_ship,
 * synchronous handlers that ALWAYS emit ship.ok or ship.failed. `planning` was the bug precisely
 * because its pre-spawn gate could return WITHOUT emitting.
 */
const AWAITING_RESULT_EXEMPT = new Set([
  "story/shipping",
  "qa/qa_assessing",
  "qa/qa_reporting",
]);

/** Every (flow, state) pair in the table. */
function allStates() {
  const out = [];
  for (const flow of FLOWS) {
    for (const [name, def] of Object.entries(getStates(flow) ?? {})) {
      out.push({ flow, name, def, key: `${flow}/${name}` });
    }
  }
  return out;
}

function isLive(def) {
  const allowed = def.allowed ?? new Set();
  return Object.keys(def.transitions ?? {}).some((tool) => allowed.has(tool));
}

describe("THE INVARIANT: every non-terminal state has a progress-making move", () => {
  it("the table is non-empty and the walk actually visits it", () => {
    // Positive control. Without this, a broken import or a renamed export would make every
    // assertion below iterate an empty list and pass vacuously.
    const states = allStates();
    expect(states.length).toBeGreaterThan(20);
    expect(states.map((s) => s.key)).toContain("story/planning");
  });

  it("no non-terminal, non-exempt state is dead", () => {
    const dead = allStates()
      .filter((s) => !isTerminal(s.flow, s.name))
      .filter((s) => !AWAITING_RESULT_EXEMPT.has(s.key))
      .filter((s) => !isLive(s.def))
      .map((s) => s.key);

    expect(
      dead,
      `dead state(s) — permitted tools exist but none changes state, so a Governor here has no ` +
        `legal move that makes progress: ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("the exemption list is EXACTLY these three — no silent absorption", () => {
    // If a future edit deadlocks a state, the honest fix is to wire it, not to add it here. Exact
    // equality forces that conversation instead of letting the list grow quietly.
    const actualNonLive = allStates()
      .filter((s) => !isTerminal(s.flow, s.name))
      .filter((s) => !isLive(s.def))
      .map((s) => s.key)
      .sort();

    expect(actualNonLive).toEqual([...AWAITING_RESULT_EXEMPT].sort());
  });

  it("story/planning is NOT exempt — the invariant must bite on the bug, not excuse it", () => {
    // The assertion that stops this whole file from being theatre.
    expect(AWAITING_RESULT_EXEMPT.has("story/planning")).toBe(false);
  });

  it("every transition target names a real state in the same flow", () => {
    for (const { flow, name, def } of allStates()) {
      for (const [tool, target] of Object.entries(def.transitions ?? {})) {
        expect(
          getStates(flow)[target],
          `${flow}/${name}: tool ${tool} transitions to unknown state '${target}'`,
        ).toBeDefined();
      }
    }
  });

  it("every transitioning tool is also permitted in its own state", () => {
    // A transition keyed on a tool the state forbids is unreachable — it would make a dead state
    // look live to a naive predicate. That is why `isLive` intersects the two rather than just
    // checking `transitions` is non-empty.
    //
    // KNOWN_DEAD_TRANSITIONS records pre-existing violations this story is NOT chartered to fix.
    // ARCH reviewed the ops/executing case explicitly and ruled it out of scope ("unreachable dead
    // config … do not expand scope to governor-state.mjs"), so it is listed rather than repaired.
    // Exact-membership listing, not a wildcard: a NEW violation still fails, and this entry is a
    // visible marker rather than a silent tolerance.
    const KNOWN_DEAD_TRANSITIONS = new Set([
      "ops/executing:rks_cycle_complete",
    ]);

    const violations = [];
    for (const { flow, name, def } of allStates()) {
      for (const tool of Object.keys(def.transitions ?? {})) {
        const key = `${flow}/${name}:${tool}`;
        if (KNOWN_DEAD_TRANSITIONS.has(key)) continue;
        if (!(def.allowed ?? new Set()).has(tool)) violations.push(key);
      }
    }

    expect(
      violations,
      `transition(s) keyed on a tool the state does not permit — the edge can never be taken: ` +
        `${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("the known-dead list is still accurate — entries that got fixed must be removed", () => {
    // Guards the exemption in the other direction. If someone repairs ops/executing, this fails
    // and the stale entry gets deleted, instead of lingering and masking a future regression at
    // the same key.
    const opsExecuting = getStates("ops")?.executing;
    expect(opsExecuting, "ops/executing not found").toBeDefined();
    expect(
      opsExecuting.allowed.has("rks_cycle_complete"),
      "ops/executing now permits rks_cycle_complete — remove it from KNOWN_DEAD_TRANSITIONS",
    ).toBe(false);
  });
});

describe("story/planning specifically — the deadlock is gone", () => {
  const planning = getStates('story').planning;

  it("is live", () => {
    expect(isLive(planning)).toBe(true);
  });

  it("permits the recovery pair that fixes what parks you here", () => {
    // The blocking issue that strands a session here is a missing @@SEARCH anchor, and these are
    // the sanctioned tools for adding one.
    expect(planning.allowed.has("rks_refine")).toBe(true);
    expect(planning.allowed.has("rks_refine_apply")).toBe(true);
  });

  it("both recovery tools EXIT rather than self-loop — planning stays transient", () => {
    // (a) risked turning `planning` into a general-purpose state. Exiting to `refining` is what
    // keeps it a waypoint, and `refining` already carries the rest of the toolkit.
    expect(planning.transitions.rks_refine).toBe("refining");
    expect(planning.transitions.rks_refine_apply).toBe("refining");
  });

  it("one hop restores the full recovery toolkit", () => {
    const refining = getStates('story').refining;
    for (const tool of ["rks_exhaustive_search", "rks_plan_ready", "dendron_edit_note", "dendron_read_note"]) {
      expect(refining.allowed.has(tool), `refining must permit ${tool}`).toBe(true);
    }
  });

  it("the existing plan resultTransitions still hold", () => {
    expect(planning.resultTransitions["plan.ok"]).toBe("planned");
    expect(planning.resultTransitions["plan.failed"]).toBe("refining");
  });

  it("out-of-phase tools are still rejected — the state was widened, not opened", () => {
    for (const tool of ["rks_exec", "rks_ship", "rks_approve"]) {
      expect(planning.allowed.has(tool), `planning must NOT permit ${tool}`).toBe(false);
    }
  });
});

describe("a plan result arriving in `refining` is honoured, not discarded", () => {
  // ARCH's blocking finding. `planning` now escapes to `refining` via the recovery pair. If that
  // hatch is taken while a plan worker is genuinely in flight, the result lands while the session
  // sits in `refining` — and `transitionOnResult` returns the CURRENT state on a missing key, so
  // without these the plan.ok is silently swallowed and the session strands in `refining`, where
  // rks_exec is not permitted. Not a deadlock; a lost plan.
  const refining = getStates('story').refining;

  it("plan.ok routes to planned", () => {
    expect(refining.resultTransitions["plan.ok"]).toBe("planned");
  });

  it("plan.failed keeps you in refining", () => {
    expect(refining.resultTransitions["plan.failed"]).toBe("refining");
  });

  it("the addition was purely additive — the refine result keys are intact", () => {
    expect(refining.resultTransitions["refine_apply.decomposed"]).toBe("decomposing");
    expect(refining.resultTransitions["refine_apply.noop"]).toBe("refining");
    expect(refining.resultTransitions["refine_apply.noop_repeated"]).toBe("escalated");
  });

  it("`refining` permits rks_exec's prerequisite path out", () => {
    // Sanity: reaching `planned` from `refining` is what makes honouring plan.ok useful.
    expect(getStates('story').planned.allowed.has("rks_exec")).toBe(true);
  });
});
