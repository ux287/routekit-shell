import { describe, it, expect, beforeEach } from "vitest";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";
import { getToken, setToken, getSession, endSession } from "../../packages/mcp-rks/src/shared/governor-token.mjs";

// Finding 4 (notes/research.2026.06.28.uat-findings.md): the problemId-mismatch
// isolation in needsNewSession was hard-gated to flowType==='story', so two qa
// Governors for DIFFERENT stories reused one session/token (carrying over
// toolCallCounts/childQueue/guardrailsDisabled). The fix isolates by problemId for
// ALL problemId-bearing flows; idempotent reuse stays only when no problemId.

function resetSessionState() {
  const t = getToken();
  if (t) { try { endSession(t); } catch { /* ignore */ } }
  try { setToken(null); } catch { /* ignore */ }
}

describe("governor-init session isolation (Finding 4)", () => {
  beforeEach(resetSessionState);

  it("two qa inits with DIFFERENT problemIds yield different tokens (a new session per work-item)", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
    expect(a.token).toBeTruthy();
    expect(b.token).toBeTruthy();
    expect(b.token).not.toBe(a.token);
  });

  it("ends the old session before minting the new one (no stale session lingers)", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
    expect(getSession(a.token)).toBeFalsy();
  });

  it("same qa flow + same problemId re-init is idempotent (same token, state reset, reuse message)", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(b.token).toBe(a.token);
    expect(getSession(b.token).state).toBe("init");
    expect(b.message).toMatch(/reset/i);
    expect(b.message).toMatch(/reused|re-entered/i);
  });

  it("open flow (no problemId) re-init reuses idempotently", () => {
    const a = handleGovernorInit({ projectId: "p" });
    const b = handleGovernorInit({ projectId: "p" });
    expect(b.flowType).toBe("open");
    expect(b.token).toBe(a.token);
  });

  it("no incoming problemId → the problemId-mismatch branch does NOT fire (reuse preserved)", () => {
    const a = handleGovernorInit({ projectId: "p" });
    const b = handleGovernorInit({ projectId: "p" });
    expect(b.token).toBe(a.token);
  });

  it("story flow isolation unchanged: different story → new token, same story → reuse", () => {
    const a = handleGovernorInit({ projectId: "p", problemId: "story-A" });
    const b = handleGovernorInit({ projectId: "p", problemId: "story-B" });
    expect(b.token).not.toBe(a.token);
    const c = handleGovernorInit({ projectId: "p", problemId: "story-B" });
    expect(c.token).toBe(b.token);
  });

  it("a new work-item session does NOT inherit the prior session's mutable state (the carry-over bug)", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const sA = getSession(a.token);
    sA.toolCallCounts = { rks_exec: 5 };
    sA.childQueue = ["child-1"];
    sA.guardrailsDisabled = true;

    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-B" });
    const sB = getSession(b.token);
    expect(sB.problemId).toBe("story-B");
    expect(sB.toolCallCounts).not.toEqual({ rks_exec: 5 });
    expect(sB.childQueue ?? []).not.toContain("child-1");
    expect(sB.guardrailsDisabled === true).toBe(false);
  });
});
