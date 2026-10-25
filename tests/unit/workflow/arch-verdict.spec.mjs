import { describe, it, expect } from "vitest";
import {
  computeArchVerdict,
  findingKey,
  ARCH_MAX_ROUNDS,
  ARCH_SUBJECT_VERSION,
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
        recordedSubject: SUBJ_B, currentSubject: SUBJ_B, recordedVersion: ARCH_SUBJECT_VERSION,
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
      recordedSubject: SUBJ_A, currentSubject: SUBJ_A, recordedVersion: ARCH_SUBJECT_VERSION,
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
      recordedSubject: SUBJ_1, currentSubject: SUBJ_1, recordedVersion: ARCH_SUBJECT_VERSION,
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
import { readServerSurfaceSource } from "../../_helpers/server-source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSrc = readServerSurfaceSource();

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

// backlog.fix.arch-verdict-enforces-plan-ready-create-gate. ADDITIVE pins: the three phrase
// pins above are untouched. The handler refuses `approved` while plan_ready's
// create_target_no_authorable_block would block the story, so the provider contract must say
// so — both in TOOL_DESCRIPTION and in the module doc (cap clause / ARCH_MAX_ROUNDS doc).
describe("arch-verdict names the plan-ready create gate exception", () => {
  const archVerdictSrc = fs.readFileSync(
    path.join(repoRoot, "packages/mcp-rks/src/workflow/arch-verdict.mjs"),
    "utf8",
  );

  it("TOOL_DESCRIPTION names create_target_no_authorable_block and gateIssues", () => {
    expect(TOOL_DESCRIPTION).toContain("create_target_no_authorable_block");
    expect(TOOL_DESCRIPTION).toContain("gateIssues");
  });

  it.each([
    "round 1 freezes the ledger",
    "returned as deferred rather than blocking",
    "the round cap counts rounds per story VERSION",
  ])("TOOL_DESCRIPTION still contains: %s", (phrase) => {
    expect(TOOL_DESCRIPTION).toContain(phrase);
  });

  it("the module doc, with the TOOL_DESCRIPTION literal removed, still names the gate exception", () => {
    // Full source text, not a fixed-size window: the literal is removed so the assertion can
    // only be satisfied by the doc comments (cap clause and ARCH_MAX_ROUNDS doc).
    const literal = JSON.stringify(TOOL_DESCRIPTION);
    expect(archVerdictSrc).toContain(literal);
    const withoutLiteral = archVerdictSrc.replace(literal, "");
    expect(withoutLiteral).not.toContain(literal);
    expect(withoutLiteral).toContain("create_target_no_authorable_block");
  });
});

// ── backlog.fix.arch-verdict-never-retracts-arch-approved ────────────────────
//
// (1) TOOL_DESCRIPTION states the retraction, so the provider contract no longer
//     describes a promotion-only phase relationship.
// (2) noteSubjectDigest is the ONE parsed-note -> digest mapping shared by the
//     rks_arch_verdict handler and the guardrails-off story gate. These cases witness
//     that it equals the handler's former inline mapping and that the pipeline's own
//     writes cannot move it.
import { noteSubjectDigest, subjectDigest as subjectDigestForHelper } from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { parseFrontmatter } from "../../../packages/mcp-rks/src/dendron.mjs";

describe("TOOL_DESCRIPTION states the arch-approved retraction", () => {
  it("says a needs-revision verdict on an arch-approved story returns its phase to ready", () => {
    expect(TOOL_DESCRIPTION).toContain(
      "a needs-revision verdict on a story at phase arch-approved returns its phase to ready",
    );
    expect(TOOL_DESCRIPTION).toContain("planned, executing and executed are not demoted");
  });

  it.each([
    "round 1 freezes the ledger",
    "returned as deferred rather than blocking",
    "the round cap counts rounds per story VERSION",
    "create_target_no_authorable_block",
    "gateIssues",
  ])("keeps the existing phrase: %s", (phrase) => {
    expect(TOOL_DESCRIPTION).toContain(phrase);
  });
});

/** A story note whose individual parts can be varied one at a time. */
function noteRaw({
  id = "backlog.fix.digest-fixture",
  phase = "arch-approved",
  updated = "1700000000000",
  targetFiles = ['  - path: "src/a.mjs"', '    op: "edit"'],
  testRequirements = ['  - "tests/a.test.mjs: a does the thing"'],
  testFiles = ["  - tests/a.test.mjs"],
  arch = ['arch_verdict: "approved"', 'arch_round: "1"', 'arch_subject: "0123456789abcdef0123456789abcdef"'],
  body = "\n## Problem\n\nThe problem.\n\n## Solution\n\nThe solution.\n",
  guidance = "",
} = {}) {
  const fm = [
    "---",
    ...(id === null ? [] : [`id: "${id}"`]),
    'title: "Digest fixture"',
    `updated: ${updated}`,
    `phase: "${phase}"`,
    "targetFiles:",
    ...targetFiles,
    "testRequirements:",
    ...testRequirements,
    "testFiles:",
    ...testFiles,
    ...arch,
    "---",
  ];
  return `${fm.join("\n")}\n${body}${guidance}`;
}

const digestOf = (opts) => noteSubjectDigest(parseFrontmatter(noteRaw(opts)));
const BASE = digestOf();

describe("noteSubjectDigest — the shared parsed-note digest", () => {
  it("equals subjectDigest over the parsed body, targetFiles and testRequirements", () => {
    const parsed = parseFrontmatter(noteRaw());
    expect(Array.isArray(parsed.data.targetFiles)).toBe(true);
    expect(Array.isArray(parsed.data.testRequirements)).toBe(true);
    expect(noteSubjectDigest(parsed)).toBe(
      subjectDigestForHelper({
        body: parsed.content,
        targetFiles: parsed.data.targetFiles,
        testRequirements: parsed.data.testRequirements,
      }),
    );
    expect(BASE).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([
    ["the ## ARCH Guidance section", { guidance: "\n## ARCH Guidance\n\n**Verdict:** approved\n\nNo findings.\n" }],
    ["testFiles", { testFiles: ["  - tests/a.test.mjs", "  - tests/b.test.mjs"] }],
    ["phase", { phase: "ready" }],
    ["updated", { updated: "1800000000000" }],
    ["id (absent, i.e. before the back-fill)", { id: null }],
    ["arch_verdict", { arch: ['arch_verdict: "needs-revision"', 'arch_round: "1"', 'arch_subject: "0123456789abcdef0123456789abcdef"'] }],
    ["arch_round", { arch: ['arch_verdict: "approved"', 'arch_round: "3"', 'arch_subject: "0123456789abcdef0123456789abcdef"'] }],
    ["arch_subject", { arch: ['arch_verdict: "approved"', 'arch_round: "1"', 'arch_subject: "ffffffffffffffffffffffffffffffff"'] }],
    ["arch_ledger", { arch: ['arch_verdict: "approved"', 'arch_round: "1"', 'arch_subject: "0123456789abcdef0123456789abcdef"', "arch_ledger:", "  - item-1-a-mjs"] }],
    ["arch_total_rounds / arch_round_findings", { arch: ['arch_verdict: "approved"', 'arch_round: "1"', 'arch_subject: "0123456789abcdef0123456789abcdef"', 'arch_total_rounds: "7"', "arch_round_findings:", '  - "2"'] }],
  ])("is unchanged when only %s differs", (_label, opts) => {
    expect(noteRaw(opts)).not.toBe(noteRaw());
    expect(digestOf(opts)).toBe(BASE);
  });

  it.each([
    ["the body outside ## ARCH Guidance", { body: "\n## Problem\n\nThe AMENDED problem.\n\n## Solution\n\nThe solution.\n" }],
    ["targetFiles", { targetFiles: ['  - path: "src/a.mjs"', '    op: "edit"', '  - path: "src/b.mjs"', '    op: "edit"'] }],
    ["testRequirements", { testRequirements: ['  - "tests/a.test.mjs: a does the OTHER thing"'] }],
  ])("changes when %s changes", (_label, opts) => {
    expect(digestOf(opts)).not.toBe(BASE);
  });
});

describe("server.mjs computes currentSubject through the shared helper", () => {
  it("calls noteSubjectDigest(parsed) and carries no inline subjectDigest({ body: ... }) mapping", () => {
    expect(serverSrc).toMatch(/const currentSubject = noteSubjectDigest\(parsed\);/);
    expect(serverSrc).toMatch(/import\s*\{[^}]*\bnoteSubjectDigest\b[^}]*\}\s*from\s*"\.\/workflow\/arch-verdict\.mjs"/);
    expect(serverSrc).not.toMatch(/subjectDigest\(\s*\{\s*body\s*:/);
  });
});

// ── backlog.fix.arch-subject-digest-guidance-boundary-whitespace ─────────────
//
// stripArchGuidanceSection removes the section from its heading line onward but KEEPS the
// blank separator a first-pass append writes above it. On a body with NO trailing newline
// that append (`X` -> `X\n\n## ARCH Guidance\n...`) left the stripped body one byte longer,
// so ARCH's mandated narrative write moved the digest it had just recorded and
// rks_guardrails_off refused with story_changed_since_arch. The existing pin above passes
// only because its "before" body already ends in a newline.
//
// The new exports are read through a namespace import so that, against the pre-fix module,
// the cases below fail individually rather than the whole file failing to link.
import * as archVerdictModule from "../../../packages/mcp-rks/src/workflow/arch-verdict.mjs";
import { createHash } from "node:crypto";

/** Independent reference implementation of the PRE-FIX subject digest. */
function referencePreFixDigest({ body, targetFiles, testRequirements } = {}) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sort(v[k]); return acc; }, {});
    }
    return v === undefined ? null : v;
  };
  const src = typeof body === "string" ? body : "";
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) if (/^## ARCH Guidance[ \t]*$/.test(lines[i])) start = i;
  let stripped = src;
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^## /.test(lines[i])) { end = i; break; }
    }
    stripped = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  }
  const canonical = JSON.stringify(sort({
    body: stripped,
    targetFiles: targetFiles ?? null,
    testRequirements: testRequirements ?? null,
  }));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// DECOY_PROSE ends WITHOUT a trailing newline — the incident shape.
const firstPassAppend = (prose, guidance = GUIDANCE, tail = "") => `${prose}\n\n${guidance}${tail}`;

describe("subjectDigest — the first-pass append is digest-neutral whatever the body ended in", () => {
  it("a body with NO trailing newline digests equal to itself after the first-pass append (the incident shape)", () => {
    expect(DECOY_PROSE.endsWith("\n")).toBe(false);
    const before = subjectDigest({ body: DECOY_PROSE });
    expect(subjectDigest({ body: firstPassAppend(DECOY_PROSE) })).toBe(before);
    expect(subjectDigest({ body: firstPassAppend(DECOY_PROSE, GUIDANCE, "\n") })).toBe(before);
  });

  it("the same equality holds for a body WITH a trailing newline", () => {
    const prose = `${DECOY_PROSE}\n`;
    const before = subjectDigest({ body: prose });
    // The prompt's step (b)iii shape: anchor replaced by anchor + "\n\n" + section.
    expect(subjectDigest({ body: `${prose}\n\n${GUIDANCE}` })).toBe(before);
    expect(subjectDigest({ body: `${prose}\n\n${GUIDANCE}\n` })).toBe(before);
    expect(subjectDigest({ body: withGuidance() })).toBe(before);
  });

  it("a section inserted mid-body directly above another level-2 section rejoins with exactly one blank line", () => {
    const pre = "## Problem\n\nprose\n\n## Related\n\n- reviewable";
    const post = `## Problem\n\nprose\n\n${GUIDANCE}\n\n## Related\n\n- reviewable`;
    expect(subjectDigest({ body: post })).toBe(subjectDigest({ body: pre }));
    // Extra blank lines between the section's narrative and the next heading are absorbed.
    const postLoose = `## Problem\n\nprose\n\n\n${GUIDANCE}\n\n\n\n## Related\n\n- reviewable`;
    expect(subjectDigest({ body: postLoose })).toBe(subjectDigest({ body: pre }));
  });

  it("trimEnd applies whether or not a section was stripped", () => {
    const x = DECOY_PROSE;
    const base = subjectDigest({ body: x });
    for (const tail of ["\n", "\n\n", "\n\n\n", "  ", " \t\n", "\n  \n"]) {
      expect(subjectDigest({ body: `${x}${tail}` })).toBe(base);
    }
  });

  it("replacing an existing guidance section still leaves the digest unchanged (no trailing newline before pass 1)", () => {
    const pass1 = firstPassAppend(DECOY_PROSE, "## ARCH Guidance\n\n**Verdict:** needs-revision\n\nfour findings");
    const pass2 = firstPassAppend(DECOY_PROSE, "## ARCH Guidance\n\n**Verdict:** approved\n\nNo findings.", "\n");
    expect(subjectDigest({ body: pass1 })).toBe(subjectDigest({ body: pass2 }));
    expect(subjectDigest({ body: pass2 })).toBe(subjectDigest({ body: DECOY_PROSE }));
  });

  it("a material amendment to reviewable prose or to the decoy prose still changes the digest", () => {
    const base = subjectDigest({ body: firstPassAppend(DECOY_PROSE) });
    const reviewable = firstPassAppend(DECOY_PROSE.replace("- [ ] reviewable material", "- [ ] AMENDED material"));
    const decoy = firstPassAppend(DECOY_PROSE.replace("still prose.", "still prose, edited."));
    expect(subjectDigest({ body: reviewable })).not.toBe(base);
    expect(subjectDigest({ body: decoy })).not.toBe(base);
    // Blank-line layout outside protected regions is NOT reviewable text
    // (backlog.fix.arch-subject-digest-whitespace-robust): lengthening a blank-line run between
    // two sections leaves the version-2 digest unchanged, while a non-whitespace internal edit
    // still moves it.
    expect(subjectDigest({ body: DECOY_PROSE.replace("## Acceptance Criteria", "\n## Acceptance Criteria") })).toBe(
      subjectDigest({ body: DECOY_PROSE }),
    );
    expect(subjectDigest({ body: DECOY_PROSE.replace("## Acceptance Criteria", "## Acceptance Criteria (edited)") })).not.toBe(
      subjectDigest({ body: DECOY_PROSE }),
    );
  });
});

