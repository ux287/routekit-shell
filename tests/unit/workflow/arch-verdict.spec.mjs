import { describe, it, expect } from "vitest";
import {
  computeArchVerdict,
  findingKey,
  ARCH_MAX_ROUNDS,
} from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

// The termination guarantee this module exists for is ARITHMETIC, not behavioural:
// round 1 freezes the ledger, later rounds may only shrink it, and a hard cap
// closes the tail. These tests assert that bound directly rather than asserting
// that ARCH "behaves well".

const f = (item, file, detail = "d") => ({ item, file, detail });

describe("findingKey — derived identity", () => {
  it("derives the key from { item, file } only", () => {
    expect(findingKey({ item: 5, file: "src/a.mjs" })).toBe(findingKey({ item: 5, file: "src/a.mjs", detail: "different" }));
  });

  it("IGNORES a caller-supplied key (ARCH cannot mint its own identity)", () => {
    const forged = findingKey({ item: 5, file: "src/a.mjs", key: "item-1-something-else" });
    expect(forged).toBe(findingKey({ item: 5, file: "src/a.mjs" }));
    expect(forged).not.toBe("item-1-something-else");
  });

  it("distinguishes different items and different files", () => {
    expect(findingKey({ item: 5, file: "a.mjs" })).not.toBe(findingKey({ item: 6, file: "a.mjs" }));
    expect(findingKey({ item: 5, file: "a.mjs" })).not.toBe(findingKey({ item: 5, file: "b.mjs" }));
  });

  // Regression: an earlier shape interpolated Number(item), so a non-numeric item
  // produced "itemNaN-..." whose uppercase letters violate the key format.
  it.each([
    [5, "src/a.mjs"],
    ["5", "src/a.mjs"],
    ["Item Five", "SRC/A.mjs"],
    [undefined, "a.mjs"],
    [null, "a.mjs"],
    [{}, "a.mjs"],
    [NaN, "a.mjs"],
  ])("emits a /^[a-z0-9-]+$/ key for item=%p file=%p", (item, file) => {
    expect(findingKey({ item, file })).toMatch(/^[a-z0-9-]+$/);
  });

  it("emits a conforming key for a completely empty finding", () => {
    expect(findingKey({})).toMatch(/^[a-z0-9-]+$/);
    expect(findingKey()).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("computeArchVerdict — purity", () => {
  it("is deterministic: identical inputs give identical output", () => {
    const args = { priorLedger: ["item-1-a"], priorRound: 1, submitted: [f(1, "a"), f(2, "b")] };
    expect(computeArchVerdict(args)).toEqual(computeArchVerdict(args));
  });

  it("does not mutate its inputs", () => {
    const priorLedger = ["item-1-a"];
    const submitted = [f(1, "a")];
    computeArchVerdict({ priorLedger, priorRound: 1, submitted });
    expect(priorLedger).toEqual(["item-1-a"]);
    expect(submitted).toEqual([f(1, "a")]);
  });

  it("runs with no arguments at all (no project on disk required)", () => {
    const r = computeArchVerdict();
    expect(r.round).toBe(1);
    expect(r.verdict).toBe("approved");
    expect(r.ledger).toEqual([]);
  });
});

describe("computeArchVerdict — round 1 freezes the ledger", () => {
  it("sets ledger to the submitted keys and blocking equal to ledger", () => {
    const submitted = [f(5, "a.mjs"), f(2, "b.mjs")];
    const r = computeArchVerdict({ priorLedger: [], priorRound: 0, submitted });
    const keys = submitted.map(findingKey);

    expect(r.round).toBe(1);
    expect(r.ledger).toEqual(keys);
    expect(r.blocking).toEqual(r.ledger);
    expect(r.deferred).toEqual([]);
    expect(r.verdict).toBe("needs-revision");
  });

  it("approves round 1 when nothing was submitted", () => {
    const r = computeArchVerdict({ priorLedger: [], priorRound: 0, submitted: [] });
    expect(r.verdict).toBe("approved");
    expect(r.blocking).toEqual([]);
  });

  it("de-dupes findings that collapse to the same key", () => {
    const r = computeArchVerdict({ priorRound: 0, submitted: [f(1, "a.mjs", "x"), f(1, "a.mjs", "y")] });
    expect(r.ledger).toHaveLength(1);
  });
});

describe("computeArchVerdict — round > 1 may only shrink", () => {
  const priorLedger = [findingKey(f(1, "a.mjs")), findingKey(f(2, "b.mjs"))];

  it("defers every submitted finding whose key is absent from priorLedger", () => {
    const novel = f(9, "z.mjs");
    const r = computeArchVerdict({ priorLedger, priorRound: 1, submitted: [f(1, "a.mjs"), novel] });

    expect(r.deferred).toContain(findingKey(novel));
    expect(r.blocking).not.toContain(findingKey(novel));
  });

  // The reproduction that motivated the story: round 2 raised a wholly disjoint
  // finding set. Under the ledger that set cannot block.
  it("cannot block on a wholly disjoint round-2 finding set", () => {
    const r = computeArchVerdict({
      priorLedger,
      priorRound: 1,
      submitted: [f(7, "x.mjs"), f(8, "y.mjs"), f(9, "z.mjs"), f(10, "w.mjs")],
    });
    expect(r.blocking).toEqual([]);
    expect(r.verdict).toBe("approved");
    expect(r.deferred).toHaveLength(4);
  });

  it("returns a ledger that is a SUBSET of priorLedger (asserted, not inferred)", () => {
    const r = computeArchVerdict({
      priorLedger,
      priorRound: 1,
      submitted: [f(1, "a.mjs"), f(9, "z.mjs"), f(10, "w.mjs")],
    });
    for (const k of r.ledger) expect(priorLedger).toContain(k);
    expect(r.ledger.length).toBeLessThanOrEqual(priorLedger.length);
  });

  it("shrinks the ledger when a prior finding is not re-raised", () => {
    const r = computeArchVerdict({ priorLedger, priorRound: 1, submitted: [f(1, "a.mjs")] });
    expect(r.ledger).toEqual([findingKey(f(1, "a.mjs"))]);
    expect(r.ledger.length).toBeLessThan(priorLedger.length);
  });

  it("renaming a round-1 finding defers it rather than keeping it blocking", () => {
    const r = computeArchVerdict({ priorLedger, priorRound: 1, submitted: [f("one", "a.mjs")] });
    expect(r.blocking).toEqual([]);
    expect(r.verdict).toBe("approved");
  });
});

describe("computeArchVerdict — the verdict iff", () => {
  it("is needs-revision iff blocking is non-empty AND round < ARCH_MAX_ROUNDS", () => {
    const cases = [
      { priorLedger: [], priorRound: 0, submitted: [f(1, "a")] },
      { priorLedger: [], priorRound: 0, submitted: [] },
      { priorLedger: [findingKey(f(1, "a"))], priorRound: 1, submitted: [f(1, "a")] },
      { priorLedger: [findingKey(f(1, "a"))], priorRound: 1, submitted: [f(2, "b")] },
      { priorLedger: [findingKey(f(1, "a"))], priorRound: ARCH_MAX_ROUNDS - 1, submitted: [f(1, "a")] },
      { priorLedger: [findingKey(f(1, "a"))], priorRound: ARCH_MAX_ROUNDS + 5, submitted: [f(1, "a")] },
    ];
    for (const c of cases) {
      const r = computeArchVerdict(c);
      const expected = r.blocking.length > 0 && r.round < ARCH_MAX_ROUNDS ? "needs-revision" : "approved";
      expect(r.verdict).toBe(expected);
    }
  });

  // ARCH's own note: assert the derivation behaviourally on BOTH return paths
  // rather than asserting the source text of a single expression.
  it("reports capped === (round >= ARCH_MAX_ROUNDS) on every path", () => {
    for (let priorRound = 0; priorRound <= ARCH_MAX_ROUNDS + 2; priorRound++) {
      for (const submitted of [[], [f(1, "a")], [f(9, "z")]]) {
        const r = computeArchVerdict({ priorLedger: [findingKey(f(1, "a"))], priorRound, submitted });
        expect(r.capped).toBe(r.round >= ARCH_MAX_ROUNDS);
      }
    }
  });
});

describe("computeArchVerdict — the hard cap closes the tail", () => {
  const priorLedger = [findingKey(f(1, "a.mjs")), findingKey(f(2, "b.mjs"))];

  it("approves at the cap regardless of residue, with blocking emptied", () => {
    const r = computeArchVerdict({ priorLedger, priorRound: ARCH_MAX_ROUNDS - 1, submitted: [f(1, "a.mjs")] });
    expect(r.round).toBe(ARCH_MAX_ROUNDS);
    expect(r.capped).toBe(true);
    expect(r.verdict).toBe("approved");
    expect(r.blocking).toEqual([]);
    expect(r.ledger).toEqual([]);
  });

  it("moves residual priorLedger entries into deferred rather than dropping them", () => {
    const r = computeArchVerdict({ priorLedger, priorRound: ARCH_MAX_ROUNDS - 1, submitted: [f(1, "a.mjs")] });
    for (const k of priorLedger) expect(r.deferred).toContain(k);
  });

  it("bounds the loop: needs-revision is unreachable from ARCH_MAX_ROUNDS onward", () => {
    for (let priorRound = ARCH_MAX_ROUNDS - 1; priorRound < ARCH_MAX_ROUNDS + 5; priorRound++) {
      const r = computeArchVerdict({ priorLedger, priorRound, submitted: [f(1, "a.mjs"), f(2, "b.mjs")] });
      expect(r.verdict).toBe("approved");
    }
  });

  // The whole point: at most ARCH_MAX_ROUNDS passes, whatever ARCH decides.
  it("terminates within ARCH_MAX_ROUNDS even when ARCH re-raises everything every round", () => {
    let priorLedger = [];
    let priorRound = 0;
    let rounds = 0;
    let verdict = "needs-revision";
    const submitted = [f(1, "a.mjs"), f(2, "b.mjs"), f(3, "c.mjs")];

    while (verdict === "needs-revision") {
      const r = computeArchVerdict({ priorLedger, priorRound, submitted });
      priorLedger = r.ledger;
      priorRound = r.round;
      verdict = r.verdict;
      rounds++;
      expect(rounds).toBeLessThanOrEqual(ARCH_MAX_ROUNDS);
    }
    expect(rounds).toBe(ARCH_MAX_ROUNDS);
  });

  it("terminates even when ARCH submits a fresh disjoint set every round", () => {
    let priorLedger = [];
    let priorRound = 0;
    let rounds = 0;
    let verdict = "needs-revision";

    while (verdict === "needs-revision") {
      const submitted = [f(rounds * 10 + 1, `f${rounds}.mjs`), f(rounds * 10 + 2, `g${rounds}.mjs`)];
      const r = computeArchVerdict({ priorLedger, priorRound, submitted });
      priorLedger = r.ledger;
      priorRound = r.round;
      verdict = r.verdict;
      rounds++;
      expect(rounds).toBeLessThanOrEqual(ARCH_MAX_ROUNDS);
    }
    // Disjoint sets defer immediately, so this terminates at round 2 — strictly
    // faster than the cap, which is the monotone-shrink property doing the work.
    expect(rounds).toBe(2);
  });
});

// ── backlog.fix.arch-ledger-subject-rebinding ────────────────────────────────
//
// Approval was ABSORBING: an empty ledger can never become non-empty under
// monotone shrink, so a story that had ever been approved could never be blocked
// again however much it was rewritten. Observed live — a story was approved at
// round 1, then materially amended with three new ACs, and the next ARCH pass
// would have approved it regardless of findings. The ledger is now bound to the
// story's CONTENT rather than its id.

import { subjectDigest } from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const SUBJ_A = subjectDigest({ body: "A", targetFiles: [{ path: "a.mjs" }], testRequirements: ["r1"] });
const SUBJ_B = subjectDigest({ body: "B", targetFiles: [{ path: "a.mjs" }], testRequirements: ["r1"] });

describe("subjectDigest — what the ledger is bound to", () => {
  it("is deterministic", () => {
    expect(subjectDigest({ body: "x" })).toBe(subjectDigest({ body: "x" }));
  });

  it("changes when the body changes", () => {
    expect(SUBJ_A).not.toBe(SUBJ_B);
  });

  it.each([
    ["targetFiles", { body: "A", targetFiles: [{ path: "b.mjs" }], testRequirements: ["r1"] }],
    ["testRequirements", { body: "A", targetFiles: [{ path: "a.mjs" }], testRequirements: ["r2"] }],
  ])("changes when %s changes", (_label, input) => {
    expect(subjectDigest(input)).not.toBe(SUBJ_A);
  });

  // THE CRUX. The digest is handed only the reviewable content, so no arch-owned
  // field, `updated` or `phase` can reach it. If one did, every recorded verdict
  // would change the digest, every round would look amended, the ledger would
  // reset every round, and termination would be lost entirely.
  it.each([
    "arch_verdict", "arch_round", "arch_ledger", "arch_deferred",
    "arch_findings_count", "arch_subject", "updated", "phase",
  ])("ignores %s entirely — an excluded field cannot move the digest", (field) => {
    const base = { body: "A", targetFiles: [{ path: "a.mjs" }], testRequirements: ["r1"] };
    expect(subjectDigest({ ...base, [field]: "anything" })).toBe(SUBJ_A);
  });

  it("is insensitive to frontmatter key order", () => {
    const one = subjectDigest({ body: "A", targetFiles: [{ path: "a.mjs", op: "edit" }] });
    const two = subjectDigest({ body: "A", targetFiles: [{ op: "edit", path: "a.mjs" }] });
    expect(one).toBe(two);
  });

  it("emits a stable-width hex digest", () => {
    expect(SUBJ_A).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("computeArchVerdict — a changed subject rebases to round 1", () => {
  const ledger = [findingKey(f(1, "a.mjs"))];

  it("returns round 1 and freezes a fresh ledger from this round's findings", () => {
    const r = computeArchVerdict({
      priorLedger: ledger, priorRound: 2, submitted: [f(9, "z.mjs")],
      recordedSubject: SUBJ_A, currentSubject: SUBJ_B,
    });
    expect(r.rebased).toBe(true);
    expect(r.round).toBe(1);
    expect(r.ledger).toEqual([findingKey(f(9, "z.mjs"))]);
    expect(r.deferred).toEqual([]);
  });

  // The absorbing-approval reproduction, closed.
  it("blocks on findings even though the prior ledger was EMPTY (approved)", () => {
    const r = computeArchVerdict({
      priorLedger: [], priorRound: 1, submitted: [f(9, "z.mjs")],
      recordedSubject: SUBJ_A, currentSubject: SUBJ_B,
    });
    expect(r.verdict).toBe("needs-revision");
    expect(r.blocking).toHaveLength(1);
  });

  it("still terminates: a rebased story reaching the cap approves with residue deferred", () => {
    const r = computeArchVerdict({
      priorLedger: ledger, priorRound: ARCH_MAX_ROUNDS - 1, submitted: [f(1, "a.mjs")],
      recordedSubject: SUBJ_A, currentSubject: SUBJ_B,
    });
    // Rebase resets the round, so the cap is not reached by the OLD count —
    // the bound is per version, which is the point.
    expect(r.round).toBe(1);
    expect(r.verdict).toBe("needs-revision");
  });

  it("bounds the rebased run at ARCH_MAX_ROUNDS against the new subject", () => {
    let priorLedger = [], priorRound = 0, rounds = 0, verdict = "needs-revision";
    while (verdict === "needs-revision") {
      const r = computeArchVerdict({
        priorLedger, priorRound, submitted: [f(1, "a.mjs")],
        recordedSubject: SUBJ_B, currentSubject: SUBJ_B,
      });
      priorLedger = r.ledger; priorRound = r.round; verdict = r.verdict;
      rounds++;
      expect(rounds).toBeLessThanOrEqual(ARCH_MAX_ROUNDS);
    }
    expect(rounds).toBe(ARCH_MAX_ROUNDS);
  });
});

describe("computeArchVerdict — a matching subject changes nothing", () => {
  it("advances the round and defers novel findings exactly as before", () => {
    const ledger = [findingKey(f(1, "a.mjs"))];
    const r = computeArchVerdict({
      priorLedger: ledger, priorRound: 1, submitted: [f(1, "a.mjs"), f(9, "z.mjs")],
      recordedSubject: SUBJ_A, currentSubject: SUBJ_A,
    });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.blocking).toEqual(ledger);
    expect(r.deferred).toEqual([findingKey(f(9, "z.mjs"))]);
  });
});

describe("computeArchVerdict — absence is grandfathered, not treated as amendment", () => {
  // A note verdicted before arch_subject existed. Treating absence as a mismatch
  // would reopen every already-approved story in the backlog at once.
  it("carries the recorded round and ledger forward when no subject was recorded", () => {
    const ledger = [findingKey(f(1, "a.mjs"))];
    const r = computeArchVerdict({
      priorLedger: ledger, priorRound: 1, submitted: [f(9, "z.mjs")],
      currentSubject: SUBJ_A,
    });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.deferred).toEqual([findingKey(f(9, "z.mjs"))]);
  });

  it("adopts the current subject so the NEXT amendment engages the mechanism", () => {
    const r = computeArchVerdict({ priorLedger: [], priorRound: 1, submitted: [], currentSubject: SUBJ_A });
    expect(r.subject).toBe(SUBJ_A);
  });
});

// backlog.fix.arch-no-cumulative-round-bound-across-rebases
//
// `round` measures rounds against ONE subject, and a needs-revision verdict requires an
// amendment to clear it, so any real revision loop rebases and `round` is 1 on nearly every
// call. That is correct for what it measures — and it means ARCH_MAX_ROUNDS is not a bound
// on total review cost for a story. `totalRounds` is that measure, and it is ADVISORY:
// it never feeds the verdict, the cap or the phase.
describe("cumulative review cost across rebases", () => {
  const SUBJ_1 = "a".repeat(32);
  const SUBJ_2 = "b".repeat(32);

  it("survives a rebase that resets round to 1", () => {
    // Defect-present: totalRounds does not exist. The observable was `round: 1` on every
    // amendment with nothing recording that four reviews had happened. A fixture asserting
    // `round === 1` alone passes TODAY — that IS the defect — so this asserts both halves
    // in one expression.
    const r = computeArchVerdict({
      priorLedger: ["item-1-a-mjs"], priorRound: 1,
      priorTotalRounds: 1, priorRoundFindings: [1],
      submitted: [f(1, "a.mjs")],
      recordedSubject: SUBJ_1, currentSubject: SUBJ_2,
    });
    expect(r.rebased).toBe(true);
    expect(r.round).toBe(1);
    expect(r.totalRounds).toBe(2);
  });

  it("increments on a NON-rebased round too", () => {
    const r = computeArchVerdict({
      priorLedger: ["item-1-a-mjs"], priorRound: 1,
      priorTotalRounds: 1, priorRoundFindings: [1],
      submitted: [f(1, "a.mjs")],
      recordedSubject: SUBJ_1, currentSubject: SUBJ_1,
    });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.totalRounds).toBe(2);
  });

  it("records the finding trajectory so convergence is legible", () => {
    // 5 → 1 → 1 → 0 converges; 3 → 3 → 3 does not. Nothing else in the payload
    // distinguishes the two, because arch_findings_count is overwritten each round.
    let traj = [];
    let total = 0;
    for (const n of [5, 1, 1, 0]) {
      const r = computeArchVerdict({
        priorLedger: [], priorRound: 0,
        priorTotalRounds: total, priorRoundFindings: traj,
        submitted: Array.from({ length: n }, (_, i) => f(i + 1, "a.mjs")),
      });
      traj = r.roundFindings;
      total = r.totalRounds;
    }
    expect(traj).toEqual([5, 1, 1, 0]);
    expect(total).toBe(4);
  });

  it("seeds a legacy note from priorRound, not from zero", () => {
    // A note verdicted before this field existed has a real history. Starting at 0 would
    // report a NEW false number for every already-approved story; seeding reports a
    // conservative one. Same reasoning as "absence is NOT a mismatch" for arch_subject.
    const r = computeArchVerdict({ priorRound: 2, submitted: [] });
    expect(r.totalRounds).toBe(3);
  });

  it("tolerates a malformed cumulative value instead of refusing the review", () => {
    // An ADVISORY field that can deny a verdict is worse than one that is wrong. Contrast
    // arch_round, whose invalid value legitimately refuses the call.
    expect(() =>
      computeArchVerdict({ priorTotalRounds: "banana", priorRoundFindings: "nope", submitted: [] }),
    ).not.toThrow();
    const r = computeArchVerdict({ priorTotalRounds: "banana", priorRoundFindings: "nope", submitted: [] });
    expect(r.totalRounds).toBe(1);
    expect(r.roundFindings).toEqual([0]);
  });

  it("bounds the trajectory so frontmatter cannot grow without limit", () => {
    const long = Array.from({ length: 40 }, () => 1);
    const r = computeArchVerdict({ priorRoundFindings: long, priorTotalRounds: 40, submitted: [] });
    expect(r.roundFindings.length).toBeLessThanOrEqual(24);
    expect(r.roundFindings[r.roundFindings.length - 1]).toBe(0);
  });

  it("NEGATIVE CONTROL: a rebase still blocks a novel finding", () => {
    // Green by design, both before and after. It proves the cumulative measure did not
    // buy itself relevance by weakening the mechanism it sits beside.
    const r = computeArchVerdict({
      priorLedger: ["item-9-old-mjs"], priorRound: 1,
      priorTotalRounds: 1, priorRoundFindings: [1],
      submitted: [f(1, "new.mjs")],
      recordedSubject: SUBJ_1, currentSubject: SUBJ_2,
    });
    expect(r.verdict).toBe("needs-revision");
    expect(r.blocking).toEqual(["item-1-new-mjs"]);
  });

  it("NEGATIVE CONTROL: the cumulative fields do not feed capped", () => {
    // Green by design. capped must stay a function of `round` alone — and note that
    // capped force-APPROVES (verdict approved, blocking []), so letting a cumulative
    // bound reach it would ship a story mid-revision rather than halting it.
    const r = computeArchVerdict({
      priorLedger: [], priorRound: 0,
      priorTotalRounds: 99, priorRoundFindings: [3, 3, 3],
      submitted: [f(1, "a.mjs")],
    });
    expect(r.totalRounds).toBe(100);
    expect(r.capped).toBe(false);
    expect(r.verdict).toBe("needs-revision");
  });
});

// ── backlog.fix.arch-guidance-write-self-rebases-ledger ──────────────────────
//
// The defect: governor-arch.md step 3(b) REQUIRES ARCH to write a `## ARCH Guidance`
// section into the story body on every pass, and subjectDigest hashed the whole body.
// So the tool invalidated, as a normal step of its own review, the subject it had just
// recorded — `round` was permanently 1 on the mandated path, `deferred` never fired,
// and ARCH_MAX_ROUNDS was unreachable.
//
// The remedy subtracts the ARCH-owned section before digesting. The hazard the remedy
// itself introduces is a naive parser: a story ABOUT this mechanism quotes the heading
// many times in ordinary prose, so a substring `indexOf` resolves to the FIRST
// quotation and strips everything from there to the next `## ` — silently deleting
// Problem, Solution and Acceptance Criteria from the digested subject, undetectably,
// because the digest is a hash.
//
// EVERY fixture below CARRIES THE DECOY. A single-occurrence fixture cannot distinguish
// the anchored condition from the substring one: it passes under both, and would ship
// the bug green.

import { stripArchGuidanceSection } from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

/**
 * A body shaped like a real story note about ARCH: the heading literal appears in
 * reviewable prose ABOVE the real section, INDENTED and inside an inline-code span,
 * and the real ARCH-owned section is the last column-0 occurrence.
 */
const DECOY_PROSE = [
  "## Problem",
  "",
  "The prompt mandates a write into the body. Quoted indented, as the prompt's own",
  "worked template quotes it:",
  "",
  "   ## ARCH Guidance",
  "",
  "and quoted inline as `## ARCH Guidance` in a sentence, and mid-line like",
  "this heading: ## ARCH Guidance — still prose.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] reviewable material that must survive the subtraction",
].join("\n");

const GUIDANCE = ["## ARCH Guidance", "", "**Verdict:** approved", "", "No findings."].join("\n");

const withGuidance = (prose = DECOY_PROSE, guidance = GUIDANCE) => `${prose}\n\n${guidance}\n`;

describe("stripArchGuidanceSection — the boundary is LINE-START-ANCHORED", () => {
  it("takes the column-0 section, not the first substring match", () => {
    // A bare body.indexOf("## ARCH Guidance") resolves inside the Problem section and
    // would strip from there onward. This assertion fails by construction under it.
    const stripped = stripArchGuidanceSection(withGuidance());
    expect(stripped).toContain("## Problem");
    expect(stripped).toContain("## Acceptance Criteria");
    expect(stripped).toContain("reviewable material that must survive the subtraction");
    expect(stripped).not.toContain("**Verdict:** approved");
    expect(stripped).not.toContain("No findings.");
  });

  it("keeps the reviewable prose sitting ABOVE the decoy in the digested subject", () => {
    const stripped = stripArchGuidanceSection(withGuidance());
    expect(stripped).toContain("The prompt mandates a write into the body.");
    // The decoys are reviewable prose, not the ARCH-owned section. They stay.
    expect(stripped).toContain("   ## ARCH Guidance");
    expect(stripped).toContain("inline as `## ARCH Guidance` in a sentence");
    expect(stripped).toContain("this heading: ## ARCH Guidance — still prose.");
  });

  it("closes on the next line STARTING with `## `, not the next occurrence of it", () => {
    // The guidance body here contains `## ` mid-line. A body.indexOf("## ", start)
    // close would cut there and leave the tail of ARCH's narrative in the subject.
    const body = [
      "## Problem",
      "",
      "prose",
      "",
      "## ARCH Guidance",
      "",
      "The finding is at item ## 4 in the checklist, mid-line.",
      "",
      "## Related",
      "",
      "- something reviewable",
    ].join("\n");
    const stripped = stripArchGuidanceSection(body);
    expect(stripped).not.toContain("mid-line");
    expect(stripped).toContain("## Related");
    expect(stripped).toContain("- something reviewable");
  });

  it("takes the LAST column-0 heading when a story carries more than one", () => {
    const body = [
      "## ARCH Guidance",
      "",
      "an earlier column-0 occurrence in the story's own prose",
      "",
      "## Solution",
      "",
      "reviewable material BETWEEN the two headings",
      "",
      "## ARCH Guidance",
      "",
      "the section ARCH actually wrote",
    ].join("\n");
    const stripped = stripArchGuidanceSection(body);
    expect(stripped).toContain("reviewable material BETWEEN the two headings");
    expect(stripped).toContain("an earlier column-0 occurrence");
    expect(stripped).not.toContain("the section ARCH actually wrote");
  });

  it("is total — a body with no line-anchored heading is returned unchanged", () => {
    expect(stripArchGuidanceSection(DECOY_PROSE)).toBe(DECOY_PROSE);
    expect(stripArchGuidanceSection("")).toBe("");
    expect(stripArchGuidanceSection(undefined)).toBe("");
  });

  it("tolerates trailing whitespace on the heading line but NOT leading", () => {
    expect(stripArchGuidanceSection("## Problem\n\np\n\n## ARCH Guidance  \n\nn\n")).not.toContain("\nn\n");
    expect(stripArchGuidanceSection("## Problem\n\np\n\n  ## ARCH Guidance\n\nn\n")).toContain("\nn\n");
  });
});

describe("subjectDigest — ARCH's own narrative write does not move the digest", () => {
  it("is unchanged by adding a guidance section to a body that had none", () => {
    expect(subjectDigest({ body: withGuidance() })).toBe(subjectDigest({ body: `${DECOY_PROSE}\n` }));
  });

  it("is unchanged by REPLACING the guidance section, which is what a re-review does", () => {
    const pass1 = withGuidance(DECOY_PROSE, "## ARCH Guidance\n\n**Verdict:** needs-revision\n\nfour findings");
    const pass2 = withGuidance(DECOY_PROSE, "## ARCH Guidance\n\n**Verdict:** approved\n\nNo findings.");
    expect(subjectDigest({ body: pass1 })).toBe(subjectDigest({ body: pass2 }));
  });

  it("STILL changes when reviewable prose above the decoy is amended", () => {
    const amended = withGuidance(DECOY_PROSE.replace("- [ ] reviewable material", "- [ ] AMENDED material"));
    expect(subjectDigest({ body: amended })).not.toBe(subjectDigest({ body: withGuidance() }));
  });

  it("STILL changes when the DECOY prose itself is amended — it is reviewable body", () => {
    const amended = withGuidance(DECOY_PROSE.replace("still prose.", "still prose, edited."));
    expect(subjectDigest({ body: amended })).not.toBe(subjectDigest({ body: withGuidance() }));
  });

  it("changes when a guidance replacement is accompanied by a genuine amendment", () => {
    // The exclusion is scoped to the ARCH-owned section and must not MASK a concurrent
    // amendment made in the same edit.
    const before = withGuidance(DECOY_PROSE, "## ARCH Guidance\n\nfour findings");
    const after = withGuidance(DECOY_PROSE.replace("reviewable material", "AMENDED material"), "## ARCH Guidance\n\nNo findings.");
    expect(subjectDigest({ body: after })).not.toBe(subjectDigest({ body: before }));
  });
});

// Source-text witnesses. Both scan a file OTHER than this one, so the assertion
// strings here cannot satisfy themselves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DESCRIPTION } from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSrc = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/server.mjs"), "utf8");

describe("the arch-verdict handler no longer documents an invariant it does not hold", () => {
  it("server.mjs does not claim a recorded verdict cannot invalidate its own subject", () => {
    // The claim was true of the FRONTMATTER and false of the BODY, which had no
    // arch-owned / reviewable partition while governor-arch.md mandated a body write on
    // every pass. Asserted on the durable phrase rather than a fixed source window: the
    // window would move on any edit above it, and the phrase would not.
    expect(serverSrc).not.toContain("cannot invalidate the subject it was recorded against");
  });
});

describe("TOOL_DESCRIPTION describes behaviour the workflow now reaches", () => {
  // POSITIVE assertions, and a not.toContain here would be a DEFECT rather than a test.
  // These three sentences were already TRUE of computeArchVerdict — the four witnesses in
  // tests/integration/arch-verdict-tool.test.mjs that drive the handler with no guidance
  // write prove it. They were false only of the tool-plus-prompt COMPOSITION, and the
  // remedy makes the composition match them. Asserting their ABSENCE would delete correct
  // documentation and land a permanently-green test pinning that deletion.
  it.each([
    "round 1 freezes the ledger",
    "returned as deferred rather than blocking",
    "the round cap counts rounds per story VERSION",
  ])("still promises: %s", (phrase) => {
    expect(TOOL_DESCRIPTION).toContain(phrase);
  });
});
