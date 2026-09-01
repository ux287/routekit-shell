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

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import childProcess from "node:child_process";

import {
  resolveShipOutcome,
  finalizeShipOutcome,
} from "../../packages/mcp-rks/src/server/guardrails-audit.mjs";
// The on-rail reference implementation. Imported so the parity claim is an
// assertion against the real reducer, not a comment describing one.
import { reduceShipOk } from "../../packages/mcp-rks/src/server/story-ship.mjs";

const AUDIT_SRC = fs.readFileSync(
  "packages/mcp-rks/src/server/guardrails-audit.mjs",
  "utf8",
);
const SHIP_SRC = fs.readFileSync(
  "packages/mcp-rks/src/server/story-ship.mjs",
  "utf8",
);

/** The degraded outcome: the merge landed, a step underneath it did not. */
const DEGRADED = "shipped_with_failures";

/** Body of `resolveShipOutcome` as source text, for the purity scan. */
function resolverBody() {
  const start = AUDIT_SRC.indexOf("export function resolveShipOutcome");
  expect(start).toBeGreaterThan(-1);
  return AUDIT_SRC.slice(start, AUDIT_SRC.indexOf("\n}", start));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

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

  it("resolves the new block-severity halt through the generic truthiness path", () => {
    // backlog.fix.offrail-gate-block-findings-are-inert adds haltReason
    // 'review_block_finding' for a policy-downgraded block-severity finding.
    // resolveShipOutcome tests `response.haltReason` for truthiness rather than
    // enumerating values, so no enumeration edit is needed — pinned here so a
    // future "tighten this to a known list" change has to face the consequence.
    expect(
      resolveShipOutcome({ autoShipped: false, haltReason: "review_block_finding" }),
    ).toBe("halted");
    // An error still outranks it.
    expect(
      resolveShipOutcome({
        autoShipped: false,
        haltReason: "review_block_finding",
        shipError: "boom",
      }),
    ).toBe("failed");
  });

  it("COLLISION GUARD: an advisory ship that suppressed the phase advance is still 'shipped'", () => {
    // The suppression field must NOT be named autoShipSuppressed. That key sits
    // ABOVE autoShipped in the precedence chain and returns "skipped", so reusing
    // the name would silently reclassify a merge that actually landed. Under
    // advisory suppression the commit, merge and push all succeeded — only the
    // story phase was held back — so the outcome is "shipped".
    const advisorySuppressed = {
      ok: true,
      autoShipped: true,
      phaseAdvanceSuppressed: {
        reason: "block_severity_finding (ac_coverage)",
        categories: ["ac_coverage"],
        findingCount: 1,
      },
    };
    expect(resolveShipOutcome(advisorySuppressed)).toBe("shipped");

    // Demonstrate the failure the name choice avoids: the same response under the
    // forbidden key collapses to "skipped".
    expect(
      resolveShipOutcome({ ok: true, autoShipped: true, autoShipSuppressed: true }),
    ).toBe("skipped");

    // And the source must never grow that name for the phase-advance field.
    expect(AUDIT_SRC).not.toMatch(/response\.autoShipSuppressed\s*=\s*\{/);
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

/**
 * backlog.fix.offrail-shipoutcome-ignores-failed-steps.
 *
 * resolveShipOutcome decided the outcome from four fields and never looked at
 * `shipSteps`, so `autoShipped === true` reported "shipped" no matter what the
 * individual steps recorded — a failed delete-branch, cycle_complete,
 * advance_phase or ship-note was indistinguishable from a clean ship by the
 * time the Dispatcher read the response. The on-rail path has reduced its steps
 * via `reduceShipOk` since backlog.fix.story-ship-false-success; this closes the
 * parity gap WITHOUT collapsing a landed merge into "failed".
 */

/** A step array with one named step failing and every other step ok. */
const onlyFailing = (name) =>
  ["commit", "review", "scope_reconcile", "local-merge", "delete-branch",
   "cycle_complete", "advance_phase", "ship-note"]
    .map((step) => ({ step, ok: step !== name }));

/** The suppressed advance_phase entry — NO `ok` key, by design. */
const SUPPRESSED_ADVANCE = {
  step: "advance_phase",
  skipped: true,
  reason: "block_severity_finding (ac_coverage)",
};

/** Every response that must resolve to the degraded outcome. */
const DEGRADED_TABLE = [
  { ok: true, autoShipped: true, shipSteps: [{ step: "delete-branch", ok: false, error: "branch in use" }] },
  { ok: true, autoShipped: true, shipSteps: [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE, { step: "ship-note", ok: false }] },
  ...["review", "scope_reconcile", "delete-branch", "cycle_complete", "advance_phase", "ship-note"]
    .map((name) => ({ ok: true, autoShipped: true, shipSteps: onlyFailing(name) })),
];

describe("resolveShipOutcome reduces shipSteps — parity with the on-rail reducer", () => {
  it("agrees with reduceShipOk on every shape, asserted not described", () => {
    // The claim is equivalence, so both rules run over the same table.
    const table = [
      [],
      [{ step: "commit", ok: true }],
      [{ step: "commit", ok: true }, { step: "local-merge", ok: true }, { step: "push-staging", ok: true }],
      [SUPPRESSED_ADVANCE],
      [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE],
      [{ step: "working_pr", skipped: true, reason: "three_branch_local_only" }],
      [{ step: "delete-branch", ok: false, error: "branch in use" }],
      [{ step: "commit", ok: true }, { step: "cycle_complete", ok: false }],
      [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE, { step: "ship-note", ok: false }],
      onlyFailing("advance_phase"),
      onlyFailing("ship-note"),
    ];
    for (const steps of table) {
      const outcome = resolveShipOutcome({ ok: true, autoShipped: true, shipSteps: steps });
      expect({ steps, shipped: outcome === "shipped" })
        .toEqual({ steps, shipped: reduceShipOk(steps) });
    }
  });

  it("leaves an all-ok ship byte-identical to today", () => {
    expect(
      resolveShipOutcome({
        ok: true,
        autoShipped: true,
        shipSteps: [
          { step: "commit", ok: true },
          { step: "local-merge", ok: true },
          { step: "push-staging", ok: true },
        ],
      }),
    ).toBe("shipped");
  });

  it("leaves a response with no shipSteps key at today's value", () => {
    const response = { ok: true, autoShipped: true };
    expect("shipSteps" in response).toBe(false);
    expect(resolveShipOutcome(response)).toBe("shipped");
  });

  it("never throws on a non-array shipSteps, and returns today's value", () => {
    for (const shipSteps of [null, undefined, "steps", { step: "commit" }, 0, NaN]) {
      const response = { ok: true, autoShipped: true, shipSteps };
      expect(() => resolveShipOutcome(response)).not.toThrow();
      expect(resolveShipOutcome(response)).toBe("shipped");
    }
  });

  it("degrades a landed merge with a failed step to neither shipped nor failed", () => {
    const outcome = resolveShipOutcome({
      autoShipped: true,
      shipSteps: [{ step: "delete-branch", ok: false, error: "branch in use" }],
    });
    expect(outcome).not.toBe("shipped");
    // "failed" is the shipError outcome and means the merge did NOT land.
    // Reusing it here would send recovery down the wrong path.
    expect(outcome).not.toBe("failed");
    expect(outcome).toBe(DEGRADED);
  });

  it("reads a step with NO ok key as a legitimate skip, not a failure", () => {
    // The exact shape backlog.fix.offrail-gate-block-findings-are-inert pushes.
    // Key ABSENCE is the contract — `ok === undefined` would also be satisfied by
    // an explicit `ok: undefined`, which is not what the gate writes.
    expect("ok" in SUPPRESSED_ADVANCE).toBe(false);
    expect(
      resolveShipOutcome({
        autoShipped: true,
        shipSteps: [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE],
      }),
    ).toBe("shipped");
  });

  it("does NOT report a clean shipped over a commit whose containment was unobserved", () => {
    // backlog.fix.offrail-scope-containment-unevidenced. The unevaluated
    // scope_reconcile step omits `ok` so it cannot trip the scope_violation halt.
    // Correct for the halt, wrong for the outcome — without an explicit rule the
    // ship would resolve to a clean `shipped` over a commit nobody reconciled,
    // which is the report-without-evidence defect reintroduced one field over.
    const step = { step: "scope_reconcile", evaluated: false, reason: "manifest_unreadable", error: "git diff-tree exited 128" };
    expect("ok" in step).toBe(false);
    const response = finalizeShipOutcome({
      autoShipped: true,
      shipSteps: [{ step: "commit", ok: true }, step],
    });
    expect(response.shipOutcome).not.toBe("shipped");
    expect(response.shipOutcome).toBe(DEGRADED);
    expect(response.failedShipSteps).toEqual(["scope_reconcile"]);
  });

  it("does NOT treat no_commit as a failure — gate alpha made no claim to falsify", () => {
    // The empty-index path already reports its own outcome; there is no commit
    // for a containment claim to be about, so nothing was falsified.
    const step = { step: "scope_reconcile", evaluated: false, reason: "no_commit" };
    const response = finalizeShipOutcome({
      autoShipped: true,
      shipSteps: [{ step: "commit", ok: true }, step],
    });
    expect(response.shipOutcome).toBe("shipped");
    expect("failedShipSteps" in response).toBe(false);
  });

  it("the rule is scoped to scope_reconcile, not to any evaluated:false step", () => {
    // A different step carrying the same fields must not be swept in by a
    // predicate that keys only on `evaluated`/`reason`.
    const response = finalizeShipOutcome({
      autoShipped: true,
      shipSteps: [
        { step: "commit", ok: true },
        { step: "review", evaluated: false, reason: "manifest_unreadable" },
      ],
    });
    expect(response.shipOutcome).toBe("shipped");
  });

  it("degrades on a mixed skip+failure array without naming the skipped step", () => {
    const response = finalizeShipOutcome({
      autoShipped: true,
      shipSteps: [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE, { step: "ship-note", ok: false }],
    });
    expect(response.shipOutcome).toBe(DEGRADED);
    expect(response.failedShipSteps).toEqual(["ship-note"]);
    expect(response.failedShipSteps).not.toContain("advance_phase");
  });

  it("names every failed step — not a count, not a sample", () => {
    const response = finalizeShipOutcome({
      autoShipped: true,
      shipSteps: [
        { step: "commit", ok: true },
        { step: "review", ok: false },
        { step: "scope_reconcile", ok: true },
        { step: "local-merge", ok: true },
        { step: "delete-branch", ok: false, error: "branch in use" },
        { step: "cycle_complete", ok: true },
        { step: "ship-note", ok: false, error: "push rejected" },
      ],
    });
    // Full identities, in recorded order. A length or a [0] would pass while the
    // Dispatcher still had to walk shipSteps to find the rest.
    expect(response.failedShipSteps).toEqual(["review", "delete-branch", "ship-note"]);
  });

  it("is step-name agnostic across every gate and trailing path", () => {
    for (const name of [
      "review", "scope_reconcile", "delete-branch",
      "cycle_complete", "advance_phase", "ship-note",
    ]) {
      const steps = onlyFailing(name);
      expect({ name, outcome: resolveShipOutcome({ autoShipped: true, shipSteps: steps }) })
        .toEqual({ name, outcome: DEGRADED });
    }
  });

  it("NAMING GUARD: the failed-step field is not autoShipSuppressed", () => {
    const response = finalizeShipOutcome({
      ok: true,
      autoShipped: true,
      shipSteps: [{ step: "cycle_complete", ok: false }],
    });
    // autoShipSuppressed ranks ABOVE autoShipped in the precedence chain, so
    // stamping the failed steps under that key would report this landed merge as
    // "skipped" instead of degrading it.
    expect(response.autoShipSuppressed).toBeUndefined();
    expect(response.shipOutcome).toBe(DEGRADED);
    expect(response.shipOutcome).not.toBe("skipped");
    expect(response.failedShipSteps).toEqual(["cycle_complete"]);
    const newKeys = Object.keys(response).filter((k) => k === "failedShipSteps");
    expect(newKeys).toEqual(["failedShipSteps"]);
    // The stamping site names the distinct key and never the forbidden one.
    // (`response.autoShipSuppressed = true` still exists exactly once, for the
    // skipAutoShip caller — that is the key's legitimate meaning and is why it
    // cannot be reused here.)
    const finIdx = AUDIT_SRC.indexOf("export function finalizeShipOutcome");
    const finBody = AUDIT_SRC.slice(finIdx, AUDIT_SRC.indexOf("\n}", finIdx));
    expect(finBody).toContain("failedShipSteps");
    expect(finBody).not.toContain("autoShipSuppressed");
    expect(AUDIT_SRC.match(/response\.autoShipSuppressed\s*=/g)).toHaveLength(1);
  });

  it("keeps the precedence chain intact WITH failing steps present", () => {
    const failing = [{ step: "delete-branch", ok: false }];
    expect(
      resolveShipOutcome({ autoShipped: true, shipSteps: failing, shipError: "boom" }),
    ).toBe("failed");
    expect(
      resolveShipOutcome({ autoShipped: true, shipSteps: failing, haltReason: "review_block" }),
    ).toBe("halted");
    expect(
      resolveShipOutcome({ autoShipped: true, shipSteps: failing, autoShipSuppressed: true }),
    ).toBe("skipped");
    expect(
      resolveShipOutcome({ autoShipped: false, shipSteps: failing }),
    ).toBe("nothing_to_ship");
    for (const junk of [null, undefined, "nope", 7]) {
      expect(resolveShipOutcome(junk)).toBe("skipped");
    }
  });
});

describe("resolveShipOutcome stays pure — the reduction reads, it does not reach out", () => {
  it("records ZERO child_process and fs calls across the degraded table", () => {
    const spies = [
      vi.spyOn(childProcess, "execFileSync"),
      vi.spyOn(childProcess, "spawnSync"),
      vi.spyOn(childProcess, "execSync"),
      vi.spyOn(fs, "readFileSync"),
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "existsSync"),
    ];
    try {
      const outcomes = DEGRADED_TABLE.map(resolveShipOutcome);
      expect(new Set(outcomes)).toEqual(new Set([DEGRADED]));
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      vi.restoreAllMocks();
    }
    // The named imports are bound at module load, so the spies above cannot see
    // a call made through them. Scan the body too.
    const body = resolverBody();
    expect(body).not.toMatch(/spawnSync|execSync|execFileSync|fs\./);
    expect(body).not.toMatch(/^export async function/);
  });

  it("is synchronous — it returns a string, never a promise", () => {
    const outcome = resolveShipOutcome(DEGRADED_TABLE[0]);
    expect(typeof outcome).toBe("string");
    expect(outcome).not.toBeInstanceOf(Promise);
  });

  it("does not mutate its argument — a deep-frozen response passes through", () => {
    // If the failed-step naming happened inside the resolver, this would throw
    // in strict mode. It belongs to finalizeShipOutcome, the single stamping site.
    const frozen = deepFreeze({
      ok: true,
      autoShipped: true,
      shipSteps: [{ step: "commit", ok: true }, { step: "advance_phase", ok: false }],
    });
    expect(() => resolveShipOutcome(frozen)).not.toThrow();
    expect(resolveShipOutcome(frozen)).toBe(DEGRADED);
    expect("shipOutcome" in frozen).toBe(false);
    expect("failedShipSteps" in frozen).toBe(false);
  });
});

describe("finalizeShipOutcome is the single stamping site", () => {
  it("stamps the degraded outcome and the named failed steps together", () => {
    const response = finalizeShipOutcome({
      ok: true,
      autoShipped: true,
      commitId: "abc12345",
      shipSteps: [
        { step: "commit", ok: true },
        { step: "local-merge", ok: true },
        { step: "advance_phase", ok: false, to: null },
      ],
    });
    expect(response.shipOutcome).toBe(DEGRADED);
    expect(response.failedShipSteps).toEqual(["advance_phase"]);
  });

  it("leaves the field absent when nothing failed", () => {
    // Absent means "no failed steps". An always-present empty array would make a
    // reader distinguish [] from silence.
    const response = finalizeShipOutcome({
      ok: true,
      autoShipped: true,
      shipSteps: [{ step: "commit", ok: true }, SUPPRESSED_ADVANCE],
    });
    expect(response.shipOutcome).toBe("shipped");
    expect("failedShipSteps" in response).toBe(false);
  });
});

describe("the on-rail reference implementation was mirrored, not modified", () => {
  it("re-asserts reduceShipOk's own contract unchanged", () => {
    expect(reduceShipOk([{ step: "commit", ok: true }, { step: "cycle_complete", ok: false }])).toBe(false);
    expect(reduceShipOk([{ step: "commit", ok: true }, SUPPRESSED_ADVANCE])).toBe(true);
    expect(reduceShipOk([])).toBe(true);
    expect(reduceShipOk()).toBe(true);
  });

  it("leaves the reducer source itself untouched", () => {
    expect(SHIP_SRC).toContain("export function reduceShipOk(steps = []) {");
    expect(SHIP_SRC).toContain("return !steps.some(s => s.ok === false);");
  });
});
