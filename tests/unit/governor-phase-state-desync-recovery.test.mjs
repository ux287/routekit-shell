/**
 * backlog.fix.governor-phase-state-desync-and-recovery
 *
 * Three mechanisms, all reachable from the one incident:
 *
 * 1. FAILED CALLS COMMITTED THEIR TRANSITION. advanceState runs on tool ENTRY, before the
 *    tool body, from a single dispatch site. Any call that then failed still moved the chain.
 *    Two rks_agent_research calls died on "Agent exceeded max turns (7)", each having already
 *    demoted `planned` -> `refining`, where rks_exec is forbidden.
 *
 * 2. PHASE AND STATE WEDGED AGAINST EACH OTHER. The story phase had independently advanced to
 *    `executing`, which rks_plan rejects. Neither layer can see the other, so the caller got a
 *    refusal from whichever it hit first with no indication both were blocking.
 *
 * 3. THE RECOVERY WAS UNREACHABLE. rks_exec_abort is the registered recovery for a story
 *    stranded at `executing` — exec.mjs says so in its own error text — but it was absent from
 *    `refining.allowed`, so from the wedged position it was blocked too.
 *
 * Note the liveness invariant gives ZERO coverage for mechanism 3: it is satisfied per-STATE,
 * and `refining` is already live via rks_refine, so admitting a tool with no transition out
 * would leave the suite green while the escape hatch dead-ends. Hence the explicit
 * getNextState assertion below.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getStates, getNextState, classifyChainRefusal } from "../../packages/mcp-rks/src/shared/governor-state.mjs";
import { createSession, advanceState, revertStateOnFailure, getSession, endSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

const FLOW = "story";

describe("failed calls must not keep their entry transition", () => {
  let token;

  beforeEach(() => {
    ({ token } = createSession({ projectId: "test-desync", flowType: FLOW, problemId: "backlog.fix.x" }));
  });

  afterEach(() => {
    try { endSession(token); } catch { /* already ended */ }
  });

  it("a research call that fails from planned leaves the chain in planned", () => {
    // The observed incident, end to end. Post-fix this is defended TWICE and the two
    // defences belong to different stories, so this asserts the composed outcome and is
    // explicit about which layer actually carries it:
    //
    //   - backlog.fix.planned-state-readonly-regression-and-search-admission removed the
    //     `planned` -> `refining` demotion, so a read-only research call no longer moves the
    //     chain at all. That is the FIRST line of defence and it fires here.
    //   - this story's rollback is the SECOND line, for any transition that does fire.
    //
    // Asserting `reverted === true` here would be asserting the second line does work the
    // first line already prevented — it would pass only while the sibling fix is absent.
    const session = getSession(token);
    session.state = "planned";

    const transition = advanceState(token, "rks_agent_research");
    expect(transition.transitioned).toBe(false);
    expect(getSession(token).state).toBe("planned");

    // Rollback is correctly a no-op: there was nothing to give back.
    expect(revertStateOnFailure(token, transition)).toMatchObject({
      reverted: false, reason: "no_transition",
    });
    expect(getSession(token).state).toBe("planned");

    // The property that actually matters, whichever layer delivered it: rks_exec is still
    // reachable after a failed research call. This is what the wedge destroyed.
    expect(getStates(FLOW)[getSession(token).state].allowed.has("rks_exec")).toBe(true);
  });

  it("rolls back a real demotion — init -> refining is given back on failure", () => {
    // `init` demotes on research independently of the planned-state story, so this case
    // exercises a genuine transition regardless of what the sibling story changed.
    const transition = advanceState(token, "rks_agent_research");
    expect(transition.transitioned).toBe(true);
    expect(transition.previousState).toBe("init");
    expect(getSession(token).state).toBe("refining");

    expect(revertStateOnFailure(token, transition).reverted).toBe(true);
    expect(getSession(token).state).toBe("init");
  });

  it("declines the rollback when the session moved on since entry", () => {
    // Conservative by design: if a result transition or a nested call has since moved the
    // session, guessing at the right position would be a new bug rather than a fix.
    const transition = advanceState(token, "rks_agent_research");
    getSession(token).state = "planning";

    const res = revertStateOnFailure(token, transition);
    expect(res.reverted).toBe(false);
    expect(res.reason).toBe("state_moved_since_entry");
    expect(getSession(token).state).toBe("planning");
  });

  it("is a no-op when the tool never transitioned", () => {
    const res = revertStateOnFailure(token, { transitioned: false });
    expect(res.reverted).toBe(false);
    expect(res.reason).toBe("no_transition");
  });

  it("is a no-op for an unknown token rather than throwing", () => {
    const res = revertStateOnFailure("not-a-real-token", {
      transitioned: true, previousState: "planned", newState: "refining",
    });
    expect(res.reverted).toBe(false);
    expect(res.reason).toBe("no_session");
  });
});

