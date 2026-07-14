/**
 * backlog.feat.advance-on-ship-phase-reconciliation — off-rail phase reconcile.
 *
 * The off-rail flow never runs rks_exec, so guardrails_on's cycle_complete is the only place
 * the arch-approved → executing → executed → integrated ladder advances. Without
 * reconcileToIntegrated, off-rail-shipped stories stay stuck at 'arch-approved' and rks_release
 * reports releasedStories:[] forever.
 *
 * The walk behavior is exercised with STATEFUL dendron mocks (updateField advances a mutable
 * phase; parseFrontmatter reads it back — so each real advancePhase hop genuinely progresses and
 * reconcileToIntegrated re-reads between hops). validateTransition is mocked-valid (gate-free) so
 * the test is not coupled to phase gates; the LADDER LEGITIMACY is asserted separately against the
 * REAL OPERATION_TRANSITIONS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let currentPhase;

vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({
  resolveNotesDir: vi.fn(() => "/tmp/proj/notes"),
  updateField: vi.fn((_notesDir, _problemId, field, value) => {
    if (field === "phase") currentPhase = value;
  }),
  parseFrontmatter: vi.fn(() => ({ data: { phase: currentPhase }, content: "x" })),
}));
vi.mock("../../packages/mcp-rks/src/server/telemetry/index.mjs", () => ({
  ensureTelemetryStorage: () => ({ emit: vi.fn() }),
}));
vi.mock("../../packages/mcp-rks/src/workflow/state-machine.mjs", () => ({
  validateTransition: vi.fn(async () => ({ valid: true })),
}));
vi.mock("fs", () => ({
  default: { existsSync: vi.fn(() => true), readFileSync: vi.fn(() => "x") },
}));

import fs from "fs";
import { reconcileToIntegrated } from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";
import { OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

describe("reconcileToIntegrated — off-rail phase ladder walk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(true);
    currentPhase = "arch-approved";
  });

  it("CORE: walks arch-approved -> executing -> executed -> integrated", async () => {
    const r = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.advanced).toBe(true);
    expect(r.to).toBe("integrated");
    expect(currentPhase).toBe("integrated"); // persisted through the real advancePhase hops
  });

  it("MID-LADDER: a story already at 'executed' takes the single remaining hop to integrated", async () => {
    currentPhase = "executed";
    const r = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.to).toBe("integrated");
    expect(currentPhase).toBe("integrated");
  });

  it("NO-OP: an already-'integrated' story (re-ship) is not advanced again", async () => {
    currentPhase = "integrated";
    const r = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.advanced).toBe(false);
    expect(r.to).toBe("integrated");
  });

  it("FAIL-SAFE: a phase with no ladder step (e.g. draft) stops cleanly, no crash, no jump", async () => {
    currentPhase = "draft";
    const r = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.advanced).toBe(false);
    expect(r.from).toBe("draft");
    expect(currentPhase).toBe("draft"); // untouched
  });

  it("missing story file: ok, not advanced (story already moved / absent)", async () => {
    fs.existsSync.mockReturnValue(false);
    const r = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.advanced).toBe(false);
  });

  it("NEVER THROWS: an internal error returns { ok:false } instead of throwing (best-effort)", async () => {
    fs.readFileSync.mockImplementation(() => { throw new Error("disk boom"); });
    let result;
    await expect(async () => { result = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj"); }).not.toThrow();
    expect(result.ok).toBe(false);
    fs.readFileSync.mockReturnValue("x");
  });

  it("IDEMPOTENT: running twice leaves the story at integrated, second run is a no-op", async () => {
    await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    const second = await reconcileToIntegrated("/tmp/proj", "backlog.x", "proj");
    expect(second.advanced).toBe(false);
    expect(second.to).toBe("integrated");
    expect(currentPhase).toBe("integrated");
  });
});

describe("off-rail ladder — real OPERATION_TRANSITIONS legitimacy", () => {
  it("guardrails_off / guardrails_on.commit / guardrails_on.merge chain arch-approved -> integrated", () => {
    expect(OPERATION_TRANSITIONS.guardrails_off.to).toBe("executing");
    expect(OPERATION_TRANSITIONS.guardrails_off.from).toContain("arch-approved");
    expect(OPERATION_TRANSITIONS["guardrails_on.commit"].to).toBe("executed");
    expect(OPERATION_TRANSITIONS["guardrails_on.commit"].from).toContain("executing");
    expect(OPERATION_TRANSITIONS["guardrails_on.merge"].to).toBe("integrated");
    expect(OPERATION_TRANSITIONS["guardrails_on.merge"].from).toContain("executed");
  });
});
