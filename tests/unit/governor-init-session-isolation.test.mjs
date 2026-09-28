import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleGovernorInit } from "../../packages/mcp-rks/src/tools/governor-init.mjs";
import { getToken, setToken, getSession, endSession, setProjectRoot, advanceState } from "../../packages/mcp-rks/src/shared/governor-token.mjs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

  it("same qa flow + same problemId re-init RESUMES: same token, chain state preserved, mode 'resumed'", () => {
    // REPLACES a pin on the old destroy-on-re-entry contract. That test re-entered a session
    // still at "init" and asserted toBe("init") — which held whether the handler resumed or
    // reset, so it could not tell the two apart. The state is driven AWAY from "init" first
    // for exactly that reason: only a preserved state can satisfy this now.
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    getSession(a.token).state = "qa_assessing";

    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(b.token).toBe(a.token);
    expect(getSession(b.token).state).toBe("qa_assessing");
    expect(b.mode).toBe("resumed");
    // The response must report the state the caller is actually in, not a constant.
    expect(b.state).toBe(getSession(b.token).state);
    // Narrow: the message NAMES the reset escape hatch, so a bare /reset/i would match the
    // guidance and prove nothing. Only the old verdict phrase is forbidden.
    expect(b.message).not.toMatch(/session reset/i);
    expect(b.message).toMatch(/resum/i);
    expect(b.message).toMatch(/reset\s*[:]\s*true/);
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

describe("governor-init staleness gate is gone (backlog.fix.governor-init-dead-staleness-gate)", () => {
  beforeEach(() => {
    const t = getToken();
    if (t) endSession(t);
    setToken(null);
  });

  it("re-init resets an AGED session identically to a fresh one — the 60s threshold was inert", () => {
    // The coverage gap this story closes. `lastActivity` had ZERO assertions anywhere in the
    // tree, so nothing proved the reset survived an aged session — which is exactly what made
    // the orphaned STALE_MS/isStale trio look load-bearing. Age the session well past the
    // deleted 60s threshold and assert the reuse path is unchanged.
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const sessionA = getSession(a.token);
    sessionA.state = "refining";
    sessionA.lastActivity = Date.now() - 120_000; // 2 minutes — double the removed threshold

    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });

    // Same token: age must NOT cause a new session to be minted.
    expect(b.token).toBe(a.token);
    // Age-independence now means the RESUME survives ageing. "refining" was already set above,
    // so this fails on any implementation that resets — which is what it exists to catch.
    expect(getSession(b.token).state).toBe("refining");
    expect(b.mode).toBe("resumed");
    expect(b.message).not.toMatch(/session reset/i);
  });

  it("a fresh session and an aged one take the same branch", () => {
    // Pins age-independence as a property rather than a single sampled age.
    const fresh = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    const freshMessage = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" }).message;

    endSession(getToken());
    setToken(null);

    const aged = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    getSession(aged.token).lastActivity = Date.now() - 3_600_000; // an hour
    const agedMessage = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" }).message;

    expect(agedMessage).toBe(freshMessage);
    expect(fresh.token).toBeTruthy();
  });
});