describe("legacySubjectDigest — the pre-fix algorithm, kept for comparison", () => {
  const TF = [{ path: "src/a.mjs", op: "edit" }];
  const TR = ["tests/a.test.mjs: a does the thing"];
  const BODIES = [
    ["no trailing newline", DECOY_PROSE],
    ["trailing newline", `${DECOY_PROSE}\n`],
    ["section at EOF", firstPassAppend(DECOY_PROSE, GUIDANCE, "\n")],
    ["section mid-body", `## Problem\n\nprose\n\n${GUIDANCE}\n\n## Related\n\n- reviewable\n`],
    ["empty", ""],
    ["undefined", undefined],
  ];

  it.each(BODIES)("equals the reference pre-fix digest: %s", (_label, body) => {
    expect(typeof archVerdictModule.legacySubjectDigest).toBe("function");
    expect(archVerdictModule.legacySubjectDigest({ body, targetFiles: TF, testRequirements: TR })).toBe(
      referencePreFixDigest({ body, targetFiles: TF, testRequirements: TR }),
    );
    expect(archVerdictModule.legacySubjectDigest({ body })).toBe(referencePreFixDigest({ body }));
  });

  it("noteLegacySubjectDigest(parsed) equals legacySubjectDigest over parsed.content, targetFiles and testRequirements", () => {
    expect(typeof archVerdictModule.noteLegacySubjectDigest).toBe("function");
    const parsed = parseFrontmatter(noteRaw({ guidance: "\n## ARCH Guidance\n\nNo findings.\n" }));
    expect(archVerdictModule.noteLegacySubjectDigest(parsed)).toBe(
      archVerdictModule.legacySubjectDigest({
        body: parsed.content,
        targetFiles: parsed.data.targetFiles,
        testRequirements: parsed.data.testRequirements,
      }),
    );
    expect(archVerdictModule.noteLegacySubjectDigest(parsed)).toBe(
      referencePreFixDigest({
        body: parsed.content,
        targetFiles: parsed.data.targetFiles,
        testRequirements: parsed.data.testRequirements,
      }),
    );
  });

  it("differs from the canonical digest on a body ending in whitespace, and agrees when nothing is canonicalized", () => {
    expect(archVerdictModule.legacySubjectDigest({ body: `${DECOY_PROSE}\n` })).not.toBe(subjectDigest({ body: `${DECOY_PROSE}\n` }));
    expect(archVerdictModule.legacySubjectDigest({ body: DECOY_PROSE })).toBe(subjectDigest({ body: DECOY_PROSE }));
  });
});

// ── Incident reproduction ────────────────────────────────────────────────────
//
// The REAL bytes of notes/backlog.fix.child-bash-git-write-verbs-bypass-ship-governor.md:
// INCIDENT_NOTE_AT_DDDB36CC8 is the whole file at commit dddb36cc8 (after rks_arch_verdict
// recorded approved; the body ends WITHOUT a trailing newline), one array entry per line.
// INCIDENT_APPENDED_AT_AD13E7E73 is exactly what commit ad13e7e73 appended after it (ARCH's
// guidance write); that commit also bumped `updated:`. Copied with `git show <sha>:<path>`.
// The two hex values are the ones rks_guardrails_off reported in the incident.
const INCIDENT_NOTE_AT_DDDB36CC8 = [
  "---",
  "id: \"backlog.fix.child-bash-git-write-verbs-bypass-ship-governor\"",
  "title: \"Child Bash hook admits git commit/add/rm from the Dispatcher; redirect them to the Ship Governor path\"",
  "desc: \"redirect-read-bash-to-agent.mjs classifies on the leading token only and git is in ALLOWLIST_TOKENS, so a child Dispatcher can run git commit, git add and git rm directly; enforce-git-workflow only gates commits on the test command. Redirect these verbs to rks_agent_git / rks_git_commit the way reads redirect to research.\"",
  "created: 1791057811714",
  "updated: 1791181407231",
  "status: \"not-implemented\"",
  "testFile: \"\"",
  "targetFiles:",
  "  - path: \"packages/hooks/read/redirect-read-bash-to-agent.mjs\"",
  "    op: \"edit\"",
  "    desc: \"Canonical child Bash hook. In classifyBashCommand, classify git commit, add and rm (after skipping git global options such as -C and -c) as a redirect kind before the leading-token allowlist returns allow. Deny output carries a REDIRECT ORDER to rks_agent_git or the Ship Governor path\"",
  "  - path: \"templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs\"",
  "    op: \"edit\"",
  "    desc: \"Byte-identical template copy of the canonical hook, enforced by the parity test\"",
  "  - path: \".routekit/hooks/read/redirect-read-bash-to-agent.mjs\"",
  "    op: \"edit\"",
  "    desc: \"Byte-identical deployed copy of the canonical hook, enforced by the parity test\"",
  "  - path: \"tests/unit/redirect-read-bash-to-agent.test.mjs\"",
  "    op: \"edit\"",
  "    desc: \"Line 152 pins git -C /tmp/repo commit as allowlisted. Update that assertion to the new redirect expectation (do not delete it). QA adds the remaining coverage\"",
  "phase: \"arch-approved\"",
  "testRequirements:",
  "  - \"classifyBashCommand returns a non-allow result with the new git-write redirect kind (action redirect or deny, not allow) for each of: git commit -m x, git add notes/a.md, git rm notes/a.md\"",
  "  - \"classifyBashCommand returns the same git-write kind when git global options precede the subcommand: git -C /tmp/repo commit -m fix, git -c user.name=x commit -m y, git --no-pager add ., git --git-dir=.git rm a.md, git --work-tree=. add a.md\"",
  "  - \"Subcommand detection is token-exact, not substring: git log --grep commit, git show HEAD:notes/add.md and git status still classify as action allow kind allowlisted\"",
  "  - \"Read-only and other git commands keep current classification action allow kind allowlisted: git status, git log --oneline -5, git diff, git rev-parse HEAD, git branch\"",
  "  - \"Non-git allowlisted commands are unchanged action allow kind allowlisted: npm install, node script.mjs, npx vitest run\"",
  "  - \"Project-declared testCommand widening cannot admit git commit, add or rm: classifyBashCommand with extraTokens containing git still returns the git-write kind for git commit -m x\"",
  "  - \"Metacharacter check still runs first: CO_AUTHOR_CMD (git -C /tmp/repo commit with a Co-Authored-By trailer containing angle brackets) still returns action deny kind metacharacter, and git add x && git commit -m y returns kind metacharacter\"",
  "  - \"The existing peer-witness control test (line 151-152, git -C /tmp/repo commit -m fix: x) is UPDATED to expect the new git-write kind instead of action allow kind allowlisted, not deleted; its intent (the trailer alone is what causes the metacharacter denial) is preserved by asserting the result kind is not metacharacter\"",
  "  - ALLOWLIST still contains git and the keeps-the-same-ten-tokens-in-order test passes unchanged",
  "  - Spawned hook given a Bash git commit -m x payload emits hookSpecificOutput with permissionDecision deny whose text contains REDIRECT ORDER and names rks_agent_git and/or rks_git_commit (Ship Governor path)",
  "  - Spawned hook deny for git add notes/a.md and git rm notes/a.md likewise contains REDIRECT ORDER naming rks_agent_git and/or rks_git_commit",
  "  - \"The git-write deny text does not claim the command was run or that an agent can run the raw command: it does not contain run (needs governance) and does not route to mcp__rks__rks_agent_research\"",
  "  - \"The git-write deny path does not take the Research-Agent outage fallthrough: with an outage marker present, a git commit payload is still denied (fallthrough remains read-class only)\"",
  "  - In keyless mode (no ANTHROPIC_API_KEY or OPENAI_API_KEY in the spawned env) a git commit payload is still denied; keyless changes messaging only, not the decision",
  "  - A git-write denial still emits a guardrail bump to .routekit/telemetry/guardrails.log identifying hook redirect-read-bash-to-agent and the git-write kind",
  "  - Spawned hook given git status still exits 0 with no output (allow)",
  "  - packages/hooks/read/redirect-read-bash-to-agent.mjs, templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs and .routekit/hooks/read/redirect-read-bash-to-agent.mjs remain byte-identical (existing parity describe block passes)",
  "  - \"All subprocess spawns in test file use explicit timeout (spawnSync timeout: option or spawn/execa setTimeout kill guard)\"",
  "testFiles:",
  "  - tests/unit/redirect-read-bash-to-agent.test.mjs",
  "arch_ledger: []",
  "arch_deferred: []",
  "arch_round: \"1\"",
  "arch_findings_count: \"0\"",
  "arch_verdict: \"approved\"",
  "arch_subject: \"ea7dfa68091f604c0abeba0296427685\"",
  "arch_total_rounds: \"1\"",
  "arch_round_findings:",
  "  - 0",
  "---",
  "",
  "## Problem",
  "",
  "User intent: a Dispatcher on a governed project must not be able to run `git commit`, `git add` or `git rm` directly in Bash. These must redirect to the Ship Governor path (`rks_git_commit` / `rks_agent_git`), the same way Bash reads redirect to the Research Agent. They are allowed only from governed paths or when guardrails are off. The user approves every hook change before it ships.",
  "",
  "### Field report (peer, ux287 session, rks 0.63.0, verbatim; the reporter's account, not measured here)",
  "",
  "> Observed in ux287-f6: the Dispatcher ran `git add <notes>` then `git commit -m ...` directly in Bash, bypassing the Ship Governor / rks_git_commit. No hook denied either call. It reached the user's permission prompt only because auto mode had dropped at that moment, and the user rejected it.",
  "> Why it passed:",
  "> - the child Bash allowlist admits `git` as a leading verb;",
  "> - hooks/write/enforce-git-workflow.mjs only gates commits on `npm test` passing. Earlier in the session the stub test failed, which incidentally blocked commits. Now that the project has a real passing test, Dispatcher commits go straight through.",
  "",
  "### Re-derived in this repo (`rks_exhaustive_search`, anchor `@16e82afba`)",
  "",
  "**Child Bash PreToolUse chain.** `packages/cli/src/project/bootstrap.mjs` registers under matcher `\"Bash\"` (`:613`): `redirect-read-bash-to-agent.mjs` (`:615`), `block-git-during-off-rail.mjs` (`:616`), `enforce-git-workflow.mjs` (`:617`), `enforce-branch-workflow.mjs` (`:618`), `check-dependency-security.mjs` (`:619`). The shell's blanket `redirect-bash-to-governor.mjs` is not in that list (it is the subject of the separate open decision in `backlog.fix.child-hook-registration-omits-template-governor-redirects`).",
  "",
  "**Claim 1 holds: `git` is admitted as a leading verb.** `packages/hooks/read/redirect-read-bash-to-agent.mjs:47` `  \"git\", \"tsc\", \"vitest\", \"eslint\", \"prettier\",` is inside `ALLOWLIST_TOKENS` (`:45`). `classifyBashCommand` (`:138`) takes `:142` `  const token = trimmed.split(/\\s+/)[0];` and returns allow at `:143` `  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };`. No subcommand after `git` is inspected. The only earlier denial is the metacharacter check (`:141`), so a chained `git add x && git commit` is denied but two separate calls, as reported, are admitted. The existing unit test pins this: `tests/unit/redirect-read-bash-to-agent.test.mjs:152` asserts `classifyBashCommand('git -C /tmp/repo commit -m \"fix: x\"')` is `{ action: 'allow', kind: 'allowlisted' }`.",
  "",
  "**Claim 2 holds: `enforce-git-workflow.mjs` only gates commits on the test command.** In `.routekit/hooks/write/enforce-git-workflow.mjs` the commit branch is `:148` `    if (/^git\\s+commit\\b/.test(gitCmd)) {`, which reads `require_tests` (`:149`) and resolves/runs the gate command (`:158`, `:172`). The other checks are policy `blocked_operations` (`:94`; default `[]` at `:26`; the shell's `.routekit/git-policy.yaml` lists only `git reset --hard`, `git push.*--delete`, `git rebase.*-i`), force push (`:113`) and direct push to protected branches (`:129`). Nothing matches `git add` or `git rm`. The reporter's path `hooks/write/enforce-git-workflow.mjs` corresponds to `write/enforce-git-workflow.mjs` in the manifest (`.routekit/hooks-manifest.json:16`).",
  "",
  "**Other gates do not close it.** `packages/hooks/write/enforce-branch-workflow.mjs:135` blocks `git commit` only when the current branch is in `block_direct_commits_to` (default `[\"main\", \"dev\"]`, `:31`). `block-git-during-off-rail.mjs` acts only during an off-rail session (`:5`).",
  "",
  "**Not re-derived:** the ux287 session itself (auto-mode state, the exact commands, the earlier stub-test failure). Those rest on the report.",
  "",
  "**The shell is not affected in the same way.** The shell registers `redirect-bash-to-governor.mjs` on Bash (`.claude/settings.json:404`), whose read-only pass-through is `.routekit/hooks/write/redirect-bash-to-governor.mjs:45` `    /^git\\s+(status|log|rev-parse|show|diff)(\\s|$)/.test(cmd) ||` plus terminal-anchored `git branch` (`:50`); `commit`, `add` and `rm` are not in it. This story is about the child hook.",
  "",
  "## Solution",
  "",
  "In `classifyBashCommand`, before the leading-token allowlist returns allow, recognise a git invocation whose subcommand is `commit`, `add` or `rm` and return a redirect (a new `kind`, e.g. `git-write`) instead of allow. Subcommand detection must skip git's global options that precede the subcommand (at minimum `-C <path>`, `-c <key=value>`, `--git-dir=...`, `--work-tree=...`, `--no-pager`), because `git -C /tmp/repo commit` is a form the existing test already exercises.",
  "",
  "The hook's output for that kind is a deny carrying a REDIRECT ORDER naming the governed path: `rks_governor_init` then `rks_agent_git` (or the Ship Governor / `/ship` skill, which commits through `rks_git_commit`). It must not claim an agent can run the raw command, consistent with the existing `denyOptionsFor` wording.",
  "",
  "Exemptions are structural and must stay that way, not be implemented as new checks:",
  "- Governed paths (`rks_git_commit`, `rks_agent_git`, `rks_exec` commits, `rks_ship`) run git inside the MCP server process, not through the Claude Code Bash tool, so this PreToolUse Bash hook does not see them. QA should confirm this rather than take it from this note.",
  "- Guardrails off: this is a read-tier hook, and the parity test's own skip reason says the read tier \"is relocated to .routekit/hooks.bak during guardrails-off\" (`tests/unit/redirect-read-bash-to-agent.test.mjs`, the `deployed` case in `describe('hook copies stay byte-identical to canonical'`). During off-rail, `block-git-during-off-rail.mjs` keeps its existing behaviour.",
  "",
  "All other git subcommands keep today's behaviour (allow, subject to the downstream hooks).",
  "",
  "The hook is vendored three ways and a byte-parity test enforces it (`tests/unit/redirect-read-bash-to-agent.test.mjs:480-482`: canonical `packages/hooks/...`, template `templates/generic/.routekit/hooks/...`, deployed `.routekit/hooks/...`). The same edit must land in all three copies.",
  "",
  "User approval: per the user's standing rule, this hook change ships only after the user approves it.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] `classifyBashCommand('git commit -m \"x\"')`, `classifyBashCommand('git add notes/a.md')` and `classifyBashCommand('git rm notes/a.md')` do not return `{ action: \"allow\" }`; each returns the new redirect kind.",
  "- [ ] The same holds when git global options precede the subcommand: `git -C /tmp/repo commit -m \"fix: x\"`, `git -c user.name=x commit -m y`, `git --no-pager add .`.",
  "- [ ] Read-only and other git commands keep their current classification: `git status`, `git log --oneline -5`, `git diff`, `git rev-parse HEAD`, `git branch` still return `{ action: \"allow\", kind: \"allowlisted\" }`.",
  "- [ ] Non-git allowlisted commands are unchanged (`npm install`, `node script.mjs`, `npx vitest run`), and project-declared `testCommand` widening still cannot admit `git commit|add|rm`.",
  "- [ ] The spawned hook, given a Bash `git commit` / `git add` / `git rm` payload, emits a PreToolUse `deny` whose text contains a REDIRECT ORDER naming `rks_agent_git` (and/or the Ship Governor path via `rks_git_commit`), and does not say the command was or can be run by an agent.",
  "- [ ] The existing assertion at `tests/unit/redirect-read-bash-to-agent.test.mjs:152` is updated to the new expected result, not deleted.",
  "- [ ] `packages/hooks/read/redirect-read-bash-to-agent.mjs`, `templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs` and `.routekit/hooks/read/redirect-read-bash-to-agent.mjs` remain byte-identical (existing parity test passes).",
  "",
  "## Target Files",
  "",
  "- `packages/hooks/read/redirect-read-bash-to-agent.mjs` — EDIT — canonical child Bash hook: classify `git commit|add|rm` (after skipping git global options) as a redirect kind before the allowlist returns allow; deny output with REDIRECT ORDER to `rks_agent_git` / Ship Governor.",
  "- `templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs` — EDIT — byte-identical copy of the canonical file (parity test).",
  "- `.routekit/hooks/read/redirect-read-bash-to-agent.mjs` — EDIT — byte-identical deployed copy (parity test).",
  "- `tests/unit/redirect-read-bash-to-agent.test.mjs` — EDIT — `:152` currently pins `git -C ... commit` as allowlisted; update it to the new expectation. QA adds the remaining coverage.",
  "",
  "### packages/hooks/read/redirect-read-bash-to-agent.mjs",
  "@@SEARCH",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@REPLACE",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@END",
  "",
  "### templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs",
  "@@SEARCH",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@REPLACE",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@END",
  "",
  "### .routekit/hooks/read/redirect-read-bash-to-agent.mjs",
  "@@SEARCH",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@REPLACE",
  "  if (ALLOWLIST.has(token)) return { action: \"allow\", kind: \"allowlisted\" };",
  "@@END",
  "",
  "### tests/unit/redirect-read-bash-to-agent.test.mjs",
  "@@SEARCH",
  "    expect(classifyBashCommand('git -C /tmp/repo commit -m \"fix: x\"')).toEqual({ action: 'allow', kind: 'allowlisted' });",
  "@@REPLACE",
  "    expect(classifyBashCommand('git -C /tmp/repo commit -m \"fix: x\"')).toEqual({ action: 'allow', kind: 'allowlisted' });",
  "@@END",
  "",
  "SEARCH equals REPLACE on purpose: these blocks anchor the planner; the edit content is the Build's to author.",
  "",
  "## Regression witnesses (for QA; from `rks_exhaustive_search` over `tests`, `tests/.tmp` and one fixture `.rks` skipped by the tool)",
  "",
  "- `tests/unit/redirect-read-bash-to-agent.test.mjs` — imports `classifyBashCommand`, `denyReasonFor`, `denyOptionsFor`, `nonReadDenyOutput`, `ALLOWLIST` (`:7`); spawned-hook tests (`:218`, `:282`); parity (`:480-482`).",
  "- `tests/unit/git-workflow-hook-test-command.test.mjs` — imports `loadProjectAllowConfig` (`:10`) and lists `read/redirect-read-bash-to-agent.mjs` among files at `:587`.",
  "- `tests/unit/hook-credential-presence-dotenv.test.mjs:158` and `tests/unit/research-agent-outage-fallthrough.test.mjs:228-240` spawn this hook with non-git payloads.",
  "",
  "## Distribution note",
  "",
  "Existing children receive the changed hook only through the normal sync path (`routekit project sync` / doctor); this story does not change distribution.",
  "",
  "## Follow-ups (different concerns, NOT merged)",
  "",
  "- Other git write verbs the child allowlist also admits (`push`, `reset`, `restore`, `checkout --`, `stash`, `merge`, `rebase`, `cherry-pick`, `revert`, `tag`, `clean`). `block-git-during-off-rail.mjs` already names a write-subcommand set for off-rail; whether the on-rail child hook should share it is a separate decision.",
  "- `git show <ref>:<path>` is a read through an allowlisted verb in children (CLAUDE.md flags the same gap for the shell). Separate read-boundary concern.",
  "- Whether children should register the shell's blanket `redirect-bash-to-governor.mjs` is open in `backlog.fix.child-hook-registration-omits-template-governor-redirects`. This story keeps the allowlist-first child model and does not depend on that decision.",
  "",
  "## Build Path",
  "",
  "GUARDRAILS-OFF with this problemId: a target starts with `.routekit/hooks/` (CLAUDE.md Build Path Analysis).",
];

