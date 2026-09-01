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
