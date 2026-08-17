/**
 * Tests for backlog.fix.off-rail-ship-failure-honest-report.
 *
 * `guardrailsOn`'s auto-ship could return a success-shaped response for a ship
 * that crashed, was halted on purpose, or did nothing at all. Five exits set
 * `autoShipped: false` with `ok` left true, and the first `shipSteps` push
 * happens well inside the try — so an early throw returned `ok: true` with an
 * empty steps array and a `shipError` nobody was looking at.
 *
 * That is not hypothetical: a CI failure surfaced as
 * `expected [] to have a length of 1` instead of the actual error.
 *
 * `ok` is NOT the bug. It scopes the guardrails-restore operation — hooks
 * restored, session ended, scope file removed — all of which genuinely succeed
 * when a ship throws. The bug was that nothing meant "did the ship work".
 * `shipOutcome` is that field, and it is DERIVED so a future exit cannot forget
 * to set it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";

import { resolveShipOutcome } from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";

const AUDIT_SRC = fs.readFileSync(
  "packages/mcp-rks/src/server/guardrails-audit.mjs",
  "utf8",
);

describe("resolveShipOutcome — the four real outcomes stay distinct", () => {
  it("reports a completed ship", () => {
    expect(resolveShipOutcome({ ok: true, autoShipped: true })).toBe("shipped");
  });

  it("reports a crash as failed, not as a success with a footnote", () => {
    expect(
      resolveShipOutcome({ ok: true, autoShipped: false, shipError: "boom" }),
    ).toBe("failed");
  });

  it("reports a deliberate enforcement halt as halted, not failed", () => {
    // A halt preserves the work by design and publishes a recoveryBranch.
    // Collapsing it into "failed" would report the gate doing its job as a bug.
    expect(
      resolveShipOutcome({
        ok: true,
        autoShipped: false,
        haltReason: "scope_violation",
        recoveryBranch: "off-rail/abc",
      }),
    ).toBe("halted");
  });

  it("reports a genuine no-op distinctly from both", () => {
    expect(resolveShipOutcome({ ok: true, autoShipped: false })).toBe(
      "nothing_to_ship",
    );
  });

  it("reports skipped when the auto-ship block never ran", () => {
    // changes.total === 0, or a caller passing skipAutoShip.
    expect(resolveShipOutcome({ ok: true })).toBe("skipped");
  });

  it("ranks an error above a halt above a completed ship", () => {
    expect(
      resolveShipOutcome({ autoShipped: true, haltReason: "review_block", shipError: "boom" }),
    ).toBe("failed");
    expect(
      resolveShipOutcome({ autoShipped: true, haltReason: "review_block" }),
    ).toBe("halted");
  });

  it("never throws on junk", () => {
    for (const junk of [null, undefined, "nope", 7, []]) {
      expect(() => resolveShipOutcome(junk)).not.toThrow();
    }
    expect(resolveShipOutcome(null)).toBe("skipped");
  });

  it("distinguishes the three shapes that used to look identical", () => {
    // All three previously returned ok:true + autoShipped:false.
    const crashed = { ok: true, autoShipped: false, shipError: "boom" };
    const halted = { ok: true, autoShipped: false, haltReason: "review_block" };
    const noop = { ok: true, autoShipped: false };
    const outcomes = [crashed, halted, noop].map(resolveShipOutcome);
    expect(new Set(outcomes).size).toBe(3);
  });
});

describe("every exit is stamped — a new one cannot forget", () => {
  it("routes every guardrailsOn return through the finalizer", () => {
    const onIdx = AUDIT_SRC.indexOf("export async function guardrailsOn");
    expect(onIdx).toBeGreaterThan(-1);
    const body = AUDIT_SRC.slice(onIdx);
    // A bare `return response;` would escape the stamp.
    expect(body).not.toMatch(/return\s+response\s*;/);
    expect(body).toMatch(/return finalizeShipOutcome\(response\);/);
  });

  it("does not leave the finalizer calling itself", () => {
    // replace_all once turned this into infinite recursion.
    const start = AUDIT_SRC.indexOf("function finalizeShipOutcome");
    const body = AUDIT_SRC.slice(start, AUDIT_SRC.indexOf("\n}", start));
    expect(body).not.toMatch(/return finalizeShipOutcome/);
    expect(body).toMatch(/return response;/);
  });
});

describe("a throw records where it stopped", () => {
  it("tracks a stage through the auto-ship block", () => {
    for (const stage of [
      "branch_create",
      "stage_files",
      "staging_check",
      "commit",
      "enforcement_gate",
      "integrate",
    ]) {
      expect(AUDIT_SRC).toContain(`shipStage = "${stage}"`);
    }
  });

  it("reports that stage on the catch path", () => {
    const catchIdx = AUDIT_SRC.indexOf("catch (shipError)");
    expect(catchIdx).toBeGreaterThan(-1);
    const block = AUDIT_SRC.slice(catchIdx, catchIdx + 400);
    expect(block).toContain("response.failedStage = shipStage");
    expect(block).toContain("response.shipError");
  });

  it("sets the commit stage before commitAndEmbed, the prime suspect", () => {
    // The CI throw is localized between branch creation and the first shipSteps
    // push; commitAndEmbed sits in that window.
    const stageIdx = AUDIT_SRC.indexOf('shipStage = "commit"');
    const embedIdx = AUDIT_SRC.indexOf("await commitAndEmbed(projectRoot");
    expect(stageIdx).toBeGreaterThan(-1);
    expect(embedIdx).toBeGreaterThan(stageIdx);
  });
});