const INCIDENT_APPENDED_AT_AD13E7E73 = [
  "",
  "## ARCH Guidance",
  "",
  "**Verdict:** approved",
  "**Anchor:** @f72a571a4",
  "",
  "Coordinates below come from `rks_exhaustive_search` and direct reads at the anchor above.",
  "",
  "### Decisions on the QA open questions (user direction: record the safer option)",
  "",
  "**Q1. Redirect or deny: DENY.** `classifyBashCommand` returns `{ action: \"deny\", kind: \"git-write\" }`. The outage fallthrough at `packages/hooks/read/redirect-read-bash-to-agent.mjs:220` is gated on `result.action === \"redirect\" && result.kind === \"read\"`, and its comment (`:216-218`) relies on every non-read denial carrying `action: \"deny\"`. Using `deny` keeps that invariant true without depending on the `kind` conjunct. If a later edit simplified the gate to `action === \"redirect\"`, a `redirect` git-write would fall through during an outage; a `deny` one would not. The check runs after the metacharacter test (`:141`) and before both `ALLOWLIST.has(token)` (`:143`) and the `extraTokens` widening (`:147`).",
  "",
  "**Q2. Guardrail log identification: two sinks, two fields.** Re-derived: there are two separate sinks, and neither records a kind today.",
  "- `appendTelemetry` writes to `.routekit/telemetry/guardrails.log` (`packages/hooks/system/hook-output.mjs:104-105`). The hook's entry (`redirect-read-bash-to-agent.mjs:236-243`) carries `hook: \"redirect-read-bash-to-agent\"`, `blocked`, `reason`, `command` and `projectId`, with no kind.",
  "- `emitGuardrailBump` writes `hook.guardrail_bump` to `.rks/telemetry/events-<date>.jsonl` (`hook-output.mjs:150-153`). Its payload is `hookName`, `blockedTool`, `redirectAgent`, `reason`, `problemId`, `tier`, `sessionId` and `context` (`:175-183`), with no kind.",
  "",
  "The testRequirement that names `.routekit/telemetry/guardrails.log` is satisfied as follows:",
  "- (a) Add `kind: result.kind` to the `appendTelemetry` entry in this hook. The field is additive, applies to all kinds, and its value is the observed classification. It is the field that identifies `git-write` in every mode, keyed or keyless.",
  "- (b) In keyed mode, the `hook.guardrail_bump` event carries `redirectAgent: \"mcp__rks__rks_agent_git\"`. It is emitted inside `buildRedirectOutput` (`hook-output.mjs:292`), so do NOT also call `emitGuardrailBump` at `:248` for git-write; that would double-count.",
  "- (c) In keyless mode nothing is routed. Call `emitGuardrailBump({ reason, blockedTool: \"Bash\", projectId })` once, leaving `redirectAgent` null so it reflects that no routing happened.",
  "- Do NOT put `kind` into `agentParams`. That object is printed as the agent's `params` in GOVERNOR ROUTING (`hook-output.mjs:281`, `:286`), and the Dispatcher would pass it to `rks_agent_git`.",
  "- Tests should assert `kind === 'git-write'` on the last `guardrails.log` entry (pattern at `tests/unit/redirect-read-bash-to-agent.test.mjs:435-436`). In keyed mode they should also assert that the events-file bump has `payload.hookName === 'redirect-read-bash-to-agent'` and `payload.redirectAgent === 'mcp__rks__rks_agent_git'`.",
  "- The existing test at `:246-254` (non-read denial, `redirectAgent` null) is unaffected.",
  "",
  "**Q3. Keyless: deny, with no REDIRECT ORDER, and point to the terminal.** In keyless mode the decision is still deny. The output must NOT be a `buildRedirectOutput` envelope, because a mandatory REDIRECT ORDER to `rks_agent_git` points at a Governor path that cannot run without a credential. Emit a plain PreToolUse deny envelope (the same shape as `nonReadDenyOutput`) with git-write-specific text. It should say that keyless mode has no LLM credential, so Governors (and with them `rks_agent_git` and the Ship Governor) are unavailable, that the command was not run, and that the user should run the git command in their own terminal. Keyed mode uses `buildRedirectOutput({ reason, agent: \"mcp__rks__rks_agent_git\", agentParams: { projectId, request: <short description naming the git command> }, instructions, project: projectId })`. Its instructions name `rks_governor_init` → `rks_agent_git`, or the Ship Governor (`/ship`, which commits via `rks_git_commit`), and say not to retry the raw command.",
  "",
  "### Item findings and mandatory guidance",
  "",
  "**Item 1 (symbols exist).** No findings.",
  "- `classifyBashCommand` is at `redirect-read-bash-to-agent.mjs:138`, with `:142` `const token = trimmed.split(/\\s+/)[0];` and the `:143` allowlist return.",
  "- `ALLOWLIST_TOKENS` (`:45-48`) contains `\"git\"` (`:47`).",
  "- The pinned test is at `tests/unit/redirect-read-bash-to-agent.test.mjs:152`.",
  "- The child registration is at `packages/cli/src/project/bootstrap.mjs:652`. The Problem section cites `:615`; that is descriptive line drift only and not a target.",
  "",
  "**Item 2 (secondary paths).** Within `packages`, the only call site of `classifyBashCommand` is `:213`. Mandatory for Build:",
  "- (i) `main()` must branch on `kind === \"git-write\"` BEFORE the `if (!isRead)` block at `:247`. Otherwise git-write falls into `nonReadDenyOutput`, whose first line (`:179`) says \"no agent can run it\" and routes to `run_command`. That is false for git-write.",
  "- (ii) Add a `git-write` branch to `denyReasonFor` (`:157`). Its fallthrough (`:165`) would otherwise report \"not on the child allowlist\", which is false because `git` is allowlisted (`:47`). That text feeds both the deny reason and both telemetry sinks (`:233`, `:240`, `:248`).",
  "- (iii) Keep `appendTelemetry` (`:236`) on the git-write path.",
  "- (iv) The subcommand parser must never throw. `main().catch` exits 0 (`:282-284`), which fails open.",
  "",
  "**Subcommand parsing (safer choices recorded):**",
  "- Walk tokens after `git`. Every token starting with `-` is an option.",
  "- `-C`, `-c`, and the space-separated forms of `--git-dir`, `--work-tree`, `--namespace`, `--config-env` and `--exec-path` also consume the next token. `--opt=value` and `-Cpath`-style attached forms consume nothing extra.",
  "- The first non-option token is the subcommand. Compare it token-exactly against the set {`commit`, `add`, `rm`, `stage`}. `stage` is git's built-in synonym for `add`; including it is the safer choice.",
  "- Token-exact matching keeps `git log --grep commit`, `git show HEAD:notes/add.md`, `commit-tree` and the like as allow.",
  "- User-defined git aliases (for example `git ci`) cannot be detected statically. They are out of scope; mention them in the Follow-ups list rather than attempting them.",
  "",
  "**Item 3 (pinning tests).** `rks_exhaustive_search` for `redirect-read-bash-to-agent` over `tests` found 4 files. Its result was `exhaustive: false` because it skipped `tests/.tmp` and one fixture `.rks`.",
  "- `tests/unit/redirect-read-bash-to-agent.test.mjs` is a target.",
  "- `tests/unit/git-workflow-hook-test-command.test.mjs:10,15,349,587` import `loadProjectAllowConfig`, spawn the hook with `pytest -q`, and list the file. None of these is affected by the git-write branch.",
  "- `tests/unit/hook-credential-presence-dotenv.test.mjs:158` uses `cat`.",
  "- `tests/unit/research-agent-outage-fallthrough.test.mjs:228,234,240` use `cat` and metacharacter payloads.",
  "- Within the target test file, `git ` appears only at `:15` (`git status`, stays allow), `:134` (`CO_AUTHOR_CMD`, stays metacharacter because of `<`/`>`) and `:152`.",
  "- The `ROUTING_MARKERS` array (`:135`) contains `REDIRECT ORDER` and `GOVERNOR ROUTING`. It is asserted absent only for the metacharacter and unknown cases (`:146`, `:189`, `:199`, `:243`), so a keyed git-write REDIRECT ORDER does not break it.",
  "- Update `:152` in place. Also retitle the test at `:151` (`'control: the same command without the trailer is allowed'`), because it will no longer be allowed. Assert `kind: 'git-write'` and `kind !== 'metacharacter'`.",
  "- New spawned tests must pin the credential explicitly, following the existing pattern:",
  "  - Keyed: `{ ANTHROPIC_API_KEY: 'test-sentinel-not-a-key' }` (`:259`).",
  "  - Keyless: `{ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }` (`:267`).",
  "  - Otherwise the REDIRECT ORDER assertion depends on the CI environment.",
  "- Prefer behavioural assertions (contains `REDIRECT ORDER` and `rks_agent_git`; lacks `mcp__rks__rks_agent_research` and `run (needs governance)`) over full-string pins.",
  "- The `TOKENS` and ten-token test (`:136`, `:167-172`) must pass unchanged, so `ALLOWLIST` is not edited.",
  "",
  "**Item 4 (frontmatter).** No findings. targetFiles match the body's Target Files section.",
  "",
  "**Item 5 (left/right balance).** No findings. The new kind has its consumer (`main()`) in the same file. No shared module changes: `hook-output.mjs` is NOT a target and must not be edited. `buildRedirectOutput`, `emitGuardrailBump` and `isKeyless` are already imported (`:37-39`).",
  "",
  "**Item 6 (phase).** No findings. The check runs at PreToolUse on Bash, where the command string exists. Governed paths run git inside the MCP server process, not through the Bash tool.",
  "",
  "**Item 7 (circular dogfood).** The `.routekit/hooks/` target triggers guardrails-off, as the story already declares. Re-derived in `packages/mcp-rks/src/server/guardrails-audit.mjs`, via `rks_agent_research` with verbatim snippets:",
  "- During guardrails-off the `read` tier is RENAMED into `.routekit/hooks.bak/read` (`RELOCATABLE_TIERS = ['write', 'read']`, `:43`).",
  "- `rks_guardrails_on` removes any `.routekit/hooks/read` with `rmSync` before renaming the bak dir back.",
  "- It then runs `runHookDeploy` → `syncAll`. That overwrites `.routekit/hooks/{write,read,system}/` and the template copy from canonical `packages/hooks`, but only when the session touched canonical hook source.",
  "- The previous ARCH Governor's account is therefore confirmed in substance. I did not verify its specific line numbers `:2109`/`:2719`.",
  "",
  "Mandatory for Build:",
  "- (i) Edit canonical `packages/hooks/read/redirect-read-bash-to-agent.mjs` first.",
  "- (ii) Copy it byte-identically to `templates/generic/.routekit/hooks/read/redirect-read-bash-to-agent.mjs` during the session. The template parity test (`:484-486`) is NOT skipped off-rail.",
  "- (iii) Do NOT hand-edit `.routekit/hooks/read/redirect-read-bash-to-agent.mjs` while off-rail. That directory has been relocated, so an edit there is deleted on restore. The deployed copy is produced by the guardrails-on deploy and captured in the auto-ship commit, which is in scope because the path is a target.",
  "- (iv) After guardrails-on, confirm that the `hookDeploy` result reports a project sync and not a skip or failure. Then run the parity test once to confirm the deployed copy (`:488-493`, skipped while relocated) matches. If the deploy failed or was skipped, the deployed copy is stale and must be fixed before shipping.",
  "- Separately, `.claude/settings.json` does not register this hook. `redirect-read-bash-to-agent` returned 0 matches; the positive control `redirect-bash-to-governor` on the same file hit at `:404`. So the shell Dispatcher's own Bash is unaffected by this change.",
  "- Per the user's standing rule, the hook diff ships only after the user approves it.",
  "",
  "**Item 8 (stale scope).** No findings. All four target paths exist at the anchor.",
  "",
  "**Item 9 (vertical value).** No findings. This is a single independently valuable slice.",
  "",
  "**Item 10 (evidence-bound reporting).**",
  "- The new telemetry `kind` comes from `result.kind`, the observed classification.",
  "- `redirectAgent` must be non-null only when a redirect envelope is actually emitted (keyed), and null in keyless mode (R1).",
  "- The deny text must not claim the command ran, or that an agent will run the raw Bash command (R8 in spirit).",
  "- The `denyReasonFor` fix in Item 2(ii) removes a false reason string.",
  "",
  "**Item 11 (cross-story).** No cross-story comparison was performed, because the batch held a single story.",
];

