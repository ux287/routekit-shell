/**
 * backlog.fix.story-ship-false-success — the ok reduction.
 *
 * THE DEFECT: runStoryShipTool hardcoded `ok: true` and never reduced over its
 * own `steps` array. It reported success while mark_implemented failed or was
 * skipped entirely — code merged, backlog record unchanged, and a later /build
 * would try to rebuild an already-merged story.
 *
 * These drive the REAL exported reducer. The reduction is no longer inline
 * precisely so this can be a call rather than a source grep.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  reduceShipOk,
  buildMarkImplementedFailure,
} from "../../packages/mcp-rks/src/server/story-ship.mjs";

const SHIP_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "packages/mcp-rks/src/server/story-ship.mjs"),
  "utf8",
);

describe("reduceShipOk — the failure direction", () => {
  it("returns false when any step carries ok:false", () => {
    const steps = [
      { step: "local-merge", ok: true },
      buildMarkImplementedFailure("phase write rejected: Invalid transition"),
      { step: "cycle_complete", ok: true },
    ];
    expect(reduceShipOk(steps)).toBe(false);
  });

  it("returns false when the failing step is the only one", () => {
    expect(reduceShipOk([buildMarkImplementedFailure("story note not found")])).toBe(false);
  });
});

describe("reduceShipOk — THE POSITIVE DIRECTION", () => {
  // The over-strict predicate `steps.every(s => s.ok === true)` satisfies every
  // failure-direction assertion above and breaks every real ship. These cases
  // are what separate the two.
  it("returns true for a run whose only non-ok entries are legitimate skips", () => {
    const steps = [
      { step: "local-merge", ok: true },
      { step: "ci_check", skipped: true, reason: "no_github_token" },
      { step: "mark_implemented", skipped: true, reason: "already_implemented" },
      { step: "cycle_complete", skipped: true, reason: "nothing to do" },
      { step: "promote", skipped: true, reason: "not configured" },
    ];
    expect(reduceShipOk(steps)).toBe(true);
  });

  it("returns true for an all-skip run", () => {
    expect(reduceShipOk([{ step: "ci_check", skipped: true }])).toBe(true);
  });

  it("returns true for an empty step list", () => {
    expect(reduceShipOk([])).toBe(true);
    expect(reduceShipOk()).toBe(true);
  });

  it("a skip is not a failure — undefined must not read as false", () => {
    // The precise distinction the predicate turns on.
    const skip = { step: "promote", skipped: true };
    expect(skip.ok).toBeUndefined();
    expect(reduceShipOk([skip])).toBe(true);
  });
});

describe("buildMarkImplementedFailure — carries the ok the reduction needs", () => {
  it("sets ok:false while retaining the skip shape and reason", () => {
    const entry = buildMarkImplementedFailure("boom");
    expect(entry.step).toBe("mark_implemented");
    expect(entry.ok).toBe(false);
    expect(entry.skipped).toBe(true);
    expect(entry.reason).toBe("boom");
  });

  it("is defined outside the tool body so the ok:false literal does not red the pinning test", () => {
    // A pinning test requires every `ok: false` literal inside runStoryShipTool
    // to also mention ci_check and steps.push. The helper keeps the literal out
    // of that region entirely.
    const toolStart = SHIP_SRC.indexOf("export async function runStoryShipTool");
    const helperStart = SHIP_SRC.indexOf("export function buildMarkImplementedFailure");
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperStart).toBeLessThan(toolStart);
  });
});

describe("the reduction drives BOTH channels from one source of truth", () => {
  it("the return value and the outcome telemetry read the same reduction", () => {
    // Reporting ok:false while emitting story_ship.success would be the same
    // false-success defect one layer down.
    expect(SHIP_SRC).toContain("const shipOk = reduceShipOk(steps)");
    expect(SHIP_SRC).toMatch(/if \(shipOk\) \{\s*collector\.emit\('story_ship\.success'/);
    expect(SHIP_SRC).toContain("ok: shipOk");
    // Exactly one success emit, and the assertion above proves it sits inside
    // the `if (shipOk)` guard — so there is no second, unguarded one.
    const successEmits = SHIP_SRC.split("collector.emit('story_ship.success'").length - 1;
    expect(successEmits).toBe(1);
  });

  it("the failure counterpart carries worktreeBranch", () => {
    // Anchored FORWARD from the reduction, not via lastIndexOf over the whole
    // file. There are four story_ship.failed emit sites; lastIndexOf lands on
    // the right one only by file order and would silently detach the moment a
    // later emit were added.
    const reductionIdx = SHIP_SRC.indexOf("const shipOk = reduceShipOk(steps)");
    expect(reductionIdx, "reduction anchor not found").toBeGreaterThan(-1);
    const outcomeBlock = SHIP_SRC.slice(reductionIdx);
    const failIdx = outcomeBlock.indexOf("collector.emit('story_ship.failed'");
    expect(failIdx, "no story_ship.failed emit in the outcome block").toBeGreaterThan(-1);
    expect(outcomeBlock.slice(failIdx, failIdx + 600)).toContain("worktreeBranch");
  });
});

describe("the fail-open review opt-out", () => {
  it("mutates the review entry only when the review actually failed", () => {
    // The code after the halt guard also runs when the review PASSED, so an
    // unconditional mutation would stamp a degraded marker onto a healthy entry.
    expect(SHIP_SRC).toMatch(/if \(!reviewStep\.ok\) \{\s*reviewStep\.ok = true;/);
  });

  it("leaves the pinned push site and halt guard untouched", () => {
    expect(SHIP_SRC).toContain("const reviewStep = buildReviewStepEntry(reviewResult);");
    expect(SHIP_SRC).toContain("steps.push(reviewStep);");
    expect(SHIP_SRC).toContain("if (!reviewStep.ok && policy.failOpen !== true) {");
  });

  it("HONESTY RIDER — flipping ok must not erase why the review failed", () => {
    const idx = SHIP_SRC.indexOf("if (!reviewStep.ok) {\n        reviewStep.ok = true;");
    // GUARD: without this, a miss returns -1, slice(-1) yields the file's LAST
    // CHARACTER, and every assertion below degrades — the not.toMatch silently
    // passes against a one-character string. The guard turns a future silent
    // failure into a loud one.
    expect(idx, "fail-open mutation block not found — anchors have drifted").toBeGreaterThan(-1);
    const mutation = SHIP_SRC.slice(idx, idx + 260);
    expect(mutation).toContain("degraded");
    expect(mutation).toContain("failOpen");
    // Nothing may clear the diagnostic fields.
    expect(mutation).not.toMatch(/reviewStep\.(verdict|cause|error)\s*=/);
  });
});

describe("the clean-tree claim is bound to a real git call", () => {
  it("no longer hardcodes a clean working tree", () => {
    expect(SHIP_SRC).toContain("const residualDirty = getUncommittedFiles(projectRoot");
    expect(SHIP_SRC).toMatch(/clean: residualDirty\.length === 0/);
    // The old unconditional sentence.
    expect(SHIP_SRC).not.toContain("with a clean working tree. Ready for the next story.`;");
  });
});

describe("NEGATIVE ACs — do not weaken", () => {
  it("status and phase remain separate fields", () => {
    // status is a workflow flag, not a phase machine concern.
    expect(SHIP_SRC).toContain("updateField(notesDir, problemId, 'status', 'implemented')");
    expect(SHIP_SRC).not.toMatch(/updateField\([^)]*'phase'\s*,\s*'implemented'/);
  });

  it("the status write is deferred until after the phase transition validates", () => {
    const statusIdx = SHIP_SRC.indexOf("updateField(notesDir, problemId, 'status', 'implemented')");
    const advanceIdx = SHIP_SRC.indexOf("const advanceResult = await advancePhase");
    expect(advanceIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(advanceIdx);
  });
});