describe("rks_exec_abort is reachable from refining", () => {
  it("is admitted in refining", () => {
    expect(getStates(FLOW).refining.allowed.has("rks_exec_abort")).toBe(true);
  });

  it("has a transition OUT — admission alone would dead-end", () => {
    // The load-bearing assertion. The liveness invariant cannot catch this: `refining` stays
    // live via rks_refine, so a tool admitted with no transition leaves the suite green.
    expect(getNextState(FLOW, "refining", "rks_exec_abort")).toBe("failed");
  });

  it("closes the observed wedge — all three exits were shut simultaneously", () => {
    const refining = getStates(FLOW).refining;
    // rks_exec blocked by state (this is correct and unchanged) ...
    expect(refining.allowed.has("rks_exec")).toBe(false);
    // ... so the recovery tool MUST be open, or the position is unrecoverable.
    expect(refining.allowed.has("rks_exec_abort")).toBe(true);
  });
});

describe("classifyChainRefusal — a wedge is diagnosable, not two unrelated errors", () => {
  const phaseAllows = (phase, tool) => !(phase === "executing" && tool === "rks_plan");

  it("reports 'both' when state and phase block independently", () => {
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", storyPhase: "executing",
      tool: "rks_exec", phaseAllows: () => false,
    });
    expect(res.blockedBy).toBe("both");
    expect(res.wedged).toBe(true);
    expect(res.message).toMatch(/WEDGE/);
    // The whole point: say that no single-layer fix helps.
    expect(res.recovery.join(" ")).toMatch(/will not unblock/);
  });

  it("names rks_exec_abort as the way out of a wedge", () => {
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", storyPhase: "executing",
      tool: "rks_exec", phaseAllows: () => false,
    });
    expect(res.recovery.join(" ")).toContain("rks_exec_abort");
  });

  it("reports 'state' when only the chain blocks", () => {
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", storyPhase: "arch-approved",
      tool: "rks_exec", phaseAllows,
    });
    expect(res.blockedBy).toBe("state");
    expect(res.wedged).toBe(false);
  });

  it("reports 'phase' when the chain permits the tool but the story record does not", () => {
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", storyPhase: "executing",
      tool: "rks_plan", phaseAllows,
    });
    expect(res.blockedBy).toBe("phase");
    expect(res.message).toMatch(/story phase/);
  });

  it("reports 'neither' when nothing blocks", () => {
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", storyPhase: "arch-approved",
      tool: "rks_plan", phaseAllows,
    });
    expect(res.blockedBy).toBe("neither");
  });

  it("never reports the phase as clear when the phase is unknown", () => {
    // An unknown phase reported as fine would send the caller down the wrong recovery.
    const res = classifyChainRefusal({
      flowType: FLOW, chainState: "refining", tool: "rks_exec",
    });
    expect(res.blockedBy).toBe("state");
    expect(res.storyPhase).toBeNull();
  });
});