const INCIDENT_BEFORE_RAW = INCIDENT_NOTE_AT_DDDB36CC8.join("\n");
const INCIDENT_AFTER_RAW = `${INCIDENT_BEFORE_RAW.replace("updated: 1791181407231", "updated: 1791181453257")}\n${INCIDENT_APPENDED_AT_AD13E7E73.join("\n")}`;
const INCIDENT_RECORDED_ARCH_SUBJECT = "ea7dfa68091f604c0abeba0296427685";
const INCIDENT_REPORTED_CURRENT_DIGEST = "6d098317eca0267e482d8aec51413853";

describe("incident reproduction — the real note bytes at dddb36cc8 and ad13e7e73", () => {
  const before = parseFrontmatter(INCIDENT_BEFORE_RAW);
  const after = parseFrontmatter(INCIDENT_AFTER_RAW);

  it("the fixture has the incident shape: no trailing newline before, a guidance section appended at EOF after", () => {
    expect(INCIDENT_BEFORE_RAW.endsWith("(CLAUDE.md Build Path Analysis).")).toBe(true);
    expect(after.content.startsWith(before.content)).toBe(true);
    expect(after.content.slice(before.content.length).startsWith("\n\n## ARCH Guidance\n")).toBe(true);
  });

  it("legacySubjectDigest of the two bodies differs — exactly the two digests the incident reported", () => {
    expect(archVerdictModule.noteLegacySubjectDigest(before)).toBe(INCIDENT_RECORDED_ARCH_SUBJECT);
    expect(archVerdictModule.noteLegacySubjectDigest(after)).toBe(INCIDENT_REPORTED_CURRENT_DIGEST);
    expect(archVerdictModule.legacySubjectDigest({ body: before.content })).not.toBe(
      archVerdictModule.legacySubjectDigest({ body: after.content }),
    );
  });

  it("subjectDigest of the two bodies is equal", () => {
    expect(subjectDigest({ body: after.content })).toBe(subjectDigest({ body: before.content }));
    expect(noteSubjectDigest(after)).toBe(noteSubjectDigest(before));
  });

  it("the arch_subject recorded at dddb36cc8 is accepted against the note at ad13e7e73 (legacy match) without a rebase", () => {
    const r = computeArchVerdict({
      priorLedger: [], priorRound: 1, submitted: [],
      recordedSubject: INCIDENT_RECORDED_ARCH_SUBJECT,
      currentSubject: noteSubjectDigest(after),
      legacySubject: archVerdictModule.noteLegacySubjectDigest(after),
      // The recording carries no arch_subject_version: it is UNVERSIONED, so it is compared
      // against the version-1 digest (backlog.fix.arch-subject-digest-whitespace-robust).
      v1Subject: archVerdictModule.noteV1SubjectDigest(after),
    });
    // The version-1 digest of the before-note equals its legacy digest (no boundary
    // whitespace to canonicalize), so the recorded value is matched through the v1 digest. The
    // note has a blank line after its frontmatter, so the version-2 digest differs from it.
    expect(archVerdictModule.noteV1SubjectDigest(before)).toBe(INCIDENT_RECORDED_ARCH_SUBJECT);
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
  });
});

describe("computeArchVerdict — a recorded subject equal to the LEGACY digest is not a rebase", () => {
  const body = `${DECOY_PROSE}\n`;
  const CANON = subjectDigest({ body });
  const LEGACY = referencePreFixDigest({ body });

  it("the fixture's legacy and canonical digests differ", () => {
    expect(LEGACY).not.toBe(CANON);
  });

  it("advances the round, keeps the ledger, and reports the canonical subject to record", () => {
    const ledger = [findingKey(f(1, "a.mjs"))];
    const r = computeArchVerdict({
      priorLedger: ledger, priorRound: 1, submitted: [f(1, "a.mjs"), f(9, "z.mjs")],
      recordedSubject: LEGACY, currentSubject: CANON, legacySubject: LEGACY,
    });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.ledger).toEqual(ledger);
    expect(r.blocking).toEqual(ledger);
    expect(r.deferred).toEqual([findingKey(f(9, "z.mjs"))]);
    expect(r.subject).toBe(CANON);
  });

  it("still rebases when the recorded subject matches neither digest", () => {
    const r = computeArchVerdict({
      priorLedger: [findingKey(f(1, "a.mjs"))], priorRound: 1, submitted: [f(9, "z.mjs")],
      recordedSubject: "c".repeat(32), currentSubject: CANON, legacySubject: LEGACY,
    });
    expect(r.rebased).toBe(true);
    expect(r.round).toBe(1);
    expect(r.ledger).toEqual([findingKey(f(9, "z.mjs"))]);
    expect(r.subject).toBe(CANON);
  });

  it("still rebases on a canonical mismatch when no legacy digest is supplied", () => {
    const r = computeArchVerdict({
      priorLedger: [], priorRound: 1, submitted: [],
      recordedSubject: LEGACY, currentSubject: CANON,
    });
    expect(r.rebased).toBe(true);
  });
});

// ── backlog.fix.arch-subject-digest-excludes-refine-context-sections ─────────
//
// Refine-owned body content (rows 1-7 of the story's shape table) is carved out of the
// subject digest, by EXACT shape, AFTER the ARCH Guidance strip. Rows 8-12 (checkboxes,
// `// CREATE FILE:`, targetFiles, testRequirements) stay inside. Digests recorded before the
// carve-out are matched through notePreCarveOutSubjectDigest at every comparison site.
//
// Where a writer exists, the block under test is produced by the REAL writer
// (runRefineApplyTool) or its exported builder/literal, never a hand-typed copy of the shape.
import * as refineShapes from "../../../packages/mcp-rks/src/shared/refine-shapes.mjs";
import * as refineModule from "../../../packages/mcp-rks/src/server/refine.mjs";
import { makeTempDir, writeFile as writeTmpFile, ensureDir } from "../../helpers/tmp.mjs";
import { splitNoteFrontmatter } from "../../../packages/mcp-rks/src/shared/frontmatter.mjs";

const {
  TARGET_HEADING_PREFIX,
  TARGET_SIGNATURE_LINE,
  TEST_EXEMPLAR_HEADING_PREFIX,
  TEST_EXEMPLAR_SIGNATURE_LINE,
  TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE,
  TEST_FIX_HEADING_PREFIX,
  REFINEMENT_HISTORY_HEADING_PREFIX,
  REFINE_ANCHOR_MARKER,
  OUT_OF_BAND_MARKER_PREFIX,
  insertBeforeArchGuidance,
} = refineShapes;
const { runRefineApplyTool, targetSectionFor, FENCE } = refineModule;
const { notePreCarveOutSubjectDigest, noteLegacySubjectDigest, preCarveOutSubjectDigest } = archVerdictModule;

const RS_TF = [{ path: "src/beta.mjs", op: "edit" }];
const RS_TR = ["tests/unit/beta.test.mjs: beta does the thing"];
const rsDigest = (body, extra = {}) => subjectDigest({ body, targetFiles: RS_TF, testRequirements: RS_TR, ...extra });

const AUTHORED = "## Problem\n\nBuild beta.\n\n## Solution\n\nDo it.\n";
const ARCH_TAIL = "## ARCH Guidance\n\n**Verdict:** approved\n\nNo findings.\n";
const ARCH_ENDING = `${AUTHORED}\n${ARCH_TAIL}`;
const outOfBandMarker = (file) => OUT_OF_BAND_MARKER_PREFIX + file + " -->";
const anchorBlock = (file, search, replace = search) =>
  `${REFINE_ANCHOR_MARKER}\n### ${file}\n\n@@SEARCH\n${search}\n@@REPLACE\n${replace}\n@@END`;

// ── a real refine project on disk ──
const RS_STORY = "backlog.fix.refine-carve-out-fixture";
function rsProject(body = AUTHORED) {
  const projectRoot = makeTempDir("refine_carve_out");
  ensureDir(path.join(projectRoot, "notes"));
  writeTmpFile(path.join(projectRoot, "src/beta.mjs"), "export const beta = 1;\n");
  writeTmpFile(path.join(projectRoot, "src/gamma.mjs"), "export const gamma = 2;\n");
  writeTmpFile(
    path.join(projectRoot, "tests/unit/beta.test.mjs"),
    'import { describe, it, expect } from "vitest";\n\ndescribe("beta", () => {\n  it("is one", () => {\n    expect(1).toBe(1);\n  });\n});\n',
  );
  rsWriteNote(projectRoot, body);
  return projectRoot;
}
// No blank line after the closing fence: refine's writers trim() the text before the insertion
// point, so a leading newline would be dropped by the writer itself, not by the carve-out
// (story QA Amendment, observation for Build).
function rsWriteNote(projectRoot, body, targetFilesYaml = '  - path: "src/beta.mjs"\n    op: "edit"') {
  fs.writeFileSync(
    path.join(projectRoot, "notes", `${RS_STORY}.md`),
    `---\nid: "${RS_STORY}"\nphase: "arch-approved"\ntargetFiles:\n${targetFilesYaml}\ntestRequirements:\n  - "${RS_TR[0]}"\n---\n${body}`,
  );
}
const rsRaw = (projectRoot) => fs.readFileSync(path.join(projectRoot, "notes", `${RS_STORY}.md`), "utf8");
const rsBody = (projectRoot) => splitNoteFrontmatter(rsRaw(projectRoot)).body;
const rsNoteDigest = (projectRoot) => noteSubjectDigest(parseFrontmatter(rsRaw(projectRoot)));
async function rsApply(projectRoot, refinements) {
  const res = await runRefineApplyTool({ projectRoot, problemId: RS_STORY, projectId: "p", refinements });
  expect(res.ok, JSON.stringify(res)).not.toBe(false);
  return res;
}

describe("refine-shapes.mjs — the literals, defined once", () => {
  it("exports the shape literals with their writer bytes", () => {
    expect(TARGET_HEADING_PREFIX).toBe("### Target: ");
    expect(TARGET_SIGNATURE_LINE).toBe("Current source (use for search_replace patterns):");
    expect(TEST_EXEMPLAR_HEADING_PREFIX).toBe("### Test Exemplar: ");
    expect(TEST_FIX_HEADING_PREFIX).toBe("### Test Fix Required: ");
    expect(REFINEMENT_HISTORY_HEADING_PREFIX).toBe("## Refinement History (");
    expect(REFINE_ANCHOR_MARKER).toBe("<!-- rks:refine-anchor -->");
    expect(OUT_OF_BAND_MARKER_PREFIX).toBe("<!-- rks:context-out-of-band: ");
  });

  it("refine.mjs re-exports the SAME bindings and declares no local OUT_OF_BAND_MARKER_PREFIX", () => {
    for (const name of [
      "TARGET_HEADING_PREFIX", "TARGET_SIGNATURE_LINE", "TEST_EXEMPLAR_HEADING_PREFIX", "TEST_EXEMPLAR_SIGNATURE_LINE",
      "TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE", "TEST_FIX_HEADING_PREFIX", "REFINEMENT_HISTORY_HEADING_PREFIX",
      "REFINE_ANCHOR_MARKER", "OUT_OF_BAND_MARKER_PREFIX",
    ]) {
      expect(refineModule[name], name).toBe(refineShapes[name]);
    }
    const refineSrc = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/server/refine.mjs"), "utf8");
    expect(refineSrc).not.toMatch(/const OUT_OF_BAND_MARKER_PREFIX\s*=/);
    expect(refineSrc).toMatch(/from "\.\.\/shared\/refine-shapes\.mjs"/);
  });

  it("the row-1 builder emits the exported literals byte-for-byte", () => {
    const section = targetSectionFor("src/beta.mjs", "export const beta = 1;");
    expect(section).toContain(`\n${TARGET_HEADING_PREFIX}src/beta.mjs\n\n${TARGET_SIGNATURE_LINE}\n\n${FENCE}`);
  });
});