describe("re-entry contract: resume, forced reset, terminal auto-reset", () => {
  beforeEach(resetSessionState);

  it("reset: true ends the live session and mints a NEW token at init, mode 'reset'", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    getSession(a.token).state = "qa_assessing";

    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A", reset: true });
    expect(b.token).not.toBe(a.token);
    expect(b.mode).toBe("reset");
    expect(getSession(b.token).state).toBe("init");
    expect(getSession(a.token), "the old session must be ended, not mutated").toBeFalsy();
  });

  it("a TERMINAL session auto-starts fresh without the caller passing reset", () => {
    const a = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    getSession(a.token).state = "shipped"; // terminal for qa

    const b = handleGovernorInit({ projectId: "p", flowType: "qa", problemId: "story-A" });
    expect(b.token).not.toBe(a.token);
    expect(b.mode).toBe("new");
    expect(getSession(b.token).state).toBe("init");
  });

  it("terminality is DELEGATED per flow, not an inlined shipped/failed list", () => {
    // The lever. ops inverts both members of the story/qa terminal set
    // (governor-state.mjs: terminalOps = {done}, terminalQA = {shipped, failed}).
    // An implementation that inlines ['shipped','failed'] passes the case above and fails
    // BOTH halves of this one.
    const done = handleGovernorInit({ projectId: "p", flowType: "ops", problemId: "op-A" });
    getSession(done.token).state = "done"; // terminal for ops ONLY
    const afterDone = handleGovernorInit({ projectId: "p", flowType: "ops", problemId: "op-A" });
    expect(afterDone.token, "ops 'done' is terminal — must mint a new session").not.toBe(done.token);

    resetSessionState();

    const failed = handleGovernorInit({ projectId: "p", flowType: "ops", problemId: "op-B" });
    getSession(failed.token).state = "failed"; // NOT terminal for ops
    const afterFailed = handleGovernorInit({ projectId: "p", flowType: "ops", problemId: "op-B" });
    expect(afterFailed.token, "ops 'failed' is NOT terminal — must resume").toBe(failed.token);
    expect(getSession(afterFailed.token).state).toBe("failed");
    expect(afterFailed.mode).toBe("resumed");
  });

  it("a problemId-less flow still RESETS on re-entry — the historical branch is untouched", () => {
    // Open-flow identity is ('open', undefined), shared by every Research, PO and ARCH
    // Governor, so a "match" there is not a work item. Resuming would strand
    // rks_agent_recovery, which the open flow admits only at 'init'.
    const a = handleGovernorInit({ projectId: "p" });
    getSession(a.token).state = "researching";

    const b = handleGovernorInit({ projectId: "p" });
    expect(b.token).toBe(a.token);
    expect(getSession(b.token).state).toBe("init");
    expect(b.mode).toBe("reset");
  });

  it("a resumed chain state agrees with what is on disk, not just in memory", () => {
    // The reuse branch mutated session.state in memory and never persisted, so memory and
    // .rks/governor-session.json disagreed after an init-reset. Resume removes the mutation;
    // this asserts the two actually agree by reading the file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-session-"));
    fs.mkdirSync(path.join(dir, ".rks"), { recursive: true });
    setProjectRoot(dir);
    try {
      const a = handleGovernorInit({ projectId: "p", problemId: "story-A" });
      advanceState(a.token, "rks_refine"); // story init → refining, and persists

      const file = path.join(dir, ".rks", "governor-session.json");
      expect(fs.existsSync(file), "ANTI-VACUITY: nothing was persisted, so this proves nothing").toBe(true);
      const onDiskBefore = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(onDiskBefore.state).toBe("refining");

      const b = handleGovernorInit({ projectId: "p", problemId: "story-A" });
      expect(b.state).toBe("refining");
      expect(getSession(b.token).state).toBe("refining");

      const onDiskAfter = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(onDiskAfter.state, "memory and disk must agree across a resume").toBe("refining");
    } finally {
      setProjectRoot(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the dead staleness trio is deleted, and ONLY from governor-init.mjs", () => {
  // Deliberately file-scoped, never directory-scoped. `isStale` is live in
  // packages/mcp-rks/src/agents/recovery.mjs as an unrelated lock-staleness check with a real
  // consumer, so a package-wide absence assertion would demand deleting working code.
  const INIT_SRC = fs.readFileSync(
    path.join(ROOT, "packages/mcp-rks/src/tools/governor-init.mjs"),
    "utf8",
  );
  const RECOVERY_SRC = fs.readFileSync(
    path.join(ROOT, "packages/mcp-rks/src/agents/recovery.mjs"),
    "utf8",
  );

  it("governor-init.mjs no longer declares STALE_MS or isStale", () => {
    expect(INIT_SRC).not.toMatch(/const\s+STALE_MS\b/);
    expect(INIT_SRC).not.toMatch(/const\s+isStale\b/);
    expect(INIT_SRC).not.toMatch(/const\s+elapsed\b/);
  });

  it("governor-init.mjs keeps exactly one Date.now() call and performs no time subtraction", () => {
    // The surviving call is `session.lastActivity = Date.now()`. Zero subtractions proves no
    // new age-comparison branch was reintroduced under a different name.
    const dateNowCount = (INIT_SRC.match(/Date\.now\(\)/g) || []).length;
    expect(dateNowCount).toBe(1);
    expect(INIT_SRC).not.toMatch(/Date\.now\(\)\s*-/);
  });

  it("recovery.mjs still uses isStale — the deletion must NOT have swept it up", () => {
    const occurrences = (RECOVERY_SRC.match(/isStale/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    // Not just declared — actually consumed. This is the assertion that turns an
    // over-broad cleanup into a red test instead of a silent regression.
    expect(RECOVERY_SRC).toMatch(/if\s*\(\s*isStale/);
  });
});
