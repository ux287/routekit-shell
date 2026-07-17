/**
 * backlog.fix.onrail-ship-advance-executing-stuck — reconcile witness.
 *
 * Bug: a story that reaches the on-rail ship phase-advance still at 'executing'
 * (rks_exec's exec_end didn't complete) makes ship's single executed -> integrated hop
 * reject as "Invalid transition: executing -> integrated" — the merge succeeds but the
 * phase stays stuck and rks_release returns releasedStories:[] forever.
 *
 * Fix: reconcileExecutingBeforeShip walks executing -> executed FIRST, by DELEGATING to
 * advancePhase('exec_end') (never reading a transition's .from). It is a conditional
 * pre-step (only when phase === 'executing'); already-'executed' stories are a no-op.
 *
 * Behavior is exercised with mocked I/O; transition legality is asserted against the
 * REAL OPERATION_TRANSITIONS (imported unmocked from phases.mjs) so the "no illegal
 * executing -> integrated shortcut" invariant is genuine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../packages/mcp-rks/src/dendron.mjs", () => ({
  resolveNotesDir: vi.fn(() => "/tmp/proj/notes"),
  updateField: vi.fn(),
  parseFrontmatter: vi.fn(),
}));
vi.mock("../../packages/mcp-rks/src/server/telemetry/index.mjs", () => ({
  ensureTelemetryStorage: () => ({ emit: vi.fn() }),
}));
vi.mock("../../packages/mcp-rks/src/workflow/state-machine.mjs", () => ({
  validateTransition: vi.fn(async () => ({ valid: true })),
}));
vi.mock("fs", () => ({
  default: { existsSync: vi.fn(), readFileSync: vi.fn() },
}));

import fs from "fs";
import { updateField, parseFrontmatter } from "../../packages/mcp-rks/src/dendron.mjs";
import { validateTransition } from "../../packages/mcp-rks/src/workflow/state-machine.mjs";
import {
  reconcileExecutingBeforeShip,
  advancePhase,
} from "../../packages/mcp-rks/src/workflow/auto-phase.mjs";
import { OPERATION_TRANSITIONS } from "../../packages/mcp-rks/src/workflow/phases.mjs";

function storyAt(phase) {
  fs.existsSync.mockReturnValue(true);
  fs.readFileSync.mockReturnValue(`---\nphase: ${phase}\n---\nx`);
  parseFrontmatter.mockReturnValue({ data: { phase }, content: "x" });
}

describe("reconcileExecutingBeforeShip — on-rail ship phase reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateTransition.mockResolvedValue({ valid: true });
  });

  it("BUG WITNESS: a story at 'executing' is walked to 'executed' (delegates exec_end)", async () => {
    storyAt("executing");
    const r = await reconcileExecutingBeforeShip("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.reconciled).toBe(true);
    expect(r.from).toBe("executing");
    expect(r.to).toBe("executed");
    expect(updateField).toHaveBeenCalledWith("/tmp/proj/notes", "backlog.x", "phase", "executed");
  });

  it("after reconcile, the ship hop succeeds: executed -> integrated (no 'Invalid transition')", async () => {
    storyAt("executed");
    const r = await advancePhase("/tmp/proj", "backlog.x", "ship", "proj");
    expect(r.ok).toBe(true);
    expect(r.to).toBe("integrated");
  });

  it("HAPPY PATH: a story already 'executed' is a no-op (reconciled=false, no exec_end write)", async () => {
    storyAt("executed");
    const r = await reconcileExecutingBeforeShip("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.reconciled).toBe(false);
    expect(r.from).toBe("executed");
    expect(updateField).not.toHaveBeenCalled();
  });

  it("FAIL-SAFE: a 'draft' arrival is a no-op — no crash, no forced jump", async () => {
    storyAt("draft");
    const r = await reconcileExecutingBeforeShip("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.reconciled).toBe(false);
    expect(updateField).not.toHaveBeenCalled();
  });

  it("FAIL-SAFE: an already-'integrated' arrival (re-ship) is a no-op", async () => {
    storyAt("integrated");
    const r = await reconcileExecutingBeforeShip("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.reconciled).toBe(false);
    expect(updateField).not.toHaveBeenCalled();
  });

  it("missing story file: ok, reconciled=false (let ship handle the moved story)", async () => {
    fs.existsSync.mockReturnValue(false);
    const r = await reconcileExecutingBeforeShip("/tmp/proj", "backlog.x", "proj");
    expect(r.ok).toBe(true);
    expect(r.reconciled).toBe(false);
  });

  describe("NO ILLEGAL EDGE — real OPERATION_TRANSITIONS graph invariant", () => {
    it("exec_end walks executing -> executed", () => {
      expect(OPERATION_TRANSITIONS.exec_end.to).toBe("executed");
      expect(OPERATION_TRANSITIONS.exec_end.from).toContain("executing");
    });
    it("ship walks executed -> integrated and does NOT accept executing as a source", () => {
      expect(OPERATION_TRANSITIONS.ship.to).toBe("integrated");
      expect(OPERATION_TRANSITIONS.ship.from).toContain("executed");
      expect(OPERATION_TRANSITIONS.ship.from).not.toContain("executing");
    });
  });
});