describe("module purity", () => {
  const sharedSrc = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/shared/refine-shapes.mjs"), "utf8");
  const avSrc = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/workflow/arch-verdict.mjs"), "utf8");

  it("refine-shapes.mjs contains no import statements", () => {
    expect(sharedSrc).not.toMatch(/^\s*import\b/m);
    expect(sharedSrc).not.toMatch(/\bimport\s*\(/);
  });

  it("arch-verdict.mjs imports only node:crypto and ../shared/refine-shapes.mjs, never refine.mjs", () => {
    const specs = [...avSrc.matchAll(/^import\b[^;]*?from\s*"([^"]+)"/gms)].map((m) => m[1]);
    expect(specs.sort()).toEqual(["../shared/refine-shapes.mjs", "node:crypto"]);
    expect(avSrc).not.toMatch(/refine\.mjs"/);
    for (const name of [
      "ARCH_GUIDANCE_LINE", "TARGET_HEADING_PREFIX", "TARGET_SIGNATURE_LINE", "TEST_EXEMPLAR_HEADING_PREFIX",
      "TEST_EXEMPLAR_SIGNATURE_LINE", "TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE", "TEST_FIX_HEADING_PREFIX",
      "REFINEMENT_HISTORY_HEADING_PREFIX", "REFINE_ANCHOR_MARKER", "OUT_OF_BAND_MARKER_PREFIX",
    ]) {
      expect(avSrc).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"\\.\\./shared/refine-shapes\\.mjs"`));
    }
  });

  it("arch-verdict.mjs no longer declares ARCH_GUIDANCE_LINE and its code restates none of the shape strings", () => {
    expect(avSrc).not.toMatch(/const ARCH_GUIDANCE_LINE\b/);
    // Comments may NAME a shape; code must reach it only through the imported binding.
    const code = avSrc.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    for (const literal of [
      "Current source (use for search_replace patterns)", "### Target: ", "### Test Exemplar: ",
      "### Test Fix Required: ", "## Refinement History (", "rks:refine-anchor", "rks:context-out-of-band",
    ]) {
      expect(code, literal).not.toContain(literal);
    }
  });
});

describe("insertBeforeArchGuidance", () => {
  it("with no column-0 heading returns exactly body.trim() + block (trimEnd mode: body.trimEnd() + block)", () => {
    expect(insertBeforeArchGuidance("\n  A\n\n", "\n\nX\n")).toBe("A" + "\n\nX\n");
    expect(insertBeforeArchGuidance("\n  A\n\n", "\n\nX\n", { trimMode: "trimEnd" })).toBe("\n  A" + "\n\nX\n");
  });

  it("an indented heading alone is a decoy, not the heading", () => {
    const body = "A\n\n   ## ARCH Guidance\n\nprose\n";
    expect(insertBeforeArchGuidance(body, "\n\nX\n")).toBe(body.trim() + "\n\nX\n");
  });

  it("inserts before the LAST column-0 heading, preserving that line and everything after it", () => {
    const tail = "## ARCH Guidance\n\nreal\n\n## After\n\nmore  \n\n";
    const body = `A\n\n## ARCH Guidance\n\nquoted\n\n${tail}`;
    const out = insertBeforeArchGuidance(body, "\n\nX\n");
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toBe(`A\n\n## ARCH Guidance\n\nquoted\n\nX\n\n${tail}`);
  });

  it("treats a non-string body as an empty string", () => {
    expect(insertBeforeArchGuidance(undefined, "\n\nX\n")).toBe("\n\nX\n");
    expect(insertBeforeArchGuidance(null, "B")).toBe("B");
  });
});

describe("subjectDigest — rows 1-7 through the real writer leave the digest unchanged", () => {
  it("row 1: add_code_snippet appends a Target snapshot (heading, signature line, one fence)", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]);
    const body = rsBody(root);
    expect(body).toContain(`${TARGET_HEADING_PREFIX}src/beta.mjs\n\n${TARGET_SIGNATURE_LINE}\n\n${FENCE}`);
    expect(body).toContain(REFINEMENT_HISTORY_HEADING_PREFIX);
    expect(rsNoteDigest(root)).toBe(before);
  });

  it("row 2: the out-of-band marker line (one whole line) is excluded", () => {
    expect(rsDigest(`${AUTHORED}\n${outOfBandMarker("src/big.mjs")}\n`)).toBe(rsDigest(AUTHORED));
  });

  it("row 3: add_test_exemplar with an existing test appends heading, signature line and one fence", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "add_test_exemplar", data: { editTargetDirs: ["src/beta"] } }]);
    const body = rsBody(root);
    expect(body).toContain(`${TEST_EXEMPLAR_HEADING_PREFIX}tests/unit/beta.test.mjs\n\n${TEST_EXEMPLAR_SIGNATURE_LINE}\n\n${FENCE}`);
    expect(rsNoteDigest(root)).toBe(before);
  });

  it("row 4: the framework-fallback Test Exemplar form is excluded", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "add_test_exemplar", data: { editTargetDirs: ["src/zzz-no-match"] } }]);
    const body = rsBody(root);
    expect(body).toContain(`${TEST_EXEMPLAR_HEADING_PREFIX}(framework fallback — vitest)\n\n${TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE}\n\n${FENCE}`);
    expect(rsNoteDigest(root)).toBe(before);
  });

  it.each([
    ["a caller-supplied anchor", "export const beta = 1;", { anchors: ["export const beta = 1;"] }],
    ["an extracted anchor", "export const beta = 1;", {}],
    ["the disk-read fallback anchor", "// no anchor-shaped line here", {}],
  ])("row 5: add_search_pattern identity anchor spliced after the snapshot fence (%s)", async (_label, payload, extra) => {
    const root = rsProject(AUTHORED.trimEnd() + targetSectionFor("src/beta.mjs", payload));
    const before = rsNoteDigest(root);
    expect(before).toBe(rsDigest(AUTHORED));
    await rsApply(root, [{ type: "add_search_pattern", data: { file: "src/beta.mjs", ...extra } }]);
    const body = rsBody(root);
    expect(body).toContain(`${FENCE}\n\n${REFINE_ANCHOR_MARKER}\n### src/beta.mjs\n\n@@SEARCH\nexport const beta = 1;\n@@REPLACE\nexport const beta = 1;\n@@END`);
    expect(rsNoteDigest(root)).toBe(before);
  });

  // fix_test_assertion runs after refine's "did the note change?" snapshot, so on its own it is
  // reported refine_noop and never written (pre-existing, out of scope). It is applied here beside
  // an add_code_snippet so its section reaches the note.
  it("row 6: fix_test_assertion heading plus ONE reason paragraph is excluded; a second paragraph is not", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [
      { type: "add_code_snippet", data: { file: "src/beta.mjs" } },
      { type: "fix_test_assertion", data: { file: "tests/unit/beta.test.mjs", line: 3, reason: "Expected 2, received 1." } },
    ]);
    expect(rsBody(root)).toContain(`${TEST_FIX_HEADING_PREFIX}tests/unit/beta.test.mjs (line 3)\n\nExpected 2, received 1.\n`);
    expect(rsNoteDigest(root)).toBe(before);

    const root2 = rsProject();
    await rsApply(root2, [
      { type: "add_code_snippet", data: { file: "src/beta.mjs" } },
      { type: "fix_test_assertion", data: { file: "tests/unit/beta.test.mjs", reason: "First paragraph.\n\nSecond paragraph." } },
    ]);
    expect(rsBody(root2)).toContain(`${TEST_FIX_HEADING_PREFIX}tests/unit/beta.test.mjs\n\nFirst paragraph.\n\nSecond paragraph.\n`);
    expect(rsNoteDigest(root2)).not.toBe(before);
  });

  it("row 7: Refinement History sections from two applies are excluded", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]);
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/gamma.mjs" } }]);
    const body = rsBody(root);
    expect(body.split(REFINEMENT_HISTORY_HEADING_PREFIX).length - 1).toBe(2);
    expect(rsNoteDigest(root)).toBe(before);
  });
});

describe("subjectDigest — never swallow authored content", () => {
  const base = rsDigest(AUTHORED);

  it("a marked block whose REPLACE differs from its SEARCH stays inside", () => {
    expect(rsDigest(`${AUTHORED}\n${anchorBlock("src/beta.mjs", "export const beta = 1;", "export const beta = 2;")}\n`)).not.toBe(base);
  });

  it("an unmarked identity block stays inside", () => {
    const unmarked = anchorBlock("src/beta.mjs", "export const beta = 1;").replace(`${REFINE_ANCHOR_MARKER}\n`, "");
    expect(rsDigest(`${AUTHORED}\n${unmarked}\n`)).not.toBe(base);
  });

  it("a PO-authored ### Target: heading without the signature line stays inside", () => {
    expect(rsDigest(`${AUTHORED}\n${TARGET_HEADING_PREFIX}src/beta.mjs\n\nPO prose about beta.\n`)).not.toBe(base);
    expect(rsDigest(`${AUTHORED}\n${TARGET_HEADING_PREFIX}src/beta.mjs\n\n${FENCE}javascript\nx\n${FENCE}\n`)).not.toBe(base);
  });

  it("a ### Test Exemplar: heading followed by any non-signature line stays inside", () => {
    expect(rsDigest(`${AUTHORED}\n${TEST_EXEMPLAR_HEADING_PREFIX}tests/a.test.mjs\n\nUse this one.\n\n${FENCE}js\nx\n${FENCE}\n`)).not.toBe(base);
  });
});

describe("subjectDigest — exact-shape bounding", () => {
  const snapshot = targetSectionFor("src/beta.mjs", "export const beta = 1;");
  const exemplar = `\n\n${TEST_EXEMPLAR_HEADING_PREFIX}tests/a.test.mjs\n\n${TEST_EXEMPLAR_SIGNATURE_LINE}\n\n${FENCE}javascript\nx\n${FENCE}\n`;
  const fallback = `\n\n${TEST_EXEMPLAR_HEADING_PREFIX}(framework fallback — vitest)\n\n${TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE}\n\n${FENCE}typescript\nx\n${FENCE}\n`;
  const anchor = `\n\n${anchorBlock("src/beta.mjs", "export const beta = 1;")}\n`;

  it.each([
    ["row 1", snapshot],
    ["row 3", exemplar],
    ["row 4", fallback],
    ["row 5", anchor],
  ])("%s: the block alone is excluded, authored prose after its close (before the next heading) is not", (_label, block) => {
    const withBlock = AUTHORED.trimEnd() + block;
    expect(rsDigest(withBlock)).toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${withBlock}\nAuthored prose after the block.\n`)).not.toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${withBlock}\nAuthored prose after the block.\n`)).toBe(rsDigest(`${AUTHORED}\nAuthored prose after the block.\n`));
  });

  it("row 1: a second fence after the snapshot fence stays inside", () => {
    expect(rsDigest(`${AUTHORED.trimEnd()}${snapshot}\n${FENCE}js\nauthored\n${FENCE}\n`)).not.toBe(rsDigest(AUTHORED));
  });

  it("row 7: a non-dash line directly after the history lines stays inside", () => {
    const hist = `\n\n${REFINEMENT_HISTORY_HEADING_PREFIX}2026-10-13)\n- did a thing\n`;
    expect(rsDigest(AUTHORED.trimEnd() + hist)).toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${AUTHORED.trimEnd()}${hist}Authored line.\n`)).not.toBe(rsDigest(AUTHORED));
  });

  it("row 6: text after the excluded paragraph's terminating blank line stays inside", () => {
    const fix = `\n\n${TEST_FIX_HEADING_PREFIX}tests/a.test.mjs\n\nReason.\n`;
    expect(rsDigest(AUTHORED.trimEnd() + fix)).toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${AUTHORED.trimEnd()}${fix}\nMore text.\n`)).not.toBe(rsDigest(AUTHORED));
  });
});

describe("subjectDigest — rows 8-12 stay inside", () => {
  it("clarify_ac checkbox lines change the digest, including directly under a Refinement History section", async () => {
    expect(rsDigest(`${AUTHORED}- [ ] new criterion\n`)).not.toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${AUTHORED}- [x] done criterion\n`)).not.toBe(rsDigest(AUTHORED));
    const hist = `${AUTHORED}\n${REFINEMENT_HISTORY_HEADING_PREFIX}2026-10-13)\n- did a thing\n`;
    expect(rsDigest(hist)).toBe(rsDigest(AUTHORED));
    expect(rsDigest(`${hist}- [ ] new criterion\n`)).not.toBe(rsDigest(AUTHORED));

    const root = rsProject();
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]);
    const afterHistory = rsNoteDigest(root);
    await rsApply(root, [{ type: "clarify_ac", data: { criteria: ["beta is two"] } }]);
    expect(rsBody(root)).toMatch(/- Injected[^\n]*\n- \[ \] beta is two\n/);
    expect(rsNoteDigest(root)).not.toBe(afterHistory);
  });

  it("a // CREATE FILE: directive under ## Files to Create changes the digest", async () => {
    const root = rsProject();
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "create_file_directive", data: { file: "src/new.mjs" } }]);
    expect(rsBody(root)).toContain("## Files to Create\n\n// CREATE FILE: src/new.mjs");
    expect(rsNoteDigest(root)).not.toBe(before);
  });

  it("targetFiles and testRequirements changes change the digest", () => {
    expect(rsDigest(AUTHORED, { targetFiles: [...RS_TF, { path: "src/x.mjs", op: "edit" }] })).not.toBe(rsDigest(AUTHORED));
    expect(rsDigest(AUTHORED, { testRequirements: ["other"] })).not.toBe(rsDigest(AUTHORED));
  });

  it("the legacy string-list targetFiles auto-upgrade changes the digest", async () => {
    const root = rsProject();
    rsWriteNote(root, AUTHORED, '  - "src/beta.mjs"');
    const before = rsNoteDigest(root);
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]);
    expect(parseFrontmatter(rsRaw(root)).data.targetFiles[0]).toMatchObject({ path: "src/beta.mjs" });
    expect(rsNoteDigest(root)).not.toBe(before);
  });

  it.each([
    ["Problem", AUTHORED.replace("Build beta.", "Build beta twice.")],
    ["Solution", AUTHORED.replace("Do it.", "Do it differently.")],
    ["AC", `${AUTHORED}\n## Acceptance Criteria\n\n- [ ] one\n`],
  ])("editing %s prose changes the digest", (_label, amended) => {
    expect(rsDigest(amended)).not.toBe(rsDigest(AUTHORED));
  });
});

describe("ARCH-ending bodies — writers insert before ## ARCH Guidance", () => {
  const archIdx = (body) => body.lastIndexOf(`\n${ARCH_TAIL.split("\n")[0]}\n`) + 1;

  it.each([
    ["clarify_ac (row 8)", [{ type: "clarify_ac", data: { criteria: ["beta is two"] } }], "- [ ] beta is two", true],
    ["add_code_snippet snapshot (row 1)", [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }], `${TARGET_HEADING_PREFIX}src/beta.mjs`, false],
    ["add_test_exemplar matched (row 3)", [{ type: "add_test_exemplar", data: { editTargetDirs: ["src/beta"] } }], `${TEST_EXEMPLAR_HEADING_PREFIX}tests/unit/beta.test.mjs`, false],
    ["add_test_exemplar fallback (row 4)", [{ type: "add_test_exemplar", data: { editTargetDirs: ["src/zzz-no-match"] } }], `${TEST_EXEMPLAR_HEADING_PREFIX}(framework fallback`, false],
    ["create_file_directive fallback (row 9)", [{ type: "create_file_directive", data: { file: "src/new.mjs" } }], "// CREATE FILE: src/new.mjs", true],
    ["fix_test_assertion (row 6)", [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }, { type: "fix_test_assertion", data: { file: "tests/unit/beta.test.mjs", reason: "R." } }], TEST_FIX_HEADING_PREFIX, false],
  ])("%s lands before the heading; the ARCH tail is byte-identical", async (_label, refinements, needle, changesDigest) => {
    const root = rsProject(ARCH_ENDING);
    const before = rsNoteDigest(root);
    await rsApply(root, refinements);
    const body = rsBody(root);
    const at = archIdx(body);
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at)).toBe(ARCH_TAIL);
    expect(body.indexOf(needle)).toBeGreaterThan(-1);
    expect(body.indexOf(needle)).toBeLessThan(at);
    // The Refinement History append (row 7) also lands before the heading.
    expect(body.indexOf(REFINEMENT_HISTORY_HEADING_PREFIX)).toBeGreaterThan(-1);
    expect(body.indexOf(REFINEMENT_HISTORY_HEADING_PREFIX)).toBeLessThan(at);
    if (changesDigest) expect(rsNoteDigest(root)).not.toBe(before);
    else expect(rsNoteDigest(root)).toBe(before);
  });

  it("add_code_snippet over the size cap writes the out-of-band marker (row 2) before the heading", async () => {
    const pad = `\n## Notes\n\n${"Authored padding line for the size cap.\n".repeat(100)}`;
    const body = `${AUTHORED}${pad}\n${ARCH_TAIL}`;
    expect(body.length).toBeLessThan(8192);
    const root = rsProject(body);
    // A 100-line file is injected whole (<= 120 lines), so the projected body exceeds the cap.
    writeTmpFile(path.join(root, "src/big.mjs"), `${"export const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n".repeat(100)}`);
    const before = rsNoteDigest(root);
    const res = await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/big.mjs" } }]);
    expect(res.applied.some((a) => a.outOfBand === true)).toBe(true);
    const after = rsBody(root);
    const at = archIdx(after);
    expect(after.slice(at)).toBe(ARCH_TAIL);
    expect(after.indexOf(outOfBandMarker("src/big.mjs"))).toBeGreaterThan(-1);
    expect(after.indexOf(outOfBandMarker("src/big.mjs"))).toBeLessThan(at);
    expect(rsNoteDigest(root)).toBe(before);
  });

  it("rows 1-7 built from the literals and inserted before the heading leave the digest unchanged; rows 8 and 9 change it", () => {
    const base = rsDigest(ARCH_ENDING);
    for (const block of [
      targetSectionFor("src/beta.mjs", "export const beta = 1;"),
      `\n\n${outOfBandMarker("src/big.mjs")}\n`,
      `\n\n${TEST_EXEMPLAR_HEADING_PREFIX}tests/a.test.mjs\n\n${TEST_EXEMPLAR_SIGNATURE_LINE}\n\n${FENCE}js\nx\n${FENCE}\n`,
      `\n\n${TEST_EXEMPLAR_HEADING_PREFIX}(framework fallback — vitest)\n\n${TEST_EXEMPLAR_FALLBACK_SIGNATURE_LINE}\n\n${FENCE}ts\nx\n${FENCE}\n`,
      `\n\n${anchorBlock("src/beta.mjs", "export const beta = 1;")}\n`,
      `\n\n${TEST_FIX_HEADING_PREFIX}tests/a.test.mjs\n\nReason.\n`,
      `\n\n${REFINEMENT_HISTORY_HEADING_PREFIX}2026-10-13)\n- did a thing\n`,
    ]) {
      expect(rsDigest(insertBeforeArchGuidance(ARCH_ENDING, block)), block).toBe(base);
    }
    expect(rsDigest(insertBeforeArchGuidance(ARCH_ENDING, "\n- [ ] new criterion\n"))).not.toBe(base);
    expect(rsDigest(insertBeforeArchGuidance(ARCH_ENDING, "\n\n## Files to Create\n\n// CREATE FILE: src/new.mjs\n"))).not.toBe(base);
  });
});

describe("canonicalSubjectBody — strip order (ARCH round-1 finding 1)", () => {
  it("ARCH Guidance is located on the original body before Refinement History is removed", () => {
    const authored = "## Problem\n\nAuthored text.\n";
    const legacyPlaced = `${authored}\n## ARCH Guidance\n\nprose\n\n${REFINEMENT_HISTORY_HEADING_PREFIX}2026-10-13)\n- did a thing\n`;
    const withCheckbox = `${legacyPlaced}- [ ] new criterion\n`;
    expect(rsDigest(withCheckbox)).not.toBe(rsDigest(legacyPlaced));
    expect(rsDigest(legacyPlaced)).toBe(rsDigest(authored));
  });
});

// The fixture carries all seven EXCLUDE shapes. GOLDEN_PRE_CARVE_OUT was captured by running
// the build-base module (arch-verdict.mjs at 59c8666d4, before this change) over exactly these
// inputs: subjectDigest({ body: PRE_CARVE_OUT_FIXTURE, targetFiles: [{ path: "src/a.mjs",
// op: "edit" }], testRequirements: ["r1"] }).
const PRE_CARVE_OUT_FIXTURE = [
  "## Problem",
  "",
  "Authored problem prose.",
  "",
  "### Target: src/a.mjs",
  "",
  "Current source (use for search_replace patterns):",
  "",
  "```javascript",
  "export const a = 1;",
  "```",
  "",
  "<!-- rks:refine-anchor -->",
  "### src/a.mjs",
  "",
  "@@SEARCH",
  "export const a = 1;",
  "@@REPLACE",
  "export const a = 1;",
  "@@END",
  "",
  "<!-- rks:context-out-of-band: src/big.mjs -->",
  "",
  "### Test Exemplar: tests/unit/a.test.mjs",
  "",
  "Use this existing test as a pattern for imports, describe/it structure, and assertion syntax:",
  "",
  "```javascript",
  'import { it } from "vitest";',
  "```",
  "",
  "### Test Exemplar: (framework fallback — vitest)",
  "",
  "Use this as a pattern for imports, describe/it structure, and assertion syntax:",
  "",
  "```typescript",
  "import { describe } from 'vitest';",
  "```",
  "",
  "### Test Fix Required: tests/unit/a.test.mjs (line 3)",
  "",
  "Expected 2, received 1.",
  "",
  "## Refinement History (2026-10-13)",
  "- Injected code context from src/a.mjs",
  "",
].join("\n");
const GOLDEN_PRE_CARVE_OUT = "85c269058e880932caa3d7ebb5a0f11d";
const PCO_TF = [{ path: "src/a.mjs", op: "edit" }];
const PCO_TR = ["r1"];

describe("preCarveOutSubjectDigest — the pre-change digest, comparison-only", () => {
  it("is pinned by the golden hex captured from the pre-change module", () => {
    expect(preCarveOutSubjectDigest({ body: PRE_CARVE_OUT_FIXTURE, targetFiles: PCO_TF, testRequirements: PCO_TR })).toBe(GOLDEN_PRE_CARVE_OUT);
    // The carve-out reduces the same fixture to its authored text.
    expect(subjectDigest({ body: PRE_CARVE_OUT_FIXTURE, targetFiles: PCO_TF, testRequirements: PCO_TR })).toBe(
      subjectDigest({ body: "## Problem\n\nAuthored problem prose.\n", targetFiles: PCO_TF, testRequirements: PCO_TR }),
    );
    expect(subjectDigest({ body: PRE_CARVE_OUT_FIXTURE, targetFiles: PCO_TF, testRequirements: PCO_TR })).not.toBe(GOLDEN_PRE_CARVE_OUT);
  });

  it("notePreCarveOutSubjectDigest applies noteSubjectDigest's field mapping", () => {
    const raw = `---\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\ntestRequirements:\n  - "r1"\n---\n${PRE_CARVE_OUT_FIXTURE}`;
    expect(notePreCarveOutSubjectDigest(parseFrontmatter(raw))).toBe(GOLDEN_PRE_CARVE_OUT);
  });

  it("equals subjectDigest for a body with no refine-owned shapes", () => {
    for (const body of [AUTHORED, ARCH_ENDING, `${AUTHORED}- [ ] c\n`, ""]) {
      expect(preCarveOutSubjectDigest({ body, targetFiles: RS_TF, testRequirements: RS_TR })).toBe(rsDigest(body));
    }
  });

  it("compat cannot mask an amendment: a Problem amendment moves all three digests", () => {
    const raw = (problem) => `---\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\ntestRequirements:\n  - "r1"\n---\n${PRE_CARVE_OUT_FIXTURE.replace("Authored problem prose.", problem)}`;
    const recorded = notePreCarveOutSubjectDigest(parseFrontmatter(raw("Authored problem prose.")));
    const amended = parseFrontmatter(raw("Amended problem prose."));
    expect(noteSubjectDigest(amended)).not.toBe(recorded);
    expect(noteLegacySubjectDigest(amended)).not.toBe(recorded);
    expect(notePreCarveOutSubjectDigest(amended)).not.toBe(recorded);
  });
});

describe("computeArchVerdict — a recorded subject equal to the PRE-CARVE-OUT digest is not a rebase", () => {
  it("preserves round and ledger", () => {
    const r = computeArchVerdict({
      priorLedger: ["item-1-a"], priorRound: 1, submitted: [f(1, "a")],
      recordedSubject: "P", currentSubject: "C", legacySubject: "L", preCarveOutSubject: "P",
    });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.ledger).toEqual(["item-1-a"]);
    expect(r.subject).toBe("C");
  });

  it("rebases to round 1 when the recorded subject matches none of current, legacy and pre-carve-out", () => {
    const r = computeArchVerdict({
      priorLedger: ["item-1-a"], priorRound: 2, submitted: [f(9, "z")],
      recordedSubject: "X", currentSubject: "C", legacySubject: "L", preCarveOutSubject: "P",
    });
    expect(r.rebased).toBe(true);
    expect(r.round).toBe(1);
  });

  it("an empty pre-carve-out digest never matches", () => {
    const r = computeArchVerdict({ priorRound: 1, recordedSubject: "", currentSubject: "C", preCarveOutSubject: "" });
    expect(r.rebased).toBe(false); // absent recorded subject: grandfathered, not matched
    const r2 = computeArchVerdict({ priorRound: 1, recordedSubject: "X", currentSubject: "C", preCarveOutSubject: "" });
    expect(r2.rebased).toBe(true);
  });
});

describe("one shared pre-carve-out function at every comparison site", () => {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src", rel), "utf8");

  it.each([
    ["server/handlers/governance.mjs", "../../workflow/arch-verdict.mjs"],
    ["server/guardrails-audit.mjs", "../workflow/arch-verdict.mjs"],
    ["shared/governor-token.mjs", "../workflow/arch-verdict.mjs"],
  ])("%s imports notePreCarveOutSubjectDigest from arch-verdict.mjs and maps no fields inline", (rel, spec) => {
    const src = read(rel);
    const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    expect(src).toMatch(new RegExp(`import\\s*\\{[^}]*\\bnotePreCarveOutSubjectDigest\\b[^}]*\\}\\s*from\\s*["']${esc}["']`));
    expect(src).toMatch(/notePreCarveOutSubjectDigest\(parsed\)/);
    expect(src).not.toMatch(/preCarveOutSubjectDigest\(\s*\{/);
  });

  it("the rks_arch_verdict handler passes it to computeArchVerdict alongside legacySubject", () => {
    expect(serverSrc).toMatch(/const preCarveOutSubject = notePreCarveOutSubjectDigest\(parsed\);/);
    expect(serverSrc).toMatch(/legacySubject,\s*preCarveOutSubject,/);
    expect(serverSrc).toMatch(/const currentSubject = noteSubjectDigest\(parsed\);/);
  });

  it("server.mjs imports notePreCarveOutSubjectDigest from ./workflow/arch-verdict.mjs", () => {
    const serverMjs = read("server.mjs");
    expect(serverMjs).toMatch(/import\s*\{[^}]*\bnotePreCarveOutSubjectDigest\b[^}]*\}\s*from\s*"\.\/workflow\/arch-verdict\.mjs"/);
  });
});

// ── backlog.fix.arch-subject-digest-whitespace-robust ───────────────────────
//
// Fingerprint version 2: subjectDigest whitespace-normalises its canonical body outside
// protected regions; v1SubjectDigest keeps the previous form byte-for-byte, consulted only for
// UNVERSIONED recordings. Every site branches on the recorded version.
import { parseFrontmatter as parseSharedFrontmatter } from "../../../packages/mcp-rks/src/shared/frontmatter.mjs";

const { isCurrentArchSubjectVersion, v1SubjectDigest, noteV1SubjectDigest, legacySubjectDigest } = archVerdictModule;
const WR_VARIANTS = [
  ["AUTHORED", AUTHORED],
  ["newline+AUTHORED", `\n${AUTHORED}`],
  ["ARCH_ENDING", ARCH_ENDING],
  ["newline+ARCH_ENDING", `\n${ARCH_ENDING}`],
];
const leadOf = (v) => (v.startsWith("\n") ? "\n" : "");
// A refine-owned Target snapshot placed as refine places it (before ## ARCH Guidance), keeping the
// variant's leading whitespace so the splice route also runs on a leading-blank body.
const withTarget = (v, payload = "export const beta = 1;") =>
  leadOf(v) + insertBeforeArchGuidance(v, targetSectionFor("src/beta.mjs", payload));
const BIG_FILE = "export const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n".repeat(110);

// Rows 1-7, each as [label, body transform, applies (one refinements array per apply), setup].
const WR_ROWS = [
  ["row 1 add_code_snippet", (v) => v, [[{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]]],
  [
    "row 2 out-of-band marker (add_code_snippet over the size cap)",
    (v) => v,
    [[{ type: "add_code_snippet", data: { file: "src/big.mjs" } }]],
    (root) => writeTmpFile(path.join(root, "src/big.mjs"), BIG_FILE),
    (root) => expect(rsBody(root)).toContain(outOfBandMarker("src/big.mjs")),
  ],
  ["row 3 add_test_exemplar matched", (v) => v, [[{ type: "add_test_exemplar", data: { editTargetDirs: ["src/beta"] } }]]],
  ["row 4 add_test_exemplar framework fallback", (v) => v, [[{ type: "add_test_exemplar", data: { editTargetDirs: ["src/zzz-no-match"] } }]]],
  [
    "row 5 add_search_pattern, Target-splice route",
    withTarget,
    [[{ type: "add_search_pattern", data: { file: "src/beta.mjs", anchors: ["export const beta = 1;"] } }]],
    null,
    (root) => expect(rsBody(root)).toContain(`${FENCE}\n\n${REFINE_ANCHOR_MARKER}\n### src/beta.mjs\n\n@@SEARCH\n`),
  ],
  [
    "row 5 add_search_pattern, no-Target append route",
    (v) => v,
    [[{ type: "add_search_pattern", data: { file: "src/beta.mjs", anchors: ["export const beta = 1;"] } }]],
    null,
    (root) => {
      expect(rsBody(root)).not.toContain(TARGET_HEADING_PREFIX);
      expect(rsBody(root)).toContain(`${REFINE_ANCHOR_MARKER}\n### src/beta.mjs\n\n@@SEARCH\nexport const beta = 1;\n`);
    },
  ],
  [
    "row 6 fix_test_assertion beside add_code_snippet",
    (v) => v,
    [[
      { type: "add_code_snippet", data: { file: "src/beta.mjs" } },
      { type: "fix_test_assertion", data: { file: "tests/unit/beta.test.mjs", line: 3, reason: "Expected 2, received 1." } },
    ]],
    null,
    (root) => expect(rsBody(root)).toContain(TEST_FIX_HEADING_PREFIX),
  ],
  [
    "row 7 Refinement History from two successive applies",
    (v) => v,
    [[{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }], [{ type: "add_code_snippet", data: { file: "src/gamma.mjs" } }]],
    null,
    (root) => expect(rsBody(root).split(REFINEMENT_HISTORY_HEADING_PREFIX).length - 1).toBe(2),
  ],
];
async function wrRunRow(variant, [_label, transform, applies, setup, check]) {
  const root = rsProject(transform(variant));
  if (setup) setup(root);
  const rawBefore = rsRaw(root);
  const before = rsNoteDigest(root);
  const parsedBefore = parseFrontmatter(rawBefore);
  for (const refinements of applies) await rsApply(root, refinements);
  expect(rsRaw(root)).not.toBe(rawBefore);
  if (check) check(root);
  return { root, before, parsedBefore };
}
const rsParsed = (root) => parseFrontmatter(rsRaw(root));

describe("parser pin (Gap 1): a blank line after the frontmatter parses to a leading newline", () => {
  const WITH = `---\nid: "x"\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\n---\n\n## Problem\n\nP.\n`;
  const WITHOUT = WITH.replace("---\n\n## Problem", "---\n## Problem");

  it.each([["dendron.mjs", parseFrontmatter], ["shared/frontmatter.mjs", parseSharedFrontmatter]])(
    "%s parseFrontmatter yields content starting with a single newline",
    (_label, parse) => {
      const content = parse(WITH).content;
      expect(content.startsWith("\n")).toBe(true);
      expect(content.startsWith("\n\n")).toBe(false);
      expect(parse(WITHOUT).content.startsWith("\n")).toBe(false);
    },
  );

  it("noteV1SubjectDigest moves with the leading newline; noteSubjectDigest does not", () => {
    expect(noteV1SubjectDigest(parseFrontmatter(WITH))).not.toBe(noteV1SubjectDigest(parseFrontmatter(WITHOUT)));
    expect(noteSubjectDigest(parseFrontmatter(WITH))).toBe(noteSubjectDigest(parseFrontmatter(WITHOUT)));
  });
});

describe("subjectDigest v2 — rows 1-7 through the real writer, on every body variant", () => {
  for (const [vLabel, variant] of WR_VARIANTS) {
    it.each(WR_ROWS.map((row) => [row[0], row]))(`${vLabel}: %s leaves noteSubjectDigest unchanged`, async (_l, row) => {
      const { root, before } = await wrRunRow(variant, row);
      expect(rsNoteDigest(root)).toBe(before);
    });
  }
});

describe("multi-anchor pin (Gap 2): one add_search_pattern apply inserting several anchors", () => {
  const TWO_LINES = "export const beta = 1;\nexport const beta2 = 2;\n";
  const ANCHOR_SETS = [
    ["two caller anchors", ["export const beta = 1;", "export const beta2 = 2;"]],
    ["one two-line anchor", ["export const beta = 1;\nexport const beta2 = 2;"]],
  ];
  const AFTER_LINE = "Authored line after the snapshot.";
  const cases = [];
  for (const [aLabel, anchors] of ANCHOR_SETS) {
    for (const [vLabel, variant] of WR_VARIANTS) {
      cases.push([`${aLabel}, no-Target append route, ${vLabel}`, variant, anchors, false]);
      cases.push([`${aLabel}, Target-splice route, ${vLabel}`, withTarget(variant, TWO_LINES.trimEnd()), anchors, true]);
    }
    // Splice route with and without a blank line between the Target closing fence and the next
    // authored line.
    for (const sep of ["\n", "\n\n"]) {
      const spliced = `${AUTHORED.trimEnd()}${targetSectionFor("src/beta.mjs", TWO_LINES.trimEnd())}`.replace(/\n$/, "") + sep + AFTER_LINE + "\n";
      cases.push([`${aLabel}, Target-splice route, ${sep.length - 1} blank line(s) before the next authored line`, spliced, anchors, true]);
      cases.push([`${aLabel}, Target-splice route, leading blank, ${sep.length - 1} blank line(s) before the next authored line`, `\n${spliced}`, anchors, true]);
    }
  }

  it.each(cases)("%s leaves noteSubjectDigest unchanged", async (_label, body, anchors, spliceRoute) => {
    const root = rsProject(body);
    writeTmpFile(path.join(root, "src/beta.mjs"), TWO_LINES);
    for (const a of anchors) expect(fs.readFileSync(path.join(root, "src/beta.mjs"), "utf8")).toContain(a);
    const before = rsNoteDigest(root);
    const res = await rsApply(root, [{ type: "add_search_pattern", data: { file: "src/beta.mjs", anchors } }]);
    expect(res.applied.some((a) => a.cause === "anchor_not_in_file")).toBe(false);
    const after = rsBody(root);
    for (const a of anchors) expect(after).toContain(`@@SEARCH\n${a}\n@@REPLACE\n${a}\n@@END`);
    if (spliceRoute) expect(after).toContain(`${FENCE}\n\n${REFINE_ANCHOR_MARKER}`);
    else expect(after).not.toContain(TARGET_HEADING_PREFIX);
    expect(rsNoteDigest(root)).toBe(before);
  });
});

describe("subjectDigest v2 — whitespace-only differences outside protected regions are equal", () => {
  const B = "## Problem\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Solution\n\nDo it.";
  it.each([
    ["one leading blank line", `\n${B}`],
    ["several leading blank lines", `\n\n\n${B}`],
    ["leading whitespace-only lines", `   \n\t\n${B}`],
    ["a blank-line run expanded between paragraphs", B.replace("First paragraph.\n\n", "First paragraph.\n\n\n\n")],
    ["a blank-line run expanded between sections", B.replace("\n\n## Solution", "\n\n\n## Solution")],
    ["a whitespace-only line in place of an empty one", B.replace("First paragraph.\n\n", "First paragraph.\n   \n")],
    ["a run of whitespace-only lines", B.replace("First paragraph.\n\n", "First paragraph.\n \n\t\n  \n")],
    ["trailing whitespace", `${B}   `],
    ["trailing blank lines", `${B}\n\n\n\n`],
  ])("%s", (_label, variant) => {
    expect(subjectDigest({ body: variant })).toBe(subjectDigest({ body: B }));
  });

  it("collapsing keeps the 0-versus-1 blank-line distinction (joining paragraphs moves the digest)", () => {
    expect(subjectDigest({ body: B.replace("First paragraph.\n\n", "First paragraph.\n") })).not.toBe(subjectDigest({ body: B }));
  });
});

describe("subjectDigest v2 — protected regions keep their bytes", () => {
  const wrap = (inner) => `## Problem\n\nP.\n\n${inner}\n\n## Solution\n\nS.\n`;
  it.each([
    ["an extra blank line inside a fenced block", "```js\na();\n\nb();\n```", "```js\na();\n\n\nb();\n```"],
    ["the indentation of a line inside a fence", "```js\nif (x) {\n  a();\n}\n```", "```js\nif (x) {\n    a();\n}\n```"],
    ["a whitespace-only line versus an empty line inside a fence", "```js\na();\n\nb();\n```", "```js\na();\n  \nb();\n```"],
    ["an extra blank line inside an UNMARKED @@SEARCH block", "### src/a.mjs\n\n@@SEARCH\na();\n\nb();\n@@REPLACE\na();\n@@END", "### src/a.mjs\n\n@@SEARCH\na();\n\n\nb();\n@@REPLACE\na();\n@@END"],
    [
      "an extra blank line inside a marked non-identity @@SEARCH block",
      `${REFINE_ANCHOR_MARKER}\n### src/a.mjs\n\n@@SEARCH\na();\n\nb();\n@@REPLACE\nc();\n@@END`,
      `${REFINE_ANCHOR_MARKER}\n### src/a.mjs\n\n@@SEARCH\na();\n\n\nb();\n@@REPLACE\nc();\n@@END`,
    ],
    ["a whitespace-only line versus an empty line inside @@SEARCH text", "@@SEARCH\na();\n\nb();\n@@REPLACE\nc();\n@@END", "@@SEARCH\na();\n \nb();\n@@REPLACE\nc();\n@@END"],
  ])("%s gives a DIFFERENT digest", (_label, a, b) => {
    expect(subjectDigest({ body: wrap(a) })).not.toBe(subjectDigest({ body: wrap(b) }));
  });
});

describe("subjectDigest v2 — protected-region recognizer breadth (ARCH round 1 item 1)", () => {
  const one = "\n";
  const three = "\n\n\n";
  const pair = (fn) => [subjectDigest({ body: fn(one) }), subjectDigest({ body: fn(three) })];
  it.each([
    ["an indented @@SEARCH/@@END block (trim() equality)", (gap) => `## P\n\nx\n\n  @@SEARCH\n  a();\n${gap}  b();\n  @@REPLACE\n  c();\n  @@END\n\nafter\n`],
    ["a ~~~ fence", (gap) => `## P\n\nx\n\n~~~js\na();\n${gap}b();\n~~~\n\nafter\n`],
    ["an indented ``` opener closed by a longer ``` run", (gap) => `## P\n\nx\n\n   \`\`\`js\na();\n${gap}b();\n\`\`\`\`\`\n\nafter\n`],
    ["an UNCLOSED ``` fence (protected to end of body)", (gap) => `## P\n\nx\n\n\`\`\`js\na();\n\nmore text${gap}further text\n`],
    ["a ~~~ line inside a ``` fence does not close it", (gap) => `## P\n\nx\n\n\`\`\`md\n~~~\n${gap}inner\n\`\`\`\n\nafter\n`],
  ])("%s: a 1 versus 3 blank-line run inside gives DIFFERENT digests", (_label, fn) => {
    const [a, b] = pair(fn);
    expect(a).not.toBe(b);
  });

  it("positive control: the same 1 versus 3 difference outside every region gives EQUAL digests", () => {
    const fn = (gap) => `## P\n\nx\n${gap}y\n\n~~~js\na();\n~~~\n\n  @@SEARCH\n  a();\n  @@END\n\nafter\n`;
    const [a, b] = pair(fn);
    expect(a).toBe(b);
  });
});

describe("subjectDigest v2 — real content changes still move it (with and without a leading blank line)", () => {
  for (const lead of ["", "\n"]) {
    const label = lead ? "leading blank" : "no leading blank";
    const base = `${lead}${AUTHORED}`;
    it.each([
      ["a changed word in Problem prose", base.replace("Build beta.", "Build gamma."), {}],
      ["a changed word in Solution prose", base.replace("Do it.", "Do that."), {}],
      ["an added authored line", base.replace("Do it.\n", "Do it.\nAnd more.\n"), {}],
      ["a removed authored line", base.replace("Do it.\n", ""), {}],
      ["an added clarify_ac checkbox", `${base}- [ ] new criterion\n`, {}],
      ["a CREATE FILE directive under ## Files to Create", `${base}\n## Files to Create\n\n// CREATE FILE: src/new.mjs\n`, {}],
      ["a changed targetFiles entry", base, { targetFiles: [{ path: "src/other.mjs", op: "edit" }] }],
      ["a changed testRequirements entry", base, { testRequirements: ["other"] }],
    ])(`${label}: %s`, (_l, body, extra) => {
      expect(rsDigest(body, extra)).not.toBe(rsDigest(base));
    });
  }
});

describe("fingerprint version predicate", () => {
  it("ARCH_SUBJECT_VERSION is 2", () => {
    expect(ARCH_SUBJECT_VERSION).toBe(2);
  });
  it.each([["the string 2", "2"], ["the string 2 with surrounding spaces", " 2 "], ["the number 2", 2]])("true for %s", (_l, v) => {
    expect(isCurrentArchSubjectVersion(v)).toBe(true);
  });
  it.each([
    ["undefined", undefined], ["null", null], ["empty string", ""], ["the string 1", "1"], ["the number 1", 1],
    ["the string 3", "3"], ["an array holding the string 2", ["2"]], ["an object", { v: 2 }], ["a boolean", true],
  ])("false for %s", (_l, v) => {
    expect(isCurrentArchSubjectVersion(v)).toBe(false);
  });
});

// WS_FIXTURE: a leading blank line, a run of three blank lines, a whitespace-only line, refine-owned
// blocks including two back-to-back identity anchors, and a trailing ## ARCH Guidance section.
// GOLDEN_V1_WS and GOLDEN_PRE_CARVE_OUT_WS were captured by running subjectDigest and
// preCarveOutSubjectDigest from packages/mcp-rks/src/workflow/arch-verdict.mjs at the build's base
// commit 3c1a7cb24 (before this change) over exactly these inputs (targetFiles WS_TF,
// testRequirements WS_TR).
const WS_FIXTURE = [
  "",
  "## Problem",
  "",
  "Authored problem prose.",
  "",
  "",
  "",
  "## Solution",
  "   ",
  "Authored solution prose.",
  "",
  "### Target: src/a.mjs",
  "",
  "Current source (use for search_replace patterns):",
  "",
  "```javascript",
  "export const a = 1;",
  "export const b = 2;",
  "```",
  "",
  "<!-- rks:refine-anchor -->",
  "### src/a.mjs",
  "",
  "@@SEARCH",
  "export const a = 1;",
  "@@REPLACE",
  "export const a = 1;",
  "@@END",
  "",
  "<!-- rks:refine-anchor -->",
  "### src/a.mjs",
  "",
  "@@SEARCH",
  "export const b = 2;",
  "@@REPLACE",
  "export const b = 2;",
  "@@END",
  "",
  "## Refinement History (2026-10-14)",
  "- Injected 2 SEARCH anchors for src/a.mjs: export const a = 1;, export const b = 2;",
  "",
  "## ARCH Guidance",
  "",
  "**Verdict:** approved",
  "",
].join("\n");
const WS_TF = [{ path: "src/a.mjs", op: "edit" }];
const WS_TR = ["r1"];
const GOLDEN_V1_WS = "1f00b78a05b9f5541ff46372a44f69f6";
const GOLDEN_PRE_CARVE_OUT_WS = "160475782837a5c3fdfc4f2a9e68a3bd";
const wsRaw = (body = WS_FIXTURE, extraYaml = "") =>
  `---\ntargetFiles:\n  - path: "src/a.mjs"\n    op: "edit"\ntestRequirements:\n  - "r1"\n${extraYaml}---\n${body}`;

describe("v1 digest is today's digest", () => {
  it("v1SubjectDigest of the whitespace-heavy fixture equals the base-commit golden", () => {
    expect(v1SubjectDigest({ body: WS_FIXTURE, targetFiles: WS_TF, testRequirements: WS_TR })).toBe(GOLDEN_V1_WS);
  });
  it("noteV1SubjectDigest(parseFrontmatter(raw)) equals the same golden", () => {
    expect(noteV1SubjectDigest(parseFrontmatter(wsRaw()))).toBe(GOLDEN_V1_WS);
  });
  it("subjectDigest of the fixture differs from the golden", () => {
    expect(subjectDigest({ body: WS_FIXTURE, targetFiles: WS_TF, testRequirements: WS_TR })).not.toBe(GOLDEN_V1_WS);
  });
});

describe("existing compat digests are byte-identical", () => {
  it("GOLDEN_PRE_CARVE_OUT still matches", () => {
    expect(preCarveOutSubjectDigest({ body: PRE_CARVE_OUT_FIXTURE, targetFiles: PCO_TF, testRequirements: PCO_TR })).toBe(GOLDEN_PRE_CARVE_OUT);
  });
  it("preCarveOutSubjectDigest over the whitespace-heavy fixture equals its base-commit golden", () => {
    expect(preCarveOutSubjectDigest({ body: WS_FIXTURE, targetFiles: WS_TF, testRequirements: WS_TR })).toBe(GOLDEN_PRE_CARVE_OUT_WS);
    expect(notePreCarveOutSubjectDigest(parseFrontmatter(wsRaw()))).toBe(GOLDEN_PRE_CARVE_OUT_WS);
  });
  it("legacySubjectDigest still equals the reference pre-fix digest on the whitespace-heavy fixture", () => {
    expect(legacySubjectDigest({ body: WS_FIXTURE, targetFiles: WS_TF, testRequirements: WS_TR })).toBe(
      referencePreFixDigest({ body: WS_FIXTURE, targetFiles: WS_TF, testRequirements: WS_TR }),
    );
  });
});

describe("the fingerprint excludes arch_subject_version", () => {
  it("adding, changing or removing it leaves noteSubjectDigest and noteV1SubjectDigest unchanged", () => {
    const none = parseFrontmatter(wsRaw());
    for (const yamlLine of ['arch_subject_version: "2"\n', 'arch_subject_version: "1"\n', "arch_subject_version: 3\n"]) {
      const withV = parseFrontmatter(wsRaw(WS_FIXTURE, yamlLine));
      expect(withV.data.arch_subject_version).toBeDefined();
      expect(noteSubjectDigest(withV)).toBe(noteSubjectDigest(none));
      expect(noteV1SubjectDigest(withV)).toBe(noteV1SubjectDigest(none));
    }
  });
});

describe("computeArchVerdict — version branch", () => {
  const base = { priorLedger: ["item-1-a"], priorRound: 1, submitted: [f(1, "a")], currentSubject: "C", v1Subject: "V", legacySubject: "L", preCarveOutSubject: "P" };

  it.each([["2", "2"], ["2 (number)", 2], [" 2 ", " 2 "]])("version %s: a recordedSubject equal to currentSubject is not rebased", (_l, recordedVersion) => {
    const r = computeArchVerdict({ ...base, recordedSubject: "C", recordedVersion });
    expect(r.rebased).toBe(false);
    expect(r.round).toBe(2);
    expect(r.ledger).toEqual(["item-1-a"]);
  });

  it.each([["v1Subject", "V"], ["legacySubject", "L"], ["preCarveOutSubject", "P"]])(
    "version 2: a recordedSubject equal only to %s rebases to round 1",
    (_l, recordedSubject) => {
      const r = computeArchVerdict({ ...base, recordedSubject, recordedVersion: "2" });
      expect(r.rebased).toBe(true);
      expect(r.round).toBe(1);
    },
  );

  describe.each([["absent", undefined], ["null", null], ["empty", ""], ["1", "1"], ["3", "3"]])("unversioned (%s)", (_vl, recordedVersion) => {
    const args = (extra) => ({ ...base, ...(recordedVersion === undefined ? {} : { recordedVersion }), ...extra });
    it.each([["v1Subject", "V"], ["legacySubject", "L"], ["preCarveOutSubject", "P"]])("a recordedSubject equal to %s is not rebased", (_l, recordedSubject) => {
      const r = computeArchVerdict(args({ recordedSubject }));
      expect(r.rebased).toBe(false);
      expect(r.round).toBe(2);
      expect(r.ledger).toEqual(["item-1-a"]);
    });
    it("a recordedSubject equal to none of them rebases", () => {
      expect(computeArchVerdict(args({ recordedSubject: "X" })).rebased).toBe(true);
    });
    it("a recordedSubject equal only to currentSubject rebases", () => {
      const r = computeArchVerdict(args({ recordedSubject: "C" }));
      expect(r.rebased).toBe(true);
      expect(r.round).toBe(1);
    });
  });

  it("with no v1Subject supplied an unversioned recording equal to currentSubject rebases (no fallback)", () => {
    const { v1Subject: _omit, ...noV1 } = base;
    expect(computeArchVerdict({ ...noV1, recordedSubject: "C" }).rebased).toBe(true);
  });

  it("empty-string values never match", () => {
    expect(computeArchVerdict({ ...base, recordedSubject: "X", v1Subject: "", legacySubject: "", preCarveOutSubject: "" }).rebased).toBe(true);
    expect(computeArchVerdict({ ...base, recordedSubject: "X", currentSubject: "C", recordedVersion: "2", v1Subject: "" }).rebased).toBe(true);
    // An empty recorded subject is absence (grandfathered), never a match on an empty digest.
    expect(computeArchVerdict({ ...base, recordedSubject: "", v1Subject: "" }).rebased).toBe(false);
  });

  it("computeArchVerdict calls isCurrentArchSubjectVersion", () => {
    const src = fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src/workflow/arch-verdict.mjs"), "utf8");
    const fn = src.slice(src.indexOf("export function computeArchVerdict("));
    expect(fn).toMatch(/isCurrentArchSubjectVersion\(recordedVersion\)/);
  });
});

describe("computeArchVerdict — returns subjectVersion", () => {
  it.each([[undefined], [null], ["1"], ["2"], ["3"]])("ARCH_SUBJECT_VERSION whenever a non-empty currentSubject is supplied (recordedVersion %s)", (recordedVersion) => {
    expect(computeArchVerdict({ priorRound: 1, recordedSubject: "X", currentSubject: "C", recordedVersion }).subjectVersion).toBe(ARCH_SUBJECT_VERSION);
    expect(computeArchVerdict({ priorRound: 0, currentSubject: "C", recordedVersion }).subjectVersion).toBe(ARCH_SUBJECT_VERSION);
  });
  it("falls back to the recordedVersion passed in when currentSubject is empty, or null when none", () => {
    const r = computeArchVerdict({ priorRound: 1, recordedSubject: "R", currentSubject: "", recordedVersion: "2" });
    expect(r.subject).toBe("R");
    expect(r.subjectVersion).toBe("2");
    const r1 = computeArchVerdict({ priorRound: 1, recordedSubject: "R", recordedVersion: "1" });
    expect(r1.subject).toBe("R");
    expect(r1.subjectVersion).toBe("1");
    const r2 = computeArchVerdict({ priorRound: 1, recordedSubject: "R" });
    expect(r2.subject).toBe("R");
    expect(r2.subjectVersion).toBeNull();
  });
});

describe("version-2 immunity to leading-newline loss (rows 1-7, one at a time)", () => {
  it.each(WR_ROWS.map((row) => [row[0], row]))("%s keeps a version-2 recording accepted; a Problem amendment then rebases", async (label, row) => {
    const variant = `\n${AUTHORED}`;
    const { root, before: recorded, parsedBefore } = await wrRunRow(variant, row);
    expect(parsedBefore.content.startsWith("\n")).toBe(true);
    if (label.startsWith("row 1 ")) {
      // The trim-mode writer removed the leading newline: the closing fence is followed directly
      // by the first body line.
      expect(rsRaw(root)).toContain("---\n## Problem");
      expect(rsParsed(root).content.startsWith("\n")).toBe(false);
    }
    const verdictFor = (parsed) => computeArchVerdict({
      priorLedger: ["item-1-a"], priorRound: 1, submitted: [f(1, "a")],
      recordedSubject: recorded, recordedVersion: ARCH_SUBJECT_VERSION,
      currentSubject: noteSubjectDigest(parsed), v1Subject: noteV1SubjectDigest(parsed),
      legacySubject: noteLegacySubjectDigest(parsed), preCarveOutSubject: notePreCarveOutSubjectDigest(parsed),
    });
    const ok = verdictFor(rsParsed(root));
    expect(ok.rebased).toBe(false);
    expect(ok.round).toBe(2);
    const amended = parseFrontmatter(rsRaw(root).replace("Build beta.", "Build beta twice."));
    const bad = verdictFor(amended);
    expect(bad.rebased).toBe(true);
    expect(bad.round).toBe(1);
  });
});

describe("unversioned residual pinned (leading-newline loss, remedy: re-run /arch)", () => {
  it("a v1 recording of a leading-blank note is accepted before any write and rebased after the row 1 write", async () => {
    const root = rsProject(`\n${AUTHORED}`);
    const recorded = noteV1SubjectDigest(rsParsed(root));
    const verdictFor = (parsed) => computeArchVerdict({
      priorLedger: ["item-1-a"], priorRound: 1, submitted: [f(1, "a")],
      recordedSubject: recorded,
      currentSubject: noteSubjectDigest(parsed), v1Subject: noteV1SubjectDigest(parsed),
      legacySubject: noteLegacySubjectDigest(parsed), preCarveOutSubject: notePreCarveOutSubjectDigest(parsed),
    });
    expect(verdictFor(rsParsed(root)).rebased).toBe(false);
    await rsApply(root, [{ type: "add_code_snippet", data: { file: "src/beta.mjs" } }]);
    expect(rsParsed(root).content.startsWith("\n")).toBe(false);
    expect(verdictFor(rsParsed(root)).rebased).toBe(true);
  });
});

describe("compat cannot mask an amendment (whitespace-heavy fixture)", () => {
  it("a Problem amendment moves all four note digests away from their pre-amendment values", () => {
    const before = parseFrontmatter(wsRaw());
    const after = parseFrontmatter(wsRaw(WS_FIXTURE.replace("Authored problem prose.", "Amended problem prose.")));
    for (const fn of [noteSubjectDigest, noteV1SubjectDigest, noteLegacySubjectDigest, notePreCarveOutSubjectDigest]) {
      expect(fn(after), fn.name).not.toBe(fn(before));
    }
  });
});

describe("one shared function per site (fingerprint version)", () => {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, "packages/mcp-rks/src", rel), "utf8");
  const importsFrom = (src, name, spec) => {
    const esc = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${esc}["']`).test(src);
  };

  it.each([
    ["server/handlers/governance.mjs", "../../workflow/arch-verdict.mjs"],
    ["server/guardrails-audit.mjs", "../workflow/arch-verdict.mjs"],
    ["shared/governor-token.mjs", "../workflow/arch-verdict.mjs"],
  ])("%s imports noteV1SubjectDigest from arch-verdict.mjs and calls it with (parsed)", (rel, spec) => {
    const src = read(rel);
    expect(importsFrom(src, "noteV1SubjectDigest", spec)).toBe(true);
    expect(src).toMatch(/noteV1SubjectDigest\(parsed\)/);
    expect(src).not.toMatch(/\bv1SubjectDigest\(\s*\{/);
  });

  it.each([
    ["server/guardrails-audit.mjs", "../workflow/arch-verdict.mjs"],
    ["tools/governor-init.mjs", "../workflow/arch-verdict.mjs"],
  ])("%s imports isCurrentArchSubjectVersion from arch-verdict.mjs and calls it", (rel, spec) => {
    const src = read(rel);
    expect(importsFrom(src, "isCurrentArchSubjectVersion", spec)).toBe(true);
    expect(src).toMatch(/isCurrentArchSubjectVersion\(/);
  });

  it("governor-token.mjs imports ARCH_SUBJECT_VERSION", () => {
    expect(importsFrom(read("shared/governor-token.mjs"), "ARCH_SUBJECT_VERSION", "../workflow/arch-verdict.mjs")).toBe(true);
  });

  it("the rks_arch_verdict handler passes recordedVersion and v1Subject and writes arch_subject_version", () => {
    expect(serverSrc).toMatch(/const v1Subject = noteV1SubjectDigest\(parsed\);/);
    expect(serverSrc).toMatch(/recordedVersion:\s*before\.arch_subject_version,/);
    expect(serverSrc).toMatch(/\bv1Subject,/);
    expect(serverSrc).toMatch(/arch_subject_version:\s*String\(computed\.subjectVersion\)/);
    // The existing pre-carve-out pins still hold.
    expect(serverSrc).toMatch(/legacySubject,\s*preCarveOutSubject,/);
  });

  it("no exported helper returns a set of accepted digests (ARCH no-consolidation ruling)", () => {
    const parsed = parseFrontmatter(wsRaw());
    for (const [name, value] of Object.entries(archVerdictModule)) {
      expect(name, name).not.toMatch(/accept|digestset|subjects$|digests$/i);
      if (typeof value === "function" && /^note[A-Z0-9].*SubjectDigest$/.test(name)) {
        expect(typeof value(parsed), name).toBe("string");
      }
    }
  });

  it("no preWhitespace identifier exists in packages/mcp-rks/src", () => {
    const rootDir = path.join(repoRoot, "packages/mcp-rks/src");
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mjs|js|cjs|ts|json)$/.test(e.name)) files.push(p);
      }
    };
    walk(rootDir);
    // Positive control: the same scan finds the identifier this story did add.
    expect(files.some((p) => fs.readFileSync(p, "utf8").includes("noteV1SubjectDigest"))).toBe(true);
    for (const p of files) expect(fs.readFileSync(p, "utf8"), p).not.toMatch(/preWhitespace/i);
  });
});

describe("TOOL_DESCRIPTION names the new reserved field (ARCH round 1 item 5)", () => {
  it("lists arch_subject_version after arch_subject in the only-permitted-writer list", () => {
    expect(TOOL_DESCRIPTION).toContain("arch_subject, arch_subject_version, arch_total_rounds");
  });
});
